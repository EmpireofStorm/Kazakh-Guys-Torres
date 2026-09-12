import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import type { SentinelPreloadApi } from '../shared/api'
import type {
  AgentConnectionTestResult,
  AgentSettings,
  AgentSettingsInput,
  AgentSettingsResult,
  CaptureSource,
  DemoClip,
  DemoScenario,
  SentinelUiState
} from '../shared/types'

const api: SentinelPreloadApi = {
  getAgentSettings: (): Promise<AgentSettings> => ipcRenderer.invoke(IPC.agentSettingsGet),
  saveAgentSettings: (input: AgentSettingsInput): Promise<AgentSettingsResult> =>
    ipcRenderer.invoke(IPC.agentSettingsSave, input),
  testAgentConnection: (input: AgentSettingsInput): Promise<AgentConnectionTestResult> =>
    ipcRenderer.invoke(IPC.agentConnectionTest, input),
  listSources: (): Promise<CaptureSource[]> => ipcRenderer.invoke(IPC.sourcesList),
  listDemoClips: (): Promise<DemoClip[]> => ipcRenderer.invoke(IPC.clipsList),
  startMonitoring: (
    sourceId: string,
    sourceName: string,
    scenario?: DemoScenario
  ): Promise<SentinelUiState> => ipcRenderer.invoke(IPC.monitorStart, { sourceId, sourceName, scenario }),
  startScriptedDemo: (scenario: DemoScenario): Promise<SentinelUiState> =>
    ipcRenderer.invoke(IPC.demoStart, { scenario }),
  stopMonitoring: (): Promise<SentinelUiState> => ipcRenderer.invoke(IPC.monitorStop),
  analyzeFrame: (jpegBase64: string, capturedAt: number) =>
    ipcRenderer.invoke(IPC.detectorAnalyze, { jpegBase64, capturedAt }),
  getState: (): Promise<SentinelUiState> => ipcRenderer.invoke(IPC.stateGet),
  showDetails: (): Promise<SentinelUiState> => ipcRenderer.invoke(IPC.overlayDetails),
  onState: (callback: (state: SentinelUiState) => void): (() => void) => {
    const listener = (_event: unknown, state: SentinelUiState) => callback(state)
    ipcRenderer.on(IPC.stateUpdate, listener)
    return () => ipcRenderer.removeListener(IPC.stateUpdate, listener)
  },
  onDemoHotkey: (callback: (scenario: DemoScenario) => void): (() => void) => {
    const listener = (_event: unknown, scenario: DemoScenario) => callback(scenario)
    ipcRenderer.on(IPC.demoHotkey, listener)
    return () => ipcRenderer.removeListener(IPC.demoHotkey, listener)
  }
}

contextBridge.exposeInMainWorld('sentinel', api)
