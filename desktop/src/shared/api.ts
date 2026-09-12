import type {
  AgentConnectionTestResult,
  AgentSettings,
  AgentSettingsInput,
  AgentSettingsResult,
  CaptureSource,
  DemoClip,
  DemoScenario,
  SentinelUiState
} from './types'

export interface SentinelPreloadApi {
  getAgentSettings: () => Promise<AgentSettings>
  saveAgentSettings: (input: AgentSettingsInput) => Promise<AgentSettingsResult>
  testAgentConnection: (input: AgentSettingsInput) => Promise<AgentConnectionTestResult>
  listSources: () => Promise<CaptureSource[]>
  listDemoClips: () => Promise<DemoClip[]>
  startMonitoring: (
    sourceId: string,
    sourceName: string,
    scenario?: DemoScenario
  ) => Promise<SentinelUiState>
  startScriptedDemo: (scenario: DemoScenario) => Promise<SentinelUiState>
  stopMonitoring: () => Promise<SentinelUiState>
  analyzeFrame: (jpegBase64: string, capturedAt: number) => Promise<unknown>
  getState: () => Promise<SentinelUiState>
  showDetails: () => Promise<SentinelUiState>
  onState: (callback: (state: SentinelUiState) => void) => () => void
  onDemoHotkey: (callback: (scenario: DemoScenario) => void) => () => void
}
