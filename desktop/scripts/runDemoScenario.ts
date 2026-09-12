import { MockDetectorAdapter } from '../src/detector/MockDetectorAdapter'
import { EvidenceAggregator } from '../src/evidence/aggregator'
import { decideWithPersistence } from '../src/agent/orchestrator'
import type { AgentToolHost } from '../src/agent/tools'
import type { AssessmentLevel, DemoScenario } from '../src/shared/types'

export async function runDemoScenario(scenario: DemoScenario): Promise<void> {
  let now = Date.now()
  const start = now
  const detector = new MockDetectorAdapter(() => now)
  detector.setDemoScenario(scenario)
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
    console.log(
      `${(i * 0.7).toFixed(1)}s  p=${result.deepfakeProbability.toFixed(2)}  mean=${snapshot.scores?.mean.toFixed(2) ?? 'n/a'}  ${assessment}`
    )
  }

  const order = [...seen]
  console.log('levels seen:', order.join(' -> ') || assessment)
  if (scenario === 'synthetic') {
    if (!seen.has('LOW_RISK') || !seen.has('UNCERTAIN') || !seen.has('HIGH_RISK')) {
      process.exitCode = 1
      console.error('Synthetic demo path incomplete')
    }
  } else if (seen.has('HIGH_RISK') || seen.has('UNCERTAIN')) {
    process.exitCode = 1
    console.error('Authentic demo should stay LOW_RISK')
  } else {
    console.log('Authentic demo stayed LOW_RISK')
  }
}
