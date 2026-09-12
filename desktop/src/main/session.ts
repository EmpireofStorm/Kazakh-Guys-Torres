import { z } from 'zod'
import type { DesktopCapturerSource } from 'electron'
import { createDetectorAdapter } from '../detector/factory'
import { HttpDetectorAdapter } from '../detector/HttpDetectorAdapter'
import { MockDetectorAdapter } from '../detector/MockDetectorAdapter'
import { EvidenceAggregator } from '../evidence/aggregator'
import { runSentinelDecision, type CompatibleAgentConfig } from '../agent/langchainAgent'
import { decideWithPersistence } from '../agent/orchestrator'
import type { AgentToolHost } from '../agent/tools'
import type { DetectorAdapter } from '../detector/types'
import type {
  AgentActivity,
  AgentMode,
  AppPhase,
  AssessmentLevel,
  CaptureSource,
  DemoScenario,
  DetectorResult,
  SamplingMode,
  SentinelUiState,
  UserAssessment
} from '../shared/types'
import { toDisplayState } from '../shared/types'

const analyzePayloadSchema = z.object({
  jpegBase64: z.string().min(32).max(2_000_000),
  capturedAt: z.number().int().positive()
})

const startPayloadSchema = z.object({
  sourceId: z.string().min(1).max(512),
  sourceName: z.string().min(1).max(256),
  scenario: z.enum(['synthetic', 'authentic', 'live']).optional()
})

const demoPayloadSchema = z.object({
  scenario: z.enum(['synthetic', 'authentic', 'live'])
})

const NORMAL_FPS = 1.5
const INTENSIVE_FPS = 2.5
const SCRIPTED_FRAME = `${'A'.repeat(48)}==`

export class SentinelSession {
  private phase: AppPhase = 'IDLE'
  private assessment: UserAssessment | null = null
  private samplingMode: SamplingMode = 'NORMAL'
  private intensiveUntil = 0
  private samplesAnalyzed = 0
  private selectedSource: { id: string; name: string } | null = null
  private errorMessage: string | null = null
  private overlayExpanded = false
  private highStreak = 0
  private demoScenario: DemoScenario = 'synthetic'
  private ticker: ReturnType<typeof setTimeout> | null = null
  private watchdog: ReturnType<typeof setInterval> | null = null
  private listeners = new Set<(state: SentinelUiState) => void>()
  private generation = 0
  private captureAbort = new AbortController()
  private agentRun: AbortController | null = null
  private nextDecisionAt = 0
  private agentMode: AgentMode = 'fallback'
  private agentActivity: AgentActivity[] = []
  private activityId = 0
  private intensiveFps = INTENSIVE_FPS
  private liveDetector = false

  private readonly evidence = new EvidenceAggregator()

  constructor(
    private readonly getAgentConfig: () => CompatibleAgentConfig | null = () => null,
    private detector: DetectorAdapter = createDetectorAdapter()
  ) {}

  agentSettingsChanged(): void {
    this.cancelInvestigation()
    this.agentMode = 'fallback'
    this.nextDecisionAt = 0
    this.recordActivity('Agent settings updated. Future investigations will use the saved endpoint.')
    this.emit()
  }

  private useLiveDetector(live: boolean): void {
    this.liveDetector = live
    if (live) {
      this.detector = new HttpDetectorAdapter()
      return
    }
    const mock = new MockDetectorAdapter()
    mock.setDemoScenario(this.demoScenario === 'authentic' ? 'authentic' : 'synthetic')
    this.detector = mock
  }

  subscribe(listener: (state: SentinelUiState) => void): () => void {
    this.listeners.add(listener)
    listener(this.getState())
    return () => this.listeners.delete(listener)
  }

  getState(): SentinelUiState {
    const fps = this.currentFps()
    return {
      phase: this.phase,
      displayState: toDisplayState(this.phase, this.assessment?.level ?? null),
      assessment: this.assessment,
      samplingMode: this.samplingMode,
      framesPerSecond: fps,
      samplesAnalyzed: this.samplesAnalyzed,
      selectedSource: this.selectedSource,
      evidence: this.phase === 'MONITORING' ? this.evidence.snapshot() : null,
      errorMessage: this.errorMessage,
      overlayExpanded: this.overlayExpanded,
      agentMode: this.agentMode,
      agentBusy: this.agentRun !== null,
      agentActivity: [...this.agentActivity],
      demoScenario: this.demoScenario
    }
  }

  currentFps(): number {
    if (this.samplingMode === 'INTENSIVE' && Date.now() < this.intensiveUntil) {
      return this.intensiveFps
    }
    if (this.samplingMode === 'INTENSIVE') {
      this.samplingMode = 'NORMAL'
    }
    return this.liveDetector ? NORMAL_FPS : 4
  }

