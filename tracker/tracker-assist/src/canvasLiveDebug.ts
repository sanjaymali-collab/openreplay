/**
 * Live-canvas pipeline stages. Enabled only when
 * `window.__OR_CANVAS_DEBUG__` is truthy. Never logs pixel/user data.
 */

export type CanvasLiveStage =
  | 'CANVAS_DISCOVERED'
  | 'CANVAS_REGISTERED'
  | 'RENDERING_CONTEXT_DETECTED'
  | 'CAPTURE_INITIALIZED'
  | 'PEER_CONNECTION_STARTED'
  | 'STREAM_CREATED'
  | 'TRACK_CREATED'
  | 'PEER_CONNECTED'
  | 'TRACK_SENT'
  | 'TRACK_RECEIVED'
  | 'FRAME_PRODUCED'
  | 'FRAME_RECEIVED'
  | 'FRAME_RENDERED'
  | 'TRACKER_RESTART'
  | 'CAPTURE_STOPPED'
  | 'CANVAS_REKEYED'
  | 'CANVAS_ID_UNSETTLED'
  | 'CANVAS_DEFERRED'

export function canvasLiveTrace(
  stage: CanvasLiveStage,
  detail?: Record<string, string | number | boolean | null | undefined>,
): void {
  try {
    const w = typeof window !== 'undefined' ? (window as Window & { __OR_CANVAS_DEBUG__?: boolean }) : null
    if (!w || !w.__OR_CANVAS_DEBUG__) {
      return
    }
    // eslint-disable-next-line no-console
    console.debug('[openreplay-canvas]', stage, detail || {})
  } catch {
    /* ignore */
  }
}
