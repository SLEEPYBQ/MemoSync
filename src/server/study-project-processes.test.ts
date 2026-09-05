import { describe, expect, test } from "bun:test"
import { stopOtherStudyProjectServers } from "./study-project-processes"

describe("study project server isolation", () => {
  test("stops only listening processes owned by the other assigned project", async () => {
    const killed: number[] = []
    const entries = [
      { port: 3000, owners: [{ command: "next-server", pid: 101 }] },
      { port: 3001, owners: [{ command: "node", pid: 102 }] },
      { port: 3010, owners: [{ command: "next-server", pid: 201 }] },
      { port: 5432, owners: [{ command: "postgres", pid: 301 }] },
    ]
    const cwdByPid = new Map([
      [101, "/workspace/apartment/frontend"],
      [102, "/workspace/apartment/backend"],
      [201, "/workspace/car/frontend"],
      [301, "/data/postgres"],
    ])

    const result = await stopOtherStudyProjectServers({
      currentProjectPath: "/workspace/car",
      rawStudyProjects: JSON.stringify([
        { localPath: "/workspace/apartment" },
        { localPath: "/workspace/car" },
      ]),
      passes: 1,
      listListeningEntries: async () => entries,
      readProcessCwd: async (pid) => cwdByPid.get(pid),
      killProcess: (pid) => { killed.push(pid) },
      sleep: async () => {},
    })

    expect(killed).toEqual([101, 102])
    expect(result).toEqual({ killedPids: [101, 102], stoppedProjectPaths: ["/workspace/apartment"] })
  })
})
