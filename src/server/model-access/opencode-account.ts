import { homedir } from 'node:os'
import type { ConnectionModel } from '../../shared/model-access'
import { startOpencodeServer, OpencodeLaunchError } from '../opencode-server'
import { cleanConnectionEnv } from './runtime'
import type { RuntimeEnv } from './legacy'
export { cleanOpencodeProblemDetail } from '../opencode-server'

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const positive = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined

/** Construct fresh objects: provider keys/options and arbitrary metadata never escape. */
export function whitelistOpencodeProviders(raw: unknown, configuredModel?: unknown): { accountModels: ConnectionModel[]; accountDefaultModel?: string } {
  const data = record(raw)
  const providers = Array.isArray(data.providers) ? data.providers.map(record) : []
  const accountModels: ConnectionModel[] = []
  for (const provider of providers) {
    if (typeof provider.id !== 'string') continue
    for (const [id, value] of Object.entries(record(provider.models))) {
      const model = record(value), limit = record(model.limit), capabilities = record(model.capabilities)
      const contextWindow = positive(limit.context), maxOutputTokens = positive(limit.output)
      const reasoning = typeof model.reasoning === 'boolean' ? model.reasoning : capabilities.reasoning
      const images = typeof model.attachment === 'boolean' ? model.attachment : record(capabilities.input).image
      accountModels.push({ id: `${provider.id}/${typeof model.id === 'string' ? model.id : id}`,
        label: `${typeof provider.name === 'string' ? provider.name : provider.id} / ${typeof model.name === 'string' ? model.name : id}`,
        ...(contextWindow ? { contextWindow } : {}), ...(maxOutputTokens ? { maxOutputTokens } : {}),
        ...(typeof reasoning === 'boolean' ? { supportsReasoning: reasoning } : {}),
        ...(typeof images === 'boolean' ? { supportsImages: images } : {}),
      })
    }
  }
  const first = providers.find(provider => typeof provider.id === 'string' && typeof record(data.default)[provider.id] === 'string')
  const fallback = first ? `${first.id}/${record(data.default)[first.id as string]}` : undefined
  return { accountModels, ...(typeof configuredModel === 'string' && configuredModel ? { accountDefaultModel: configuredModel } : fallback ? { accountDefaultModel: fallback } : {}) }
}

export type OpencodeAccountResult = ReturnType<typeof whitelistOpencodeProviders> & { problem?: 'account-config-invalid'; problemDetail?: string }
export async function probeOpencodeAccount(executable: string, env: RuntimeEnv): Promise<OpencodeAccountResult> {
  const signal = AbortSignal.timeout(8_000)
  let server: Awaited<ReturnType<typeof startOpencodeServer>> | undefined
  try {
    server = await startOpencodeServer({ executable, cwd: env.HOME || homedir(), env: cleanConnectionEnv(env), signal })
    const headers = { Authorization: server.authorization }
    const read = async (path: string) => {
      const response = await fetch(`${server!.url}${path}`, { headers, signal })
      if (!response.ok) throw new Error('OpenCode configuration unavailable')
      return response.json() as Promise<unknown>
    }
    const [providers, config] = await Promise.all([read('/config/providers'), read('/config')])
    return whitelistOpencodeProviders(providers, record(config).model)
  } catch (error) {
    return { accountModels: [], problem: 'account-config-invalid', problemDetail: error instanceof OpencodeLaunchError ? error.problemDetail : 'Unable to load OpenCode account configuration.' }
  } finally { await server?.close() }
}
