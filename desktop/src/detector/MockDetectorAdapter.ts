import type { DemoScenario, DetectorResult, FrameInput } from '../shared/types'
import { demoProbability } from './demoScores'
import type { DetectorAdapter } from './types'

/**
 * Scripted detector for the live demo.
 * `synthetic` walks LOW → VERIFYING → HIGH MANIPULATION RISK.
 * `authentic` stays in a low, stable band so the overlay remains LOW RISK.
 *
 * Ignores pixels. Real models enter through HttpDetectorAdapter.
 */
export class MockDetectorAdapter implements DetectorAdapter {
  readonly name = 'mock-detector'
  private startedAt: number | null = null
  private scenario: DemoScenario = 'synthetic'

  constructor(private readonly now: () => number = () => Date.now()) {}

  setDemoScenario(scenario: DemoScenario): void {
    this.scenario = scenario
    this.reset()
  }

  reset(): void {
    this.startedAt = null
  }

  async analyzeFrame(_frame: FrameInput): Promise<DetectorResult> {
    if (this.startedAt === null) {
      this.startedAt = this.now()
    }

    const elapsed = (this.now() - this.startedAt) / 1000
    return demoProbability(this.scenario, elapsed)
  }
}
