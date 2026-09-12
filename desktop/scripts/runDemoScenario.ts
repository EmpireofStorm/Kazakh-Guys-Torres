import { MockDetectorAdapter } from '../src/detector/MockDetectorAdapter'
import { EvidenceAggregator } from '../src/evidence/aggregator'
import { decideWithPersistence } from '../src/agent/orchestrator'
import type { AgentToolHost } from '../src/agent/tools'
import type { AssessmentLevel, DemoScenario } from '../src/shared/types'

export async function runDemoScenario(scenario: DemoScenario): Promise<void> {
  let now = Date.now()
  const start = now
  const detector = new MockDetectorAdapter(() => now)
  detector.setDemoScenario(scenario === 'authentic' ? 'authentic' : 'synthetic')
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

  let highAt: number | null = null
  for (let i = 0; i < 22; i++) {
    now = start + i * 200
    const result = await detector.analyzeFrame({
      jpegBase64: 'dGVzdA==dGVzdA==dGVzdA==dGVzdA==',
      capturedAt: now
    })
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
    const elapsed = i * 0.2
    if (assessment === 'HIGH_RISK' && highAt === null) highAt = elapsed
    console.log(
      `${elapsed.toFixed(1)}s  p=${result.deepfakeProbability.toFixed(2)}  mean=${snapshot.scores?.mean.toFixed(2) ?? 'n/a'}  ${assessment}`
    )
  }

  const order = [...seen]
  console.log('levels seen:', order.join(' -> ') || assessment)
  if (scenario === 'synthetic') {
    if (!seen.has('LOW_RISK') || !seen.has('UNCERTAIN') || !seen.has('HIGH_RISK')) {
      process.exitCode = 1
      console.error('Synthetic demo path incomplete')
    } else if (highAt === null || highAt > 5) {
      process.exitCode = 1
      console.error(`HIGH_RISK too slow (${highAt}s)`)
    } else {
      console.log(`HIGH_RISK at ${highAt.toFixed(1)}s`)
    }
  } else if (seen.has('HIGH_RISK') || seen.has('UNCERTAIN')) {
    process.exitCode = 1
    console.error('Authentic demo should stay LOW_RISK')
  } else {
    console.log('Authentic demo stayed LOW_RISK')
  }
}
