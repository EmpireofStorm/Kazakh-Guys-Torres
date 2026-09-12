import { HttpDetectorAdapter } from './HttpDetectorAdapter'
import { MockDetectorAdapter } from './MockDetectorAdapter'
import type { DetectorAdapter } from './types'

export function createDetectorAdapter(): DetectorAdapter {
  const mode = (process.env.SENTINEL_DETECTOR ?? 'mock').trim().toLowerCase()
  if (mode === 'http') {
    return new HttpDetectorAdapter()
  }
  return new MockDetectorAdapter()
}
