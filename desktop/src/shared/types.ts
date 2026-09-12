export type AppPhase = 'IDLE' | 'SELECTING_SOURCE' | 'MONITORING' | 'ERROR'

export type AssessmentLevel = 'LOW_RISK' | 'UNCERTAIN' | 'HIGH_RISK'

export type DisplayState =
  | 'IDLE'
  | 'SELECTING_SOURCE'
  | 'MONITORING'
  | 'VERIFYING'
  | 'LOW_RISK'
  | 'UNCERTAIN'
  | 'HIGH_RISK'
  | 'ERROR'

export type SamplingMode = 'NORMAL' | 'INTENSIVE'

export type AgentMode = 'openai' | 'fallback'

export type DemoScenario = 'synthetic' | 'authentic'

export interface DemoClip {
  id: string
  name: string
  url: string
}

export interface DetectorResult {
  deepfakeProbability: number
  faceDetected: boolean
  confidence?: number
  model?: string
}

export interface FrameInput {
  jpegBase64: string
  capturedAt: number
}

export interface EvidenceSample {
  timestamp: number
  deepfakeProbability: number
  faceDetected: boolean
  confidence?: number
  model?: string
}

export interface ScoreStats {
  mean: number
  median: number
  min: number
  max: number
  stdDev: number
}

export type ScoreTrend = 'rising' | 'falling' | 'stable' | 'insufficient'

export interface EvidenceSnapshot {
  windowSeconds: number
  sampleCount: number
  validFaceFrames: number
  scores: ScoreStats | null
  trend: ScoreTrend
  previousAssessment: AssessmentLevel | null
  latestSample: EvidenceSample | null
}

export interface CaptureSource {
  id: string
  name: string
  thumbnail: string
  sourceType: 'window' | 'screen'
}

export interface UserAssessment {
  level: AssessmentLevel
  explanation: string
  updatedAt: number
}

export interface SentinelUiState {
  phase: AppPhase
  displayState: DisplayState
  assessment: UserAssessment | null
  samplingMode: SamplingMode
  framesPerSecond: number
  samplesAnalyzed: number
  selectedSource: { id: string; name: string } | null
  evidence: EvidenceSnapshot | null
  errorMessage: string | null
  overlayExpanded: boolean
  agentMode: AgentMode
  demoScenario: DemoScenario
}

export function toDisplayState(
  phase: AppPhase,
  assessment: AssessmentLevel | null
): DisplayState {
  if (phase === 'IDLE') return 'IDLE'
  if (phase === 'SELECTING_SOURCE') return 'SELECTING_SOURCE'
  if (phase === 'ERROR') return 'ERROR'
  if (!assessment) return 'MONITORING'
  if (assessment === 'UNCERTAIN') return 'VERIFYING'
  return assessment
}
