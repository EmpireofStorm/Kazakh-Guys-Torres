import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import type { SentinelPreloadApi } from '../shared/api'
import type { CaptureSource, SentinelUiState } from '../shared/types'

const api = {
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
