import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { ChatAnalysis, ChatAttachment, ChatState } from '../shared/types'

export function ChatPanel({ active, onOpenConnection }: { active: boolean; onOpenConnection: () => void }) {
  const [chat, setChat] = useState<ChatState | null>(null)
  const [draft, setDraft] = useState('')
  const [attachments, setAttachments] = useState<ChatAttachment[]>([])
  const [pending, setPending] = useState<'conversation' | 'attachment' | 'send' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const transcript = useRef<HTMLDivElement>(null)
  const composer = useRef<HTMLTextAreaElement>(null)
  const followOutput = useRef(true)
  const operationVersion = useRef(0)
  const bridgeMissing = !window.sentinel?.getChatState
  const conversation = chat?.activeConversation
  const working = Boolean(chat?.busy || pending === 'send')

  useEffect(() => {
    if (!active || bridgeMissing) return
    let mounted = true
    let receivedUpdate = false
    const unsubscribe = window.sentinel.onChatState((next) => {
      receivedUpdate = true
      if (mounted) setChat(next)
    })
    void window.sentinel.getChatState().then((next) => {
      if (mounted && !receivedUpdate) setChat(next)
    }).catch(() => {
      if (mounted) setError('Could not load conversations. Restart SENTINEL and try again.')
    })
    return () => { mounted = false; unsubscribe() }
  }, [active, bridgeMissing])

  useEffect(() => {
    setDraft('')
    setAttachments([])
    followOutput.current = true
  }, [conversation?.id])

  useEffect(() => {
    if (active && followOutput.current && transcript.current) {
      transcript.current.scrollTop = transcript.current.scrollHeight
    }
  }, [active, conversation?.id, conversation?.messages])

  async function changeConversation(id?: string) {
    const version = ++operationVersion.current
    setPending('conversation')
    setError(null)
    try {
      const next = id ? await window.sentinel.selectChat(id) : await window.sentinel.newChat()
      if (version === operationVersion.current) setChat(next)
    } catch (reason) {
      if (version === operationVersion.current) setError(reason instanceof Error ? reason.message : 'Could not open the conversation.')
    } finally {
      if (version === operationVersion.current) setPending(null)
    }
  }

  async function attach() {
    setPending('attachment')
    setError(null)
    try {
      const selected = await window.sentinel.addChatAttachments()
      setAttachments((current) => [...current, ...selected.filter((file) => !current.some((item) => item.id === file.id))])
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not attach the selected file.')
    } finally {
      setPending(null)
    }
  }

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!chat?.configured || working || pending || attachments.length > 3 || (!draft.trim() && attachments.length === 0)) return
    const version = ++operationVersion.current
    const content = draft.trim() || 'Analyze the attached media. Check video and voice separately, then explain what the evidence supports.'
    const selected = attachments
    setDraft('')
    setAttachments([])
    setPending('send')
    setError(null)
    followOutput.current = true
    try {
      const next = await window.sentinel.sendChatMessage({ content, attachmentIds: selected.map((item) => item.id) })
      if (version === operationVersion.current) setChat(next)
    } catch (reason) {
      if (version === operationVersion.current) {
        setDraft(content)
        setAttachments(selected)
        setError(reason instanceof Error ? reason.message : 'The message could not be sent.')
      }
    } finally {
      if (version === operationVersion.current) {
        setPending(null)
        composer.current?.focus()
      }
    }
  }

  async function stop() {
    const version = ++operationVersion.current
    setError(null)
    try {
      const next = await window.sentinel.cancelChat()
      if (version === operationVersion.current) setChat(next)
    } catch {
      if (version === operationVersion.current) setError('Could not stop the investigation. Wait for the current request to finish.')
    } finally {
      if (version === operationVersion.current) setPending(null)
    }
  }

  return (
    <section className="chat-workspace" aria-label="SENTINEL agent chat">
      <aside className="chat-sidebar" aria-label="Conversation history">
        <button className="new-chat-button" disabled={bridgeMissing || !chat || working || pending !== null} onClick={() => void changeConversation()}>
          <span aria-hidden="true">＋</span> New conversation
        </button>
        <div className="conversation-history">
          <p className="sidebar-label">Conversations</p>
          {chat?.conversations.map((item) => (
            <button key={item.id} className={`conversation-item ${item.id === conversation?.id ? 'selected' : ''}`}
              aria-current={item.id === conversation?.id ? 'true' : undefined}
              disabled={working || pending !== null} onClick={() => void changeConversation(item.id)} title={item.title}>
              <span>{item.title || 'New conversation'}</span>
              <time dateTime={new Date(item.updatedAt).toISOString()}>{new Date(item.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</time>
            </button>
          ))}
          {!chat && <p className="sidebar-note">{bridgeMissing ? 'Open in the desktop app.' : 'Loading history…'}</p>}
        </div>
        <div className="sidebar-footer">
          <span className="local-history-dot" aria-hidden="true" />
          <span>History saved on this computer</span>
        </div>
      </aside>

      <div className="chat-main">
        <header className="chat-header">
          <div className="chat-heading">
            <h2>{conversation?.title || 'New conversation'}</h2>
            <p>{working ? 'Investigation in progress' : 'Media checks with visible tool activity'}</p>
          </div>
          <button className="model-switcher" onClick={onOpenConnection} title="Change the model and compatible endpoint">
            <span>{chat?.model || 'Connect a model'}</span>
            <small>{chat?.configured ? 'Agent connection' : 'Choose an endpoint'}</small>
            <span className="model-chevron" aria-hidden="true">⌄</span>
          </button>
        </header>

        <div className="chat-transcript" ref={transcript} role="log" aria-label="Conversation messages" aria-live="polite" aria-relevant="additions"
          onScroll={() => {
            const element = transcript.current
            if (element) followOutput.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80
          }}>
          {conversation?.messages.length === 0 && (
            <div className="chat-empty">
              <div className="chat-empty-mark" aria-hidden="true">S</div>
              <p className="eyebrow">SENTINEL agent</p>
              <h3>Investigate a video or voice clip.</h3>
              <p>Attach media and ask a question. Follow the checks the agent chooses and see the evidence behind its answer.</p>
              <div className="chat-starters">
                <button disabled={pending !== null || attachments.length >= 3} onClick={() => void attach()}>
                  <strong>Attach a clip <span aria-hidden="true">↗</span></strong>
                  <span>Check video and voice with real detectors</span>
                </button>
                <button onClick={() => { setDraft('Check which detectors are ready to analyze my media.'); composer.current?.focus() }}>
                  <strong>Check detector readiness <span aria-hidden="true">↗</span></strong>
                  <span>Ask the agent to inspect the available models</span>
                </button>
              </div>
            </div>
          )}

          {conversation?.messages.map((message) => (
            <article key={message.id} className={`chat-message ${message.role}`} aria-label={message.role === 'user' ? 'Your message' : 'SENTINEL response'}>
              <div className="message-author">
                {message.role === 'assistant' && <span className="assistant-mark" aria-hidden="true">S</span>}
                <span>{message.role === 'user' ? 'You' : 'SENTINEL'}</span>
                {message.status === 'cancelled' && <span className="message-status">Stopped</span>}
                {message.status === 'error' && <span className="message-status error">Interrupted</span>}
              </div>
              {message.attachmentIds.length > 0 && (
                <div className="message-attachments">
                  {message.attachmentIds.map((id) => {
                    const file = conversation.attachments.find((item) => item.id === id)
                    return <span className="attachment-chip" key={id}><span aria-hidden="true">↳</span> {file?.name || 'Attached media'}</span>
                  })}
                </div>
              )}
              {message.tools.length > 0 && (
                <div className="tool-cards" aria-label="Executed agent tools">
                  {message.tools.map((tool) => (
                    <details className={`tool-card ${tool.status}`} key={tool.id}>
                      <summary>
                        <span className={`tool-status-dot ${tool.status}`} aria-hidden="true" />
                        <span className="tool-name">{tool.name.replace(/_/g, ' ')}</span>
                        <span className="tool-status-label">{tool.status === 'running' ? 'Running' : tool.status === 'complete' ? 'Complete' : 'Failed'}</span>
                      </summary>
                      <p>{tool.summary || (tool.status === 'running' ? 'Waiting for this check to finish.' : 'No additional details.')}</p>
                    </details>
                  ))}
                </div>
              )}
              {message.analyses.map((analysis, index) => <AnalysisCard key={`${analysis.attachmentId}:${index}`} analysis={analysis} />)}
              {message.content && <div className="message-content">{message.content}</div>}
              {message.status === 'streaming' && !message.content && <p className="agent-working" role="status">{message.tools.some((tool) => tool.status === 'running') ? 'Collecting evidence…' : 'Working on your request…'}</p>}
            </article>
          ))}
        </div>

        <div className="chat-composer-area">
          {(error || chat?.error || bridgeMissing) && <p className="chat-error" role="alert">{error || chat?.error || 'Launch SENTINEL in Electron to use agent chat.'}</p>}
          {attachments.length > 3 && <p className="chat-error" role="alert">Up to three files can be sent in one message. Remove an attachment to continue.</p>}
          {chat && !chat.configured && <p className="connection-prompt">Choose your compatible model endpoint to start. <button onClick={onOpenConnection}>Open connection settings</button></p>}
          <form className="chat-composer" onSubmit={(event) => void send(event)}>
            {attachments.length > 0 && (
              <div className="pending-attachments" aria-label="Attachments for this message">
                {attachments.map((file) => (
                  <span className="attachment-chip" key={file.id} title={`${file.name} · ${(file.size / 1024 / 1024).toFixed(1)} MB`}>
                    <span className="attachment-name">{file.name}</span>
                    <button type="button" disabled={working} aria-label={`Remove ${file.name} from this message`} onClick={() => setAttachments((current) => current.filter((item) => item.id !== file.id))}>×</button>
                  </span>
                ))}
              </div>
            )}
            <label className="sr-only" htmlFor="chat-message">Message SENTINEL</label>
            <textarea id="chat-message" ref={composer} value={draft} rows={3} maxLength={8000}
              disabled={bridgeMissing || !chat || working || pending === 'conversation'}
              placeholder="Ask SENTINEL to investigate a clip, compare evidence, or explain a result…"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  event.currentTarget.form?.requestSubmit()
                }
              }} />
            <div className="composer-actions">
              <button className="attach-button" type="button" disabled={bridgeMissing || !chat || working || pending !== null || attachments.length >= 3} onClick={() => void attach()}>
                <span aria-hidden="true">＋</span> {pending === 'attachment' ? 'Choosing files…' : 'Attach media'}
              </button>
              <span className="composer-hint">Shift + Enter for a new line</span>
              {working
                ? <button className="stop-chat-button" type="button" onClick={() => void stop()}><span aria-hidden="true">■</span> Stop</button>
                : <button className="send-chat-button" type="submit" disabled={!chat?.configured || pending !== null || attachments.length > 3 || (!draft.trim() && attachments.length === 0)}>Send <span aria-hidden="true">↑</span></button>}
            </div>
          </form>
          <p className="chat-privacy-note">Chat text, filenames and score summaries use your selected model endpoint. Media goes only to the detector service.</p>
        </div>
      </div>
    </section>
  )
}

