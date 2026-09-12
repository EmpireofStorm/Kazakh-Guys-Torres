import type { DetectorResult, FrameInput } from '../shared/types'
import { clampProbability, type DetectorAdapter } from './types'

/**
 * Scripted detector so the demo can show:
 * LOW RISK → VERIFYING (unstable) → HIGH MANIPULATION RISK
 *
 * Ignores pixels on purpose. Real models enter through HttpDetectorAdapter.
 */
export class MockDetectorAdapter implements DetectorAdapter {
  readonly name = 'mock-detector'
  private startedAt: number | null = null

  reset(): void {
    this.startedAt = null
  }

  async analyzeFrame(_frame: FrameInput): Promise<DetectorResult> {
    if (this.startedAt === null) {
      this.startedAt = Date.now()
    }

    const elapsed = (Date.now() - this.startedAt) / 1000
    const jitter = (span: number) => (Math.random() - 0.5) * span

    let probability: number
    if (elapsed < 6) {
      probability = 0.11 + jitter(0.06)
    } else if (elapsed < 12) {
      probability = 0.48 + jitter(0.42)
    } else {
      probability = 0.88 + jitter(0.05)
    }

    return {
      deepfakeProbability: clampProbability(probability),
      faceDetected: Math.random() > 0.04,
      confidence: 0.9,
      model: this.name
    }
  }
}
