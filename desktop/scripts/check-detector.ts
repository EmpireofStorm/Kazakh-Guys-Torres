import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { analyzeMediaFile, checkDetectorHealth, mediaAnalysisSchema, MAX_MEDIA_BYTES } from '../src/main/detectorService'

async function main() {
  const directory = await mkdtemp(join(tmpdir(), 'sentinel-media-check-'))
  const path = join(directory, 'chosen.mp4')
  const previous = process.env.DETECTOR_URL
  const expected = { videoRisk: .2, voiceRisk: .8, framesSampled: 3, facesFound: 2, voiceSeconds: 4, errors: {}, calibrated: false }
  let receivedSlow!: () => void
  const slowRequest = new Promise<void>((resolve) => { receivedSlow = resolve })
  let multipart = ''
  let acknowledgeAdditional = true
  const service = createServer(async (request, response) => {
    if (request.url === '/health') {
      response.end(JSON.stringify({ backend: 'UCF+AASIST3', videoLoaded: true, audioLoaded: false, audioWeightsPresent: true }))
    } else if (request.url === '/analyze/media') {
      for await (const chunk of request) multipart += chunk.toString()
      response.end(JSON.stringify(acknowledgeAdditional && multipart.includes('name="additionalEvidence"')
        ? { ...expected, additionalEvidence: true, voiceStartSeconds: 4.0375 } : expected))
    } else if (request.url === '/slow/analyze/media') {
      request.resume()
      receivedSlow()
    } else {
      response.writeHead(404).end()
    }
  })
  await new Promise<void>((resolve) => service.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(service.address() as AddressInfo).port}`
  try {
    await writeFile(path, 'selected-media-bytes')
    process.env.DETECTOR_URL = `${base}/analyze`
    const health = await checkDetectorHealth()
    assert.equal(health.videoReady, true)
    assert.equal(health.voiceReady, true)
    assert.deepEqual(await analyzeMediaFile(path, new AbortController().signal), expected)
    assert.match(multipart, /name="file"; filename="chosen.mp4"/)
    assert.match(multipart, /selected-media-bytes/)
    multipart = ''
    await analyzeMediaFile(path, new AbortController().signal, true)
    assert.match(multipart, /name="additionalEvidence"\r\n\r\ntrue/)
    assert.equal(mediaAnalysisSchema.parse({ ...expected, additionalEvidence: true, voiceStartSeconds: 4.0375 }).voiceStartSeconds, 4.0375)
    acknowledgeAdditional = false
    await assert.rejects(analyzeMediaFile(path, new AbortController().signal, true), /did not confirm an additional evidence pass/)
    assert.equal(mediaAnalysisSchema.safeParse({ ...expected, videoRisk: 1.1 }).success, false)
    assert.equal(mediaAnalysisSchema.safeParse({ ...expected, facesFound: 0 }).success, false)
    assert.equal(mediaAnalysisSchema.safeParse({ ...expected, voiceSeconds: null }).success, false)
    assert.equal(mediaAnalysisSchema.safeParse({ ...expected, videoRisk: null, facesFound: 0 }).success, true)

    const controller = new AbortController()
    process.env.DETECTOR_URL = `${base}/slow/analyze`
    const pending = analyzeMediaFile(path, controller.signal)
    const rejected = assert.rejects(pending, /abort/i)
    await slowRequest
    controller.abort()
    await rejected
    await truncate(path, MAX_MEDIA_BYTES + 1)
    await assert.rejects(analyzeMediaFile(path, new AbortController().signal), /100 MB/)
    console.log('Detector checks passed: health, native-file upload contract, channel availability, cancellation, and size limit.')
  } finally {
    if (previous === undefined) delete process.env.DETECTOR_URL
    else process.env.DETECTOR_URL = previous
    service.closeAllConnections()
    await new Promise<void>((resolve) => service.close(() => resolve()))
    await rm(directory, { recursive: true, force: true })
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
