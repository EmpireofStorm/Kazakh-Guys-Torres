import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { SentinelSession } from '../src/main/session'
import { FrameSampler } from '../src/renderer/capture/frameSampler'
import { HttpDetectorAdapter } from '../src/detector/HttpDetectorAdapter'
import { EvidenceAggregator } from '../src/evidence/aggregator'
import type { DetectorResult, EvidenceSnapshot } from '../src/shared/types'

const result: DetectorResult = { deepfakeProbability: 0.6, faceDetected: true, model: 'test-only' }
const frame = () => ({ jpegBase64: 'A'.repeat(48), capturedAt: Date.now() })
const source = { sourceId: 'test:window', sourceName: 'Test window' }

async function main() {
  const requestedWindow = new EvidenceAggregator(20_000)
  requestedWindow.add({ timestamp: 1000, deepfakeProbability: .6, faceDetected: true })
  assert.equal(requestedWindow.snapshot(21_000).validFaceFrames, 1, 'A 20-second request retains its early fresh samples')
  assert.equal(requestedWindow.snapshot(21_000).windowSeconds, 20)
  assert.equal(requestedWindow.snapshot(21_001).sampleCount, 0)
  let realCalls = 0
  const demo = new SentinelSession(() => null, {
    name: 'real-test', reset() {}, analyzeFrame: async () => { realCalls++; return result }
  })
  try {
    assert.equal(demo.startScriptedDemo().detectorMode, 'demo')
    assert.equal((await demo.analyzeFrame(frame())).result.model, 'mock-detector')
    assert.equal(realCalls, 0, 'Scripted demo must never send dummy pixels to the real service')
    assert.throws(() => demo.setDetectorMode('real'), /Stop monitoring/)
    assert.equal(demo.stopMonitoring().detectorMode, 'real', 'Stop restores the selected live detector')
    demo.startMonitoring(source)
    assert.equal((await demo.analyzeFrame(frame())).result.model, 'test-only')
    assert.equal(realCalls, 1)
  } finally {
    demo.stopMonitoring()
  }

  let resolveFrame!: (value: DetectorResult) => void
  const deferred = new SentinelSession(() => null, {
    name: 'deferred', reset() {},
    analyzeFrame: () => new Promise((resolve) => { resolveFrame = resolve })
  })
  deferred.startMonitoring(source)
  assert.equal(deferred.getState().assessment, null, 'Starting capture must not imply low risk')
  const oldFrame = deferred.analyzeFrame(frame())
  deferred.stopMonitoring()
  deferred.startMonitoring({ ...source, sourceId: 'test:new-window' })
  resolveFrame(result)
  await assert.rejects(oldFrame, /session ended/)
  assert.equal(deferred.getState().samplesAnalyzed, 0)
  deferred.stopMonitoring()

  deferred.startMonitoring(source)
  try {
    const capturedBeforeRequest = deferred.analyzeFrame({ ...frame(), capturedAt: Date.now() - 4000 })
    const sampling = deferred.sampleForChat({ durationSeconds: 2, framesPerSecond: 2 }, new AbortController().signal)
    resolveFrame(result)
    await capturedBeforeRequest
    const report = await sampling as { newSamples: number; freshEvidenceAvailable: boolean; evidence: EvidenceSnapshot }
    assert.equal(report.newSamples, 0, 'An old frame resolving inside a requested window is not fresh evidence')
    assert.equal(report.freshEvidenceAvailable, false)
    assert.equal(report.evidence.sampleCount, 0)
    const nextSampling = deferred.sampleForChat({ durationSeconds: 2, framesPerSecond: 2 }, new AbortController().signal)
    const freshFrame = deferred.analyzeFrame(frame())
    resolveFrame({ ...result, deepfakeProbability: .2 })
    await freshFrame
    const freshReport = await nextSampling as typeof report
    assert.equal(freshReport.newSamples, 1)
    assert.equal(freshReport.evidence.scores?.mean, .2, 'Requested evidence excludes the earlier rolling window')
  } finally { deferred.stopMonitoring() }

  let receivedRequest!: () => void
  const received = new Promise<void>((resolve) => { receivedRequest = resolve })
  const endpoint = createServer((request, response) => {
    if (request.url === '/invalid-detector') {
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ faceDetected: true }))
      return
    }
    receivedRequest()
    // Leave the model response pending to exercise Stop and settings changes.
  })
  await new Promise<void>((resolve) => endpoint.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${(endpoint.address() as AddressInfo).port}`
  const session = new SentinelSession(
    () => ({ baseUrl: `${baseUrl}/v1`, model: 'local-test-model', apiKey: '' }),
    { name: 'test', reset() {}, analyzeFrame: async () => result }
  )
  try {
    await assert.rejects(new HttpDetectorAdapter(`${baseUrl}/invalid-detector`).analyzeFrame(frame()), /deepfakeProbability/)
    session.startMonitoring(source)
    const start = Date.now()
    for (let i = 0; i < 3; i++) await session.analyzeFrame(frame())
    assert.ok(Date.now() - start < 1000, 'Model execution must not block frame ingestion')
    assert.equal(session.getState().agentBusy, true)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([received, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('The agent never reached the configured endpoint')), 5000)
      })])
    } finally {
      clearTimeout(timer)
    }
    session.agentSettingsChanged()
    assert.equal(session.getState().agentBusy, false)
    session.stopMonitoring()
    const stopped = session.getState()
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.deepEqual(session.getState(), stopped, 'An aborted run must not change the stopped UI')
  } finally {
    session.stopMonitoring()
    endpoint.closeAllConnections()
    await new Promise<void>((resolve) => endpoint.close(() => resolve()))
  }

  let releaseCapture!: () => void
  let scheduled = 0
  Object.assign(globalThis, {
    window: { setTimeout: () => { scheduled++; return 1 }, clearTimeout() {} },
    document: { createElement: () => ({ getContext: () => ({ drawImage() {} }), toDataURL: () => 'data:image/jpeg;base64,AAA' }) }
  })
  const sampler = new FrameSampler(
    { readyState: 2, videoWidth: 640, videoHeight: 480 } as HTMLVideoElement,
    () => new Promise<void>((resolve) => { releaseCapture = resolve })
  )
  sampler.start(() => 1.5)
  sampler.stop()
  releaseCapture()
  await new Promise((resolve) => setTimeout(resolve, 0))
  assert.equal(scheduled, 0, 'Stopping during capture must not restart the sampling timer')
  console.log('Session checks passed: nonblocking investigations, settings cancellation, stale-frame rejection, and Stop.')
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
