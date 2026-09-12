import { useEffect, useMemo, useRef, useState } from 'react'
import type { CaptureSource, DetectorHealth, DetectorMode, SentinelUiState } from '../shared/types'
import { FrameSampler } from './capture/frameSampler'
import { AgentSettingsPanel } from './AgentSettingsPanel'
import { MediaAnalysisPanel } from './MediaAnalysisPanel'
import { ChatPanel } from './ChatPanel'

const idleState: SentinelUiState = {
  phase: 'IDLE',
  displayState: 'IDLE',
  assessment: null,
  samplingMode: 'NORMAL',
  framesPerSecond: 1.5,
  samplesAnalyzed: 0,
  selectedSource: null,
  evidence: null,
  errorMessage: null,
  overlayExpanded: false,
  agentMode: 'fallback',
  detectorMode: 'real',
  agentActivity: [],
  agentBusy: false
}

export function App() {
  const [view, setView] = useState<'chat' | 'live' | 'connection'>('chat')
  const [state, setState] = useState<SentinelUiState>(idleState)
  const [sources, setSources] = useState<CaptureSource[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [mediaBusy, setMediaBusy] = useState(false)
  const [health, setHealth] = useState<DetectorHealth | null>(null)
  const [checkingHealth, setCheckingHealth] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const samplerRef = useRef<FrameSampler | null>(null)
  const fpsRef = useRef(state.framesPerSecond)
  fpsRef.current = state.framesPerSecond

  useEffect(() => {
    if (!window.sentinel) return
    void window.sentinel.getState().then(setState)
    void checkHealth()
    return window.sentinel.onState(setState)
  }, [])

  useEffect(() => {
    if (state.overlayExpanded) setView('live')
  }, [state.overlayExpanded])

  useEffect(() => {
    return () => {
      stopCaptureTracks()
    }
  }, [])

  const riskLabel = useMemo(() => formatRisk(state), [state])

  async function checkHealth() {
    setCheckingHealth(true)
    try {
      const next = await window.sentinel.checkDetectorHealth()
      setHealth(next)
      return next
    } catch {
      const next: DetectorHealth = { reachable: false, videoReady: false, voiceReady: false, message: 'Could not reach the real detector service.' }
      setHealth(next)
      return next
    } finally {
      setCheckingHealth(false)
    }
  }

  async function changeDetector(mode: DetectorMode) {
    setBusy(true)
    setLocalError(null)
    try {
      setState(await window.sentinel.setDetectorMode(mode))
      setSources(null)
      if (mode === 'real') await checkHealth()
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : 'Could not change detector mode')
    } finally {
      setBusy(false)
    }
  }

  async function openPicker() {
    setBusy(true)
    setLocalError(null)
    try {
      const list = await window.sentinel.listSources()
      setSources(list)
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : 'Could not list windows')
    } finally {
      setBusy(false)
    }
  }

  async function chooseSource(source: CaptureSource) {
    setBusy(true)
    setLocalError(null)
    try {
      if (state.detectorMode === 'real') {
        const status = await checkHealth()
        if (!status.videoReady) throw new Error(status.message)
      }
      await startPreview(source.id)
      await window.sentinel.startMonitoring(source.id, source.name)
      setSources(null)
      startSampler()
    } catch (error) {
      stopCaptureTracks()
      setLocalError(error instanceof Error ? error.message : 'Could not start capture')
    } finally {
      setBusy(false)
    }
  }

  async function runScriptedDemo() {
    setBusy(true)
    setLocalError(null)
    try {
      stopCaptureTracks()
      setSources(null)
      await window.sentinel.startScriptedDemo()
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : 'Could not start scripted demo')
    } finally {
      setBusy(false)
    }
  }

  async function stopMonitoring() {
    samplerRef.current?.stop()
    samplerRef.current = null
    stopCaptureTracks()
    await window.sentinel.stopMonitoring()
    setSources(null)
  }

  function startSampler() {
    const video = videoRef.current
    if (!video) return
    samplerRef.current?.stop()
    const sampler = new FrameSampler(video, async (jpegBase64, capturedAt) => {
      await window.sentinel.analyzeFrame(jpegBase64, capturedAt)
    })
    samplerRef.current = sampler
    sampler.start(() => fpsRef.current)
  }

  async function startPreview(sourceId: string) {
    stopCaptureTracks()
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: sourceId,
          maxWidth: 1280,
          maxHeight: 720,
          maxFrameRate: 10
        }
      } as unknown as MediaTrackConstraints
    })
    streamRef.current = stream
    if (videoRef.current) {
      videoRef.current.srcObject = stream
      await videoRef.current.play()
    }
  }

  function stopCaptureTracks() {
    samplerRef.current?.stop()
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    if (videoRef.current) videoRef.current.srcObject = null
  }

  const monitoring = state.phase === 'MONITORING'
  const bridgeMissing = typeof window.sentinel === 'undefined'

  return (
    <div className="shell app-shell">
      <header className="hero app-header">
        <div className="brand-mark">S</div>
        <div>
          <h1>SENTINEL</h1>
          <p className="tagline">Media authenticity workspace</p>
        </div>
        <nav className="workspace-nav" aria-label="Workspace views">
          <button aria-pressed={view === 'chat'} onClick={() => setView('chat')}>Chat</button>
          <button aria-pressed={view === 'live'} onClick={() => setView('live')}>
            {monitoring && <span className="nav-live-dot" aria-hidden="true" />}Live monitor
          </button>
          <button aria-pressed={view === 'connection'} onClick={() => setView('connection')}>Connection</button>
        </nav>
      </header>

      <div hidden={view !== 'chat'}>
        <ChatPanel active={view === 'chat'} onOpenConnection={() => setView('connection')} />
      </div>
      <div hidden={view !== 'live'}>
      <section className="panel">
        <div className="detector-controls">
          <label htmlFor="detector-mode">Meeting detector</label>
          <select id="detector-mode" value={state.detectorMode} disabled={monitoring || busy || mediaBusy || bridgeMissing}
            onChange={(event) => void changeDetector(event.target.value as DetectorMode)}>
            <option value="real">Real detector · UCF</option>
            <option value="demo">Demo · simulated scores</option>
          </select>
          <button className="ghost" disabled={checkingHealth || bridgeMissing} onClick={() => void checkHealth()}>
            {checkingHealth ? 'Checking…' : 'Check detector service'}
          </button>
        </div>
        {health && <p className="settings-help" role="status">{health.message}</p>}
        <div className="actions">
          {!monitoring && (
            <>
              <button className="primary" disabled={busy || mediaBusy || bridgeMissing} onClick={() => void openPicker()}>
                Select Meeting Window
              </button>
              <button className="ghost" disabled={busy || mediaBusy || bridgeMissing} onClick={() => void runScriptedDemo()}>
                Run scripted demo
              </button>
            </>
          )}
          {monitoring && (
            <button className="danger" onClick={() => void stopMonitoring()}>
              Stop Monitoring
            </button>
          )}
        </div>

        <p className="monitoring-line">
          {monitoring && state.selectedSource
            ? `Monitoring: ${state.selectedSource.name}`
            : 'No meeting window selected. Capture starts only after you choose a source.'}
        </p>

        {sources && (
          <div className="source-grid" role="list">
            {sources.map((source) => (
              <button
                key={source.id}
                className="source-card"
                onClick={() => void chooseSource(source)}
                disabled={busy || mediaBusy}
              >
                <img src={source.thumbnail} alt="" />
                <span>{source.name}</span>
                <em>{source.sourceType}</em>
              </button>
            ))}
          </div>
        )}

        <div className="preview-frame">
          <video ref={videoRef} className="preview" muted playsInline />
          {!monitoring && <div className="preview-empty">Captured preview</div>}
        </div>

        <dl className="stats">
          <div>
            <dt>Status</dt>
            <dd>
              <span className={`dot ${state.displayState.toLowerCase()}`} />
              {statusText(state)}
            </dd>
          </div>
          <div>
            <dt>Risk</dt>
            <dd>{riskLabel}</dd>
          </div>
          <div>
            <dt>Samples analyzed</dt>
            <dd>{state.samplesAnalyzed}</dd>
          </div>
          <div>
            <dt>Sampling</dt>
            <dd>
              {state.framesPerSecond.toFixed(1)} FPS
              {state.samplingMode === 'INTENSIVE' ? ' · intensive' : ''}
            </dd>
          </div>
          <div>
            <dt>Agent</dt>
            <dd>
              {state.agentMode === 'langchain' ? 'LangChain agent' : 'Local rules'}
              {state.agentBusy ? ' · investigating' : ''}
            </dd>
          </div>
        </dl>

        <p className="settings-help">{state.detectorMode === 'demo'
          ? 'Demo mode: scores are simulated and do not analyze the captured pixels.'
          : 'Real UCF video scores · largest visible face. Meeting audio is not captured; use a saved file to check voice.'}</p>

        <section className="agent-activity" aria-labelledby="agent-activity-title">
          <h2 id="agent-activity-title">Agent activity</h2>
          <p className="settings-help" role="status" aria-live="polite">
            {state.agentBusy ? 'Investigation in progress…' : monitoring ? 'Watching for new evidence.' : 'Start monitoring to see agent actions.'}
          </p>
          {state.agentActivity.length > 0 && (
            <ol className="activity-log" aria-label="Recent agent actions">
              {state.agentActivity.slice(-8).map((event) => (
                <li key={event.id}>
                  <time dateTime={new Date(event.timestamp).toISOString()}>
                    {new Date(event.timestamp).toLocaleTimeString()}
                  </time>
                  <span>{event.message}</span>
                </li>
              ))}
            </ol>
          )}
        </section>

        {state.assessment && (
          <p className="explanation">{state.assessment.explanation}</p>
        )}

        {state.evidence?.scores && (
          <p className="evidence-line">
            Window {state.evidence.windowSeconds}s · faces {state.evidence.validFaceFrames}/
            {state.evidence.sampleCount} · mean {state.evidence.scores.mean.toFixed(2)} · σ{' '}
            {state.evidence.scores.stdDev.toFixed(2)} · {state.evidence.trend}
          </p>
        )}

        {bridgeMissing && (
          <p className="error">
            This page is the renderer only. Launch the desktop app with `npm run
            dev` inside `desktop/` so Electron preload/IPC is available.
          </p>
        )}
        {(localError || state.errorMessage) && (
          <p className="error">{localError || state.errorMessage}</p>
        )}
      </section>
      <MediaAnalysisPanel disabled={monitoring || busy} onBusyChange={setMediaBusy} />
      </div>
      <div hidden={view !== 'connection'}>
      <AgentSettingsPanel />
      </div>
    </div>
  )
}

function formatRisk(state: SentinelUiState): string {
  if (state.phase !== 'MONITORING' || !state.assessment) return '—'
  if (state.assessment.level === 'LOW_RISK') return 'LOW'
  if (state.assessment.level === 'UNCERTAIN') return 'VERIFYING'
  return 'HIGH'
}

function statusText(state: SentinelUiState): string {
  if (state.phase === 'MONITORING' && !state.assessment) return 'Gathering evidence'
  if (state.displayState === 'VERIFYING') return 'Verifying'
  if (state.displayState === 'HIGH_RISK') return 'High manipulation risk'
  if (state.displayState === 'LOW_RISK' || state.displayState === 'MONITORING') return 'Monitoring'
  if (state.displayState === 'SELECTING_SOURCE') return 'Select a window'
  if (state.displayState === 'ERROR') return 'Error'
  return 'Idle'
}
