import { ChatOpenAI } from '@langchain/openai'
import { createAgent, tool } from 'langchain'
import { z } from 'zod'
import { CONSERVATIVE_COPY, SENTINEL_AGENT_INSTRUCTIONS } from './instructions'
import { decideWithPersistence, shouldInvokeAgent } from './orchestrator'
import { additionalSamplingSchema, createToolFns, setAssessmentSchema } from './tools'
import type { AgentToolHost } from './tools'
import type { AssessmentLevel, EvidenceSnapshot } from '../shared/types'

export interface CompatibleAgentConfig {
  baseUrl: string
  model: string
  apiKey: string
}

const AGENT_TIMEOUT_MS = 12_000

function createModel(config: CompatibleAgentConfig): ChatOpenAI {
  const url = new URL(config.baseUrl)
  if (!['https:', 'http:'].includes(url.protocol) || !config.model.trim()) {
    throw new Error('Invalid agent configuration')
  }
  return new ChatOpenAI({
    model: config.model,
    apiKey: config.apiKey || 'not-required',
    configuration: { baseURL: config.baseUrl },
    useResponsesApi: false,
    streamUsage: false,
    streaming: false,
    maxRetries: 0,
    timeout: AGENT_TIMEOUT_MS
  })
}

async function withDeadline<T>(
  parent: AbortSignal | undefined,
  work: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController()
  const signal = parent ? AbortSignal.any([parent, controller.signal]) : controller.signal
  const timer = setTimeout(() => controller.abort(new Error('Agent timed out')), AGENT_TIMEOUT_MS)
  let onAbort: () => void = () => undefined
  try {
    signal.throwIfAborted()
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason)
      signal.addEventListener('abort', onAbort, { once: true })
    })
    return await Promise.race([work(signal), aborted])
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', onAbort)
    // Close the tool gate even if an endpoint ignores transport cancellation.
    controller.abort()
  }
}

function policyLevel(evidence: EvidenceSnapshot, highStreak: number): AssessmentLevel {
  if (!evidence.scores || evidence.validFaceFrames < 3) return 'UNCERTAIN'
  return decideWithPersistence(evidence, {
    getEvidence: () => evidence,
    requestAdditionalSampling: (args) => ({ samplingMode: 'INTENSIVE', ...args }),
    setAssessment: ({ level }) => ({ level })
  }, highStreak)
}

function factualExplanation(level: AssessmentLevel, evidence: EvidenceSnapshot): string {
  if (!evidence.scores || evidence.validFaceFrames < 3) {
    return 'Insufficient video evidence. Collecting more valid face samples. Voice analysis is unavailable.'
  }
  return `${CONSERVATIVE_COPY[level]} Video score mean ${evidence.scores.mean.toFixed(2)} across ${evidence.validFaceFrames} valid face samples; trend ${evidence.trend}. Voice analysis is unavailable.`
}

