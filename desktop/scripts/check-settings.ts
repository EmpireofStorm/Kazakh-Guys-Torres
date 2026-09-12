import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentSettingsStore } from '../src/main/agentSettings'

const directory = mkdtempSync(join(tmpdir(), 'sentinel-settings-check-'))
const path = join(directory, 'settings.json')
// Test the persistence contract without requiring an OS keychain in this check.
const secrets = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from([...value].reverse().join('')),
  decryptString: (value: Buffer) => [...value.toString()].reverse().join('')
}

try {
  const store = new AgentSettingsStore(path, secrets, { OPENAI_API_KEY: 'must-not-be-used-without-an-explicit-url' })
  assert.equal(store.getConfig(), null)
  assert.equal(store.getPublic().hasApiKey, false)
  const isolated = new AgentSettingsStore(join(directory, 'env-isolation.json'), secrets, {
    SENTINEL_LLM_BASE_URL: 'http://localhost:11434/v1',
    SENTINEL_LLM_MODEL: 'local-tool-model',
    OPENAI_BASE_URL: 'https://unrelated-provider.example/v1',
    OPENAI_MODEL: 'unrelated-model',
    OPENAI_API_KEY: 'must-not-leak-to-local-provider'
  })
  assert.equal(isolated.getConfig()?.apiKey, '', 'A custom endpoint must not inherit a key from the legacy environment namespace')
  assert.equal(isolated.getConfig()?.model, 'local-tool-model')
  const missingModel = new AgentSettingsStore(join(directory, 'env-missing-model.json'), secrets, {
    SENTINEL_LLM_BASE_URL: 'http://localhost:11434/v1', OPENAI_MODEL: 'unrelated-model', OPENAI_API_KEY: 'unrelated-key'
  })
  assert.equal(missingModel.getConfig(), null, 'An explicit endpoint also requires its own model setting')
  const legacy = new AgentSettingsStore(join(directory, 'env-legacy.json'), secrets, {
    OPENAI_BASE_URL: 'http://localhost:1234/v1', OPENAI_MODEL: 'legacy-local', OPENAI_API_KEY: 'legacy-key'
  })
  assert.equal(legacy.getConfig()?.apiKey, 'legacy-key')
  const initial = { enabled: true, baseUrl: 'http://localhost:11434/v1/', model: 'local-tool-model', apiKey: 'provider-a-secret' }
  assert.equal(store.save(initial).ok, true)
  assert.equal(store.getPublic().baseUrl, 'http://localhost:11434/v1')
  assert.equal('apiKey' in store.getPublic(), false)
  assert.equal(readFileSync(path, 'utf8').includes(initial.apiKey), false)
  assert.equal(statSync(path).mode & 0o777, 0o600)
  const restored = new AgentSettingsStore(path, secrets, {})
  assert.equal(restored.getConfig()?.apiKey, initial.apiKey)
  assert.equal(restored.preview({ ...initial, apiKey: '' }).apiKey, initial.apiKey)
  const changed = { ...initial, baseUrl: 'https://different-provider.example/v1', apiKey: '' }
  assert.equal(restored.preview(changed).apiKey, '')
  assert.equal(restored.getConfig()?.apiKey, initial.apiKey, 'Testing an unsaved endpoint must not mutate settings')
  assert.equal(restored.save(changed).ok, true)
  assert.equal(restored.getPublic().hasApiKey, false)
  assert.equal(new AgentSettingsStore(path, secrets, { OPENAI_API_KEY: initial.apiKey }).getConfig()?.apiKey, '')
  assert.equal(restored.save({ ...changed, apiKey: 'new-key' }).ok, true)
  assert.equal(restored.save({ ...changed, clearApiKey: true }).settings.hasApiKey, false)
  for (const baseUrl of ['ftp://example.com', 'https://key:secret@example.com/v1', 'https://example.com/v1?key=secret', 'https://example.com/v1#secret', 'http://localhost/v1/chat/completions', 'not-a-url']) {
    assert.equal(restored.save({ ...initial, baseUrl }).ok, false)
  }
  assert.equal(restored.save({ ...initial, model: '' }).ok, false)
  assert.equal(restored.save({ ...initial, apiKey: 'bad\r\nheader' }).ok, false)
  const unavailable = new AgentSettingsStore(join(directory, 'unavailable.json'), { ...secrets, isEncryptionAvailable: () => false }, {})
  assert.equal(unavailable.save(initial).ok, false)
  assert.equal(unavailable.save({ ...initial, apiKey: '' }).ok, true, 'Keyless compatible endpoints must work')
  assert.equal(restored.save({ enabled: false, baseUrl: '', model: '' }).ok, true)
  assert.equal(restored.getConfig(), null)
  writeFileSync(path, '{corrupt')
  const corrupt = new AgentSettingsStore(path, secrets, {})
  assert.equal(corrupt.getConfig(), null)
  assert.ok(corrupt.loadError)
  console.log('Settings checks passed: persistence, masked keys, provider changes, validation, and keyless endpoints.')
} finally {
  rmSync(directory, { recursive: true, force: true })
}
