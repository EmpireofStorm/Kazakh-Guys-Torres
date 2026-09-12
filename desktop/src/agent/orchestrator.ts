import { CONSERVATIVE_COPY } from './instructions'
import type { AgentToolHost } from './tools'
import type { AssessmentLevel, EvidenceSnapshot } from '../shared/types'

const HIGH_MEAN = 0.7
const LOW_MEAN = 0.28
const UNSTABLE_STD = 0.18

export function shouldInvokeAgent(snapshot: EvidenceSnapshot): boolean {
  if (snapshot.sampleCount < 3) return snapshot.validFaceFrames < 2
  if (snapshot.validFaceFrames < 3) return true
  if (!snapshot.scores) return true
  if (snapshot.scores.mean >= 0.42) return true
  if (snapshot.scores.stdDev >= UNSTABLE_STD) return true
  if (snapshot.trend === 'rising') return true
  return false
}

export function decideFromEvidence(snapshot: EvidenceSnapshot, host: AgentToolHost): AssessmentLevel {
  const evidence = host.getEvidence()
  const stats = evidence.scores

  if (evidence.validFaceFrames < 3 || !stats) {
    if (evidence.sampleCount < 4 && (!stats || stats.mean < 0.4)) {
      host.setAssessment({
        level: 'LOW_RISK',
        explanation: CONSERVATIVE_COPY.LOW_RISK
      })
      return 'LOW_RISK'
    }
    host.requestAdditionalSampling({ durationSeconds: 6, framesPerSecond: 2.5 })
    host.setAssessment({
      level: 'UNCERTAIN',
      explanation: CONSERVATIVE_COPY.UNCERTAIN
    })
    return 'UNCERTAIN'
  }

  const { mean, stdDev } = stats
  const unstable = stdDev >= UNSTABLE_STD || evidence.trend === 'rising'
  const persistentlyHigh = mean >= HIGH_MEAN && evidence.validFaceFrames >= 6
  const recoveredHigh =
    evidence.previousAssessment === 'UNCERTAIN' &&
    mean >= 0.75 &&
    evidence.validFaceFrames >= 8 &&
    stdDev < 0.22
  const clearlyLow = mean <= LOW_MEAN && stdDev < UNSTABLE_STD && evidence.trend !== 'rising'

  if ((persistentlyHigh && !unstable) || recoveredHigh) {
    host.setAssessment({
      level: 'HIGH_RISK',
      explanation: CONSERVATIVE_COPY.HIGH_RISK
    })
    return 'HIGH_RISK'
  }

  if (persistentlyHigh && unstable) {
    host.requestAdditionalSampling({ durationSeconds: 8, framesPerSecond: 2.5 })
    host.setAssessment({
      level: 'UNCERTAIN',
      explanation: CONSERVATIVE_COPY.UNCERTAIN
    })
    return 'UNCERTAIN'
  }

  if (unstable || mean >= 0.4) {
    host.requestAdditionalSampling({ durationSeconds: 8, framesPerSecond: 2.5 })
    host.setAssessment({
      level: 'UNCERTAIN',
      explanation: CONSERVATIVE_COPY.UNCERTAIN
    })
    return 'UNCERTAIN'
  }

  if (clearlyLow) {
    host.setAssessment({
      level: 'LOW_RISK',
      explanation: CONSERVATIVE_COPY.LOW_RISK
    })
    return 'LOW_RISK'
  }

  host.setAssessment({
    level: 'LOW_RISK',
    explanation: CONSERVATIVE_COPY.LOW_RISK
  })
  return 'LOW_RISK'
}

export function decideWithPersistence(
  snapshot: EvidenceSnapshot,
  host: AgentToolHost,
  highStreak: number
): AssessmentLevel {
  if (
    snapshot.scores &&
    snapshot.scores.mean >= 0.76 &&
    highStreak >= 5 &&
    snapshot.validFaceFrames >= 5
  ) {
    host.setAssessment({
      level: 'HIGH_RISK',
      explanation: CONSERVATIVE_COPY.HIGH_RISK
    })
    return 'HIGH_RISK'
  }
  return decideFromEvidence(snapshot, host)
}
