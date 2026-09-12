import type { DemoScenario, DetectorResult, FrameInput } from '../shared/types'

export interface DetectorAdapter {
  readonly name: string
  analyzeFrame(frame: FrameInput, signal?: AbortSignal): Promise<DetectorResult>
  reset(): void
  setDemoScenario(scenario: DemoScenario): void
}

export function clampProbability(value: number): number {
  if (Number.isNaN(value)) return 0
  return Math.min(1, Math.max(0, value))
}