export async function runSentinelDecision(
  snapshot: EvidenceSnapshot,
  host: AgentToolHost,
  highStreak: number,
  options: {
    config: CompatibleAgentConfig | null
    signal: AbortSignal
    getHighStreak?: () => number
    onEvent: (message: string) => void
    onMode: (mode: 'langchain' | 'fallback') => void
  }
): Promise<AssessmentLevel> {
  const cancelledLevel = snapshot.previousAssessment ?? 'UNCERTAIN'
  if (options.signal.aborted) return cancelledLevel
  let samplingResult: ReturnType<AgentToolHost['requestAdditionalSampling']> | undefined
  const requestSampling: AgentToolHost['requestAdditionalSampling'] = (args) =>
    samplingResult ??= host.requestAdditionalSampling(args)

  const fallback = (reason: string): AssessmentLevel => {
    if (options.signal.aborted) return cancelledLevel
    options.onMode('fallback')
    options.onEvent(reason)
    const evidence = host.getEvidence()
    if (!evidence.scores || evidence.validFaceFrames < 3) {
      requestSampling({ durationSeconds: 6, framesPerSecond: 2.5 })
      host.setAssessment({ level: 'UNCERTAIN', explanation: factualExplanation('UNCERTAIN', evidence) })
      return 'UNCERTAIN'
    }
    return decideWithPersistence(evidence, { ...host, requestAdditionalSampling: requestSampling }, options.getHighStreak?.() ?? highStreak)
  }

  if (!options.config) return fallback('No agent endpoint configured. Using local evidence rules.')
  if (!shouldInvokeAgent(snapshot) && snapshot.scores && snapshot.scores.mean < 0.35) {
    return fallback('Scores are stable and low. Local rules continue monitoring.')
  }

  try {
    return await withDeadline(options.signal, async (signal) => {
      let published: AssessmentLevel | null = null
      let readEvidence = false
      let toolCalls = 0
      const beforeTool = () => {
        signal.throwIfAborted()
        if (++toolCalls > 6) throw new Error('Agent tool budget exhausted')
      }
      const fns = createToolFns({
        getEvidence: () => {
          beforeTool()
          readEvidence = true
          options.onEvent('Agent read recent video scores. Voice analysis is unavailable.')
          return host.getEvidence()
        },
        requestAdditionalSampling: (args) => {
          beforeTool()
          if (!readEvidence) throw new Error('Read evidence before choosing an action')
          if (samplingResult) throw new Error('Sampling already requested in this investigation')
          const result = requestSampling(args)
          options.onEvent(`Agent requested ${result.durationSeconds} more seconds at ${result.framesPerSecond} frames/s. Awaiting new evidence.`)
          return result
        },
        setAssessment: ({ level }) => {
          beforeTool()
          if (!readEvidence) throw new Error('Read evidence before publishing an assessment')
          if (published) return { level: published }
          const evidence = host.getEvidence()
          const permitted = policyLevel(evidence, options.getHighStreak?.() ?? highStreak)
          const guarded = (level === 'HIGH_RISK' && permitted !== 'HIGH_RISK') ||
            (level === 'LOW_RISK' && permitted !== 'LOW_RISK')
          published = guarded ? 'UNCERTAIN' : level
          host.setAssessment({ level: published, explanation: factualExplanation(published, evidence) })
          options.onEvent(guarded
            ? `Evidence rules changed the requested ${level} assessment to UNCERTAIN.`
            : `Agent published ${published.replaceAll('_', ' ').toLowerCase()} from the available scores.`)
          return { level: published }
        }
      })

      const agent = createAgent({
        model: createModel(options.config!),
        systemPrompt: SENTINEL_AGENT_INSTRUCTIONS,
        tools: [
          tool(fns.get_recent_detection_evidence, {
            name: 'get_recent_detection_evidence',
            description: 'Read the current rolling video-score statistics. Voice scores are unavailable.',
            schema: z.object({})
          }),
          tool((args) => ({ ...fns.request_additional_sampling(args), status: 'scheduled', freshEvidenceAvailable: false }), {
            name: 'request_additional_sampling',
            description: 'Schedule one bounded video sampling window. Returns immediately; fresh results arrive in a later investigation.',
            schema: additionalSamplingSchema
          }),
          tool(fns.set_user_assessment, {
            name: 'set_user_assessment',
            description: 'Publish an assessment constrained by evidence rules. The application generates factual wording from the scores.',
            schema: setAssessmentSchema
          })
        ]
      })
      options.onEvent('Agent started an evidence investigation.')
      await agent.invoke({ messages: [{
        role: 'user',
        content: 'Read the current evidence with your tool. Choose whether another sampling window is needed, then publish an assessment. Never treat scheduled sampling as completed.'
      }] }, { signal, recursionLimit: 12 })
      signal.throwIfAborted()
      if (!published) throw new Error('No assessment tool action')
      options.onMode('langchain')
      return published
    })
  } catch (error) {
    if (options.signal.aborted) return cancelledLevel
    return fallback(error instanceof Error && error.message === 'No assessment tool action'
      ? 'Agent returned without publishing an assessment through its tool. Using local evidence rules.'
      : 'Agent endpoint failed, timed out, or could not complete tool calls. Using local evidence rules.')
  }
}

export async function testAgentConnection(
  config: CompatibleAgentConfig,
  signal?: AbortSignal
): Promise<{ ok: boolean; message: string }> {
  try {
    return await withDeadline(signal, async (activeSignal) => {
      let called = false
      const agent = createAgent({
        model: createModel(config),
        systemPrompt: 'Call check_connection exactly once, then reply with the token it returns. This is a connection check with no user media.',
        tools: [tool(() => {
          activeSignal.throwIfAborted()
          called = true
          return { token: 'sentinel-ready' }
        }, {
          name: 'check_connection',
          description: 'Return a harmless token to check function-tool support.',
          schema: z.object({})
        })]
      })
      const result = await agent.invoke({ messages: [{ role: 'user', content: 'Check the connection now.' }] }, {
        signal: activeSignal,
        recursionLimit: 6
      })
      activeSignal.throwIfAborted()
      if (!called || !JSON.stringify(result.messages.at(-1)?.content).includes('sentinel-ready')) {
        return { ok: false, message: 'Endpoint responded but did not complete the function-tool check. Choose a model with tool support.' }
      }
      return { ok: true, message: 'Connected. The selected model completed a function-tool roundtrip.' }
    })
  } catch {
    return { ok: false, message: signal?.aborted
      ? 'Connection check cancelled.'
      : 'Connection or function-tool check failed. Check the base URL, model, API key, and endpoint tool support.' }
  }
}
