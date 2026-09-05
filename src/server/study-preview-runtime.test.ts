import { describe, expect, test } from "bun:test"
import {
  STUDY_PREVIEW_BACKEND_PORT,
  STUDY_PREVIEW_FRONTEND_PORT,
  StudyPreviewRuntime,
  studyPreviewLaunchSpec,
  studyPreviewSubprocessEnv,
} from "./study-preview-runtime"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

describe("StudyPreviewRuntime", () => {
  test("owns fixed ports only when their listeners belong to its process group and switches groups in order", async () => {
    const spawned: Array<{ path: string; pid: number }> = []
    const exits = new Map<number, ReturnType<typeof deferred<number | null>>>()
    const groups = new Map<number, Set<number>>()
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = []
    let nextPid = 100
    let latestPid = 0
    let listenersOwned = false
    const runtime = new StudyPreviewRuntime({
      spawnPreview: (projectPath) => {
        const pid = nextPid++
        latestPid = pid
        const exit = deferred<number | null>()
        exits.set(pid, exit)
        groups.set(pid, new Set([pid, pid + 1_000, pid + 2_000]))
        spawned.push({ path: projectPath, pid })
        return { pid, exited: exit.promise }
      },
      signalProcessGroup: (pid, signal) => {
        signals.push({ pid, signal })
        groups.set(pid, new Set())
        exits.get(pid)?.resolve(signal === "SIGTERM" ? 0 : 137)
      },
      listProcessGroupMembers: async (pid) => groups.get(pid) ?? new Set(),
      listListeningEntries: async () => latestPid === 0 || (groups.get(latestPid)?.size ?? 0) === 0 ? [] : [
        { port: STUDY_PREVIEW_FRONTEND_PORT, owners: [{ pid: listenersOwned ? latestPid + 1_000 : 999_998, command: "next-server" }] },
        { port: STUDY_PREVIEW_BACKEND_PORT, owners: [{ pid: listenersOwned ? latestPid + 2_000 : 999_999, command: "node" }] },
        { port: 4000, owners: [{ pid: 999_999, command: "unrelated" }] },
      ],
      sleep: async () => {},
    })

    const first = await runtime.ensure("/workspace/car")
    expect(first).toMatchObject({ phase: "starting", readyPorts: [] })
    listenersOwned = true
    expect(await runtime.status("/workspace/car")).toMatchObject({ phase: "ready", readyPorts: [3000, 3001] })
    await runtime.ensure("/workspace/car")
    expect(spawned).toHaveLength(1)

    const second = await runtime.ensure("/workspace/apartment")
    expect(signals).toEqual([{ pid: 100, signal: "SIGTERM" }])
    expect(spawned).toEqual([
      { path: "/workspace/car", pid: 100 },
      { path: "/workspace/apartment", pid: 101 },
    ])
    expect(second).toMatchObject({ pid: 101, phase: "ready" })
  })

  test("clears a foreign preview tree without signaling PID 1 or this server even when they share its process group", async () => {
    const spawned: number[] = []
    const individuallySignaled: Array<{ pid: number; signal: NodeJS.Signals }> = []
    const foreign = new Set([910, 911, 912])
    const sharedProcessGroup = process.pid
    const runtime = new StudyPreviewRuntime({
      spawnPreview: () => {
        spawned.push(920)
        return { pid: 920, exited: new Promise(() => {}) }
      },
      signalProcess: (pid, signal) => {
        individuallySignaled.push({ pid, signal })
        foreign.delete(pid)
      },
      listProcesses: async () => [
        { pid: 1, parentPid: 0, processGroupId: sharedProcessGroup, command: "tini", commandLine: "tini -- bun", cwd: "/app" },
        { pid: process.pid, parentPid: 1, processGroupId: sharedProcessGroup, command: "bun", commandLine: "bun src/server/cli.ts", cwd: "/app" },
        { pid: 909, parentPid: process.pid, processGroupId: sharedProcessGroup, command: "claude", commandLine: "claude", cwd: "/workspace/apartment" },
        ...(foreign.has(910) ? [{ pid: 910, parentPid: 909, processGroupId: sharedProcessGroup, command: "npm", commandLine: "npm run dev", cwd: "/workspace/apartment" }] : []),
        ...(foreign.has(911) ? [{ pid: 911, parentPid: 910, processGroupId: sharedProcessGroup, command: "next-server", commandLine: "next-server", cwd: "/workspace/apartment/frontend" }] : []),
        ...(foreign.has(912) ? [{ pid: 912, parentPid: 910, processGroupId: sharedProcessGroup, command: "node", commandLine: "node /workspace/apartment/backend/dist/main.js", cwd: "/workspace/apartment/backend" }] : []),
        { pid: 913, parentPid: 909, processGroupId: sharedProcessGroup, command: "node", commandLine: "node unrelated.js", cwd: "/tmp" },
      ],
      listListeningEntries: async () => [
        ...(foreign.has(911) ? [{ port: STUDY_PREVIEW_FRONTEND_PORT, owners: [{ pid: 911, command: "next-server" }] }] : []),
        ...(foreign.has(912) ? [{ port: STUDY_PREVIEW_BACKEND_PORT, owners: [{ pid: 912, command: "node" }] }] : []),
      ],
      listProcessGroupMembers: async (pid) => pid === 920 ? new Set([920]) : new Set(),
      sleep: async () => {},
      rawStudyProjects: JSON.stringify([
        { localPath: "/workspace/apartment" },
        { localPath: "/workspace/car" },
      ]),
    })

    await runtime.ensure("/workspace/car")

    expect(new Set(individuallySignaled.map(({ pid }) => pid))).toEqual(new Set([910, 911, 912]))
    expect(individuallySignaled.every(({ signal }) => signal === "SIGTERM")).toBe(true)
    expect(individuallySignaled.some(({ pid }) => pid === 1 || pid === process.pid || pid === 909 || pid === 913)).toBe(false)
    expect(spawned).toEqual([920])
  })

  test("fails closed without spawning when a foreign fixed-port preview cannot be removed", async () => {
    let spawnCount = 0
    const signals: NodeJS.Signals[] = []
    const runtime = new StudyPreviewRuntime({
      spawnPreview: () => {
        spawnCount += 1
        return { pid: 930, exited: new Promise(() => {}) }
      },
      signalProcess: (_pid, signal) => { signals.push(signal) },
      listProcesses: async () => [
        { pid: 921, parentPid: process.pid, processGroupId: 921, command: "npm", commandLine: "npm run dev", cwd: "/workspace/apartment" },
        { pid: 922, parentPid: 921, processGroupId: 921, command: "next-server", commandLine: "next-server", cwd: "/workspace/apartment/frontend" },
      ],
      listListeningEntries: async () => [
        { port: STUDY_PREVIEW_FRONTEND_PORT, owners: [{ pid: 922, command: "next-server" }] },
      ],
      listProcessGroupMembers: async () => new Set(),
      sleep: async () => {},
      stopGraceMs: 1,
      rawStudyProjects: JSON.stringify([
        { localPath: "/workspace/apartment" },
        { localPath: "/workspace/car" },
      ]),
    })

    await expect(runtime.ensure("/workspace/car")).rejects.toThrow("Could not clear study preview port(s): 3000")
    expect(signals).toContain("SIGTERM")
    expect(signals).toContain("SIGKILL")
    expect(spawnCount).toBe(0)
  })

  test("does not signal an ordinary foreground test that happens to use a fixed preview port", async () => {
    let spawnCount = 0
    const signaled: number[] = []
    const runtime = new StudyPreviewRuntime({
      spawnPreview: () => {
        spawnCount += 1
        return { pid: 940, exited: new Promise(() => {}) }
      },
      signalProcess: (pid) => { signaled.push(pid) },
      listProcesses: async () => [
        { pid: 931, parentPid: process.pid, processGroupId: process.pid, command: "bun", commandLine: "bun test --watch", cwd: "/workspace/car" },
      ],
      listListeningEntries: async () => [
        { port: STUDY_PREVIEW_FRONTEND_PORT, owners: [{ pid: 931, command: "bun" }] },
      ],
      listProcessGroupMembers: async () => new Set(),
      sleep: async () => {},
      rawStudyProjects: JSON.stringify([{ localPath: "/workspace/car" }]),
    })

    await expect(runtime.ensure("/workspace/car")).rejects.toThrow("Refusing to stop unrecognized process 931")
    expect(signaled).toEqual([])
    expect(spawnCount).toBe(0)
  })

  test("waits for every group member and fails closed when descendants survive SIGKILL", async () => {
    const exitedLeader = deferred<number | null>()
    const groups = new Map([[404, new Set([404, 405])]])
    const signals: NodeJS.Signals[] = []
    let started = false
    const runtime = new StudyPreviewRuntime({
      spawnPreview: () => {
        started = true
        return { pid: 404, exited: exitedLeader.promise }
      },
      signalProcessGroup: (_pid, signal) => { signals.push(signal) },
      listProcessGroupMembers: async (pid) => groups.get(pid) ?? new Set(),
      listListeningEntries: async () => started ? [
        { port: STUDY_PREVIEW_FRONTEND_PORT, owners: [{ pid: 405, command: "next" }] },
        { port: STUDY_PREVIEW_BACKEND_PORT, owners: [{ pid: 405, command: "node" }] },
      ] : [],
      sleep: async () => {},
      stopGraceMs: 1,
    })

    await runtime.ensure("/workspace/car")
    exitedLeader.resolve(0)
    await Promise.resolve()
    await expect(runtime.stop("/workspace/car")).rejects.toThrow("survived SIGKILL")
    expect(signals).toEqual(["SIGTERM", "SIGKILL"])
    expect(await runtime.status()).toMatchObject({
      projectPath: "/workspace/car",
      phase: "degraded",
      degradedReason: "stop_failed",
      readyPorts: [3000, 3001],
    })
  })

  test("does not restart an alive startup-timeout loop, but one manual degraded restart is available", async () => {
    const exits = new Map<number, ReturnType<typeof deferred<number | null>>>()
    const groups = new Map<number, Set<number>>()
    const signals: number[] = []
    let now = 0
    let nextPid = 500
    const runtime = new StudyPreviewRuntime({
      spawnPreview: () => {
        const pid = nextPid++
        const exit = deferred<number | null>()
        exits.set(pid, exit)
        groups.set(pid, new Set([pid]))
        return { pid, exited: exit.promise, recentLog: () => pid === 500 ? "TypeScript compile error" : "" }
      },
      signalProcessGroup: (pid) => {
        signals.push(pid)
        groups.set(pid, new Set())
        exits.get(pid)?.resolve(0)
      },
      listProcessGroupMembers: async (pid) => groups.get(pid) ?? new Set(),
      listListeningEntries: async () => [],
      sleep: async () => {},
      startupGraceMs: 30_000,
      now: () => now,
    })

    expect((await runtime.ensure("/workspace/car")).phase).toBe("starting")
    now = 30_001
    expect(await runtime.status("/workspace/car")).toMatchObject({
      phase: "degraded",
      degradedReason: "startup_timeout",
      recentLog: "TypeScript compile error",
    })
    expect((await runtime.ensure("/workspace/car")).pid).toBe(500)
    expect((await runtime.recover("/workspace/car", () => true)).pid).toBe(500)
    expect(nextPid).toBe(501)

    expect((await runtime.restart("/workspace/car")).pid).toBe(501)
    expect(signals).toEqual([500])
    await expect(runtime.restart("/workspace/car")).rejects.toThrow("restart is only available")
  })

  test("recovers a dead group once and a racing freeze cannot resurrect it", async () => {
    const exits = new Map<number, ReturnType<typeof deferred<number | null>>>()
    const groups = new Map<number, Set<number>>()
    let nextPid = 700
    const runtime = new StudyPreviewRuntime({
      spawnPreview: () => {
        const pid = nextPid++
        const exit = deferred<number | null>()
        exits.set(pid, exit)
        groups.set(pid, new Set([pid]))
        return { pid, exited: exit.promise }
      },
      signalProcessGroup: (pid) => {
        groups.set(pid, new Set())
        exits.get(pid)?.resolve(0)
      },
      listProcessGroupMembers: async (pid) => groups.get(pid) ?? new Set(),
      listListeningEntries: async () => [],
      sleep: async () => {},
    })

    await runtime.ensure("/workspace/car")
    groups.set(700, new Set())
    exits.get(700)?.resolve(1)
    expect((await runtime.recover("/workspace/car", () => true)).pid).toBe(701)
    expect((await runtime.recover("/workspace/car", () => true)).pid).toBe(701)

    groups.set(701, new Set())
    exits.get(701)?.resolve(1)
    expect((await runtime.ensure("/workspace/car")).pid).toBe(701)
    expect((await runtime.recover("/workspace/car", () => true)).pid).toBe(701)
    expect((await runtime.recover("/workspace/car", () => true)).pid).toBe(701)
    expect(nextPid).toBe(702)
    const freeze = runtime.stop("/workspace/car")
    const racingHeal = runtime.recover("/workspace/car", () => true)
    await freeze
    expect(await racingHeal).toMatchObject({ phase: "stopped", projectPath: "/workspace/car" })
    expect(nextPid).toBe(702)
  })

  test("uses low-watch polling settings for every assigned study project", () => {
    const env = studyPreviewSubprocessEnv(
      { STUDY_CONDITION: "static", PORT: "3210" },
      "/workspace/car",
      JSON.stringify([{ localPath: "/workspace/car" }]),
    )

    expect(env).toMatchObject({
      WATCHPACK_POLLING: "true",
      WATCHPACK_POLLING_INTERVAL: "1000",
      TSC_WATCHFILE: "DynamicPriorityPolling",
      TSC_WATCHDIRECTORY: "RecursiveDirectoryUsingDynamicPriorityPolling",
      CHOKIDAR_USEPOLLING: "true",
      CHOKIDAR_INTERVAL: "1000",
    })
    expect(env.PORT).toBe("3001")
  })

  test("launches one detached supervisor group with explicit backend and frontend ports and webpack Next dev", () => {
    const spec = studyPreviewLaunchSpec(
      "/workspace/car",
      { PORT: "3210" },
      JSON.stringify([{ localPath: "/workspace/car" }]),
    )

    expect(spec.command).toBe("/workspace/car/node_modules/.bin/concurrently")
    expect(spec.args).toContain("npm --prefix backend run start:dev")
    expect(spec.args).toContain("cd frontend && exec ./node_modules/.bin/next dev --port 3000")
    expect(spec.args.join(" ")).not.toContain("npm --prefix frontend exec")
    expect(spec.args.join(" ")).not.toContain("turbopack")
    expect(spec.env.PORT).toBe("3001")
  })
})