function AnalysisCard({ analysis }: { analysis: ChatAnalysis }) {
  const [combined, setCombined] = useState<number | null>(null)
  const result = analysis.result
  return (
    <section className="chat-analysis" aria-label={`Detector results for ${analysis.fileName}`}>
      <header><strong>{result.additionalEvidence ? 'Additional evidence' : 'Detector results'}</strong><span title={analysis.fileName}>{analysis.fileName}</span></header>
      <div className="analysis-scores">
        {([['Video', result.videoRisk], ['Voice', result.voiceRisk]] as const).map(([label, score]) => (
          <div key={label}>
            <span>{label} risk score</span>
            <strong>{score === null ? 'Unavailable' : score.toFixed(3)}</strong>
            <div className="risk-track" aria-hidden="true"><span className={score !== null && score > .75 ? 'high' : score !== null && score >= .3 ? 'medium' : ''} style={{ width: `${(score ?? 0) * 100}%` }} /></div>
          </div>
        ))}
      </div>
      <p className="analysis-detail">{result.facesFound}/{result.framesSampled} face samples · {result.voiceSeconds === null ? 'Voice unavailable' : `${result.voiceSeconds.toFixed(1)}s voice from ${(result.voiceStartSeconds ?? 0).toFixed(1)}s`}</p>
      {result.errors.video && <p className="analysis-detail">Video: {result.errors.video}</p>}
      {result.errors.audio && <p className="analysis-detail">Voice: {result.errors.audio}</p>}
      <div className="analysis-combine">
        <button type="button" disabled={result.videoRisk === null || result.voiceRisk === null} onClick={() => {
          if (result.videoRisk !== null && result.voiceRisk !== null) setCombined(1 - (1 - result.videoRisk) * (1 - result.voiceRisk))
        }}>Combine scores</button>
        {combined !== null && <span role="status">{combined.toFixed(3)} · {combined > .75 ? 'High' : combined >= .3 ? 'Medium' : 'Low'} tier</span>}
      </div>
      <p className="analysis-caveat">Uncalibrated model scores. Combined only on request using noisy-OR; low scores do not prove authenticity.</p>
    </section>
  )
}
