import { canvasLiveTrace, isCanvasLiveDebug } from './canvasLiveDebug.js'

// Background ticker period for the WebGL proxy copy loop. Well above the
// requested fps on purpose: copy() rate-gates to fps, so a faster tick only
// buys accuracy, not more work.
const TICK_MS = 50

/**
 * Longest side the WebGL proxy is allowed to have. A CanvasKit canvas is
 * backed at CSS size × devicePixelRatio (a 1728px-wide window at DPR 2 is a
 * 3456px bitmap; a 5K display at DPR 2 is 5120px). Everything up to 4K UHD is
 * streamed 1:1 so the agent sees the member's exact pixels; beyond that the
 * proxy is scaled down proportionally to keep the encoder within what
 * browsers can actually encode in real time.
 */
export const MAX_CAPTURE_DIM = 3840

/** Scale factor (≤ 1) that fits `w×h` into MAX_CAPTURE_DIM. */
export function captureScale(w: number, h: number): number {
  const longest = Math.max(w, h)
  return longest > MAX_CAPTURE_DIM ? MAX_CAPTURE_DIM / longest : 1
}

/**
 * Tell the encoder this is screen content, not camera video. Without a hint
 * WebRTC treats a canvas track like a webcam: under its default bitrate cap it
 * *lowers the resolution* to keep 30fps, so a DPR-2 UI arrives at a quarter of
 * its size and is stretched back over the canvas box — the "small, blurred"
 * co-browse picture. 'detail' switches the encoder to screen-content mode
 * (resolution is kept, framerate is what gives) and is paired with explicit
 * sender parameters in Assist.startCanvasStream.
 */
function hintScreenContent(stream: MediaStream | null) {
  stream?.getVideoTracks().forEach((track) => {
    try {
      if ('contentHint' in track) {
        track.contentHint = 'detail'
      }
    } catch {
      /* ignore */
    }
  })
}

/** Framerate the sender is asked to hold: UI content, not video. */
export const CANVAS_MAX_FPS = 15
/** Bitrate ceiling clamps: enough for sharp 4K UI at CANVAS_MAX_FPS, never below SD. */
const CANVAS_MIN_BITRATE = 1_500_000
const CANVAS_MAX_BITRATE = 12_000_000
/** Bits per pixel per frame for screen content at the quality we want (~0.08). */
const CANVAS_BITS_PER_PIXEL = 0.08

/**
 * Bitrate ceiling for a canvas of `w×h` pixels: scales with the frame size so
 * a DPR-2 desktop canvas is not squeezed into the same ~2Mbps the browser
 * gives a webcam (which is exactly what forced the 4× downscale).
 */
export function canvasMaxBitrate(w: number, h: number): number {
  const bps = w * h * CANVAS_BITS_PER_PIXEL * CANVAS_MAX_FPS
  return Math.round(Math.min(CANVAS_MAX_BITRATE, Math.max(CANVAS_MIN_BITRATE, bps)))
}

/**
 * Sender-side encoding policy for a live canvas track: keep the resolution
 * (degrade framerate under bandwidth/CPU pressure, never the picture), never
 * pre-scale, cap framerate at CANVAS_MAX_FPS, and raise the bitrate ceiling to
 * match the frame size. Best effort — browsers that reject a field keep the
 * rest, and a rejected call leaves the defaults in place.
 */
