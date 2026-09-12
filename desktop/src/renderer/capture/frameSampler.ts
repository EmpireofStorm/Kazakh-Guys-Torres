export class FrameSampler {
  private timer: number | null = null
  private canvas: HTMLCanvasElement
  private ctx: CanvasRenderingContext2D

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly onFrame: (jpegBase64: string, capturedAt: number) => Promise<void>
  ) {
    this.canvas = document.createElement('canvas')
    const ctx = this.canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) throw new Error('Canvas unsupported')
    this.ctx = ctx
  }

  start(getFps: () => number): void {
    this.stop()
    const tick = async () => {
      const fps = Math.min(4, Math.max(1, getFps()))
      try {
        await this.capture()
      } catch {
        // keep sampling even if one frame fails
      }
      this.timer = window.setTimeout(tick, Math.round(1000 / fps))
    }
    void tick()
  }

  stop(): void {
    if (this.timer !== null) {
      window.clearTimeout(this.timer)
      this.timer = null
    }
  }

  private async capture(): Promise<void> {
    const video = this.video
    if (video.readyState < 2 || video.videoWidth === 0) return

    const maxW = 640
    const scale = Math.min(1, maxW / video.videoWidth)
    this.canvas.width = Math.max(1, Math.round(video.videoWidth * scale))
    this.canvas.height = Math.max(1, Math.round(video.videoHeight * scale))
    this.ctx.drawImage(video, 0, 0, this.canvas.width, this.canvas.height)
    const dataUrl = this.canvas.toDataURL('image/jpeg', 0.7)
    const jpegBase64 = dataUrl.replace(/^data:image\/jpeg;base64,/, '')
    await this.onFrame(jpegBase64, Date.now())
  }
}
