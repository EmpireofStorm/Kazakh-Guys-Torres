import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { config as loadEnv } from 'dotenv'

/** Load repo-root `.env` into the main process. Never import this from the renderer. */
export function loadSentinelEnv(): string | null {
  const candidates = [
    join(process.cwd(), '.env'),
    join(process.cwd(), '..', '.env'),
    join(__dirname, '../../../.env'),
    join(__dirname, '../../.env')
  ]

  const seen = new Set<string>()
  for (const candidate of candidates) {
    const path = resolve(candidate)
    if (seen.has(path) || !existsSync(path)) continue
    seen.add(path)
    loadEnv({ path, override: true })
    return path
  }

  return null
}
