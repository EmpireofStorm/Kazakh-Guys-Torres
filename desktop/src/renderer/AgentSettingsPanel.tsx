import { useEffect, useState, type FormEvent } from 'react'
import type { AgentSettings, AgentSettingsInput } from '../shared/types'

export function AgentSettingsPanel() {
  const [saved, setSaved] = useState<AgentSettings | null>(null)
  const [form, setForm] = useState<AgentSettingsInput>({
    enabled: false,
    baseUrl: 'http://localhost:11434/v1',
    model: '',
    apiKey: ''
  })
  const [pending, setPending] = useState<'load' | 'save' | 'test' | null>('load')
  const [feedback, setFeedback] = useState<{ ok: boolean; message: string } | null>(null)
  const bridgeMissing = typeof window.sentinel === 'undefined'
  const endpointChanged = saved !== null &&
    form.baseUrl.trim().replace(/\/+$/, '') !== saved.baseUrl.replace(/\/+$/, '')

  useEffect(() => {
    if (!window.sentinel) return
    let mounted = true
    void window.sentinel.getAgentSettings().then((settings) => {
      if (!mounted) return
      setSaved(settings)
      setForm({ enabled: settings.enabled, baseUrl: settings.baseUrl, model: settings.model, apiKey: '' })
    }).catch(() => {
      if (mounted) setFeedback({ ok: false, message: 'Could not load agent settings.' })
    }).finally(() => {
      if (mounted) setPending(null)
    })
    return () => { mounted = false }
  }, [])

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const action = (event.nativeEvent as SubmitEvent).submitter?.getAttribute('value') === 'test'
      ? 'test' : 'save'
    setPending(action)
    setFeedback(null)
    try {
      if (action === 'test') {
        setFeedback(await window.sentinel.testAgentConnection(form))
      } else {
        const result = await window.sentinel.saveAgentSettings(form)
        if (result.ok) {
          setSaved(result.settings)
          setForm({
            enabled: result.settings.enabled,
            baseUrl: result.settings.baseUrl,
            model: result.settings.model,
            apiKey: ''
          })
        }
        setFeedback({
          ok: result.ok,
          message: result.ok
            ? `Settings saved. ${result.settings.enabled ? 'LangChain agent enabled.' : 'Local rules enabled.'}`
            : result.error || 'Could not save agent settings.'
        })
      }
    } catch {
      setFeedback({ ok: false, message: action === 'test' ? 'Connection test failed.' : 'Could not save agent settings.' })
    } finally {
      setPending(null)
    }
  }

  function update(patch: Partial<AgentSettingsInput>) {
    setForm((current) => ({ ...current, ...patch }))
    setFeedback(null)
  }

  return (
    <section className="panel agent-settings" aria-labelledby="agent-settings-title">
      <h2 id="agent-settings-title">Agent connection</h2>
      <p className="settings-help">
        Use a server with OpenAI-compatible chat completions and tool calling.
        During monitoring, the agent sends score summaries to this endpoint.
      </p>
      <p className="settings-help">
        Saved configuration: {saved ? saved.enabled ? `LangChain · ${saved.model}` : 'Local rules' : pending === 'load' && !bridgeMissing ? 'Loading…' : 'Unavailable'}
      </p>
      <form onSubmit={(event) => void submit(event)}>
        <fieldset disabled={pending !== null || bridgeMissing}>
          <label className="checkbox-field">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(event) => update({ enabled: event.target.checked })}
            />
            Enable LangChain agent
          </label>
          <div className="settings-grid">
            <label>
              Base URL
              <input
                type="url"
                required={form.enabled}
                value={form.baseUrl}
                placeholder="http://localhost:11434/v1"
                onChange={(event) => update({ baseUrl: event.target.value })}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <label>
              Model ID
              <input
                required={form.enabled}
                value={form.model}
                placeholder="Your server's model ID"
                onChange={(event) => update({ model: event.target.value })}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <label>
              API key, optional
              <input
                type="password"
                value={form.apiKey || ''}
                disabled={form.clearApiKey}
                placeholder={saved?.hasApiKey && !endpointChanged ? 'Saved key retained if blank' : 'Leave blank if no key is required'}
                onChange={(event) => update({ apiKey: event.target.value })}
                autoComplete="new-password"
                aria-describedby="api-key-help"
              />
            </label>
          </div>
          <p id="api-key-help" className="settings-help">
            {endpointChanged && saved?.hasApiKey
              ? 'The endpoint changed. The saved key will be cleared unless you enter a replacement.'
              : 'A blank key keeps the saved key only when the endpoint stays the same.'}
          </p>
          {saved?.hasApiKey && (
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={form.clearApiKey || false}
                onChange={(event) => update({ clearApiKey: event.target.checked, apiKey: '' })}
              />
              Remove saved API key
            </label>
          )}
          <div className="actions">
            <button className="primary" type="submit" value="save">Save settings</button>
            <button className="ghost" type="submit" value="test" disabled={!form.model.trim()}>
              Test connection
            </button>
          </div>
        </fieldset>
      </form>
      <p className="settings-help">Test connection uses a small tool call. It does not save settings or send meeting media.</p>
      <p className={feedback?.ok === false ? 'error' : 'settings-feedback'} role="status" aria-live="polite">
        {pending === 'save' ? 'Saving settings…' : pending === 'test' ? 'Testing tool calling…' : feedback?.message}
      </p>
    </section>
  )
}
