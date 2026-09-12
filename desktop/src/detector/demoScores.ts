import type { DemoScenario } from '../shared/types'
import { clampProbability } from './types'

export function jitter(span: number): number {
  return (Math.random() - 0.5) * span
}

/** Scripted probabilities for the hackathon walkthrough. Not model inference. */
export function demoProbability(scenario: DemoScenario, elapsedSeconds: number): {
  deepfakeProbability: number
  faceDetected: boolean
  confidence: number
  model: string
} {
  if (scenario === 'authentic') {
    return {
      deepfakeProbability: clampProbability(0.09 + jitter(0.08)),
      faceDetected: true,
      confidence: clampProbability(0.88 + jitter(0.06)),
      model: 'demo-authentic'
    }
  }

  let probability: number
  if (elapsedSeconds < 5) {
    probability = 0.16 + jitter(0.1)
  } else if (elapsedSeconds < 11) {
    probability = 0.55 + jitter(0.34)
  } else {
    probability = 0.87 + jitter(0.08)
  }

  return {
    deepfakeProbability: clampProbability(probability),
    faceDetected: Math.random() > 0.03,
    confidence: clampProbability(0.91 + jitter(0.05)),
    model: 'demo-synthetic'
  }
}
