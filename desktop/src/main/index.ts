import { app, BrowserWindow, desktopCapturer, ipcMain, session } from 'electron'
import { config as loadEnv } from 'dotenv'
import { join } from 'node:path'
import { IPC } from '../shared/ipc'
import { createOverlayWindow, resizeOverlay } from './overlay'
import { mapDesktopSources, SentinelSession } from './session'

loadEnv({ path: join(app.getAppPath(), '..', '.env') })
loadEnv({ path: join(process.cwd(), '..', '.env') })
loadEnv({ path: join(process.cwd(), '.env') })

const isDev = !app.isPackaged
const sentinel = new SentinelSession()

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
