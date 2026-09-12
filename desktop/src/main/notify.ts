import { Notification, app } from 'electron'
import type { DisplayState } from '../shared/types'

let lastAlert: DisplayState | null = null

export function configureNotifications(): void {
  if (process.platform === 'win32') {
    app.setAppUserModelId('com.sentinel.desktop')
  }
}

export function notifyAssessment(displayState: DisplayState): void {
  if (displayState === lastAlert) return
  lastAlert = displayState
  if (displayState !== 'HIGH_RISK') return
  if (!Notification.isSupported()) return

  new Notification({
    title: 'SENTINEL',
    body: "We're pretty sure this is a deepfake. Verify identity independently.",
    silent: false
  }).show()
}