  beginSelecting(): void {
    this.phase = 'SELECTING_SOURCE'
    this.errorMessage = null
    this.emit()
  }

  startMonitoring(raw: unknown): SentinelUiState {
    const payload = startPayloadSchema.parse(raw)
    this.generation += 1
    this.captureAbort.abort()
    this.captureAbort = new AbortController()
    this.cancelInvestigation()
    this.stopTicker()
    if (this.watchdog) clearInterval(this.watchdog)
    this.demoScenario = payload.scenario ?? this.demoScenario
    if (payload.scenario !== undefined) {
      this.useLiveDetector(this.demoScenario === 'live')
    }
    this.detector.reset()
    this.evidence.reset()
    this.samplesAnalyzed = 0
    this.highStreak = 0
    this.samplingMode = 'NORMAL'
    this.intensiveUntil = 0
    this.overlayExpanded = false
    this.nextDecisionAt = 0
    this.agentMode = 'fallback'
    this.agentActivity = []
    this.selectedSource = { id: payload.sourceId, name: payload.sourceName }
    this.phase = 'MONITORING'
    this.assessment = null
    this.evidence.setPreviousAssessment(null)
    this.errorMessage = null
    this.recordActivity('Monitoring started. Collecting evidence before making an assessment.')
    this.watchdog = setInterval(() => {
      if (this.phase !== 'MONITORING') return
      const snapshot = this.evidence.snapshot()
      if (this.samplesAnalyzed && !snapshot.scores && this.assessment?.level !== 'UNCERTAIN') {
        this.cancelInvestigation()
        this.applyAssessment('UNCERTAIN', 'Recent valid face evidence is unavailable. Waiting for fresh samples.')
        this.recordActivity('Previous evidence expired. Waiting for fresh samples.')
      }
      this.emit()
    }, 1000)
    this.emit()
    return this.getState()
  }

  startScriptedDemo(raw: unknown): SentinelUiState {
    const payload = demoPayloadSchema.parse(raw)
    const state = this.startMonitoring({
      sourceId: `scripted:${payload.scenario}`,
      sourceName: 'Primary participant',
      scenario: payload.scenario
    })
    if (payload.scenario !== 'live') this.startTicker()
    return state
  }

  stopMonitoring(): SentinelUiState {
    this.generation += 1
    this.captureAbort.abort()
    this.cancelInvestigation()
    this.stopTicker()
    if (this.watchdog) clearInterval(this.watchdog)
    this.watchdog = null
    this.phase = 'IDLE'
    this.selectedSource = null
    this.samplingMode = 'NORMAL'
    this.assessment = null
    this.overlayExpanded = false
    this.detector.reset()
    this.evidence.reset()
    this.recordActivity('Monitoring stopped. Pending investigations were cancelled.')
    this.emit()
    return this.getState()
  }

  setError(message: string): void {
    this.cancelInvestigation()
    this.phase = 'ERROR'
    this.errorMessage = message
    this.emit()
  }

  setOverlayExpanded(expanded: boolean): void {
    this.overlayExpanded = expanded
    this.emit()
  }

  async analyzeFrame(raw: unknown): Promise<{ result: DetectorResult; state: SentinelUiState }> {
    if (this.phase !== 'MONITORING') {
      throw new Error('Not monitoring')
    }

    const payload = analyzePayloadSchema.parse(raw)
    const generation = this.generation
    let result: DetectorResult
    try {
      result = await this.detector.analyzeFrame({
        jpegBase64: payload.jpegBase64,
        capturedAt: payload.capturedAt
      }, this.captureAbort.signal)
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      console.error(`[SENTINEL] analyzeFrame failed: ${detail}`)
      if (generation === this.generation && this.phase === 'MONITORING') {
        this.cancelInvestigation()
        this.errorMessage = 'The detector is unavailable. Waiting for a successful analysis.'
        this.applyAssessment('UNCERTAIN', this.errorMessage)
        this.recordActivity(`Detector request failed (${detail}). No risk score was inferred from the failure.`)
        this.emit()
      }
      throw new Error(detail)
    }
    if (generation !== this.generation || this.phase !== 'MONITORING') {
      throw new Error('Capture session ended')
    }
    if (Date.now() - payload.capturedAt > 10_000 || payload.capturedAt > Date.now() + 1000) {
      throw new Error('Discarded a stale or invalid capture timestamp')
    }
    this.errorMessage = null

    this.samplesAnalyzed += 1
    this.evidence.noteLifetime()
    this.evidence.add({
      timestamp: payload.capturedAt,
      deepfakeProbability: result.deepfakeProbability,
      faceDetected: result.faceDetected,
      confidence: result.confidence,
      model: result.model
    })

    if (result.faceDetected && result.deepfakeProbability >= 0.75) {
      this.highStreak += 1
    } else {
      this.highStreak = 0
    }

    this.investigate()
    this.emit()
    return { result, state: this.getState() }
  }

