import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk"
import { z } from "zod"
import type { StudyPreviewRuntimeController } from "./study-preview-runtime"

export const STUDY_PREVIEW_MCP_SERVER_NAME = "preview"

function result(snapshot: Awaited<ReturnType<StudyPreviewRuntimeController["status"]>>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(snapshot) }],
  }
}

/** Agent-readable diagnostics and a safe restart for the server-owned preview. */
export function toClaudeStudyPreviewMcpServer(
  runtime: Pick<StudyPreviewRuntimeController, "status" | "restart">,
  projectPath: string,
) {
  return createSdkMcpServer({
    name: STUDY_PREVIEW_MCP_SERVER_NAME,
    version: "1.0.0",
    tools: [
      tool(
        "preview_status",
        "Inspect the managed study preview on fixed frontend port 3000 and backend port 3001, including bounded recent logs. Use this instead of starting another dev server.",
        {},
        async () => result(await runtime.status(projectPath)),
        { alwaysLoad: true },
      ),
      tool(
        "preview_restart",
        "Restart the managed study preview process group for this project on fixed ports 3000 and 3001. Use only when preview_status reports degraded or exited.",
        {
          reason: z.string().min(1).max(240).describe("Why the managed preview needs a restart"),
        },
        async () => result(await runtime.restart(projectPath)),
        { alwaysLoad: true },
      ),
    ],
  })
}
