import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import type { SentinelPreloadApi } from '../shared/api'
import type { CaptureSource, ChatState, SentinelUiState } from '../shared/types'

const api: SentinelPreloadApi = {
  getChatState: () => ipcRenderer.invoke(IPC.chatGet),
  newChat: () => ipcRenderer.invoke(IPC.chatNew),
  selectChat: (id) => ipcRenderer.invoke(IPC.chatSelect, id),
  addChatAttachments: () => ipcRenderer.invoke(IPC.chatAttach),
  sendChatMessage: (input) => ipcRenderer.invoke(IPC.chatSend, input),
  cancelChat: () => ipcRenderer.invoke(IPC.chatCancel),
  onChatState: (callback: (state: ChatState) => void) => {
    const listener = (_event: unknown, state: ChatState) => callback(state)
    ipcRenderer.on(IPC.chatUpdate, listener)
    return () => ipcRenderer.removeListener(IPC.chatUpdate, listener)
  },
  getAgentSettings: () => ipcRenderer.invoke(IPC.agentSettingsGet),
  saveAgentSettings: (input) => ipcRenderer.invoke(IPC.agentSettingsSave, input),
  testAgentConnection: (input) => ipcRenderer.invoke(IPC.agentConnectionTest, input),
  setDetectorMode: (mode) => ipcRenderer.invoke(IPC.detectorMode, mode),
  checkDetectorHealth: () => ipcRenderer.invoke(IPC.detectorHealth),
  analyzeMediaFile: () => ipcRenderer.invoke(IPC.mediaAnalyze),
  cancelMediaAnalysis: () => ipcRenderer.invoke(IPC.mediaCancel),
  listSources: (): Promise<CaptureSource[]> => ipcRenderer.invoke(IPC.sourcesList),
  startMonitoring: (sourceId: string, sourceName: string): Promise<SentinelUiState> =>
    ipcRenderer.invoke(IPC.monitorStart, { sourceId, sourceName }),
  startScriptedDemo: (): Promise<SentinelUiState> => ipcRenderer.invoke(IPC.demoStart),
  stopMonitoring: (): Promise<SentinelUiState> => ipcRenderer.invoke(IPC.monitorStop),
  analyzeFrame: (jpegBase64: string, capturedAt: number) =>
    ipcRenderer.invoke(IPC.detectorAnalyze, { jpegBase64, capturedAt }),
  getState: (): Promise<SentinelUiState> => ipcRenderer.invoke(IPC.stateGet),
  showDetails: (): Promise<SentinelUiState> => ipcRenderer.invoke(IPC.overlayDetails),
  onState: (callback: (state: SentinelUiState) => void): (() => void) => {
    const listener = (_event: unknown, state: SentinelUiState) => callback(state)
    ipcRenderer.on(IPC.stateUpdate, listener)
    return () => ipcRenderer.removeListener(IPC.stateUpdate, listener)
  }
}

contextBridge.exposeInMainWorld('sentinel', api)
