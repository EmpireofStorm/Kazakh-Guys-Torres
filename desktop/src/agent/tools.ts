import { z } from 'zod'
import type { AssessmentLevel, EvidenceSnapshot, SamplingMode } from '../shared/types'

export const assessmentLevelSchema = z.enum(['LOW_RISK', 'UNCERTAIN', 'HIGH_RISK'])

export const additionalSamplingSchema = z.object({
  durationSeconds: z.number().min(2).max(20),
  framesPerSecond: z.number().min(1).max(4)
})

export const setAssessmentSchema = z.object({
  level: assessmentLevelSchema,
  explanation: z.string().min(8).max(600)
})

export interface AgentToolHost {
  getEvidence(): EvidenceSnapshot
  requestAdditionalSampling(args: { durationSeconds: number; framesPerSecond: number }): {
    samplingMode: SamplingMode
    framesPerSecond: number
    durationSeconds: number
  }
  setAssessment(args: { level: AssessmentLevel; explanation: string }): {
    level: AssessmentLevel
  }
}

export function createToolFns(host: AgentToolHost) {
  return {
    get_recent_detection_evidence: () => host.getEvidence(),
    request_additional_sampling: (raw: unknown) =>
      host.requestAdditionalSampling(additionalSamplingSchema.parse(raw)),
    set_user_assessment: (raw: unknown) => host.setAssessment(setAssessmentSchema.parse(raw))
  }
}
