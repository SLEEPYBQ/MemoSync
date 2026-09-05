import { resolve } from "node:path"
import {
  isPathWithin,
  listListeningTcpEntries,
  readProcessCwd,
  type ListeningPortEntry,
} from "./local-http-servers"
import { parseStudyProjects } from "./study-projects"

function isMissingProcess(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ESRCH")
}

/** Stop dev servers from the previous assigned project before the next one runs. */
export async function stopOtherStudyProjectServers(args: {
  currentProjectPath: string
  rawStudyProjects: string | undefined
  passes?: number
  listListeningEntries?: () => Promise<ListeningPortEntry[]>
  readProcessCwd?: (pid: number) => Promise<string | undefined>
  killProcess?: (pid: number) => void
  sleep?: (milliseconds: number) => Promise<void>
}): Promise<{ killedPids: number[]; stoppedProjectPaths: string[] }> {
  const currentProjectPath = resolve(args.currentProjectPath)
  const assignedPaths = parseStudyProjects(args.rawStudyProjects).map((project) => resolve(project.localPath))
  if (!assignedPaths.includes(currentProjectPath)) return { killedPids: [], stoppedProjectPaths: [] }
  const otherProjectPaths = assignedPaths.filter((projectPath) => projectPath !== currentProjectPath)
  const listEntries = args.listListeningEntries ?? listListeningTcpEntries
  const readCwd = args.readProcessCwd ?? readProcessCwd
  const kill = args.killProcess ?? ((pid) => process.kill(pid, "SIGTERM"))
  const sleep = args.sleep ?? ((milliseconds) => new Promise<void>((resolveSleep) => setTimeout(resolveSleep, milliseconds)))
  const passes = args.passes ?? 2
  const killedPids = new Set<number>()
  const stoppedProjectPaths = new Set<string>()

  for (let pass = 0; pass < passes; pass += 1) {
    const entries = await listEntries()
    const owners = [...new Map(
      entries.flatMap((entry) => entry.owners).map((owner) => [owner.pid, owner]),
    ).values()].filter((owner) => !killedPids.has(owner.pid))
    // /proc lookups are independently bounded. Resolve them concurrently so
    // a busy participant container cannot multiply the Claude-start delay by
    // its listener count.
    const ownersWithCwd = await Promise.all(owners.map(async (owner) => ({
      owner,
      cwd: await readCwd(owner.pid),
    })))
    for (const { owner, cwd } of ownersWithCwd) {
      const projectPath = otherProjectPaths.find((candidate) => isPathWithin(candidate, cwd))
      if (!projectPath) continue
      try {
        kill(owner.pid)
      } catch (error) {
        if (!isMissingProcess(error)) throw error
      }
      killedPids.add(owner.pid)
      stoppedProjectPaths.add(projectPath)
    }
    if (pass + 1 < passes) await sleep(250)
  }

  return {
    killedPids: [...killedPids],
    stoppedProjectPaths: [...stoppedProjectPaths],
  }
}
