import { HttpDetectorAdapter } from './HttpDetectorAdapter'
import { MockDetectorAdapter } from './MockDetectorAdapter'
import type { DetectorAdapter } from './types'
import type { DetectorMode } from '../shared/types'

export function createDetectorAdapter(mode?: DetectorMode): DetectorAdapter {
  const selected = mode ?? ((process.env.SENTINEL_DETECTOR ?? '').trim().toLowerCase() === 'mock' ? 'demo' : 'real')
  return selected === 'real' ? new HttpDetectorAdapter() : new MockDetectorAdapter()
}
