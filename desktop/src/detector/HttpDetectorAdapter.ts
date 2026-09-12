import type { DetectorResult, FrameInput } from '../shared/types'
import type { DetectorAdapter } from './types'
import { z } from 'zod'
import type { DemoScenario } from '../shared/types'

const detectorResultSchema = z.object({
  deepfakeProbability: z.number().finite().min(0).max(1),
  faceDetected: z.boolean(),
  confidence: z.number().finite().min(0).max(1).optional(),
  model: z.string().max(128).optional()
})

/**
 * Calls the team detector over HTTP. Do not assume Python internals.
 * Contract: POST {jpegBase64} → DetectorResult JSON.
 */
export class HttpDetectorAdapter implements DetectorAdapter {
  readonly name = 'http-detector'

  constructor(
    private readonly endpoint = process.env.DETECTOR_URL ?? 'http://127.0.0.1:8000/analyze'
  ) {}

  reset(): void {}

  setDemoScenario(_scenario: DemoScenario): void {}

  async analyzeFrame(frame: FrameInput, signal?: AbortSignal): Promise<DetectorResult> {
    const response = await fetch(this.endpoint, {
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000),
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jpegBase64: frame.jpegBase64,
        capturedAt: frame.capturedAt
      })
    })

    if (!response.ok) {
      throw new Error(`Detector HTTP ${response.status}`)
    }

    const body = detectorResultSchema.parse(await response.json())
    return {
      deepfakeProbability: body.deepfakeProbability,
      faceDetected: body.faceDetected,
      confidence: body.confidence,
      model: body.model ?? this.name
    }
  }
}
