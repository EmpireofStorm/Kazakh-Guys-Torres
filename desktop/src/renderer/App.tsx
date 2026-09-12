import { useEffect, useMemo, useRef, useState } from 'react'
import type { CaptureSource, DemoClip, DemoScenario, SentinelUiState } from '../shared/types'
import { FrameSampler } from './capture/frameSampler'
import { AgentSettingsPanel } from './AgentSettingsPanel'

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
  agentActivity: [],
  agentBusy: false,
  demoScenario: 'synthetic'
}

export function App() {
  const [state, setState] = useState<SentinelUiState>(idleState)
  const [sources, setSources] = useState<CaptureSource[] | null>(null)
  const [clips, setClips] = useState<DemoClip[]>([])
  const [busy, setBusy] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const samplerRef = useRef<FrameSampler | null>(null)
  const fpsRef = useRef(state.framesPerSecond)
  const stateRef = useRef(state)
  const clipsRef = useRef(clips)
  fpsRef.current = state.framesPerSecond
  stateRef.current = state
  clipsRef.current = clips

  useEffect(() => {
    if (!window.sentinel) return
    void window.sentinel.getState().then(setState)
    void window.sentinel.listDemoClips().then(setClips).catch(() => setClips([]))
    return window.sentinel.onState(setState)
  }, [])

  useEffect(() => {
    if (!window.sentinel?.onDemoHotkey) return
    return window.sentinel.onDemoHotkey((scenario) => {
      void runHiddenProfile(scenario)
    })
  }, [])

  useEffect(() => {
    return () => {
      stopCaptureTracks()
    }
  }, [])

  const riskLabel = useMemo(() => formatRisk(state), [state])

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
      await startPreview(source.id)
      await window.sentinel.startMonitoring(source.id, source.name, 'live')
      setSources(null)
      startSampler()
    } catch (error) {
      stopCaptureTracks()
      setLocalError(error instanceof Error ? error.message : 'Could not start capture')
    } finally {
      setBusy(false)
    }
  }

  async function playHiddenClip(clip: DemoClip, scenario: DemoScenario) {
    const video = videoRef.current
    if (!video) throw new Error('Preview is not ready')
    stopCaptureTracks()
    setSources(null)
    video.loop = true
    video.srcObject = null
    video.src = clip.url
    await video.play()
    await window.sentinel.startMonitoring(`clip:${clip.id}`, 'Primary participant', scenario)
    startSampler()
  }

  async function runHiddenProfile(scenario: DemoScenario) {
    setBusy(true)
    setLocalError(null)
    try {
      const current = stateRef.current
      const liveCapture =
        current.phase === 'MONITORING' &&
        current.selectedSource &&
        !current.selectedSource.id.startsWith('clip:') &&
        !current.selectedSource.id.startsWith('scripted:')

      if (liveCapture && current.selectedSource) {
        await window.sentinel.startMonitoring(
          current.selectedSource.id,
          current.selectedSource.name,
          scenario
        )
        startSampler()
        return
      }

      const clip = pickPresenterClip(clipsRef.current)
      if (clip) {
        await playHiddenClip(clip, scenario)
        return
      }

      stopCaptureTracks()
      await window.sentinel.startScriptedDemo(scenario)
    } catch (error) {
      setLocalError(error instanceof Error ? error.message : 'Could not start session')
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
      videoRef.current.removeAttribute('src')
      videoRef.current.srcObject = stream
      await videoRef.current.play()
    }
  }

  function stopCaptureTracks() {
    samplerRef.current?.stop()
    samplerRef.current = null
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
    if (videoRef.current) {
      videoRef.current.pause()
      videoRef.current.srcObject = null
      videoRef.current.removeAttribute('src')
      videoRef.current.load()
    }
  }

  const monitoring = state.phase === 'MONITORING'
  const bridgeMissing = typeof window.sentinel === 'undefined'

  return (
    <div className="shell">
      <header className="hero">
        <div className="brand-mark">S</div>
        <div>
          <p className="eyebrow">Endpoint protection</p>
          <h1>SENTINEL</h1>
          <p className="tagline">Real-time media authenticity for video meetings</p>
        </div>
      </header>

      <section className="panel">
        <div className="actions">
          {!monitoring && (
            <button className="primary" disabled={busy} onClick={() => void openPicker()}>
              Select Meeting Window
            </button>
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
            : 'Choose a meeting window to begin consented capture.'}
        </p>

        {sources && (
          <div className="source-grid" role="list">
            {sources.map((source) => (
              <button
                key={source.id}
                className="source-card"
                onClick={() => void chooseSource(source)}
                disabled={busy}
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
          {!monitoring && <div className="preview-empty">Waiting for meeting source</div>}
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
            <dt>Samples</dt>
            <dd>{state.samplesAnalyzed}</dd>
          </div>
          <div>
            <dt>Sampling</dt>
            <dd>{state.framesPerSecond.toFixed(1)} FPS</dd>
          </div>
          <div>
            <dt>Agent</dt>
            <dd>
              {state.agentMode === 'langchain' ? 'LangChain' : 'Investigation'}
              {state.agentBusy ? ' · investigating' : ''}
            </dd>
          </div>
        </dl>

        <section className="agent-activity" aria-labelledby="agent-activity-title">
          <h2 id="agent-activity-title">Agent activity</h2>
          <p className="settings-help" role="status" aria-live="polite">
            {state.agentBusy
              ? 'Investigation in progress…'
              : monitoring
                ? 'Watching for new evidence.'
                : 'Start monitoring to begin.'}
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
            10s window · {state.evidence.validFaceFrames}/{state.evidence.sampleCount} faces · mean{' '}
            {state.evidence.scores.mean.toFixed(2)} · σ {state.evidence.scores.stdDev.toFixed(2)} ·{' '}
            {state.evidence.trend}
          </p>
        )}

        {bridgeMissing && (
          <p className="error">Launch SENTINEL with npm run dev inside desktop/.</p>
        )}
        {(localError || state.errorMessage) && (
          <p className="error">{localError || state.errorMessage}</p>
        )}
      </section>
      <AgentSettingsPanel />
    </div>
  )
}

function pickPresenterClip(clips: DemoClip[]): DemoClip | undefined {
  return (
    clips.find((clip) => clip.id.includes('vasa1_synthetic_speaker_09')) ??
    clips.find((clip) => clip.id.includes('vasa1')) ??
    clips[0]
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
