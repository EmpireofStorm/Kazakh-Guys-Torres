import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, safeStorage, session } from 'electron'
import { basename, join } from 'node:path'
import { IPC } from '../shared/ipc'
import { loadSentinelEnv } from './env'
import { createOverlayWindow, resizeOverlay } from './overlay'
import { mapDesktopSources, SentinelSession } from './session'
import { AgentSettingsStore } from './agentSettings'
import { testAgentConnection } from '../agent/langchainAgent'
import { analyzeMediaFile, checkDetectorHealth } from './detectorService'
import { ChatSession } from './chatSession'
import type { MediaAnalysisOutcome } from '../shared/types'

loadSentinelEnv()

const isDev = !app.isPackaged
let agentSettings: AgentSettingsStore
const sentinel = new SentinelSession(() => agentSettings?.getConfig() ?? null)
let connectionTest: AbortController | null = null
let mediaAnalysis: AbortController | null = null
let chat: ChatSession

let mainWindow: BrowserWindow | null = null
let overlayWindow: BrowserWindow | null = null

function rendererEntry(file: 'index.html' | 'overlay.html'): { url?: string; file?: string } {
  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    const base = process.env.ELECTRON_RENDERER_URL
    return { url: file === 'index.html' ? base : `${base}/${file}` }
  }
  return { file: join(__dirname, `../renderer/${file}`) }
}

function createMainWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 980,
    height: 820,
    minWidth: 820,
    minHeight: 680,
    show: false,
    backgroundColor: '#070b12',
    title: 'SENTINEL',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  win.on('ready-to-show', () => win.show())
  win.on('closed', () => {
    connectionTest?.abort()
    mediaAnalysis?.abort()
    chat?.cancel()
    sentinel.stopMonitoring()
    mainWindow = null
    if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.close()
  })

  const entry = rendererEntry('index.html')
  if (entry.url) void win.loadURL(entry.url)
  else if (entry.file) void win.loadFile(entry.file)

  return win
}

function broadcast(state: ReturnType<SentinelSession['getState']>): void {
  for (const win of [mainWindow, overlayWindow]) {
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC.stateUpdate, state)
    }
  }
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    resizeOverlay(overlayWindow, state.overlayExpanded && state.displayState === 'HIGH_RISK')
  }
}

