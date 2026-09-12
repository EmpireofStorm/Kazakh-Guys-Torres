import { useEffect, useMemo, useRef, useState } from 'react'
import type { CaptureSource, SentinelUiState } from '../shared/types'
import { FrameSampler } from './capture/frameSampler'

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
  overlayExpanded: false
}

export function App() {
  const [state, setState] = useState<SentinelUiState>(idleState)
  const [sources, setSources] = useState<CaptureSource[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const samplerRef = useRef<FrameSampler | null>(null)
  const fpsRef = useRef(state.framesPerSecond)
  fpsRef.current = state.framesPerSecond

  useEffect(() => {
    if (!window.sentinel) return
    void window.sentinel.getState().then(setState)
    return window.sentinel.onState(setState)
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
    <div className="shell">
      <header className="hero">
        <div className="brand-mark">S</div>
        <div>
          <p className="eyebrow">Desktop authenticity agent</p>
          <h1>SENTINEL</h1>
          <p className="tagline">Real-Time Media Authenticity</p>
        </div>
      </header>

      <section className="panel">
        <div className="actions">
          {!monitoring && (
            <>
              <button className="primary" disabled={busy} onClick={() => void openPicker()}>
                Select Meeting Window
              </button>
              <button className="ghost" disabled={busy} onClick={() => void runScriptedDemo()}>
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
        </dl>

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
  if (state.displayState === 'VERIFYING') return 'Verifying'
  if (state.displayState === 'HIGH_RISK') return 'High manipulation risk'
  if (state.displayState === 'LOW_RISK' || state.displayState === 'MONITORING') return 'Monitoring'
  if (state.displayState === 'SELECTING_SOURCE') return 'Select a window'
  if (state.displayState === 'ERROR') return 'Error'
  return 'Idle'
}
