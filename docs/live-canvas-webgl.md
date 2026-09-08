# Live Assist canvas (WebGL / Flutter CanvasKit)

Branch: `feature/co-browse`. Generic OpenReplay canvas capability — not Flutter- or Mongoose-specific.

## Architecture: where the paths diverge

```
Session Replay
  canvas node (incl. Shadow DOM)
    → CanvasRecorder.captureSnapshot()
    → drawImage(src → 2D dummy) → toBlob(webp)
    → POST /v1/web/images
    → CanvasManager paints frames as the replayed canvas' CSS background
  Result on Flutter CanvasKit: PASS

Live Assist (before)
  canvas node
    → tracker-assist Canvas.captureStream(src)
    → WebRTC addTrack
    → agent CanvasReceiver drawImage(<video>) onto the reconstructed canvas
  Result on Flutter CanvasKit: FAIL (white viewport)
  Result on HTML 2D canvas: FAIL under the sandboxed player (see root cause 2)
  Result on HTML DOM: PASS (no WebRTC involved)
```

Two independent root causes, one per end of the pipe:

1. **Member / capture** (`tracker/tracker-assist/src/Canvas.ts`, former
   `this.canvas.captureStream(this.fps)`): browsers do not composite WebGL
   frames into `captureStream()` unless `preserveDrawingBuffer` was set at
   `getContext` time, and even then the track is often empty. Session Replay
   never used `captureStream`; it used `drawImage` + `toBlob`, which is why it
   worked.
2. **Agent / render** (`frontend/app/player/web/assist/CanvasReceiver.ts`):
   the player iframe is sandboxed **without `allow-scripts`**
   (`Screen.ts`). Per the HTML spec a `<canvas>` in a script-disabled document
   renders its *fallback content*, not its bitmap, so `drawImage()` filled the
   bitmap and nothing was ever shown — no error, no log. Upstream fixed the
   *replay* side of this in `CanvasManager` (#4854: paint frames as CSS
   background); the live receiver still drew bitmaps.

```
Live Assist (after)
  canvas node
    → detect 2d vs webgl/webgl2
    → 2d: captureStream(src)                       (unchanged)
    → webgl: rAF drawImage → 2D proxy → captureStream(proxy), fps-gated
    → existing webrtc_canvas_* signaling (ICE bundled + candidate buffering)
    → CanvasReceiver: decoded <video> → staging canvas → toBlob(webp)
         → Image.decode() → replayed canvas CSS background
      (bitmap drawImage only when Screen.scriptingEnabled)
```

## Files changed

| File | Why |
|------|-----|
| `tracker/tracker-assist/src/Canvas.ts` | WebGL → 2D proxy, then existing `captureStream` + WebRTC; single fps-gated copy loop even with several tickers (rAF + worker + interval) |
| `tracker/tracker-assist/src/Assist.ts` | Canvas lifecycle across tracker restarts (`resetCanvasHandlers` / `rescanCanvases`), one capture per DOM element, id-settle window, capture deferred until an agent is connected, ICE gathering awaited before the offer |
| `tracker/tracker-assist/src/canvasLiveDebug.ts` | `__OR_CANVAS_DEBUG__` stage traces (no pixel/PII logs) |
| `tracker/tracker-assist/tests/Canvas.test.ts` | Regression: 2d = direct stream, webgl = proxy, fps gate |
| `tracker/tracker/src/main/app/preserveDrawingBuffer.ts` | Default-on `getContext` patch so the drawing buffer is readable |
| `tracker/tracker/src/main/app/index.ts` | `canvas.preserveDrawingBuffer` option (default `true`) |
| `tracker/tracker/src/tests/preserveDrawingBuffer.test.ts` | Patch unit tests |
| `frontend/app/player/web/managers/canvasCssPaint.ts` | Shared CSS-background paint/clear helper for replay and live |
| `frontend/app/player/web/managers/CanvasManager.ts` | Uses the shared helper |
| `frontend/app/player/web/assist/CanvasReceiver.ts` | CSS-paint mode under the sandbox (staging canvas → webp blob → pre-decoded background), overlay/blob cleanup on `webrtc_canvas_stop`, ICE bundling, `FRAME_RECEIVED` / `FRAME_RENDERED` traces |
| `frontend/app/player/web/assist/AssistManager.ts` | Passes `!screen.scriptingEnabled` to `CanvasReceiver`; optional deployment ICE/TURN config via `ICE_SERVERS` env |
| `frontend/tests/unit/CanvasReceiver.test.ts` | Regression: bitmap vs CSS-paint mode, single encode in flight, blob revocation, stop/clear, pre-decode |

## Diagnostics

In the member or agent console:

```js
window.__OR_CANVAS_DEBUG__ = true
```

Stages: `CANVAS_DISCOVERED`, `CANVAS_REGISTERED`, `RENDERING_CONTEXT_DETECTED`,
`CAPTURE_INITIALIZED`, `STREAM_CREATED`, `TRACK_CREATED`, `PEER_CONNECTED`,
`TRACK_SENT`, `TRACK_RECEIVED`, `FRAME_PRODUCED`, `FRAME_RECEIVED`, `FRAME_RENDERED`,
plus lifecycle: `TRACKER_RESTART`, `CANVAS_REKEYED`, `CANVAS_ID_UNSETTLED`,
`CANVAS_DEFERRED`, `CAPTURE_STOPPED`.

On the member, `__OR_CANVAS_DEBUG__` also forces eager capture (before any agent
joins) and a local debug `<video>`; leave it off to exercise product semantics.

## Validation matrix (self-hosted, official dashboard, headless Chromium)

| Runtime | Session Replay | Live Co-Browse |
|---|---|---|
| HTML DOM | PASS | PASS (DOM mirrored, live change + navigation reflected) |
| HTML 2D canvas | PASS | PASS (animating canvas painted on screen; capture stops on agent leave) |
| Flutter CanvasKit | PASS | PASS (UI visible, live change, navigation, return trip; capture stops ≈4s after agent leaves) |

## Remaining limitations

- Tracker must load **before** the app creates its WebGL context, or
  `preserveDrawingBuffer` cannot be applied to that context. The proxy
  `drawImage` still helps when the current frame is in the buffer.
- OffscreenCanvas / WebGPU are not handled.
- CSS-paint mode re-encodes each decoded frame to webp on the agent (one encode
  in flight, frames dropped while busy); it is only used when the player iframe
  cannot paint bitmaps.
- Remote control of a canvas-only UI remains a separate problem (no DOM
  hit targets).
- `tracker/tracker-assist/tests/Assist.test.ts` does not compile against
  upstream HEAD either (references `requestConfirm`, expects `Map`-based
  `calls`); pre-existing, untouched.
