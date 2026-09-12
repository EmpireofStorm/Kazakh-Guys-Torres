import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ChatSession } from '../src/main/chatSession'
import type { runChatTurn } from '../src/agent/chatAgent'
import type { MediaAnalysis } from '../src/shared/types'

async function main() {
  const directory = mkdtempSync(join(tmpdir(), 'sentinel-chat-check-'))
  const path = join(directory, 'history.json')
  const media = join(directory, 'selected.wav')
  const unsent = join(directory, 'not-sent.wav')
  writeFileSync(media, 'mock-wave')
  writeFileSync(unsent, 'private-pending-file')
  const config = { baseUrl: 'http://localhost:1234/v1', model: 'check-model', apiKey: 'secret-never-saved' }
  const result: MediaAnalysis = { videoRisk: null, voiceRisk: .8, framesSampled: 0, facesFound: 0, voiceSeconds: 4, errors: {video:'No video stream'}, calibrated: false }
  let analyses = 0
  const additionalPasses: boolean[] = []
  let busy = false
  let turns = 0
  const runTurn: typeof runChatTurn = async options => {
    turns++
    assert.equal(options.attachments.length, 1, 'Do not send pending or removed attachments to the model')
    assert.equal(JSON.stringify(options).includes(directory), false, 'No local paths in agent context')
    if (turns === 1) {
      options.onTool({ id:'tool-1', name:'analyze_attachment', status:'running', summary:'Checking selected.wav' })
      const report = await options.host.analyzeAttachment(options.attachments[0].id, options.signal)
      options.onAnalysis(report)
      options.onTool({ id:'tool-1', name:'analyze_attachment', status:'complete', summary:'Voice evidence ready' })
    } else {
      assert.equal(options.previousAnalyses.length, turns === 2 ? 1 : 2)
      assert.ok(options.history.some(message => message.role === 'assistant' && message.content === 'Voice score 0.8.'))
      if (turns === 2) options.onAnalysis(await options.host.gatherAttachmentEvidence(options.attachments[0].id, options.signal))
    }
    options.onText('Voice score ')
    options.onText('0.8.')
    return 'Voice score 0.8.'
  }
  const host = { getLiveEvidence: () => ({monitoring:false}), requestLiveSampling: async () => ({}), onBusy: (value:boolean) => {busy=value} }
  try {
    const session = new ChatSession(path, () => config, host, runTurn, async (_path, _signal, additional = false) => {
      analyses++; additionalPasses.push(additional)
      return additional ? { ...result, additionalEvidence: true, voiceStartSeconds: 4.0375 } : result
    })
    const firstChat = session.getState().activeConversation.id
    const [file] = session.addAttachments([media], firstChat)
    session.addAttachments([unsent], firstChat)
    const states: string[] = []
    session.subscribe(state => states.push(state.activeConversation.messages.at(-1)?.content || ''))
    await session.send({content:'Analyze this voice clip',attachmentIds:[file.id]})
    assert.equal(analyses, 1)
    assert.equal(busy, false)
    assert.ok(states.includes('Voice score '), 'Stream text into the UI before completion')
    const state = session.getState()
    assert.equal(state.activeConversation.messages[1].tools[0].status, 'complete')
    assert.equal(state.activeConversation.messages[1].analyses[0].result.voiceRisk, .8)
    assert.equal(JSON.stringify(state).includes(directory), false)
    assert.equal(readFileSync(path,'utf8').includes(config.apiKey), false)
    assert.equal(statSync(path).mode & 0o777, 0o600)
    await session.send({content:'Why is it uncertain?'})
    assert.equal(analyses, 2)
    assert.deepEqual(additionalPasses, [false, true], 'Gathering evidence must request a distinct media pass')
    assert.equal(session.getState().activeConversation.messages.at(-1)?.analyses[0].result.voiceStartSeconds, 4.0375)
    const reloaded = new ChatSession(path, () => config, host, runTurn)
    assert.equal(reloaded.getState().activeConversation.messages.length, 4)
    session.newChat()
    assert.equal(session.getState().activeConversation.messages.length, 0)
    await assert.rejects(session.send({content:'Analyze previous file',attachmentIds:[file.id]}), /not available/)
    session.selectChat(firstChat)
    assert.equal(session.getState().activeConversation.messages.length, 4)
    await assert.rejects(session.send({content:'Bad attachment',attachmentIds:[randomUUID()]}), /not available/)

    let release!: () => void
    let invoked!: () => void
    const entered = new Promise<void>(resolve => {invoked=resolve})
    const slow: typeof runChatTurn = async options => {
      options.onTool({id:'late',name:'analyze_attachment',status:'running',summary:'Working'})
      invoked()
      await new Promise<void>(resolve => {release=resolve})
      options.onText('Late text must not appear')
      options.onAnalysis({attachmentId:file.id,fileName:file.name,result})
      return 'Late final must not appear'
    }
    const cancelled = new ChatSession(join(directory,'cancel.json'),()=>config,host,slow)
    const pending = cancelled.send({content:'Hello'})
    await entered
    cancelled.cancel()
    assert.equal(cancelled.getState().busy,false)
    assert.equal(cancelled.getState().activeConversation.messages.at(-1)?.status,'cancelled')
    release()
    await pending
    assert.equal(cancelled.getState().activeConversation.messages.at(-1)?.content,'')
    assert.equal(cancelled.getState().activeConversation.messages.at(-1)?.analyses.length,0)
    const disabled = new ChatSession(join(directory,'disabled.json'),()=>null,host,runTurn)
    await disabled.send({content:'Hello'})
    assert.match(disabled.getState().error || '', /Configure/)
    assert.equal(disabled.getState().activeConversation.messages.length,0)
    console.log('Chat session checks passed: streaming, tool reports, history, scoped attachments, key/path privacy, cancellation, and missing configuration.')
  } finally { rmSync(directory,{recursive:true,force:true}) }
}
main().catch(error=>{console.error(error);process.exitCode=1})
