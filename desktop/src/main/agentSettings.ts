import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import type { CompatibleAgentConfig } from '../agent/langchainAgent'
import type { AgentSettings, AgentSettingsResult } from '../shared/types'

const settingsSchema = z.object({
  enabled: z.boolean(),
  baseUrl: z.string().trim().max(2048),
  model: z.string().trim().max(256),
  apiKey: z.string().trim().max(4096).refine((key) => !/[\r\n]/.test(key)).optional(),
  clearApiKey: z.boolean().optional()
})

interface SecretStorage {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

interface SavedConfig extends CompatibleAgentConfig {
  enabled: boolean
}

function normalizeBaseUrl(value: string): string {
  if (!value) return ''
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Enter a valid HTTP or HTTPS API base URL.')
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('Use an HTTP or HTTPS base URL without credentials, query parameters, or a fragment.')
  }
  if (url.pathname.replace(/\/+$/, '').endsWith('/chat/completions')) {
    throw new Error('Enter the API base URL, such as http://localhost:11434/v1, without /chat/completions.')
  }
  return url.href.replace(/\/+$/, '')
}

/** Keys stay in the main process and are encrypted with Electron safeStorage on disk. */
export class AgentSettingsStore {
  private config: SavedConfig = { enabled: false, baseUrl: '', model: '', apiKey: '' }
  readonly loadError: string | null

  constructor(
    private readonly path: string,
    private readonly secrets: SecretStorage,
    env: NodeJS.ProcessEnv = process.env
  ) {
    let loadError: string | null = null
    try {
      if (existsSync(path)) {
        const saved = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
        const parsed = settingsSchema.parse(saved)
        const baseUrl = normalizeBaseUrl(parsed.baseUrl)
        let apiKey = ''
        if (saved.encryptedApiKey) {
          if (typeof saved.encryptedApiKey !== 'string' || !secrets.isEncryptionAvailable()) {
            throw new Error('Credential storage unavailable')
          }
          apiKey = secrets.decryptString(Buffer.from(saved.encryptedApiKey, 'base64'))
        }
        this.config = { enabled: parsed.enabled && !!baseUrl && !!parsed.model, baseUrl, model: parsed.model, apiKey }
      } else {
        // An API key alone must never activate an implicit provider endpoint.
        const useSentinelNames = !!env.SENTINEL_LLM_BASE_URL?.trim()
        const baseUrl = normalizeBaseUrl((useSentinelNames ? env.SENTINEL_LLM_BASE_URL : env.OPENAI_BASE_URL)?.trim() || '')
        const model = (useSentinelNames ? env.SENTINEL_LLM_MODEL : env.OPENAI_MODEL)?.trim() || ''
        this.config = {
          enabled: !!baseUrl && !!model,
          baseUrl,
          model,
          apiKey: baseUrl ? (useSentinelNames ? env.SENTINEL_LLM_API_KEY : env.OPENAI_API_KEY)?.trim() || '' : ''
        }
      }
    } catch {
      loadError = 'Agent settings could not be loaded. Configure the endpoint and key again in Agent settings.'
    }
    this.loadError = loadError
  }

  getPublic(): AgentSettings {
    const { enabled, baseUrl, model, apiKey } = this.config
    return { enabled, baseUrl, model, hasApiKey: !!apiKey }
  }

  getConfig(): CompatibleAgentConfig | null {
    if (!this.config.enabled) return null
    const { baseUrl, model, apiKey } = this.config
    return { baseUrl, model, apiKey }
  }

  preview(raw: unknown): SavedConfig {
    const parsed = settingsSchema.safeParse(raw)
    if (!parsed.success) throw new Error('Check the endpoint, model, and API key fields.')
    const input = parsed.data
    const baseUrl = normalizeBaseUrl(input.baseUrl)
    if (input.enabled && (!baseUrl || !input.model)) {
      throw new Error('Enter both an API base URL and model ID to enable the agent.')
    }
    const apiKey = input.clearApiKey
      ? ''
      : input.apiKey || (baseUrl === this.config.baseUrl ? this.config.apiKey : '')
    return { enabled: input.enabled, baseUrl, model: input.model, apiKey }
  }

  save(raw: unknown): AgentSettingsResult {
    let next: SavedConfig
    try {
      next = this.preview(raw)
    } catch (error) {
      return { ok: false, settings: this.getPublic(), error: (error as Error).message }
    }
    if (next.apiKey && !this.secrets.isEncryptionAvailable()) {
      return { ok: false, settings: this.getPublic(), error: 'OS credential encryption is unavailable. Settings with an API key could not be saved.' }
    }
    try {
      const { apiKey, ...publicFields } = next
      const saved = {
        ...publicFields,
        encryptedApiKey: apiKey ? this.secrets.encryptString(apiKey).toString('base64') : undefined
      }
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
      const temporary = `${this.path}.tmp`
      writeFileSync(temporary, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 })
      chmodSync(temporary, 0o600)
      renameSync(temporary, this.path)
      this.config = next
      return { ok: true, settings: this.getPublic() }
    } catch {
      return { ok: false, settings: this.getPublic(), error: 'Agent settings could not be saved to this device.' }
    }
  }
}
