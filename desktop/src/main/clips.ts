import { existsSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { DemoClip } from '../shared/types'

export function findDemoClipsDirectory(): string | null {
  const candidates = [
    join(process.cwd(), 'deepfake videos'),
    join(process.cwd(), '..', 'deepfake videos'),
    join(__dirname, '../../../deepfake videos'),
    join(__dirname, '../../../../deepfake videos')
  ]

  for (const candidate of candidates) {
    const path = resolve(candidate)
    if (existsSync(path)) return path
  }

  return null
}

export function listDemoClips(): DemoClip[] {
  const dir = findDemoClipsDirectory()
  if (!dir) return []

  return readdirSync(dir)
    .filter((file) => file.toLowerCase().endsWith('.mp4'))
    .map((file) => ({
      id: file,
      name: file.replace(/\.mp4$/i, '').replace(/_/g, ' '),
      url: `sentinel://media/${encodeURIComponent(file)}`
    }))
}

export function resolveDemoClipFile(fileName: string): string | null {
  const dir = findDemoClipsDirectory()
  if (!dir) return null
  if (!fileName || fileName.includes('..') || fileName.includes('/') || fileName.includes('\\')) {
    return null
  }
  if (!fileName.toLowerCase().endsWith('.mp4')) return null
  const full = join(dir, fileName)
  return existsSync(full) ? full : null
}
