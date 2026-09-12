import { app, BrowserWindow, desktopCapturer, ipcMain, net, protocol, safeStorage, session } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { IPC } from '../shared/ipc'
import { listDemoClips, resolveDemoClipFile } from './clips'
import { loadSentinelEnv } from './env'
import { configureNotifications, notifyAssessment } from './notify'
import { createOverlayWindow, resizeOverlay } from './overlay'
import { mapDesktopSources, SentinelSession } from './session'
import { AgentSettingsStore } from './agentSettings'
import { testAgentConnection } from '../agent/langchainAgent'

loadSentinelEnv()
configureNotifications()

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'sentinel',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: true
    }
  }
])

const isDev = !app.isPackaged
let agentSettings: AgentSettingsStore
const sentinel = new SentinelSession(() => agentSettings?.getConfig() ?? null)
let connectionTest: AbortController | null = null

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

  win.on('ready-to-show', () => {
    win.show()
    if (isDev) win.webContents.openDevTools({ mode: 'detach' })
  })
  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    const tag = ['log', 'warn', 'error'][level] ?? 'log'
    console.log(`[renderer:${tag}] ${message} (${sourceId}:${line})`)
  })
  win.on('closed', () => {
    connectionTest?.abort()
    sentinel.stopMonitoring()
    mainWindow = null
    if (overlayWindow && !overlayWindow.isDestroyed()) overlayWindow.close()
  })

  const entry = rendererEntry('index.html')
  if (entry.url) void win.loadURL(entry.url)
  else if (entry.file) void win.loadFile(entry.file)

  return win
}

function attachPresenterHotkeys(win: BrowserWindow): void {
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !input.control || !input.shift) return
    if (input.code === 'Digit1') {
      event.preventDefault()
      mainWindow?.webContents.send(IPC.demoHotkey, 'synthetic')
    }
    if (input.code === 'Digit2') {
      event.preventDefault()
      mainWindow?.webContents.send(IPC.demoHotkey, 'authentic')
    }
    if (input.code === 'Digit3') {
      event.preventDefault()
      mainWindow?.webContents.send(IPC.demoHotkey, 'live')
    }
  })
}

function broadcast(state: ReturnType<SentinelSession['getState']>): void {
  for (const win of [mainWindow, overlayWindow]) {
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC.stateUpdate, state)
    }
  }
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    resizeOverlay(overlayWindow, state.displayState === 'HIGH_RISK')
    if (state.displayState === 'HIGH_RISK') overlayWindow.showInactive()
  }
  notifyAssessment(state.displayState)
}

function registerIpc(): void {
  sentinel.subscribe(broadcast)

  // Only the control panel can read or change provider settings.
  const assertSettingsSender = (event: Electron.IpcMainInvokeEvent) => {
    if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== event.sender.mainFrame) {
      throw new Error('Agent settings are only available in the control panel.')
    }
  }
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

  ipcMain.handle(IPC.sourcesList, async () => {
    sentinel.beginSelecting()
    const sources = await desktopCapturer.getSources({
      types: ['window', 'screen'],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: false
    })
    return mapDesktopSources(sources)
  })

  ipcMain.handle(IPC.monitorStart, (_event, payload: unknown) => sentinel.startMonitoring(payload))
  ipcMain.handle(IPC.demoStart, (_event, payload: unknown) => sentinel.startScriptedDemo(payload))
  ipcMain.handle(IPC.clipsList, () => listDemoClips())
  ipcMain.handle(IPC.monitorStop, () => sentinel.stopMonitoring())
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
  protocol.handle('sentinel', (request) => {
    const url = new URL(request.url)
    const fileName = decodeURIComponent(url.pathname.replace(/^\//, ''))
    const file = resolveDemoClipFile(fileName)
    if (!file) {
      return new Response('Not found', { status: 404 })
    }
    return net.fetch(pathToFileURL(file).href)
  })

  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === 'media' || permission === 'display-capture')
  })

  registerIpc()
  console.log(
    `[SENTINEL] SENTINEL_DETECTOR=${process.env.SENTINEL_DETECTOR ?? '(unset)'} DETECTOR_URL=${process.env.DETECTOR_URL ?? '(unset)'}`
  )
  mainWindow = createMainWindow()
  overlayWindow = createOverlayWindow()
  attachPresenterHotkeys(mainWindow)
  attachPresenterHotkeys(overlayWindow)

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
