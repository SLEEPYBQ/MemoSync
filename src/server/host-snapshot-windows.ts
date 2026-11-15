import { dlopen, FFIType, ptr } from "bun:ffi"
import path from "node:path"

function loadKernel() {
  return dlopen("kernel32.dll", {
    CreateFileW: { args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr], returns: FFIType.ptr },
    GetFileInformationByHandle: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
  })
}
let kernel: ReturnType<typeof loadKernel> | undefined

/** Windows has no openat. Pin every ancestor and the leaf with non-inheritable
 * handles that omit FILE_SHARE_DELETE: rename/delete is denied until release.
 * OPEN_REPARSE_POINT lets us reject junctions/symlinks before opening the next
 * component. Node can then open the pinned path without a CRT/HANDLE conversion.
 * https://learn.microsoft.com/windows/win32/api/fileapi/nf-fileapi-createfilew
 */
export function pinWindowsSnapshotPath(root: string, relative: string, verifyRoot: () => void) {
  const api = (kernel ??= loadKernel()).symbols
  const handles: ReturnType<typeof ptr>[] = []
  const release = () => { for (const handle of handles.splice(0).reverse()) api.CloseHandle(handle) }
  const pin = (file: string, directory: boolean) => {
    const name = Buffer.from(`${path.toNamespacedPath(file)}\0`, "utf16le")
    // GENERIC_READ; SHARE_READ | SHARE_WRITE; OPEN_EXISTING;
    // FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT.
    const handle = api.CreateFileW(ptr(name), 0x80000000, 0x3, null, 3, 0x02200000, null)
    if (!handle || handle < 0 || handle > Number.MAX_SAFE_INTEGER) throw new Error("Workspace component unavailable")
    handles.push(handle)
    const information = Buffer.alloc(52) // BY_HANDLE_FILE_INFORMATION
    if (!api.GetFileInformationByHandle(handle, ptr(information))) throw new Error("Workspace component unavailable")
    const attributes = information.readUInt32LE(0)
    if (attributes & 0x400) throw new Error("Workspace component unavailable or symlinked")
    if (Boolean(attributes & 0x10) !== directory) throw new Error("Unexpected workspace component type")
  }
  try {
    let component = path.parse(root).root
    pin(component, true)
    for (const segment of path.relative(component, root).split(path.sep).filter(Boolean)) {
      component = path.join(component, segment)
      pin(component, true)
    }
    verifyRoot()
    const segments = relative.split("/")
    for (const [index, segment] of segments.entries()) {
      component = path.join(component, segment)
      pin(component, index !== segments.length - 1)
    }
    return release
  } catch (error) { release(); throw error }
}
