import { BrowserWindow, screen } from 'electron'
import { join } from 'node:path'
import { app } from 'electron'

const isDev = !app.isPackaged

function overlayTarget(): { url?: string; file?: string } {
  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    return { url: `${process.env.ELECTRON_RENDERER_URL}/overlay.html` }
  }
  return { file: join(__dirname, '../renderer/overlay.html') }
}

export function createOverlayWindow(): BrowserWindow {
  const display = screen.getPrimaryDisplay()
  const { width, height, x: workX, y: workY } = display.workArea
  const overlayWidth = 280
  const overlayHeight = 148
  const margin = 18

  const win = new BrowserWindow({
    width: overlayWidth,
    height: overlayHeight,
    x: workX + width - overlayWidth - margin,
    y: workY + height - overlayHeight - margin,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  win.webContents.on('did-finish-load', () => {
    if (!win.isDestroyed()) win.showInactive()
  })

  const target = overlayTarget()
  if (target.url) void win.loadURL(target.url)
  else if (target.file) void win.loadFile(target.file)

  return win
}

export function resizeOverlay(win: BrowserWindow, expanded: boolean): void {
  if (win.isDestroyed()) return
  const [x, y] = win.getPosition()
  const [, currentH] = win.getSize()
  const nextW = expanded ? 340 : 280
  const nextH = expanded ? 236 : 148
  const deltaH = nextH - currentH
  win.setSize(nextW, nextH)
  win.setPosition(x, Math.max(0, y - deltaH))
}
