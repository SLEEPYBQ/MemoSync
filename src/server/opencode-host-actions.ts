import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { HOST_ACTION_TOOL_NAMES } from '../shared/host-actions'
import { OPENCODE_HOST_TICKET } from './memory/opencode-adapter'

/** The native hook adds an opaque ticket AFTER model input validation. The
 * ordinary MCP credential cannot mint tickets, and identity is never in a tool schema.
 */
export async function createOpencodeHostPlugin(config: { url: string; authorization: string }) {
  const directory = await mkdtemp(join(tmpdir(), 'memosync-opencode-host-'))
  const file = join(directory, 'host-actions.mjs')
  const source = `export default async () => ({
    'tool.execute.before': async (input, output) => {
      const names = ${JSON.stringify(Object.values(HOST_ACTION_TOOL_NAMES))};
      const name = names.find(name => input.tool === 'memosync_' + name);
      if (!name) return;
      delete output.args[${JSON.stringify(OPENCODE_HOST_TICKET)}];
      const response = await fetch(${JSON.stringify(config.url)}, {
        method: 'POST', headers: { Authorization: ${JSON.stringify(config.authorization)}, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, args: output.args, sessionID: input.sessionID, callID: input.callID }),
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error('MemoSync host action unavailable');
      const binding = await response.json();
      if (binding.ticket) output.args[${JSON.stringify(OPENCODE_HOST_TICKET)}] = binding.ticket;
    },
  });\n`
  try { await writeFile(file, source, { mode: 0o600 }) }
  catch (error) { await rm(directory, { recursive: true, force: true }); throw error }
  return { url: pathToFileURL(file).href, close: () => rm(directory, { recursive: true, force: true }) }
}
