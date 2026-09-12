import { z } from 'zod'
import { createDetectorAdapter } from '../detector/factory'
import { EvidenceAggregator } from '../evidence/aggregator'
import { runSentinelDecision } from '../agent/openaiAgent'
import type { AgentToolHost } from '../agent/tools'
import { hasOpenAIKey } from './env'
import type {
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
  private listeners = new Set<(state: SentinelUiState) => void>()

  private readonly detector = createDetectorAdapter()
  private readonly evidence = new EvidenceAggregator()

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
      agentMode: hasOpenAIKey() ? 'openai' : 'fallback'
    }
  }

  currentFps(): number {
    if (this.samplingMode === 'INTENSIVE' && Date.now() < this.intensiveUntil) {
      return INTENSIVE_FPS
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
    this.detector.reset()
    this.evidence.reset()
    this.samplesAnalyzed = 0
    this.highStreak = 0
    this.samplingMode = 'NORMAL'
    this.intensiveUntil = 0
    this.overlayExpanded = false
    this.stopTicker()
    this.selectedSource = { id: payload.sourceId, name: payload.sourceName }
    this.phase = 'MONITORING'
    this.assessment = {
      level: 'LOW_RISK',
      explanation: 'Monitoring started. Collecting an initial evidence window.',
      updatedAt: Date.now()
    }
    this.evidence.setPreviousAssessment('LOW_RISK')
    this.errorMessage = null
    this.emit()
    return this.getState()
  }

  startScriptedDemo(): SentinelUiState {
    const state = this.startMonitoring({
      sourceId: 'scripted:demo',
      sourceName: 'Scripted demo timeline'
    })
    this.startTicker()
    return state
  }

  stopMonitoring(): SentinelUiState {
    this.stopTicker()
    this.phase = 'IDLE'
    this.selectedSource = null
    this.samplingMode = 'NORMAL'
    this.assessment = null
    this.overlayExpanded = false
    this.detector.reset()
    this.evidence.reset()
    this.emit()
    return this.getState()
  }

  setError(message: string): void {
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
    const result = await this.detector.analyzeFrame({
      jpegBase64: payload.jpegBase64,
      capturedAt: payload.capturedAt
    })

    this.samplesAnalyzed += 1
    this.evidence.noteLifetime()
    const snapshot = this.evidence.add({
      timestamp: payload.capturedAt,
      deepfakeProbability: result.deepfakeProbability,
      faceDetected: result.faceDetected,
      confidence: result.confidence,
      model: result.model
    })

    if (result.faceDetected && result.deepfakeProbability >= 0.75) {
      this.highStreak += 1
    } else if (!result.faceDetected) {
      // keep streak; missing face is not a counter-example
    } else {
      this.highStreak = Math.max(0, this.highStreak - 1)
    }

    const host = this.createToolHost()
    await runSentinelDecision(snapshot, host, this.highStreak)
    this.emit()
    return { result, state: this.getState() }
  }

  private startTicker(): void {
    this.stopTicker()
    const tick = async () => {
      if (this.phase !== 'MONITORING') return
      try {
        await this.analyzeFrame({ jpegBase64: SCRIPTED_FRAME, capturedAt: Date.now() })
      } catch {
        // keep the timeline moving if a single sample fails
      }
      if (this.phase !== 'MONITORING') return
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

  private createToolHost(): AgentToolHost {
    return {
      getEvidence: () => this.evidence.snapshot(),
      requestAdditionalSampling: ({ durationSeconds, framesPerSecond }) => {
        this.samplingMode = 'INTENSIVE'
        this.intensiveUntil = Date.now() + durationSeconds * 1000
        void framesPerSecond
        this.emit()
        return {
          samplingMode: this.samplingMode,
          framesPerSecond: INTENSIVE_FPS,
          durationSeconds
        }
      },
      setAssessment: ({ level, explanation }) => {
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
  sources: Electron.DesktopCapturerSource[]
): CaptureSource[] {
  return sources.map((source) => ({
    id: source.id,
    name: source.name,
    thumbnail: source.thumbnail.toDataURL(),
    sourceType: source.id.startsWith('screen:') ? 'screen' : 'window'
  }))
}
