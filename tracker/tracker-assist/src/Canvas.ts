import { canvasLiveTrace } from './canvasLiveDebug.js'

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

function detectContextKind(canvas: HTMLCanvasElement): CaptureHandle['context'] {
  if (isNative2dCanvas(canvas)) {
    return '2d'
  }
  try {
    if (canvas.getContext('webgl2')) return 'webgl2'
  } catch {
    /* Flutter skwasm/WebGPU: getContext often returns null */
  }
  try {
    if (canvas.getContext('webgl') || canvas.getContext('experimental-webgl')) return 'webgl'
  } catch {
    /* ignore */
  }
  return 'unknown'
}

/**
 * WebGL canvases typically produce an empty captureStream() (cleared drawing
 * buffer, no compositor frames). Session Replay already works around this by
 * drawImage() → toBlob(). Live Assist must stay on captureStream → WebRTC, so
 * we copy WebGL pixels onto a 2D proxy and stream that instead.
 *
 * 2D canvases keep the direct captureStream path (no extra copy).
 */
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

export function createCanvasCapture(canvas: HTMLCanvasElement, fps: number): CaptureHandle {
  const kind = detectContextKind(canvas)
  canvasLiveTrace('RENDERING_CONTEXT_DETECTED', { context: kind, width: canvas.width, height: canvas.height })

  // Direct captureStream is valid only for a real 2D context. Flutter
  // CanvasKit/skwasm canvases often expose no getContext() at all (kind
  // "unknown") but still blit via drawImage. captureStream() on those is empty.
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

  // Three tickers can call copy() (rAF, the Worker and setInterval below).
  // Gate them to the requested fps: a full-size WebGL→2D drawImage plus a
  // requestFrame() per call at ~100Hz would peg the member's renderer.
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
          try {
            const sample = dest.getImageData(0, 0, Math.min(proxy.width, 8), Math.min(proxy.height, 8)).data
            let sum = 0
            let whites = 0
            const n = sample.length / 4
            for (let i = 0; i < sample.length; i += 4) {
              sum += sample[i] + sample[i + 1] + sample[i + 2]
              if (sample[i] > 245 && sample[i + 1] > 245 && sample[i + 2] > 245) whites += 1
            }
            ;(window as Window & { __OR_CANVAS_FRAME_STATS__?: Record<string, unknown> }).__OR_CANVAS_FRAME_STATS__ = {
              frames,
              mean: sum / n,
              whiteRatio: whites / n,
              width: proxy.width,
              height: proxy.height,
              source: 'webgl-proxy',
            }
          } catch {
            /* tainted / context lost */
          }
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
  // Background tabs pause rAF and throttle setInterval. A Worker ticker
  // keeps posting so the Assist stream (and session timer) stay live when
  // the member switches away and back.
  let worker: Worker | null = null
  try {
    const src = 'setInterval(function(){postMessage(1)},50)'
    worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })))
    worker.onmessage = () => {
      copy()
    }
  } catch {
    /* Worker unavailable */
  }
  const interval = window.setInterval(copy, 50)

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
      clearInterval(interval)
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
    try {
      if (typeof window !== 'undefined' && (window as Window & { __OR_CANVAS_DEBUG__?: boolean }).__OR_CANVAS_DEBUG__) {
        this.toggleLocal(handle.stream)
      }
    } catch {
      /* ignore */
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
      try {
        (window as Window & { __OR_CANVAS_LAST_ERROR__?: string }).__OR_CANVAS_LAST_ERROR__ =
          String((e as Error).message || e)
      } catch {
        /* ignore */
      }
      this.logError('canvas capture failed', this.canvasId, e)
    }
  }

  restart() {
    this.stopCopy()
    const handle = createCanvasCapture(this.canvas, this.fps)
    this.stream = handle.stream
    this.stopCopy = handle.stopCopy
    this.emitStream(handle.stream)
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
