import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { setTimeout as delay } from 'node:timers/promises'
import { runChatTurn } from '../src/agent/chatAgent'
import { createModel } from '../src/agent/langchainAgent'
import type { ChatAnalysis, ChatToolEvent } from '../src/shared/types'

type TurnOptions = Parameters<typeof runChatTurn>[0]
type ToolCall = { name: string; args?: object }
type Reply = { text?: string[]; calls?: ToolCall[]; status?: number; streamError?: boolean; skipGate?: boolean; uncertain?: boolean; ids?: string[]; live?: boolean }

async function main() {
  const requests: Array<{ path?: string; authorization?: string; body: any }> = []
  let respond: (body: any) => Reply = () => ({ text: ['Ready.'] })
  let finalStreamFinished = false
  const server = createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = JSON.parse(raw)
    requests.push({ path: req.url, authorization: req.headers.authorization, body })
    let reply = respond(body)
    if (reply.status) {
      res.writeHead(reply.status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'private-chat-key provider internals must remain private' } }))
      return
    }
    // Cooperative models request the required gate; individual scenarios can deliberately skip it.
    if (reply.text && !reply.calls && body.tools?.length && !reply.skipGate) reply = {
      calls: [{ name: 'finalize_assessment', args: { uncertain: reply.uncertain ?? false, attachmentIds: reply.ids ?? [], live: reply.live ?? false } }]
    }
    const id = `chat-check-${requests.length}`
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' })
    res.write(': OPENROUTER PROCESSING\n\n')
    const emit = (delta: object, finishReason: string | null = null, extra: object = {}) => {
      res.write(`data: ${JSON.stringify({
        id, object: 'chat.completion.chunk', created: 1, model: body.model,
        choices: [{ index: 0, delta, finish_reason: finishReason }], ...extra
      })}\n\n`)
    }
    if (reply.streamError) {
      emit({ content: '' }, 'error', { error: { code: 'server_error', message: 'private-chat-key provider internals must remain private' } })
      res.end('data: [DONE]\n\n')
      return
    }
    emit({ role: 'assistant', reasoning_content: 'Hidden reasoning must not be displayed.' })
    if (!body.tools?.length) finalStreamFinished = false
    for (const content of reply.text ?? []) {
      emit({ content })
      await delay(3)
    }
    for (const [index, call] of (reply.calls ?? []).entries()) {
      const args = JSON.stringify(call.args ?? {})
      const split = Math.floor(args.length / 2)
      emit({ tool_calls: [{ index, id: `call-${requests.length}-${index}`, type: 'function', function: { name: call.name, arguments: args.slice(0, split) } }] })
      emit({ tool_calls: [{ index, function: { arguments: args.slice(split) } }] })
    }
    const finish = reply.calls?.length ? 'tool_calls' : 'stop'
    emit({}, finish)
    // OpenRouter's usage frame repeats the finish reason with an empty content delta.
    emit({ role: 'assistant', content: '' }, finish, { usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } })
    res.end('data: [DONE]\n\n')
    if (!body.tools?.length) finalStreamFinished = true
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address && typeof address !== 'string')
  const config = { baseUrl: `http://127.0.0.1:${address.port}/custom/v1`, model: 'local-chat-model', apiKey: 'private-chat-key' }
  const report = (id = 'file-1', changes: Partial<ChatAnalysis['result']> = {}): ChatAnalysis => ({
    attachmentId: id, fileName: '/private/secret-path/recording.mp4', result: {
      videoRisk: 0.72, voiceRisk: null, framesSampled: 8, facesFound: 6,
      voiceSeconds: null, errors: { audio: 'No audio stream' }, calibrated: false,
      jpegBase64: 'raw-media-must-not-leak', ...changes
    } as ChatAnalysis['result']
  })
  const confident = { videoRisk: 0.1, voiceRisk: 0.1, voiceSeconds: 4, errors: {} }
  const toolResults = (body: any): any[] => body.messages.filter((message: any) => message.role === 'tool')
  const call = (name: string, args: object = {}): Reply => ({ calls: [{ name, args }] })
  function prepare(overrides: Partial<TurnOptions> = {}) {
    const actions: string[] = []
    const texts: string[] = []
    const events: ChatToolEvent[] = []
    const analyses: ChatAnalysis[] = []
    let streamedBeforeFinish = false
    const options: TurnOptions = {
      config, history: [{ role: 'user', content: 'Check the attached recording and the live evidence.' }],
      attachments: [{ id: 'file-1', name: 'recording.mp4', size: 1000, path: '/private/secret-path/recording.mp4' } as TurnOptions['attachments'][number]],
      previousAnalyses: [], signal: new AbortController().signal,
      host: {
        getLiveEvidence: async () => { actions.push('live'); return { monitoring: true, liveVoiceAvailable: false, evidence: { validFaceFrames: 5, scores: { mean: 0.61, stdDev: 0.1 } } } },
        analyzeAttachment: async id => { actions.push(`analyze:${id}`); return report(id) },
        gatherAttachmentEvidence: async id => {
          actions.push(`gather:${id}`)
          assert.equal(texts.length, 0, 'No premature decision may stream before additional evidence is gathered')
          return report(id, { additionalEvidence: true, voiceStartSeconds: 4.0375, framesSampled: 16, facesFound: 12 })
        },
        requestLiveSampling: async args => { actions.push('sample'); return { freshEvidenceAvailable: true, newSamples: 5, ...args, evidence: { validFaceFrames: 5, scores: { mean: 0.63, stdDev: 0.1 } } } }
      },
      onText: delta => { texts.push(delta); if (!finalStreamFinished) streamedBeforeFinish = true },
      onTool: event => events.push(event), onAnalysis: analysis => analyses.push(analysis), ...overrides
    }
    return { options, actions, texts, events, analyses, streamed: () => streamedBeforeFinish }
  }

  try {
    respond = body => {
      switch (toolResults(body).length) {
        case 0: return { text: ['Premature claim: this is certainly fake.'], calls: [{ name: 'get_live_evidence' }] }
        case 1: return call('analyze_attachment', { attachmentId: 'file-1' })
        case 2: return call('request_live_sampling', { durationSeconds: 2, framesPerSecond: 1 })
        default: return { text: ['The video score is 0.72. ', 'Voice evidence is unavailable.'] }
      }
    }
    const investigation = prepare()
    const answer = await runChatTurn(investigation.options)
    assert(answer.startsWith('Evidence is insufficient'))
    assert(answer.endsWith('The video score is 0.72. Voice evidence is unavailable.'))
    assert(!answer.includes('Premature') && !answer.includes('Hidden reasoning'))
    assert.equal(investigation.texts.join(''), answer)
    assert(investigation.streamed(), 'Approved final tokens should stream before the HTTP response finishes')
    assert.deepEqual(investigation.actions, ['live', 'analyze:file-1', 'sample', 'gather:file-1'])
    assert.equal(investigation.analyses.length, 2)
    assert.equal(investigation.analyses[1].result.additionalEvidence, true)
    assert.equal(investigation.analyses[1].result.voiceStartSeconds, 4.0375)
    assert.equal(requests.length, 6)
    assert.equal(requests.at(-1)!.body.tool_choice, 'none')
    assert(!requests.at(-1)!.body.tools?.length)
    assert(toolResults(requests.at(-1)!.body).some(message => message.content.includes('freshEvidenceAvailable')))
    for (const request of requests) {
      assert.equal(request.path, '/custom/v1/chat/completions')
      assert.equal(request.authorization, 'Bearer private-chat-key')
      assert.equal(request.body.model, 'local-chat-model')
      assert.equal(request.body.stream, true)
      assert(!request.body.stream_options)
      assert(!JSON.stringify(request.body).includes('secret-path'))
      assert(!JSON.stringify(request.body).includes('jpegBase64'))
      assert(!JSON.stringify(request.body).includes('raw-media-must-not-leak'))
    }

    respond = () => ({ text: ['The prior report found no audio stream.'], ids: ['file-1'] })
    const followup = prepare({ history: [
      ...investigation.options.history, { role: 'assistant', content: answer }, { role: 'user', content: 'Why is voice unavailable?' }
    ], previousAnalyses: investigation.analyses })
    await runChatTurn(followup.options)
    assert.deepEqual(followup.actions, [], 'A fixed additional pass must not be repeated on follow-ups')
    assert(requests.at(-1)!.body.messages.some((message: any) => message.role === 'assistant' && message.content === answer))
    const context = JSON.stringify(requests.at(-1)!.body.messages.find((message: any) => message.role === 'system').content)
    assert(context.includes('No audio stream') && context.includes('additionalEvidence'))
    assert(!context.includes('secret-path') && !context.includes('jpegBase64'))

    respond = body => !toolResults(body).length ? call('get_live_evidence') : { text: ['Video is ready; voice assets are present.'], live: false }
    const readiness = prepare({ history: [{ role: 'user', content: 'Check which detectors are ready.' }] })
    const readinessAnswer = await runChatTurn(readiness.options)
    assert.deepEqual(readiness.actions, ['live'], 'A readiness lookup must not start an authenticity investigation')
    assert(!readinessAnswer.includes('Evidence is insufficient'))

    // Even a model that ignores all tools is forced through initial and additional evidence checks.
    respond = body => ({ text: body.tools?.length ? ['Unreviewed certain verdict.'] : ['The available report remains inconclusive.'], skipGate: true })
    const bypass = prepare({ history: [{ role: 'user', content: 'Is recording.mp4 authentic?' }] })
    await runChatTurn(bypass.options)
    assert.deepEqual(bypass.actions, ['analyze:file-1', 'gather:file-1'])
    assert(!bypass.texts.join('').includes('Unreviewed'))

    // Actual evidence overrides a falsely confident model declaration for every uncertainty trigger.
    for (const change of [
      { videoRisk: 0.5 }, { voiceRisk: null, voiceSeconds: null }, { facesFound: 1 },
      { videoRisk: 0.9, voiceRisk: 0.1 }, { voiceSeconds: 0.5 }, { errors: { video: 'Decode failed' } }
    ]) {
      respond = () => ({ text: ['More evidence was checked.'], ids: ['file-1'], uncertain: false })
      const check = prepare({ previousAnalyses: [report('file-1', { ...confident, ...change })] })
      await runChatTurn(check.options)
      assert.deepEqual(check.actions, ['gather:file-1'])
      assert(check.texts.join('').startsWith('Evidence is insufficient'))
    }
    respond = () => ({ text: ['A fresh pass was checked because I was uncertain.'], ids: ['file-1'], uncertain: true })
    const subjective = prepare({ previousAnalyses: [report('file-1', confident)] })
    await runChatTurn(subjective.options)
    assert.deepEqual(subjective.actions, ['gather:file-1'])

    respond = () => ({ text: ['The detector could not gather further evidence.'], ids: ['file-1'] })
    const failedGather = prepare({ previousAnalyses: [report()] })
    let failedAttempts = 0
    failedGather.options.host.gatherAttachmentEvidence = async () => { failedAttempts++; throw new Error('private-chat-key secret-path') }
    await runChatTurn(failedGather.options)
    assert.equal(failedAttempts, 1)
    assert(failedGather.texts.join('').startsWith('Evidence is insufficient'))
    assert(!JSON.stringify(requests.at(-1)!.body).includes('secret-path'))

    respond = body => ({ text: ['Additional evidence could not be checked.'], ids: ['file-1'], uncertain: toolResults(body).length === 0 })
    const failedDespiteClear = prepare({ previousAnalyses: [report('file-1', confident)] })
    failedDespiteClear.options.host.gatherAttachmentEvidence = async () => { throw new Error('Unavailable') }
    const failedAnswer = await runChatTurn(failedDespiteClear.options)
    assert(failedAnswer.startsWith('Evidence is insufficient'), 'A failed additional pass cannot resolve declared uncertainty')

    respond = () => ({ text: ['The two passes disagree.'], ids: ['file-1'], uncertain: false })
    const disagreement = prepare({ previousAnalyses: [report('file-1', confident), report('file-1', {
      ...confident, videoRisk: 0.9, voiceRisk: 0.9, additionalEvidence: true, voiceStartSeconds: 4.0375
    })] })
    assert((await runChatTurn(disagreement.options)).startsWith('Evidence is insufficient'))
    assert.deepEqual(disagreement.actions, [])
    const priorPasses = JSON.stringify(requests.at(-1)!.body.messages.find((message: any) => message.role === 'system').content)
    assert(priorPasses.includes('0.1') && priorPasses.includes('0.9'), 'Follow-ups retain both initial and additional reports')

    respond = body => ({ text: ['Both reviewed passes have low classifier scores.'], ids: ['file-1'], uncertain: toolResults(body).length === 0 })
    const resolved = prepare({ previousAnalyses: [report('file-1', confident)] })
    resolved.options.host.gatherAttachmentEvidence = async id => report(id, { ...confident, additionalEvidence: true, voiceStartSeconds: 4.0375 })
    assert(!(await runChatTurn(resolved.options)).startsWith('Evidence is insufficient'), 'Successful consistent evidence can resolve subjective uncertainty')

    respond = body => toolResults(body).length < 2 ? call('analyze_attachment', { attachmentId: 'file-1' }) : { text: ['The retry returned a report.'] }
    let attempts = 0
    const recovery = prepare({ previousAnalyses: [report('file-1', { additionalEvidence: true })] })
    recovery.options.host.analyzeAttachment = async () => {
      if (++attempts === 1) throw new Error('/private/secret-path private-chat-key')
      return report('file-1', { errors: { audio: 'No audio stream', video: 'ffmpeg failed for /private/secret-path/temporary-upload' } })
    }
    await runChatTurn(recovery.options)
    assert.equal(attempts, 2)
    assert.equal(recovery.analyses.length, 1)
    assert(toolResults(requests.at(-1)!.body)[0].content.includes('Attachment analysis failed'))
    assert(!JSON.stringify(recovery.events).includes('private-chat-key'))
    assert(!JSON.stringify(requests.at(-1)!.body).includes('secret-path'))
    assert(recovery.analyses[0].result.errors.video?.includes('temporary-upload'))

    respond = body => {
      switch (toolResults(body).length) {
        case 0: return call('analyze_attachment', { attachmentId: '/private/arbitrary.mp4' })
        case 1: return call('request_live_sampling', { durationSeconds: 100, framesPerSecond: 1 })
        case 2: return call('gather_attachment_evidence', { attachmentId: '/private/arbitrary.mp4' })
        default: return { text: ['The invalid requests were rejected.'] }
      }
    }
    const invalid = prepare()
    await runChatTurn(invalid.options)
    assert.deepEqual(invalid.actions, [])
    assert.equal(invalid.events.filter(event => event.status === 'error').length, 3)
    assert(toolResults(requests.at(-1)!.body)[0].content.includes('Unknown attachment ID'))
    assert(toolResults(requests.at(-1)!.body)[1].content.includes('Invalid tool arguments'))

    const boundedCalls: ToolCall[] = [
      { name: 'analyze_attachment', args: { attachmentId: 'file-1' } },
      { name: 'analyze_attachment', args: { attachmentId: 'file-2' } },
      { name: 'analyze_attachment', args: { attachmentId: 'file-3' } },
      { name: 'analyze_attachment', args: { attachmentId: 'file-4' } },
      { name: 'analyze_attachment', args: { attachmentId: 'file-1' } },
      { name: 'analyze_attachment', args: { attachmentId: 'file-1' } },
      { name: 'request_live_sampling', args: { durationSeconds: 2, framesPerSecond: 1 } },
      { name: 'request_live_sampling', args: { durationSeconds: 2, framesPerSecond: 1 } }
    ]
    respond = body => {
      const next = boundedCalls[toolResults(body).length]
      return next ? { calls: [next] } : { text: ['The bounded checks are complete.'] }
    }
    const bounded = prepare({ attachments: [1, 2, 3, 4].map(index => ({ id: `file-${index}`, name: `clip-${index}.mp4`, size: 1000 })) })
    await runChatTurn(bounded.options)
    assert.deepEqual(bounded.actions, ['analyze:file-1', 'analyze:file-2', 'analyze:file-3', 'analyze:file-1', 'sample'])
    assert.equal(bounded.events.filter(event => event.status === 'error').length, 3)
    assert(bounded.texts.join('').startsWith('Evidence is insufficient'))

    respond = () => call('get_live_evidence')
    const loop = prepare()
    const beforeLoop = requests.length
    await assert.rejects(runChatTurn(loop.options), /eight-tool limit/)
    assert.equal(loop.actions.length, 8)
    assert(requests.length - beforeLoop <= 9)

    const beforeMissing = requests.length
    await assert.rejects(runChatTurn(prepare({ config: null as unknown as TurnOptions['config'] }).options), /Configure a model endpoint/)
    assert.equal(requests.length, beforeMissing)
    for (const reply of [{ status: 401 }, { streamError: true }]) {
      respond = () => reply
      await assert.rejects(runChatTurn(prepare().options), error => {
        assert(error instanceof Error && error.message.includes('configured model could not finish'))
        assert(!error.message.includes('private-chat-key') && !error.message.includes('provider internals'))
        return true
      })
    }

    // The same real SDK accepts OpenRouter's /api/v1 route and provider/model IDs.
    const routerConfig = { ...config, baseUrl: `http://127.0.0.1:${address.port}/api/v1`, model: 'openai/test-tool-model' }
    assert(createModel({ ...routerConfig, baseUrl: 'https://openrouter.ai/api/v1' }))
    respond = () => ({ text: ['OpenRouter-format ', 'SSE parsed successfully.'] })
    await runChatTurn(prepare({ config: routerConfig, attachments: [] }).options)
    assert.equal(requests.at(-1)!.path, '/api/v1/chat/completions')
    assert.equal(requests.at(-1)!.body.model, 'openai/test-tool-model')

    respond = () => ({ text: ['No verdict yet.'], ids: ['file-1'] })
    const controller = new AbortController()
    let started: () => void = () => undefined
    let release: (analysis: ChatAnalysis) => void = () => undefined
    let hostSignal: AbortSignal | undefined
    const pending = new Promise<void>(resolve => { started = resolve })
    const cancelled = prepare({ signal: controller.signal, previousAnalyses: [report()] })
    cancelled.options.host.gatherAttachmentEvidence = async (_id, signal) => {
      hostSignal = signal
      started()
      return new Promise<ChatAnalysis>(resolve => { release = resolve })
    }
    const running = runChatTurn(cancelled.options)
    await pending
    controller.abort()
    await assert.rejects(running, /Chat stopped/)
    assert(hostSignal?.aborted)
    const countAtStop = cancelled.events.length
    release(report('file-1', { additionalEvidence: true }))
    await delay(40)
    assert.equal(cancelled.events.length, countAtStop)
    assert.equal(cancelled.analyses.length, 0)
    assert.equal(cancelled.texts.length, 0)
    console.log('Chat agent checks passed: OpenRouter SSE, endpoint routing, gated final streaming, enforced extra evidence, uncertainty, prior-pass reuse, recovery, budgets, and cancellation.')
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1 })
