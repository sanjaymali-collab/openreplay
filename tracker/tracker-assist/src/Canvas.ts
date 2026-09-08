import { canvasLiveTrace, isCanvasLiveDebug } from './canvasLiveDebug.js'

// Background ticker period for the WebGL proxy copy loop. Well above the
// requested fps on purpose: copy() rate-gates to fps, so a faster tick only
// buys accuracy, not more work.
const TICK_MS = 50

type CaptureHandle = {
  stream: MediaStream
  stopCopy: () => void
  source: 'direct' | 'webgl-proxy'
  context: '2d' | 'webgl' | 'webgl2' | 'unknown'
}

function isNative2dCanvas(canvas: HTMLCanvasElement): boolean {
  try {
    return !!canvas.getContext('2d')
  } catch {
    return false
  }
}

/**
 * getContext() returns the existing context only when asked for the same
 * kind; asking a WebGL canvas for '2d' returns null (and vice versa), so
 * probing in order tells us which kind the application created. A canvas
 * whose context was transferred to a worker / OffscreenCanvas answers null to
 * every kind ('unknown') but can still be read via drawImage.
 */
function detectContextKind(canvas: HTMLCanvasElement): CaptureHandle['context'] {
  if (isNative2dCanvas(canvas)) {
    return '2d'
  }
  try {
    if (canvas.getContext('webgl2')) return 'webgl2'
  } catch {
    /* ignore */
  }
  try {
    if (canvas.getContext('webgl') || canvas.getContext('experimental-webgl')) return 'webgl'
  } catch {
    /* ignore */
  }
  return 'unknown'
}

/** Resolve once the canvas has a real backing store (or after timeoutMs). */
function waitForCanvasSize(canvas: HTMLCanvasElement, timeoutMs = 4000): Promise<void> {
  return new Promise((resolve) => {
    const started = Date.now()
    const tick = () => {
      if ((canvas.width >= 8 && canvas.height >= 8) || Date.now() - started > timeoutMs) {
        resolve()
        return
      }
      window.setTimeout(tick, 50)
    }
    tick()
  })
}

function requestCaptureFrame(stream: MediaStream | null) {
  const track = stream?.getVideoTracks()[0] as (MediaStreamTrack & { requestFrame?: () => void }) | undefined
  try {
    track?.requestFrame?.()
  } catch {
    /* ignore */
  }
}

/**
 * Build a MediaStream for a canvas.
 *
 * 2D canvases stream directly via captureStream() (no extra copy). WebGL
 * canvases do not: captureStream() only emits a frame when the canvas is
 * composited, and a WebGL drawing buffer without preserveDrawingBuffer is
 * cleared right after compositing, so the track stays black/empty. Session
 * Replay already works around this with drawImage() → toBlob(); live Assist
 * must stay on captureStream → WebRTC, so the WebGL pixels are copied onto a
 * hidden 2D proxy canvas (rate-gated to `fps`) and the proxy is streamed.
 * The tracker's preserveDrawingBuffer patch keeps the source readable.
 */
