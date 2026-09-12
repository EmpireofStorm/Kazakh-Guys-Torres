import type { DetectorResult, FrameInput } from '../shared/types'
import type { DetectorAdapter } from './types'
import { z } from 'zod'
import type { DemoScenario } from '../shared/types'

const detectorResultSchema = z.object({
  deepfakeProbability: z.number().finite().min(0).max(1),
  faceDetected: z.boolean(),
  confidence: z.number().finite().min(0).max(1).nullish(),
  model: z.string().max(128).nullish()
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
      const detail = (await response.text()).slice(0, 400)
      console.error(`[SENTINEL] detector HTTP ${response.status} from ${this.endpoint}: ${detail}`)
      throw new Error(`Detector HTTP ${response.status}`)
    }

    const raw: unknown = await response.json()
    const parsed = detectorResultSchema.safeParse(raw)
    if (!parsed.success) {
      console.error('[SENTINEL] detector JSON rejected', parsed.error.flatten(), raw)
      throw new Error('Detector response did not match the analyze contract')
    }
    const body = parsed.data
    return {
      deepfakeProbability: body.deepfakeProbability,
      faceDetected: body.faceDetected,
      confidence: body.confidence ?? undefined,
      model: body.model ?? this.name
    }
  }
}
