import type { AgentConnectionTestResult, AgentSettings, AgentSettingsInput, AgentSettingsResult, CaptureSource, SentinelUiState } from './types'

export interface SentinelPreloadApi {
  getAgentSettings: () => Promise<AgentSettings>
  saveAgentSettings: (input: AgentSettingsInput) => Promise<AgentSettingsResult>
  testAgentConnection: (input: AgentSettingsInput) => Promise<AgentConnectionTestResult>
  listSources: () => Promise<CaptureSource[]>
  startMonitoring: (sourceId: string, sourceName: string) => Promise<SentinelUiState>
  startScriptedDemo: () => Promise<SentinelUiState>
  stopMonitoring: () => Promise<SentinelUiState>
  analyzeFrame: (jpegBase64: string, capturedAt: number) => Promise<unknown>
  getState: () => Promise<SentinelUiState>
  showDetails: () => Promise<SentinelUiState>
  onState: (callback: (state: SentinelUiState) => void) => () => void
}
