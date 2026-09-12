import { useRef, useState } from 'react'
import type { MediaAnalysisOutcome } from '../shared/types'

export function MediaAnalysisPanel({ disabled, onBusyChange }: { disabled: boolean; onBusyChange: (busy: boolean) => void }) {
  const [busy, setBusy] = useState(false)
  const [report, setReport] = useState<Extract<MediaAnalysisOutcome, { status: 'ok' }> | null>(null)
  const [message, setMessage] = useState('Choose a saved clip to check its video and voice separately.')
  const [error, setError] = useState(false)
  const [combined, setCombined] = useState<number | null>(null)
  const cancelled = useRef(false)

  async function analyze() {
    setBusy(true)
    cancelled.current = false
    onBusyChange(true)
    setReport(null)
    setCombined(null)
    setError(false)
    setMessage('Choose a file, then wait while the real video and voice detectors analyze it…')
    try {
      const outcome = await window.sentinel.analyzeMediaFile()
      if (cancelled.current) {
        setMessage('Analysis cancelled.')
      } else if (outcome.status === 'ok') {
        setReport(outcome)
        setMessage(`Analysis finished: ${outcome.fileName}`)
      } else if (outcome.status === 'cancelled') {
        setMessage('Analysis cancelled.')
      } else {
        setError(true)
        setMessage(outcome.message)
      }
    } catch {
      setError(true)
      setMessage('Could not analyze the file. Check the detector service and try again.')
    } finally {
      setBusy(false)
      onBusyChange(false)
    }
  }

  async function cancel() {
    cancelled.current = true
    setMessage('Cancelling analysis…')
    try {
      await window.sentinel.cancelMediaAnalysis()
    } catch {
      setError(true)
      setMessage('Could not cancel the request. Wait for it to finish.')
    }
  }

  const result = report?.result
  return (
    <section className="panel agent-settings" aria-labelledby="media-analysis-title">
      <h2 id="media-analysis-title">Analyze a video or audio file</h2>
      <p className="settings-help">Uses UCF, Community Forensics and AASIST3 in every mode. Up to 100 MB and five minutes.</p>
      <div className="actions">
        <button className="primary" disabled={disabled || busy || !window.sentinel} onClick={() => void analyze()}>
          Choose video or audio
        </button>
        {busy && <button className="ghost" onClick={() => void cancel()}>Cancel analysis</button>}
      </div>
      <p className={error ? 'error' : 'settings-help'} role="status" aria-live="polite">{message}</p>
      {result && (
        <>
          <dl className="stats">
            <div><dt>Face manipulation · UCF</dt><dd>{formatScore(result.videoRisk)}</dd></div>
            <div><dt>Voice spoofing · AASIST3</dt><dd>{formatScore(result.voiceRisk)}</dd></div>
            <div><dt>Face samples</dt><dd>{result.facesFound} / {result.framesSampled}</dd></div>
            <div><dt>Voice analyzed</dt><dd>{result.voiceSeconds === null ? 'Unavailable' : `${result.voiceSeconds.toFixed(1)} seconds`}</dd></div>
          </dl>
          {result.generatedFrameEvidence && <p className="settings-help"><strong>Community Forensics: {result.generatedFrameEvidence.flaggedFrames}/{result.generatedFrameEvidence.sampledFrames} frames flagged</strong> · mean {result.generatedFrameEvidence.meanScore.toFixed(3)} at frame threshold 0.5. Experimental video summary.</p>}
          {result.errors.video && <p className="settings-help">Video: {result.errors.video}</p>}
          {result.errors.audio && <p className="settings-help">Voice: {result.errors.audio}</p>}
          {result.errors.generatedVideo && <p className="settings-help">Generated-frame check: {result.errors.generatedVideo}</p>}
          <p className="settings-help">Scores are uncalibrated. UCF can miss fully generated video; a low face score does not clear the video or cancel a voice warning.</p>
          <button className="ghost" disabled={result.videoRisk === null || result.voiceRisk === null} onClick={() => {
            if (result.videoRisk !== null && result.voiceRisk !== null) setCombined(1 - (1 - result.videoRisk) * (1 - result.voiceRisk))
          }}>Combine video and voice scores</button>
          {combined !== null && <p className="settings-feedback" role="status">Combined score: {formatScore(combined)} · {combined > .75 ? 'High' : combined >= .3 ? 'Medium' : 'Low'} risk tier (noisy-OR rule).</p>}
        </>
      )}
    </section>
  )
}

function formatScore(value: number | null): string {
  return value === null ? 'Unavailable' : value.toFixed(3)
}