export function createCanvasCapture(canvas: HTMLCanvasElement, fps: number): CaptureHandle {
  const kind = detectContextKind(canvas)
  canvasLiveTrace('RENDERING_CONTEXT_DETECTED', { context: kind, width: canvas.width, height: canvas.height })

  if (kind === '2d') {
    const stream = canvas.captureStream(fps)
    requestCaptureFrame(stream)
    canvasLiveTrace('CAPTURE_INITIALIZED', { source: 'direct', context: kind })
    canvasLiveTrace('STREAM_CREATED', { tracks: stream.getTracks().length })
    canvasLiveTrace('TRACK_CREATED', { videoTracks: stream.getVideoTracks().length })
    return {
      stream,
      stopCopy: () => {},
      source: 'direct',
      context: kind,
    }
  }

  const proxy = document.createElement('canvas')
  proxy.setAttribute('data-openreplay-hidden', '1')
  proxy.style.cssText =
    'position:fixed;left:-10000px;top:0;opacity:0.01;pointer-events:none;z-index:-1;'
  try {
    document.body.appendChild(proxy)
  } catch {
    /* ignore */
  }
  const dest = proxy.getContext('2d')
  let running = true
  let raf = 0
  let frames = 0
  let stream: MediaStream | null = null

  // captureStream() on a 0×0 canvas never produces frames, even after resize.
  if (canvas.width >= 8 && canvas.height >= 8) {
    proxy.width = canvas.width
    proxy.height = canvas.height
    try {
      dest?.drawImage(canvas, 0, 0)
    } catch {
      /* context lost */
    }
  }
  stream = proxy.captureStream(fps)
  requestCaptureFrame(stream)

  // Two tickers can call copy() (rAF and the background Worker below). Gate
  // them to the requested fps: a full-size WebGL→2D drawImage plus a
  // requestFrame() per call at ~80Hz would peg the member's renderer.
  const minIntervalMs = fps > 0 ? 1000 / fps : 0
  let lastCopyAt = 0

  const copy = () => {
    if (!running) {
      return
    }
    const now = performance.now()
    if (now - lastCopyAt < minIntervalMs - 1) {
      return
    }
    lastCopyAt = now
    try {
      if (proxy.width !== canvas.width) {
        proxy.width = canvas.width
      }
      if (proxy.height !== canvas.height) {
        proxy.height = canvas.height
      }
      if (proxy.width > 0 && proxy.height > 0 && dest) {
        dest.drawImage(canvas, 0, 0)
        requestCaptureFrame(stream)
        frames += 1
        if (frames === 1 || frames % 60 === 0) {
          canvasLiveTrace('FRAME_PRODUCED', { frames, width: proxy.width, height: proxy.height })
        }
      }
    } catch {
      /* context lost */
    }
  }
  const rafLoop = () => {
    if (!running) {
      return
    }
    copy()
    raf = requestAnimationFrame(rafLoop)
  }
  rafLoop()
  // Background tabs pause rAF and throttle setInterval to ~1Hz. A Worker
  // ticker keeps posting so the Assist stream stays live when the member
  // switches away and back; setInterval is only the fallback when Workers
  // (or blob: URLs) are blocked. Both are rate-gated by copy().
  let worker: Worker | null = null
  let interval: number | null = null
  try {
    const src = `setInterval(function(){postMessage(1)},${TICK_MS})`
    worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })))
    worker.onmessage = () => {
      copy()
    }
  } catch {
    interval = window.setInterval(copy, TICK_MS)
  }

  canvasLiveTrace('CAPTURE_INITIALIZED', { source: 'webgl-proxy', context: kind })
  canvasLiveTrace('STREAM_CREATED', { tracks: stream?.getTracks().length || 0 })
  canvasLiveTrace('TRACK_CREATED', { videoTracks: stream?.getVideoTracks().length || 0 })

  return {
    stream: stream as MediaStream,
    stopCopy: () => {
      running = false
      if (raf) {
        cancelAnimationFrame(raf)
      }
      if (interval !== null) {
        clearInterval(interval)
      }
      try {
        worker?.terminate()
      } catch {
        /* ignore */
      }
      proxy.width = 0
      proxy.height = 0
      try {
        proxy.remove()
      } catch {
        /* ignore */
      }
    },
    source: 'webgl-proxy',
    context: kind,
  }
}

export default class CanvasRecorder {
  stream: MediaStream | null = null
  private stopCopy: () => void = () => {}
  private cancelled = false
  captureSource: CaptureHandle['source'] = 'direct'
  captureContext: CaptureHandle['context'] = 'unknown'

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly canvasId: number,
    private readonly fps: number,
    private readonly onStream: (stream: MediaStream) => void,
    private readonly logError: (...args: any[]) => void,
  ) {
    canvasLiveTrace('CANVAS_REGISTERED', { canvasId: this.canvasId })
    void this.beginCapture()
  }

  private applyHandle(handle: CaptureHandle) {
    this.stream = handle.stream
    this.stopCopy = handle.stopCopy
    this.captureSource = handle.source
    this.captureContext = handle.context
    this.emitStream(handle.stream)
    if (isCanvasLiveDebug()) {
      this.toggleLocal(handle.stream)
    }
  }

  private async beginCapture() {
    await waitForCanvasSize(this.canvas)
    if (this.cancelled) {
      return
    }
    try {
      this.applyHandle(createCanvasCapture(this.canvas, this.fps))
    } catch (e) {
      canvasLiveTrace('CAPTURE_FAILED', {
        canvasId: this.canvasId,
        error: String((e as Error).message || e),
      })
      this.logError('canvas capture failed', this.canvasId, e)
    }
  }

  restart() {
    this.stopCopy()
    this.applyHandle(createCanvasCapture(this.canvas, this.fps))
  }

  toggleLocal(stream: MediaStream) {
    const possibleVideoEl = document.getElementById('canvas-or-testing')
    if (possibleVideoEl) {
      document.body.removeChild(possibleVideoEl)
    }
    const video = document.createElement('video')
    video.width = 520
    video.height = 400
    video.id = 'canvas-or-testing'
    video.setAttribute('autoplay', 'true')
    video.setAttribute('muted', 'true')
    video.setAttribute('playsinline', 'true')
    video.crossOrigin = 'anonymous'
    document.body.appendChild(video)

    video.srcObject = stream

    void video.play()
    video.addEventListener('error', (e) => {
      this.logError('Video error:', e)
    })
  }

  emitStream(stream?: MediaStream) {
    if (stream) {
      return this.onStream(stream)
    }
    if (this.stream) {
      this.onStream(this.stream)
    } else {
      this.logError('no stream for canvas', this.canvasId)
    }
  }

  stop() {
    this.cancelled = true
    this.stopCopy()
    this.stream?.getTracks().forEach((track) => track.stop())
    this.stream = null
  }
}
