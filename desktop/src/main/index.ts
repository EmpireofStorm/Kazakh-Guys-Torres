import { app, BrowserWindow, desktopCapturer, ipcMain, safeStorage, session } from 'electron'
import { join } from 'node:path'
import { IPC } from '../shared/ipc'
import { loadSentinelEnv } from './env'
import { createOverlayWindow, resizeOverlay } from './overlay'
import { mapDesktopSources, SentinelSession } from './session'
import { AgentSettingsStore } from './agentSettings'
import { testAgentConnection } from '../agent/langchainAgent'

loadSentinelEnv()

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

  win.on('ready-to-show', () => win.show())
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
  ipcMain.handle(IPC.demoStart, () => sentinel.startScriptedDemo())
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
