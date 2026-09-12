import type {
  AssessmentLevel,
  EvidenceSample,
  EvidenceSnapshot,
  ScoreStats,
  ScoreTrend
} from '../shared/types'

const WINDOW_MS = 10_000

export class EvidenceAggregator {
  private samples: EvidenceSample[] = []
  private previousAssessment: AssessmentLevel | null = null

  constructor(private readonly windowMs = WINDOW_MS) {}

  reset(): void {
    this.samples = []
    this.previousAssessment = null
  }

  setPreviousAssessment(level: AssessmentLevel | null): void {
    this.previousAssessment = level
  }

  add(sample: EvidenceSample): EvidenceSnapshot {
    this.samples.push(sample)
    this.prune(sample.timestamp)
    return this.snapshot(sample.timestamp)
  }

  snapshot(now = Date.now()): EvidenceSnapshot {
    this.prune(now)
    const valid = this.samples.filter((s) => s.faceDetected)
    const probabilities = valid.map((s) => s.deepfakeProbability)

    return {
      windowSeconds: this.windowMs / 1000,
      sampleCount: this.samples.length,
      validFaceFrames: valid.length,
      scores: probabilities.length ? computeStats(probabilities) : null,
      trend: computeTrend(valid),
      previousAssessment: this.previousAssessment,
      latestSample: this.samples.at(-1) ?? null
    }
  }

  get totalSamplesEver(): number {
    return this.lifetimeCount
  }

  private lifetimeCount = 0

  noteLifetime(): void {
    this.lifetimeCount += 1
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs
    this.samples = this.samples.filter((s) => s.timestamp >= cutoff)
  }
}

function computeStats(values: number[]): ScoreStats {
  const sorted = [...values].sort((a, b) => a - b)
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / values.length

  return {
    mean,
    median: percentile(sorted, 0.5),
    min: sorted[0],
    max: sorted[sorted.length - 1],
    stdDev: Math.sqrt(variance)
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 1) return sorted[0]
  const idx = (sorted.length - 1) * p
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return sorted[lo]
  const w = idx - lo
  return sorted[lo] * (1 - w) + sorted[hi] * w
}

function computeTrend(valid: EvidenceSample[]): ScoreTrend {
  if (valid.length < 4) return 'insufficient'
  const mid = Math.floor(valid.length / 2)
  const first = meanOf(valid.slice(0, mid).map((s) => s.deepfakeProbability))
  const second = meanOf(valid.slice(mid).map((s) => s.deepfakeProbability))
  const delta = second - first
  if (delta > 0.12) return 'rising'
  if (delta < -0.12) return 'falling'
  return 'stable'
}

function meanOf(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length
}