  private startTicker(): void {
    this.stopTicker()
    const generation = this.generation
    const tick = async () => {
      if (this.phase !== 'MONITORING' || generation !== this.generation) return
      try {
        await this.analyzeFrame({ jpegBase64: SCRIPTED_FRAME, capturedAt: Date.now() })
      } catch {
        // keep the timeline moving if a single sample fails
      }
      if (this.phase !== 'MONITORING' || generation !== this.generation) return
      this.ticker = setTimeout(tick, Math.round(1000 / this.currentFps()))
    }
    void tick()
  }

  private stopTicker(): void {
    if (this.ticker !== null) {
      clearTimeout(this.ticker)
      this.ticker = null
    }
  }

  private investigate(): void {
    if (!this.liveDetector) {
      const snapshot = this.evidence.snapshot()
      if (snapshot.sampleCount < 2) return
      const host = this.createToolHost(() => this.phase === 'MONITORING')
      try {
        decideWithPersistence(snapshot, host, this.highStreak)
      } catch {
        // session already stopped
      }
      return
    }
    if (this.agentRun || Date.now() < this.nextDecisionAt) return
    const snapshot = this.evidence.snapshot()
    if (snapshot.sampleCount < 3) return
    const run = new AbortController()
    this.agentRun = run
    this.nextDecisionAt = Date.now() + 5000
    const current = () => this.agentRun === run && !run.signal.aborted && this.phase === 'MONITORING'
    const host = this.createToolHost(current)
    // Sampling continues while the model chooses its next action.
    void runSentinelDecision(snapshot, host, this.highStreak, {
      config: this.getAgentConfig(),
      getHighStreak: () => this.highStreak,
      signal: run.signal,
      onEvent: (message) => { if (current()) this.recordActivity(message) },
      onMode: (mode) => { if (current()) this.agentMode = mode }
    }).catch(() => {
      if (!current()) return
      this.agentMode = 'fallback'
      this.applyAssessment('UNCERTAIN', 'The investigation could not finish. Gathering more evidence.')
      this.recordActivity('Investigation interrupted. Waiting before retrying.')
    }).finally(() => {
      if (!current()) return
      this.agentRun = null
      this.nextDecisionAt = Math.max(this.nextDecisionAt, Date.now() + 3000)
      this.emit()
    })
  }

  private cancelInvestigation(): void {
    this.agentRun?.abort()
    this.agentRun = null
  }

  private recordActivity(message: string): void {
    if (this.agentActivity.at(-1)?.message === message) return
    this.agentActivity.push({ id: ++this.activityId, timestamp: Date.now(), message })
    this.agentActivity = this.agentActivity.slice(-30)
    this.emit()
  }

  private createToolHost(current: () => boolean): AgentToolHost {
    const ensureCurrent = () => {
      if (!current()) throw new Error('Investigation cancelled')
    }
    return {
      getEvidence: () => { ensureCurrent(); return this.evidence.snapshot() },
      requestAdditionalSampling: ({ durationSeconds, framesPerSecond }) => {
        ensureCurrent()
        this.samplingMode = 'INTENSIVE'
        this.intensiveFps = framesPerSecond
        this.intensiveUntil = Date.now() + durationSeconds * 1000
        this.nextDecisionAt = this.intensiveUntil
        this.emit()
        return {
          samplingMode: this.samplingMode,
          framesPerSecond: this.intensiveFps,
          durationSeconds
        }
      },
      setAssessment: ({ level, explanation }) => {
        ensureCurrent()
        this.applyAssessment(level, explanation)
        return { level }
      }
    }
  }

  private applyAssessment(level: AssessmentLevel, explanation: string): void {
    this.assessment = { level, explanation, updatedAt: Date.now() }
    this.evidence.setPreviousAssessment(level)
    if (level === 'HIGH_RISK') {
      this.overlayExpanded = true
    } else {
      this.overlayExpanded = false
    }
  }

  private emit(): void {
    const state = this.getState()
    for (const listener of this.listeners) listener(state)
  }
}

export function mapDesktopSources(
  sources: DesktopCapturerSource[]
): CaptureSource[] {
  return sources.map((source) => ({
    id: source.id,
    name: source.name,
    thumbnail: source.thumbnail.toDataURL(),
    sourceType: source.id.startsWith('screen:') ? 'screen' : 'window'
  }))
}
