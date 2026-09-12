import type { DetectorResult, FrameInput } from '../shared/types'
import { clampProbability, type DetectorAdapter } from './types'

/**
 * Phase 10 stub. Do not assume the Python model's internal API.
 * Contract: POST {jpegBase64} → DetectorResult JSON.
 */
export class HttpDetectorAdapter implements DetectorAdapter {
  readonly name = 'http-detector'

  constructor(
    private readonly endpoint = process.env.DETECTOR_URL ?? 'http://127.0.0.1:8000/analyze'
  ) {}

  reset(): void {}

  async analyzeFrame(frame: FrameInput): Promise<DetectorResult> {
    const response = await fetch(this.endpoint, {
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

    const body = (await response.json()) as Partial<DetectorResult>
    return {
      deepfakeProbability: clampProbability(Number(body.deepfakeProbability ?? 0)),
      faceDetected: Boolean(body.faceDetected),
      confidence:
        body.confidence === undefined ? undefined : clampProbability(Number(body.confidence)),
      model: body.model ?? this.name
    }
  }
}
