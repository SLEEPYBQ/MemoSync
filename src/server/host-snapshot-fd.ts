import { dlopen, FFIType, ptr } from "bun:ffi"
import { closeSync, constants, fstatSync, openSync, statSync } from "node:fs"
import path from "node:path"
import { pinWindowsSnapshotPath } from "./host-snapshot-windows"

let openAt: ((directory: number, segment: string, flags: number) => number) | undefined
const windowsPins = new Map<number, () => void>()

export function closeWorkspaceSnapshotFd(fd: number) {
  try { closeSync(fd) }
  finally { windowsPins.get(fd)?.(); windowsPins.delete(fd) }
}
// Node omits O_CLOEXEC; native descriptors must not leak into engine subprocesses.
const closeOnExec = process.platform === "darwin" ? 0x1000000 : 0x80000

/** Node does not expose openat. Use the OS primitive so a concurrent parent-directory
 * symlink swap cannot redirect a snapshot read outside the pinned workspace descriptor.
 * No path-based fallback: unsupported platforms fail this optional host capability closed.
 */
function descriptorOpen(directory: number, segment: string, flags: number): number {
  if (!openAt) {
    const libraries = process.platform === "darwin" ? ["/usr/lib/libSystem.B.dylib"]
      : process.platform === "linux" ? ["libc.so.6", "libc.musl-aarch64.so.1", "libc.musl-x86_64.so.1"] : []
    for (const library of libraries) {
      try {
        const native = dlopen(library, { openat: { args: [FFIType.int, FFIType.ptr, FFIType.int], returns: FFIType.int } })
        openAt = (fd, name, mode) => {
          const bytes = Buffer.from(`${name}\0`, "utf8")
          const result = native.symbols.openat(fd, ptr(bytes), mode)
          if (result < 0) throw new Error("Workspace component unavailable or symlinked")
          return result
        }
        break
      } catch { /* Try the next supported libc name. */ }
    }
  }
  if (!openAt) throw new Error("Descriptor-relative host snapshots are unavailable on this platform")
  return openAt(directory, segment, flags)
}

/** Caller owns the returned file descriptor. All traversed directories are opened
 * relative to a pinned parent and reject symlinks atomically at each component.
 */
export function openWorkspaceSnapshotFd(root: string, relative: string, expectedRootIdentity: string): number {
  if (relative.split("/").some(part => !part || part === "." || part === ".." || /[\\\\:\u0000]/.test(part))) throw new Error("Invalid workspace-relative path")
  if (process.platform === "win32") {
    const release = pinWindowsSnapshotPath(root, relative, () => {
      const info = statSync(root)
      if (`${info.dev}:${info.ino}` !== expectedRootIdentity) throw new Error("Workspace root identity changed")
    })
    try {
      const fd = openSync(path.join(root, relative), constants.O_RDONLY)
      windowsPins.set(fd, release)
      return fd
    } catch (error) { release(); throw error }
  }
  const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | closeOnExec
  let parent = openSync(root, directoryFlags)
  try {
    const rootStat = fstatSync(parent)
    if (`${rootStat.dev}:${rootStat.ino}` !== expectedRootIdentity) throw new Error("Workspace root identity changed")
    const parts = relative.split("/")
    for (const part of parts.slice(0, -1)) {
      const child = descriptorOpen(parent, part, directoryFlags)
      closeSync(parent)
      parent = child
    }
    return descriptorOpen(parent, parts[parts.length - 1]!, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | closeOnExec)
  } finally { closeSync(parent) }
}
