import { useEffect, useState } from 'react'
import type { SentinelUiState } from '../shared/types'

const idle: SentinelUiState = {
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
  agentBusy: false
}

export function OverlayApp() {
  const [state, setState] = useState<SentinelUiState>(idle)

  useEffect(() => {
    if (!window.sentinel) return
    void window.sentinel.getState().then(setState)
    return window.sentinel.onState(setState)
  }, [])

  const mode = overlayMode(state)

  return (
    <div className={`overlay-card ${mode.tone}`} data-mode={mode.tone}>
      <header className="overlay-head">
        <span className="overlay-glyph">{mode.glyph}</span>
        <strong>SENTINEL</strong>
      </header>
      <p className="overlay-title">{mode.title}</p>
      {mode.subtitle && <p className="overlay-sub">{mode.subtitle}</p>}
      {mode.body && <p className="overlay-body-copy">{mode.body}</p>}
      {mode.showDetails && (
        <button className="overlay-details" onClick={() => void window.sentinel.showDetails()}>
          Details
        </button>
      )}
    </div>
  )
}

function overlayMode(state: SentinelUiState): {
  tone: 'idle' | 'low' | 'verify' | 'high'
  glyph: string
  title: string
  subtitle?: string
  body?: string
  showDetails?: boolean
} {
  if (state.phase === 'MONITORING' && !state.assessment) {
    return { tone: 'verify', glyph: '◐', title: 'GATHERING EVIDENCE' }
  }
  if (state.displayState === 'HIGH_RISK') {
    return {
      tone: 'high',
      glyph: '⚠',
      title: 'HIGH MANIPULATION RISK',
      subtitle: 'Suspicious media signals detected consistently.',
      body: 'Verify this person’s identity independently.',
      showDetails: true
    }
  }
  if (state.displayState === 'VERIFYING' || state.displayState === 'UNCERTAIN') {
    return {
      tone: 'verify',
      glyph: '◐',
      title: 'VERIFYING...',
      subtitle: 'Gathering more evidence'
    }
  }
  if (state.phase === 'MONITORING') {
    return { tone: 'low', glyph: '●', title: 'LOW RISK' }
  }
  return { tone: 'idle', glyph: '●', title: 'STANDBY' }
}
