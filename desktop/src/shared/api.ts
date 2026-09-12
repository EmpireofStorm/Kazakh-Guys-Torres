import type { CaptureSource, SentinelUiState } from './types'

export interface SentinelPreloadApi {
  listSources: () => Promise<CaptureSource[]>
  startMonitoring: (sourceId: string, sourceName: string) => Promise<SentinelUiState>
  startScriptedDemo: () => Promise<SentinelUiState>
  stopMonitoring: () => Promise<SentinelUiState>
  analyzeFrame: (jpegBase64: string, capturedAt: number) => Promise<unknown>
  getState: () => Promise<SentinelUiState>
  showDetails: () => Promise<SentinelUiState>
  onState: (callback: (state: SentinelUiState) => void) => () => void
}
