import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { runSentinelDecision, testAgentConnection } from '../src/agent/langchainAgent'
import { EvidenceAggregator } from '../src/evidence/aggregator'
import type { AgentToolHost } from '../src/agent/tools'
import type { AssessmentLevel, EvidenceSnapshot } from '../src/shared/types'

async function main() {
  type Scenario = 'investigate' | 'text' | 'error' | 'high' | 'sparse' | 'abort' | 'connection' | 'loop' | 'stale'
  let scenario: Scenario = 'investigate'
  const requests: Array<{ path?: string; authorization?: string; body: any }> = []
  let waitingOnAbort: () => void = () => undefined
  let beforeAssessment: () => void = () => undefined
  const server = createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    requests.push({ path: req.url, authorization: req.headers.authorization, body })
    const results = body.messages.filter((message: any) => message.role === 'tool')
    const count = results.length
    let message: object = { role: 'assistant', content: 'Done.' }
    const call = (name: string, args: object = {}) => ({
      role: 'assistant', content: null,
      tool_calls: [{ id: `call_${count}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }]
    })

    if (scenario === 'error') {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'private-test-key provider response must stay private' } }))
      return
    }
    if (scenario === 'connection') {
      message = count ? { role: 'assistant', content: 'sentinel-ready' } : call('check_connection')
    } else if (scenario !== 'text') {
      if (!count || scenario === 'loop') message = call('get_recent_detection_evidence')
      else if (scenario === 'investigate' && count === 1) {
        message = call('request_additional_sampling', { durationSeconds: 6, framesPerSecond: 2.5 })
      } else if ((scenario === 'investigate' && count === 2) || (scenario !== 'investigate' && count === 1)) {
        if (scenario === 'stale') beforeAssessment()
        if (scenario === 'abort') {
          waitingOnAbort()
          await delay(120)
        }
        message = call('set_user_assessment', {
          level: scenario === 'high' || scenario === 'stale' ? 'HIGH_RISK' : scenario === 'sparse' ? 'LOW_RISK' : 'UNCERTAIN',
          explanation: 'Invented blinking claim must not be published.'
        })
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      id: `local-check-${requests.length}`, object: 'chat.completion', created: 1, model: body.model,
      choices: [{ index: 0, message, finish_reason: 'tool_calls' in message ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
    }))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address && typeof address !== 'string')
  const config = { baseUrl: `http://127.0.0.1:${address.port}/custom/v1`, model: 'local-tool-model', apiKey: 'private-test-key' }

  const evidence = new EvidenceAggregator()
  for (let i = 0; i < 6; i++) evidence.add({ timestamp: Date.now(), deepfakeProbability: 0.48, faceDetected: true })
  const snapshot = evidence.snapshot()
  const empty = new EvidenceAggregator().snapshot()

  function prepare(current: EvidenceSnapshot = snapshot, signal = new AbortController().signal) {
    const actions: string[] = []
    const events: string[] = []
    const modes: string[] = []
    const assessments: Array<{ level: AssessmentLevel; explanation: string }> = []
    const host: AgentToolHost = {
      getEvidence: () => current,
      requestAdditionalSampling: (args) => {
        actions.push('sample')
        return { samplingMode: 'INTENSIVE', ...args }
      },
      setAssessment: (assessment) => {
        actions.push('publish')
        assessments.push(assessment)
        return { level: assessment.level }
      }
    }
    return {
      actions, events, modes, assessments, host,
      updateEvidence: (next: EvidenceSnapshot) => { current = next },
      options: { config, signal, onEvent: (event: string) => events.push(event), onMode: (mode: 'langchain' | 'fallback') => modes.push(mode) }
    }
  }

  try {
    const investigation = prepare()
    assert.equal(await runSentinelDecision(snapshot, investigation.host, 0, investigation.options), 'UNCERTAIN')
    assert.deepEqual(investigation.actions, ['sample', 'publish'])
    assert.deepEqual(investigation.modes, ['langchain'], JSON.stringify(investigation.events))
    assert(investigation.events.some((event) => event.includes('Awaiting new evidence')))
    assert(!investigation.assessments[0].explanation.includes('blinking'))
    assert.equal(requests.length, 4, 'Agent must process tool results across model turns')
    const finalMessages = requests.at(-1)!.body.messages
    assert(finalMessages.some((message: any) => message.role === 'tool' && message.content.includes('validFaceFrames')))
    assert(finalMessages.some((message: any) => message.role === 'tool' && message.content.includes('"freshEvidenceAvailable":false')))
    for (const request of requests) {
      assert.equal(request.path, '/custom/v1/chat/completions')
      assert.equal(request.authorization, 'Bearer private-test-key')
      assert.equal(request.body.model, 'local-tool-model')
      assert(!request.body.stream)
      assert(!request.body.stream_options)
      assert(!JSON.stringify(request.body).includes('jpegBase64'))
    }

    scenario = 'high'
    const high = prepare()
    assert.equal(await runSentinelDecision(snapshot, high.host, 0, high.options), 'UNCERTAIN')
    assert(high.events.some((event) => event.includes('Evidence rules changed')))
    const elevated = { ...snapshot, scores: { mean: 0.9, median: 0.9, min: 0.9, max: 0.9, stdDev: 0 } }
    const persistent = prepare(elevated)
    assert.equal(await runSentinelDecision(elevated, persistent.host, 6, persistent.options), 'HIGH_RISK')

    scenario = 'stale'
    const initialHigh = {
      ...elevated, sampleCount: 5, validFaceFrames: 5,
      scores: { mean: 1, median: 1, min: 1, max: 1, stdDev: 0 },
      latestSample: { timestamp: Date.now(), deepfakeProbability: 1, faceDetected: true }
    }
    const changed = {
      ...snapshot, scores: { mean: 5 / 6, median: 1, min: 0, max: 1, stdDev: Math.sqrt(5 / 36) },
      trend: 'falling' as const,
      latestSample: { timestamp: Date.now(), deepfakeProbability: 0, faceDetected: true }
    }
    const stale = prepare(initialHigh)
    let currentStreak = 5
    beforeAssessment = () => {
      stale.updateEvidence(changed)
      currentStreak = 0
    }
    assert.equal(await runSentinelDecision(initialHigh, stale.host, 5, {
      ...stale.options, getHighStreak: () => currentStreak
    }), 'UNCERTAIN', 'New low samples during inference must invalidate the old high streak')
    assert.deepEqual(stale.modes, ['langchain'])
    const changedFallback = prepare(changed)
    assert.equal(await runSentinelDecision(initialHigh, changedFallback.host, 5, {
      ...changedFallback.options, config: null, getHighStreak: () => 0
    }), 'UNCERTAIN', 'Fallback must also use the current streak')

    scenario = 'sparse'
    const sparse = prepare(empty)
    assert.equal(await runSentinelDecision(empty, sparse.host, 0, sparse.options), 'UNCERTAIN')
    assert(sparse.assessments[0].explanation.includes('Insufficient'))

    for (const failure of ['text', 'error'] as const) {
      scenario = failure
      const failed = prepare()
      await runSentinelDecision(snapshot, failed.host, 0, failed.options)
      assert.deepEqual(failed.modes, ['fallback'])
      assert(failed.events.some((event) => event.includes('Using local evidence rules')))
      assert(!JSON.stringify(failed.events).includes(config.apiKey))
    }

    const unconfigured = prepare(empty)
    const before = requests.length
    assert.equal(await runSentinelDecision(empty, unconfigured.host, 0, { ...unconfigured.options, config: null }), 'UNCERTAIN')
    assert.equal(requests.length, before, 'No endpoint configured must mean no API request')
    const low = { ...snapshot, scores: { mean: 0.1, median: 0.1, min: 0.1, max: 0.1, stdDev: 0 } }
    const stable = prepare(low)
    assert.equal(await runSentinelDecision(low, stable.host, 0, stable.options), 'LOW_RISK')
    assert.equal(requests.length, before, 'Stable low scores must not trigger an endpoint request')
    assert.deepEqual(stable.modes, ['fallback'])
    assert(stable.events.includes('Scores are stable and low. Local rules continue monitoring.'))

    scenario = 'loop'
    const loop = prepare()
    const beforeLoop = requests.length
    await runSentinelDecision(snapshot, loop.host, 0, loop.options)
    assert.deepEqual(loop.modes, ['fallback'])
    assert(requests.length - beforeLoop <= 7, 'Repeated tool calls must hit the investigation budget')

    scenario = 'connection'
    assert.equal((await testAgentConnection(config)).ok, true)
    assert(requests.at(-1)!.body.messages.some((message: any) => message.role === 'tool' && message.content.includes('sentinel-ready')))
    scenario = 'text'
    assert.equal((await testAgentConnection(config)).ok, false)
    scenario = 'error'
    const failure = await testAgentConnection(config)
    assert.equal(failure.ok, false)
    assert(!failure.message.includes(config.apiKey))

    scenario = 'abort'
    const controller = new AbortController()
    const cancelled = prepare(snapshot, controller.signal)
    const reachedPendingRequest = new Promise<void>((resolve) => { waitingOnAbort = resolve })
    const running = runSentinelDecision(snapshot, cancelled.host, 0, cancelled.options)
    await reachedPendingRequest
    controller.abort()
    await running
    const eventsAtStop = cancelled.events.length
    await delay(160)
    assert.deepEqual(cancelled.actions, [], 'Delayed tool calls must not change a stopped session')
    assert.equal(cancelled.events.length, eventsAtStop)
    assert.deepEqual(cancelled.modes, [])
    console.log('Agent checks passed: tool loop, endpoint routing, evidence guards, fallback, connection check, cancellation.')
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
}

void main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
