import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname } from 'node:path'
import { z } from 'zod'
import { runChatTurn } from '../agent/chatAgent'
import type { CompatibleAgentConfig } from '../agent/langchainAgent'
import { analyzeMediaFile, MAX_MEDIA_BYTES, mediaAnalysisSchema } from './detectorService'
import type { ChatAnalysis, ChatAttachment, ChatConversation, ChatMessage, ChatState } from '../shared/types'

const attachmentSchema = z.object({ id: z.string().uuid(), name: z.string().max(256), size: z.number().int().positive().max(MAX_MEDIA_BYTES), path: z.string().max(4096) })
const analysisSchema = z.object({ attachmentId: z.string(), fileName: z.string().max(256), result: mediaAnalysisSchema })
const messageSchema = z.object({
  id: z.string(), role: z.enum(['user', 'assistant']), content: z.string().max(32000), createdAt: z.number().finite(),
  status: z.enum(['complete', 'streaming', 'cancelled', 'error']), attachmentIds: z.array(z.string()).max(3),
  tools: z.array(z.object({ id: z.string(), name: z.string(), status: z.enum(['running', 'complete', 'error']), summary: z.string().max(2000) })).max(16),
  analyses: z.array(analysisSchema).max(8)
})
const conversationSchema = z.object({
  id: z.string().uuid(), title: z.string().max(100), updatedAt: z.number().finite(),
  messages: z.array(messageSchema).max(40), attachments: z.array(attachmentSchema).max(30)
})
const savedSchema = z.object({ version: z.literal(1), activeId: z.string(), conversations: z.array(conversationSchema).min(1).max(20) })
const sendSchema = z.object({ content: z.string().trim().max(8000), attachmentIds: z.array(z.string().uuid()).max(3).default([]) })
const MAX_HISTORY_BYTES = 32 * 1024 * 1024
type StoredConversation = z.infer<typeof conversationSchema>

export class ChatSession {
  private conversations: StoredConversation[] = []
  private activeId = ''
  private run: AbortController | null = null
  private error: string | null = null
  private listeners = new Set<(state: ChatState) => void>()

  constructor(
    private readonly path: string,
    private readonly getConfig: () => CompatibleAgentConfig | null,
    private readonly host: {
      getLiveEvidence: () => unknown
      requestLiveSampling: (args: { durationSeconds: number; framesPerSecond: number }, signal: AbortSignal) => Promise<unknown>
      onBusy: (busy: boolean) => void
    },
    private readonly runTurn: typeof runChatTurn = runChatTurn,
    private readonly analyzeFile: typeof analyzeMediaFile = analyzeMediaFile
  ) {
    if (existsSync(path)) {
      try {
        if (statSync(path).size > MAX_HISTORY_BYTES) throw new Error('History exceeds size limit')
        const saved = savedSchema.parse(JSON.parse(readFileSync(path, 'utf8')))
        this.conversations = saved.conversations
        this.activeId = saved.conversations.some(chat => chat.id === saved.activeId) ? saved.activeId : saved.conversations[0].id
        for (const chat of this.conversations) for (const message of chat.messages) {
          if (message.status === 'streaming') message.status = 'cancelled'
          for (const event of message.tools) if (event.status === 'running') {
            event.status = 'error'
            event.summary = 'Interrupted when the app closed.'
          }
        }
      } catch {
        // Preserve an unreadable history before the next save can replace it.
        try { renameSync(path, `${path}.unreadable-${Date.now()}`) } catch {
          throw new Error('Chat history could not be read or backed up. It has been left unchanged.')
        }
        this.error = 'Previous chat history could not be read. A backup was kept on this device.'
      }
    }
    if (!this.conversations.length) this.createConversation()
  }

  private get active(): StoredConversation {
    return this.conversations.find(chat => chat.id === this.activeId)!
  }

  getState(): ChatState {
    const { attachments, ...chat } = this.active
    const publicChat: ChatConversation = { ...chat, attachments: attachments.map(({ path: _path, ...item }) => item) }
    return {
      conversations: this.conversations.map(({ id, title, updatedAt }) => ({ id, title, updatedAt })),
      activeConversation: publicChat, busy: this.run !== null,
      configured: this.getConfig() !== null, model: this.getConfig()?.model ?? null, error: this.error
    }
  }