export async function configureCanvasSender(
  sender: RTCRtpSender,
  width: number,
  height: number,
): Promise<void> {
  let params: RTCRtpSendParameters
  try {
    params = sender.getParameters()
  } catch {
    return
  }
  if (!params.encodings || params.encodings.length === 0) {
    params.encodings = [{}]
  }
  const maxBitrate = canvasMaxBitrate(width, height)
  params.encodings.forEach((enc) => {
    enc.maxBitrate = maxBitrate
    enc.maxFramerate = CANVAS_MAX_FPS
    enc.scaleResolutionDownBy = 1
    // Firefox rejects unknown/`undefined` fields on setParameters.
    if (enc.networkPriority !== undefined) enc.networkPriority = 'high'
    if (enc.priority !== undefined) enc.priority = 'high'
  })
  ;(params as RTCRtpSendParameters & { degradationPreference?: string }).degradationPreference =
    'maintain-resolution'
  try {
    await sender.setParameters(params)
  } catch {
    // Retry without the priority fields, the most commonly rejected ones.
    try {
      const again = sender.getParameters()
      again.encodings.forEach((enc) => {
        enc.maxBitrate = maxBitrate
        enc.maxFramerate = CANVAS_MAX_FPS
        enc.scaleResolutionDownBy = 1
      })
      ;(again as RTCRtpSendParameters & { degradationPreference?: string }).degradationPreference =
        'maintain-resolution'
      await sender.setParameters(again)
    } catch {
      /* keep browser defaults */
    }
  }
}

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
export function createCanvasCapture(
  canvas: HTMLCanvasElement,
  fps: number,
  onResize?: (width: number, height: number) => void,
): CaptureHandle {
  const kind = detectContextKind(canvas)
  canvasLiveTrace('RENDERING_CONTEXT_DETECTED', { context: kind, width: canvas.width, height: canvas.height })

  if (kind === '2d') {
    const stream = canvas.captureStream(fps)
    hintScreenContent(stream)
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

  // Proxy backing size for the current source size: 1:1 up to
  // MAX_CAPTURE_DIM, proportionally smaller beyond it. Tracks the source on
  // every copy so a window resize / DPR change is followed within one frame.
  const targetSize = (): [number, number] => {
    const s = captureScale(canvas.width, canvas.height)
    return [Math.max(1, Math.round(canvas.width * s)), Math.max(1, Math.round(canvas.height * s))]
  }
  const blit = () => {
    if (!dest) return
    if (proxy.width === canvas.width && proxy.height === canvas.height) {
      dest.drawImage(canvas, 0, 0)
    } else {
      dest.drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, proxy.width, proxy.height)
    }
  }

  // captureStream() on a 0×0 canvas never produces frames, even after resize.
  if (canvas.width >= 8 && canvas.height >= 8) {
    ;[proxy.width, proxy.height] = targetSize()
    try {
      blit()
    } catch {
      /* context lost */
    }
  }
  stream = proxy.captureStream(fps)
  hintScreenContent(stream)
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
      const [tw, th] = targetSize()
      if (proxy.width !== tw || proxy.height !== th) {
        proxy.width = tw
        proxy.height = th
        // Window resize / DPR change: let the sender re-derive its bitrate
        // ceiling for the new frame size.
        onResize?.(tw, th)
      }
      if (proxy.width > 0 && proxy.height > 0 && dest && canvas.width > 0 && canvas.height > 0) {
        blit()
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

  /** The application canvas being captured (size source of truth for the sender). */
  get source(): HTMLCanvasElement {
    return this.canvas
  }

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly canvasId: number,
    private readonly fps: number,
    private readonly onStream: (stream: MediaStream) => void,
    private readonly logError: (...args: any[]) => void,
    /** Fired when the streamed frame size changes (source resize / DPR change). */
    private readonly onResize?: (width: number, height: number) => void,
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
      this.applyHandle(createCanvasCapture(this.canvas, this.fps, this.onResize))
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
    this.applyHandle(createCanvasCapture(this.canvas, this.fps, this.onResize))
  }

  toggleLocal(stream: MediaStream) {
    const possibleVideoEl = document.getElementById('canvas-or-testing')
    if (possibleVideoEl) {
      document.body.removeChild(possibleVideoEl)
    }
    // Debug-only local preview of the captured stream. Anything appended to
    // <body> is mirrored to the agent, where a <video> with no stream paints
    // as a black box over the canvas; a hidden element is still recorded as a
    // same-size placeholder. So mount the preview inside a 0×0 host with a
    // *closed* shadow root: the tracker records only the empty host, while
    // the video (overflow) stays visible on the member for the developer.
    const host = document.createElement('div')
    host.id = 'canvas-or-testing'
    host.setAttribute('data-openreplay-hidden', '1')
    host.style.cssText =
      'position:fixed;left:0;bottom:0;width:0;height:0;overflow:visible;z-index:2147483647;pointer-events:none;'
    const video = document.createElement('video')
    video.width = 520
    video.height = 400
    video.style.cssText = 'position:absolute;left:0;bottom:0;'
    video.setAttribute('autoplay', 'true')
    video.setAttribute('muted', 'true')
    video.setAttribute('playsinline', 'true')
    video.crossOrigin = 'anonymous'
    host.attachShadow({ mode: 'closed' }).appendChild(video)
    document.body.appendChild(host)

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