function registerIpc(): void {
  sentinel.subscribe(broadcast)
  chat.subscribe(state => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.chatUpdate, state)
  })

  // Only the control panel can read or change provider settings.
  const assertSettingsSender = (event: Electron.IpcMainInvokeEvent) => {
    if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== event.sender.mainFrame) {
      throw new Error('Agent settings are only available in the control panel.')
    }
  }
  ipcMain.handle(IPC.chatGet, event => { assertSettingsSender(event); return chat.getState() })
  ipcMain.handle(IPC.chatNew, event => { assertSettingsSender(event); return chat.newChat() })
  ipcMain.handle(IPC.chatSelect, (event, id: unknown) => { assertSettingsSender(event); return chat.selectChat(id) })
  ipcMain.handle(IPC.chatSend, (event, input: unknown) => {
    assertSettingsSender(event)
    if (mediaAnalysis) throw new Error('Wait for file analysis to finish before sending a chat request.')
    return chat.send(input)
  })
  ipcMain.handle(IPC.chatCancel, event => { assertSettingsSender(event); return chat.cancel() })
  ipcMain.handle(IPC.chatAttach, async event => {
    assertSettingsSender(event)
    if (chat.getState().busy || mediaAnalysis) throw new Error('Wait for the current request or press Stop before attaching files.')
    const conversationId = chat.getState().activeConversation.id
    const choice = await dialog.showOpenDialog(mainWindow!, {
      title: 'Attach media to this chat', properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Video and audio', extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'wav', 'flac', 'mp3', 'm4a', 'ogg', 'aac'] }]
    })
    if (choice.canceled) return []
    return chat.addAttachments(choice.filePaths, conversationId)
  })
  ipcMain.handle(IPC.agentSettingsGet, (event) => {
    assertSettingsSender(event)
    return agentSettings.getPublic()
  })
  ipcMain.handle(IPC.agentSettingsSave, (event, input: unknown) => {
    assertSettingsSender(event)
    const result = agentSettings.save(input)
    if (result.ok) {
      connectionTest?.abort()
      sentinel.agentSettingsChanged()
      chat.settingsChanged()
    }
    return result
  })
  ipcMain.handle(IPC.agentConnectionTest, async (event, input: unknown) => {
    assertSettingsSender(event)
    connectionTest?.abort()
    const controller = new AbortController()
    connectionTest = controller
    try {
      const config = agentSettings.preview(input)
      if (!config.baseUrl || !config.model) return { ok: false, message: 'Enter an API base URL and model ID first.' }
      return await testAgentConnection(config, controller.signal)
    } catch {
      return { ok: false, message: 'Check the API base URL, model ID, and key fields.' }
    } finally {
      if (connectionTest === controller) connectionTest = null
    }
  })

  ipcMain.handle(IPC.detectorMode, (event, mode: unknown) => {
    assertSettingsSender(event)
    chat.cancel()
    return sentinel.setDetectorMode(mode)
  })
  ipcMain.handle(IPC.detectorHealth, (event) => {
    assertSettingsSender(event)
    return checkDetectorHealth()
  })
  ipcMain.handle(IPC.mediaAnalyze, async (event): Promise<MediaAnalysisOutcome> => {
    assertSettingsSender(event)
    if (mediaAnalysis) return { status: 'error', message: 'A media analysis is already running.' }
    if (chat.getState().busy) return { status: 'error', message: 'Finish or stop the chat request before analyzing a file here.' }
    if (sentinel.getState().phase === 'MONITORING') return { status: 'error', message: 'Stop monitoring before analyzing a file.' }
    const controller = new AbortController()
    mediaAnalysis = controller
    try {
      const choice = await dialog.showOpenDialog(mainWindow!, {
        title: 'Analyze video or audio with real detectors', properties: ['openFile'],
        filters: [{ name: 'Video and audio', extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'wav', 'flac', 'mp3', 'm4a', 'ogg'] }]
      })
      if (choice.canceled || controller.signal.aborted || !choice.filePaths[0]) return { status: 'cancelled' }
      const path = choice.filePaths[0]
      const result = await analyzeMediaFile(path, controller.signal)
      if (controller.signal.aborted) return { status: 'cancelled' }
      return { status: 'ok', fileName: basename(path), result }
    } catch (error) {
      if (controller.signal.aborted) return { status: 'cancelled' }
      return { status: 'error', message: error instanceof Error ? error.message : 'Could not analyze the selected file.' }
    } finally {
      if (mediaAnalysis === controller) mediaAnalysis = null
    }
  })
  ipcMain.handle(IPC.mediaCancel, (event) => {
    assertSettingsSender(event)
    mediaAnalysis?.abort()
  })

  ipcMain.handle(IPC.sourcesList, async () => {
    sentinel.beginSelecting()
    const sources = await desktopCapturer.getSources({
      types: ['window', 'screen'],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: false
    })
    return mapDesktopSources(sources)
  })

  ipcMain.handle(IPC.monitorStart, (_event, payload: unknown) => {
    if (mediaAnalysis) throw new Error('Finish or cancel file analysis before monitoring.')
    chat.cancel()
    return sentinel.startMonitoring(payload)
  })
  ipcMain.handle(IPC.demoStart, () => {
    if (mediaAnalysis) throw new Error('Finish or cancel file analysis before starting the demo.')
    chat.cancel()
    return sentinel.startScriptedDemo()
  })
  ipcMain.handle(IPC.monitorStop, () => { chat.cancel(); return sentinel.stopMonitoring() })
  ipcMain.handle(IPC.detectorAnalyze, (_event, payload: unknown) => sentinel.analyzeFrame(payload))
  ipcMain.handle(IPC.stateGet, () => sentinel.getState())
  ipcMain.handle(IPC.overlayDetails, () => {
    sentinel.setOverlayExpanded(true)
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show()
      mainWindow.focus()
    }
    return sentinel.getState()
  })
  ipcMain.handle(IPC.overlayExpand, (_event, expanded: unknown) => {
    sentinel.setOverlayExpanded(Boolean(expanded))
    return sentinel.getState()
  })
}

app.whenReady().then(() => {
  agentSettings = new AgentSettingsStore(join(app.getPath('userData'), 'agent-settings.json'), safeStorage)
  chat = new ChatSession(join(app.getPath('userData'), 'chat-history.json'), () => agentSettings.getConfig(), {
    getLiveEvidence: async () => {
      const detectorHealth = await checkDetectorHealth()
      const state = sentinel.getState()
      return { monitoring: state.phase === 'MONITORING', detectorMode: state.detectorMode,
        evidence: state.evidence, assessment: state.assessment, liveVoiceAvailable: false,
        detectorHealth }
    },
    requestLiveSampling: (args, signal) => sentinel.sampleForChat(args, signal),
    onBusy: busy => sentinel.setChatBusy(busy)
  })
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media' || permission === 'display-capture')
  })

  registerIpc()
  mainWindow = createMainWindow()
  overlayWindow = createOverlayWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow()
      overlayWindow = createOverlayWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
