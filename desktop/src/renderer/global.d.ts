import type { SentinelPreloadApi } from '../shared/api'

declare global {
  interface Window {
    sentinel: SentinelPreloadApi
  }
}

export {}
