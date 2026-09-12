import type { AgentConnectionTestResult, AgentSettings, AgentSettingsInput, AgentSettingsResult, CaptureSource, ChatAttachment, ChatSendInput, ChatState, DetectorHealth, DetectorMode, MediaAnalysisOutcome, SentinelUiState } from './types'

export interface SentinelPreloadApi {
  getChatState: () => Promise<ChatState>
  newChat: () => Promise<ChatState>
  selectChat: (id: string) => Promise<ChatState>
  addChatAttachments: () => Promise<ChatAttachment[]>
  sendChatMessage: (input: ChatSendInput) => Promise<ChatState>
  cancelChat: () => Promise<ChatState>
  onChatState: (callback: (state: ChatState) => void) => () => void
  getAgentSettings: () => Promise<AgentSettings>
  saveAgentSettings: (input: AgentSettingsInput) => Promise<AgentSettingsResult>
  testAgentConnection: (input: AgentSettingsInput) => Promise<AgentConnectionTestResult>
  setDetectorMode: (mode: DetectorMode) => Promise<SentinelUiState>
  checkDetectorHealth: () => Promise<DetectorHealth>
  analyzeMediaFile: () => Promise<MediaAnalysisOutcome>
  cancelMediaAnalysis: () => Promise<void>
  listSources: () => Promise<CaptureSource[]>
  startMonitoring: (sourceId: string, sourceName: string) => Promise<SentinelUiState>
  startScriptedDemo: () => Promise<SentinelUiState>
  stopMonitoring: () => Promise<SentinelUiState>
  analyzeFrame: (jpegBase64: string, capturedAt: number) => Promise<unknown>
  getState: () => Promise<SentinelUiState>
  showDetails: () => Promise<SentinelUiState>
  onState: (callback: (state: SentinelUiState) => void) => () => void
}