  subscribe(listener: (state: ChatState) => void): () => void {
    this.listeners.add(listener)
    listener(this.getState())
    return () => this.listeners.delete(listener)
  }

  private createConversation(): void {
    const chat: StoredConversation = { id: randomUUID(), title: 'New chat', updatedAt: Date.now(), messages: [], attachments: [] }
    this.conversations.unshift(chat)
    // ponytail: keep the latest 20 chats and 40 messages each; use a database if longer history is needed.
    this.conversations = this.conversations.slice(0, 20)
    this.activeId = chat.id
  }

  newChat(): ChatState {
    this.cancel()
    this.createConversation()
    this.error = null
    this.save()
    return this.emit()
  }

  selectChat(raw: unknown): ChatState {
    const id = z.string().uuid().parse(raw)
    if (!this.conversations.some(chat => chat.id === id)) throw new Error('Chat is no longer available.')
    this.cancel()
    this.activeId = id
    this.error = null
    this.save()
    return this.emit()
  }

  addAttachments(paths: string[], conversationId: string): ChatAttachment[] {
    if (this.run || conversationId !== this.activeId) throw new Error('Chat changed while the file picker was open. Attach the file again.')
    if (!paths.length || paths.length > 3 || this.active.attachments.length + paths.length > 30) {
      throw new Error('Choose up to three files at once, with at most 30 attachments per chat.')
    }
    const attachments = paths.map(path => {
      const file = statSync(path)
      if (!file.isFile() || file.size <= 0 || file.size > MAX_MEDIA_BYTES) throw new Error('Choose nonempty video or audio files up to 100 MiB each.')
      return attachmentSchema.parse({ id: randomUUID(), path, name: basename(path), size: file.size })
    })
    this.active.attachments.push(...attachments)
    this.save()
    this.emit()
    return attachments.map(({ path: _path, ...item }) => item)
  }

