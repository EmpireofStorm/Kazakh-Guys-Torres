import { CONSERVATIVE_COPY, SENTINEL_AGENT_INSTRUCTIONS } from './instructions'
import { decideWithPersistence, shouldInvokeAgent } from './orchestrator'
import type { AgentToolHost } from './tools'
import { hasOpenAIKey } from '../main/env'
import type { AssessmentLevel, EvidenceSnapshot } from '../shared/types'

export async function runSentinelDecision(
  snapshot: EvidenceSnapshot,
  host: AgentToolHost,
  highStreak: number
): Promise<AssessmentLevel> {
  if (!shouldInvokeAgent(snapshot) && snapshot.scores && snapshot.scores.mean < 0.35) {
    host.setAssessment({
      level: 'LOW_RISK',
      explanation: CONSERVATIVE_COPY.LOW_RISK
    })
    return 'LOW_RISK'
  }

  if (!hasOpenAIKey()) {
    return decideWithPersistence(snapshot, host, highStreak)
  }

  try {
    const { Agent, run, tool } = await import('@openai/agents')
    const { z } = await import('zod')

    const getEvidence = tool({
      name: 'get_recent_detection_evidence',
      description: 'Return the current 10-second evidence snapshot. Statistics are already computed.',
      parameters: z.object({}),
      execute: async () => host.getEvidence()
    })

    const requestSampling = tool({
      name: 'request_additional_sampling',
      description: 'Temporarily increase frame sampling while evidence is insufficient or unstable.',
      parameters: z.object({
        durationSeconds: z.number(),
        framesPerSecond: z.number()
      }),
      execute: async ({ durationSeconds, framesPerSecond }) =>
        host.requestAdditionalSampling({ durationSeconds, framesPerSecond })
    })

    const setAssessment = tool({
      name: 'set_user_assessment',
      description: 'Publish a conservative user-facing assessment.',
      parameters: z.object({
        level: z.enum(['LOW_RISK', 'UNCERTAIN', 'HIGH_RISK']),
        explanation: z.string()
      }),
      execute: async ({ level, explanation }) => host.setAssessment({ level, explanation })
    })

    const agent = new Agent({
      name: 'SENTINEL',
      instructions: SENTINEL_AGENT_INSTRUCTIONS,
      tools: [getEvidence, requestSampling, setAssessment]
    })

    const result = await Promise.race([
      run(agent, `Evaluate this evidence snapshot and use tools. Snapshot: ${JSON.stringify(snapshot)}`),
      new Promise((_, reject) => setTimeout(() => reject(new Error('agent-timeout')), 8000))
    ])

    void result
    const latest = host.getEvidence()
    return latest.previousAssessment ?? decideWithPersistence(snapshot, host, highStreak)
  } catch {
    return decideWithPersistence(snapshot, host, highStreak)
  }
}
