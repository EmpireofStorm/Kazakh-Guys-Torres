import { z } from 'zod'
import { setTimeout as delay } from 'node:timers/promises'
import type { DesktopCapturerSource } from 'electron'
import { createDetectorAdapter } from '../detector/factory'
import { MockDetectorAdapter } from '../detector/MockDetectorAdapter'
import { EvidenceAggregator } from '../evidence/aggregator'
import { runSentinelDecision, type CompatibleAgentConfig } from '../agent/langchainAgent'
import type { AgentToolHost } from '../agent/tools'
import { additionalSamplingSchema } from '../agent/tools'
import type { DetectorAdapter } from '../detector/types'
import type {
  AgentActivity,
  AgentMode,
  AppPhase,
  AssessmentLevel,
  CaptureSource,
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
  sourceName: z.string().min(1).max(256)
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
  private scriptedDemo = false
  private chatBusy = false
  private chatSampling: { startedAt: number; until: number; count: number; evidence: EvidenceAggregator } | null = null
  private readonly demoDetector = new MockDetectorAdapter()

  private readonly evidence = new EvidenceAggregator()

  constructor(
    private readonly getAgentConfig: () => CompatibleAgentConfig | null = () => null,
    private detector: DetectorAdapter = createDetectorAdapter()
  ) {}

  setDetectorMode(raw: unknown): SentinelUiState {
    const mode = z.enum(['real', 'demo']).parse(raw)
    if (this.phase === 'MONITORING') throw new Error('Stop monitoring before changing the detector.')
    this.stopMonitoring()
    this.detector = createDetectorAdapter(mode)
    this.emit()
    return this.getState()
  }

  setChatBusy(busy: boolean): void {
    this.chatBusy = busy
    if (busy) this.cancelInvestigation()
  }

  async sampleForChat(raw: unknown, signal: AbortSignal): Promise<unknown> {
    const args = additionalSamplingSchema.parse(raw)
    signal.throwIfAborted()
    if (this.phase !== 'MONITORING') throw new Error('Select a meeting window and start monitoring before requesting live samples.')
    const generation = this.generation
    if (this.chatSampling) throw new Error('A live evidence window is already running.')
    const startedAt = Date.now()
    const sampling = { startedAt, until: startedAt + args.durationSeconds * 1000, count: 0, evidence: new EvidenceAggregator(args.durationSeconds * 1000) }
    this.chatSampling = sampling
    const current = () => !signal.aborted && generation === this.generation && this.phase === 'MONITORING'
    this.createToolHost(current).requestAdditionalSampling(args)
    const until = this.intensiveUntil
    this.recordActivity(`Chat requested ${args.durationSeconds} seconds of additional sampling.`)
    try {
      await delay(args.durationSeconds * 1000, undefined, { signal })
      if (!current()) throw new Error('Monitoring ended before the sampling window completed.')
      return { status: 'completed', newSamples: sampling.count,
        freshEvidenceAvailable: sampling.count > 0,
        detectorMode: this.getState().detectorMode, evidence: sampling.evidence.snapshot(sampling.until) }
    } finally {
      if (this.chatSampling === sampling) this.chatSampling = null
      if (generation === this.generation && this.intensiveUntil === until) {
        this.intensiveUntil = 0
        this.samplingMode = 'NORMAL'
        this.emit()
      }
    }
  }

  agentSettingsChanged(): void {
    this.cancelInvestigation()
    this.agentMode = 'fallback'
    this.nextDecisionAt = 0
    this.recordActivity('Agent settings updated. Future investigations will use the saved endpoint.')
    this.emit()
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
      detectorMode: this.scriptedDemo || this.detector.name === 'mock-detector' ? 'demo' : 'real',
      agentBusy: this.agentRun !== null,
      agentActivity: [...this.agentActivity]
    }
  }

  currentFps(): number {
    if (this.samplingMode === 'INTENSIVE' && Date.now() < this.intensiveUntil) {
      return this.intensiveFps
    }
    if (this.samplingMode === 'INTENSIVE') {
      this.samplingMode = 'NORMAL'
    }
    return NORMAL_FPS
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
    this.scriptedDemo = false
    this.detector.reset()
    this.demoDetector.reset()
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

  startScriptedDemo(): SentinelUiState {
    this.startMonitoring({
      sourceId: 'scripted:demo',
      sourceName: 'Scripted demo timeline'
    })
    this.scriptedDemo = true
    this.recordActivity('Scripted demo uses simulated scores. Real detector results are not used.')
    this.startTicker()
    this.emit()
    return this.getState()
  }

  stopMonitoring(): SentinelUiState {
    this.generation += 1
    this.captureAbort.abort()
    this.cancelInvestigation()
    this.stopTicker()
    if (this.watchdog) clearInterval(this.watchdog)
    this.watchdog = null
    this.phase = 'IDLE'
    this.scriptedDemo = false
    this.selectedSource = null
    this.samplingMode = 'NORMAL'
    this.assessment = null
    this.overlayExpanded = false
    this.detector.reset()
    this.demoDetector.reset()
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
      const detector = this.scriptedDemo ? this.demoDetector : this.detector
      result = await detector.analyzeFrame({
        jpegBase64: payload.jpegBase64,
        capturedAt: payload.capturedAt
      }, this.captureAbort.signal)
    } catch (error) {
      if (generation === this.generation && this.phase === 'MONITORING') {
        this.cancelInvestigation()
        this.errorMessage = 'The detector is unavailable. Waiting for a successful analysis.'
        this.applyAssessment('UNCERTAIN', this.errorMessage)
        this.recordActivity('Detector request failed. No risk score was inferred from the failure.')
        this.emit()
      }
      throw error
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
    const sample = {
      timestamp: payload.capturedAt,
      deepfakeProbability: result.deepfakeProbability,
      faceDetected: result.faceDetected,
      confidence: result.confidence,
      model: result.model
    }
    this.evidence.add(sample)
    const sampling = this.chatSampling
    if (sampling && payload.capturedAt >= sampling.startedAt && payload.capturedAt <= sampling.until) {
      sampling.count += 1
      sampling.evidence.add(sample)
    }

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
      config: this.chatBusy ? null : this.getAgentConfig(),
      localFallbackReason: this.chatBusy ? 'Chat is using the model connection. Local evidence rules continue monitoring.' : undefined,
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
    if (level !== 'HIGH_RISK') {
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