  async send(raw: unknown): Promise<ChatState> {
    if (this.run) throw new Error('Wait for the response or press Stop.')
    const input = sendSchema.parse(raw)
    const config = this.getConfig()
    if (!config) {
      this.error = 'Configure and enable a model with tool calling in Connection before chatting.'
      return this.emit()
    }
    const chat = this.active
    if (input.attachmentIds.some(id => !chat.attachments.some(file => file.id === id))) throw new Error('Attachment is not available in this chat.')
    const content = input.content || (input.attachmentIds.length ? 'Analyze the attached media and explain the available evidence.' : '')
    if (!content) throw new Error('Enter a message or attach a video or audio file.')
    const message = (role: 'user' | 'assistant', text: string): ChatMessage => ({
      id: randomUUID(), role, content: text, createdAt: Date.now(), status: role === 'user' ? 'complete' : 'streaming',
      attachmentIds: role === 'user' ? input.attachmentIds : [], tools: [], analyses: []
    })
    const user = message('user', content)
    const assistant = message('assistant', '')
    chat.messages.push(user, assistant)
    chat.messages = chat.messages.slice(-40)
    if (chat.title === 'New chat') chat.title = content.replace(/\s+/g, ' ').slice(0, 60)
    chat.updatedAt = Date.now()
    this.error = null
    const run = new AbortController()
    this.run = run
    this.host.onBusy(true)
    const current = () => this.run === run && !run.signal.aborted && this.activeId === chat.id
    this.save()
    this.emit()
    try {
      const previousAnalyses = chat.messages.flatMap(item => item.analyses).slice(-8)
      const sentAttachments = new Set(chat.messages.filter(item => item.role === 'user').flatMap(item => item.attachmentIds))
      const history = chat.messages.filter(item => item !== assistant && (item.role === 'user' || item.status === 'complete')).map(item => ({
        role: item.role, content: item.content + (item.attachmentIds.length ? `\nAttached media: ${JSON.stringify(item.attachmentIds.map(id => {
          const file = chat.attachments.find(candidate => candidate.id === id)!
          return { id: file.id, name: file.name }
        }))}` : '')
      }))
      const analyzeAttachment = async (id: string, signal: AbortSignal, additionalEvidence = false): Promise<ChatAnalysis> => {
        signal.throwIfAborted()
        const file = chat.attachments.find(item => item.id === id)
        if (!file || !sentAttachments.has(id) || !current()) throw new Error('Attachment is not available in this chat.')
        try {
          if (!statSync(file.path).isFile()) throw new Error('Missing file')
        } catch { throw new Error('The attached file is no longer available. Attach it again.') }
        let result
        try {
          result = await this.analyzeFile(file.path, signal, additionalEvidence)
        } catch {
          signal.throwIfAborted()
          throw new Error('Media analysis failed. Check that the detector service is running and the file is supported; retry if the detector is busy.')
        }
        signal.throwIfAborted()
        if (!current()) throw new Error('Chat was cancelled.')
        return { attachmentId: id, fileName: file.name, result }
      }
      const answer = await this.runTurn({
        config, history, attachments: this.getState().activeConversation.attachments.filter(file => sentAttachments.has(file.id)), previousAnalyses, signal: run.signal,
        host: {
          getLiveEvidence: () => { run.signal.throwIfAborted(); return this.host.getLiveEvidence() },
          requestLiveSampling: (args, signal) => this.host.requestLiveSampling(args, signal),
          analyzeAttachment,
          gatherAttachmentEvidence: (id, signal) => analyzeAttachment(id, signal, true)
        },
        onText: delta => {
          if (!current()) return
          assistant.content = (assistant.content + delta).slice(0, 32000)
          this.emit()
        },
        onTool: event => {
          if (!current()) return
          const existing = assistant.tools.findIndex(item => item.id === event.id)
          if (existing < 0) assistant.tools.push(event)
          else assistant.tools[existing] = event
          this.emit()
        },
        onAnalysis: (analysis: ChatAnalysis) => {
          if (!current()) return
          assistant.analyses.push(analysis)
          this.emit()
        }
      })
      if (current()) {
        assistant.content = answer.slice(0, 32000)
        assistant.status = 'complete'
      }
    } catch {
      if (current()) {
        assistant.status = 'error'
        this.error = 'The agent could not finish. Check your model connection, then send a follow-up to retry.'
        if (!assistant.content) assistant.content = this.error
      }
    } finally {
      if (this.run === run) {
        this.run = null
        run.abort()
        this.host.onBusy(false)
        for (const tool of assistant.tools) if (tool.status === 'running') {
          tool.status = 'error'
          tool.summary = 'The turn ended before this tool completed.'
        }
        chat.updatedAt = Date.now()
        this.save()
        this.emit()
      }
    }
    return this.getState()
  }

  cancel(): ChatState {
    if (this.run) {
      this.run.abort()
      this.run = null
      this.host.onBusy(false)
      const response = this.active.messages.at(-1)
      if (response?.status === 'streaming') {
        response.status = 'cancelled'
        for (const tool of response.tools) if (tool.status === 'running') {
          tool.status = 'error'
          tool.summary = 'Stopped by the user.'
        }
      }
      this.save()
    }
    return this.emit()
  }

  settingsChanged(): void {
    this.cancel()
    this.error = null
    this.emit()
  }

  private save(): void {
    try {
      const serialized = JSON.stringify({ version: 1, activeId: this.activeId, conversations: this.conversations })
      if (Buffer.byteLength(serialized) > MAX_HISTORY_BYTES) {
        this.error = 'Chat history has reached its storage limit. This session remains in memory; the previous saved history is unchanged.'
        return
      }
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
      const temporary = `${this.path}.tmp`
      writeFileSync(temporary, serialized, { mode: 0o600 })
      chmodSync(temporary, 0o600)
      renameSync(temporary, this.path)
    } catch { this.error = 'Chat history could not be saved to this device. This conversation is available until the app closes.' }
  }

  private emit(): ChatState {
    const state = this.getState()
    for (const listener of this.listeners) listener(state)
    return state
  }
}
