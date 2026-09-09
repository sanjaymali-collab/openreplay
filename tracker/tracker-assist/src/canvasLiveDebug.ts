/**
 * Live-canvas pipeline diagnostics. Enabled only when
 * `window.__OR_CANVAS_DEBUG__` is truthy (the agent-side player honours the
 * same flag). Traces carry stage names, ids and sizes — never pixel or user
 * data.
 */

export type CanvasLiveStage =
  | 'CANVAS_DISCOVERED'
  | 'CANVAS_REGISTERED'
  | 'RENDERING_CONTEXT_DETECTED'
  | 'CAPTURE_INITIALIZED'
  | 'CAPTURE_FAILED'
  | 'PEER_CONNECTION_STARTED'
  | 'STREAM_CREATED'
  | 'TRACK_CREATED'
  | 'PEER_CONNECTED'
  | 'PEER_RETRY'
  | 'PEER_FAILED'
  | 'TRACK_SENT'
  | 'FRAME_PRODUCED'
  | 'TRACKER_RESTART'
  | 'CAPTURE_STOPPED'
  | 'CANVAS_REKEYED'
  | 'CANVAS_ID_UNSETTLED'
  | 'CANVAS_DEFERRED'

export function isCanvasLiveDebug(): boolean {
  try {
    return (
      typeof window !== 'undefined' &&
      Boolean((window as Window & { __OR_CANVAS_DEBUG__?: boolean }).__OR_CANVAS_DEBUG__)
    )
  } catch {
    return false
  }
}

export function canvasLiveTrace(
  stage: CanvasLiveStage,
  detail?: Record<string, string | number | boolean | null | undefined>,
): void {
  if (!isCanvasLiveDebug()) {
    return
  }
  try {
    // eslint-disable-next-line no-console
    console.debug('[openreplay-canvas]', stage, detail || {})
  } catch {
    /* ignore */
  }
}
