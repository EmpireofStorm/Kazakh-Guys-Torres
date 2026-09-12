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

export type AgentMode = 'langchain' | 'fallback'

export type DetectorMode = 'real' | 'demo'

export interface DetectorHealth {
  reachable: boolean
  videoReady: boolean
  voiceReady: boolean
  message: string
}

export interface MediaAnalysis {
  videoRisk: number | null
  voiceRisk: number | null
  framesSampled: number
  facesFound: number
  voiceSeconds: number | null
  additionalEvidence?: boolean
  voiceStartSeconds?: number
  errors: { video?: string; audio?: string }
  calibrated: false
}

export type MediaAnalysisOutcome =
  | { status: 'ok'; fileName: string; result: MediaAnalysis }
  | { status: 'cancelled' }
  | { status: 'error'; message: string }

export interface ChatAttachment {
  id: string
  name: string
  size: number
}

export interface ChatToolEvent {
  id: string
  name: string
  status: 'running' | 'complete' | 'error'
  summary: string
}

export interface ChatAnalysis {
  attachmentId: string
  fileName: string
  result: MediaAnalysis
}

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: number
  status: 'complete' | 'streaming' | 'cancelled' | 'error'
  attachmentIds: string[]
  tools: ChatToolEvent[]
  analyses: ChatAnalysis[]
}

export interface ChatConversation {
  id: string
  title: string
  updatedAt: number
  messages: ChatMessage[]
  attachments: ChatAttachment[]
}

export interface ChatState {
  conversations: { id: string; title: string; updatedAt: number }[]
  activeConversation: ChatConversation
  busy: boolean
  configured: boolean
  model: string | null
  error: string | null
}

export interface ChatSendInput {
  content: string
  attachmentIds?: string[]
}

export interface AgentSettings {
  enabled: boolean
  baseUrl: string
  model: string
  hasApiKey: boolean
}

export interface AgentSettingsInput {
  enabled: boolean
  baseUrl: string
  model: string
  apiKey?: string
  clearApiKey?: boolean
}

export interface AgentSettingsResult {
  ok: boolean
  settings: AgentSettings
  error?: string
}

export interface AgentConnectionTestResult {
  ok: boolean
  message: string
}

export interface AgentActivity {
  id: number
  timestamp: number
  message: string
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
  detectorMode: DetectorMode
  agentBusy: boolean
  agentActivity: AgentActivity[]
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
