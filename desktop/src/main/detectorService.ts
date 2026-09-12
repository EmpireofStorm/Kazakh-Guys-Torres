import { openAsBlob } from 'node:fs'
import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { z } from 'zod'
import type { DetectorHealth, MediaAnalysis } from '../shared/types'

export const MAX_MEDIA_BYTES = 100 * 1024 * 1024

const score = z.number().finite().min(0).max(1).nullable()
export const mediaAnalysisSchema = z.object({
  videoRisk: score,
  voiceRisk: score,
  framesSampled: z.number().int().nonnegative(),
  facesFound: z.number().int().nonnegative(),
  voiceSeconds: z.number().finite().nonnegative().nullable(),
  mediaDurationSeconds: z.number().finite().positive().max(300).optional(),
  additionalEvidence: z.boolean().optional(),
  voiceStartSeconds: z.number().finite().nonnegative().max(300).optional(),
  generatedFrameEvidence: z.object({
    model: z.literal('CommunityForensics'), meanScore: z.number().finite().min(0).max(1),
    flaggedFrames: z.number().int().nonnegative(), sampledFrames: z.number().int().positive(), threshold: z.literal(.5)
  }).nullable().optional(),
  errors: z.object({ video: z.string().max(2000).optional(), audio: z.string().max(2000).optional(), generatedVideo: z.string().max(2000).optional() }),
  calibrated: z.literal(false)
}).refine((result) => result.facesFound <= result.framesSampled, 'Face count exceeds sampled frames')
  .refine((result) => result.videoRisk === null || result.facesFound > 0, 'Video score requires a detected face')
  .refine((result) => result.voiceRisk === null || (result.voiceSeconds !== null && result.voiceSeconds > 0), 'Voice score requires analyzed audio')
  .refine((result) => !result.generatedFrameEvidence || (result.generatedFrameEvidence.flaggedFrames <= result.generatedFrameEvidence.sampledFrames
    && result.generatedFrameEvidence.sampledFrames <= result.framesSampled), 'Generated-frame counts exceed analyzed frames')

function serviceUrl(path: string): URL {
  // DETECTOR_URL is main-process configuration; the renderer never supplies a URL.
  return new URL(path, (process.env.DETECTOR_URL ?? 'http://127.0.0.1:8000/analyze').replace(/\/+$/, ''))
}

export async function checkDetectorHealth(): Promise<DetectorHealth> {
  try {
    const response = await fetch(serviceUrl('health'), { signal: AbortSignal.timeout(5000) })
    if (!response.ok) throw new Error('Health request failed')
    const health = z.object({
      backend: z.enum(['UCF+AASIST3', 'UCF+CommunityForensics+AASIST3']), videoLoaded: z.boolean(),
      audioLoaded: z.boolean(), audioWeightsPresent: z.boolean(),
      generatedVideoLoaded: z.boolean().optional(), generatedVideoWeightsPresent: z.boolean().optional()
    }).parse(await response.json())
    const voiceReady = health.audioLoaded || health.audioWeightsPresent
    const generatedVideoReady = !!(health.generatedVideoLoaded || health.generatedVideoWeightsPresent)
    return {
      reachable: true, videoReady: health.videoLoaded, voiceReady, generatedVideoReady,
      message: `UCF ${health.videoLoaded ? 'ready' : 'unavailable'} · generated-frame ${generatedVideoReady ? 'ready' : 'unavailable'} · voice ${voiceReady ? 'assets ready' : 'assets missing'}.`
    }
  } catch {
    return { reachable: false, videoReady: false, voiceReady: false, message: 'Real detector unavailable. Start the Python detector service and check model setup.' }
  }
}

export async function analyzeMediaFile(path: string, signal: AbortSignal, additionalEvidence = false): Promise<MediaAnalysis> {
  // The caller passes only a file chosen by Electron's native picker.
  const file = await stat(path)
  if (!file.isFile() || file.size <= 0 || file.size > MAX_MEDIA_BYTES) throw new Error('Choose a nonempty media file up to 100 MB.')
  signal.throwIfAborted()
  const form = new FormData()
  form.set('file', await openAsBlob(path), basename(path))
  if (additionalEvidence) form.set('additionalEvidence', 'true')
  const response = await fetch(serviceUrl('analyze/media'), {
    method: 'POST', body: form, signal: AbortSignal.any([signal, AbortSignal.timeout(180_000)])
  })
  if (!response.ok) {
    throw new Error(`Media analysis failed (HTTP ${response.status}). Check the detector service and media format.`)
  }
  const result = mediaAnalysisSchema.parse(await response.json())
  if (additionalEvidence && (result.additionalEvidence !== true || (result.voiceRisk !== null && result.voiceStartSeconds !== 4.0375))) {
    throw new Error('The detector did not confirm an additional evidence pass. Restart the updated detector service before retrying.')
  }
  return result
}
