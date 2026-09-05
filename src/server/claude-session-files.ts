// Claude engine session files live on the CONTAINER filesystem
// (~/.claude/projects/<encoded-localPath>/<sessionId>.jsonl), not in the /data
// volume — so a rebuilt/recreated container cannot resume any chat's stored
// session token. The SDK surfaces that as a misleading "native binary failed
// to launch" and the chat stays permanently broken. Validating the token
// against the session file BEFORE booting lets the coordinator fall back to a
// fresh session (context is lost; the chat keeps working).
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/** The Claude CLI's project-folder encoding: every non-alphanumeric char → '-'. */
export function claudeProjectFolderName(localPath: string): string {
  return localPath.replace(/[^a-zA-Z0-9]/g, "-")
}

/** Whether a resume token still has its backing session file on this machine. */
export function claudeSessionFileExists(localPath: string, sessionToken: string, homeDir = homedir()): boolean {
  // Session ids are UUID-shaped; refuse anything that could traverse paths.
  if (!/^[A-Za-z0-9-]+$/.test(sessionToken)) return false
  return existsSync(join(homeDir, ".claude", "projects", claudeProjectFolderName(localPath), `${sessionToken}.jsonl`))
}
