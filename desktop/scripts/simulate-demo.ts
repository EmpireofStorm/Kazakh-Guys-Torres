/**
 * Headless check that mock scores + aggregator + policy walk
 * LOW_RISK → UNCERTAIN → HIGH_RISK without Electron.
 */
import { MockDetectorAdapter } from '../src/detector/MockDetectorAdapter'
import { EvidenceAggregator } from '../src/evidence/aggregator'
import { decideWithPersistence } from '../src/agent/orchestrator'
import type { AgentToolHost } from '../src/agent/tools'
import type { AssessmentLevel } from '../src/shared/types'

class FakeClockAdapter extends MockDetectorAdapter {
  constructor(private elapsedMs: () => number) {
    super()
  }

  override async analyzeFrame() {
    const elapsed = this.elapsedMs() / 1000
    const jitter = (span: number) => (Math.random() - 0.5) * span
    let probability: number
    if (elapsed < 6) probability = 0.11 + jitter(0.06)
    else if (elapsed < 12) probability = 0.48 + jitter(0.42)
    else probability = 0.88 + jitter(0.05)
    return {
      deepfakeProbability: Math.min(1, Math.max(0, probability)),
      faceDetected: true,
      confidence: 0.9,
      model: 'mock-detector'
    }
  }
}

async function main() {
  let now = Date.now()
  const detector = new FakeClockAdapter(() => now - start)
  const start = now
  const evidence = new EvidenceAggregator()
  let assessment: AssessmentLevel = 'LOW_RISK'
  evidence.setPreviousAssessment(assessment)
  let highStreak = 0
  const seen = new Set<AssessmentLevel>()

  const host: AgentToolHost = {
    getEvidence: () => evidence.snapshot(now),
    requestAdditionalSampling: (args) => ({
      samplingMode: 'INTENSIVE',
      framesPerSecond: 2.5,
      durationSeconds: args.durationSeconds
    }),
    setAssessment: ({ level }) => {
      assessment = level
      evidence.setPreviousAssessment(level)
      seen.add(level)
      return { level }
    }
  }

  for (let i = 0; i < 40; i++) {
    now = start + i * 700
    const result = await detector.analyzeFrame({ jpegBase64: 'dGVzdA==dGVzdA==dGVzdA==dGVzdA==', capturedAt: now })
    if (result.deepfakeProbability >= 0.75) highStreak += 1
    else highStreak = Math.max(0, highStreak - 1)
    const snapshot = evidence.add({
      timestamp: now,
      deepfakeProbability: result.deepfakeProbability,
      faceDetected: result.faceDetected,
      confidence: result.confidence,
      model: result.model
    })
    decideWithPersistence(snapshot, host, highStreak)
    console.log(
      `${(i * 0.7).toFixed(1)}s  p=${result.deepfakeProbability.toFixed(2)}  mean=${snapshot.scores?.mean.toFixed(2) ?? 'n/a'}  ${assessment}`
    )
  }

  const order = [...seen]
  console.log('levels seen:', order.join(' -> '))
  if (!seen.has('LOW_RISK') || !seen.has('UNCERTAIN') || !seen.has('HIGH_RISK')) {
    process.exitCode = 1
    console.error('Demo path incomplete')
  }
}

void main()
