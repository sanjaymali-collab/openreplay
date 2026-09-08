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
| `tracker/tracker-assist/src/Assist.ts` | Canvas lifecycle across tracker restarts (`resetCanvasHandlers` / `rescanCanvases`), one capture per DOM element, id-settle window, capture deferred until an agent is connected, ICE gathering awaited before the offer, generic open-shadow-root canvas discovery, hidden **and obscured** canvases excluded |
| `tracker/tracker-assist/src/canvasDiscovery.ts` + `tests/canvasDiscovery.test.ts` | `findShadowRootCanvases()` — framework-agnostic; closed roots skipped |
| `tracker/tracker/src/main/app/canvas.ts` + `tests/canvas.test.ts` | Replay recorder keeps a shadow-root canvas alive (`isConnected`, not `document.contains`) |
| `tracker/tracker/src/main/app/index.ts` + `tests/sessionTokenResume.test.ts` | Session token version stamp written on first start so `stop()`/`start()` resumes the same session (Assist agents were orphaned otherwise) |
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

## Validation matrix (self-hosted, official dashboard)

| Runtime | Session Replay | Live Co-Browse | Remote control |
|---|---|---|---|
| HTML DOM | PASS | PASS (DOM mirrored, live change + navigation reflected) | move/click/scroll/text PASS; hover + key events NOT SUPPORTED |
| HTML 2D canvas | PASS | PASS (animating canvas painted on screen; capture stops on agent leave) | as HTML DOM |
| Flutter CanvasKit (shadow-DOM WebGL) | PASS (snapshots stream after `isConnected` fix) | PASS (UI visible, live change, navigation, resize, return trip; capture stops <50 ms after agent leaves) | cursor move PASS; click/hover/scroll/text/keys NOT SUPPORTED |

Remote control is unchanged by this work: `RemoteControl.ts` synthesizes DOM
`click` / `input` / `scrollTop` on the element under the agent's cursor and
never dispatches `mouseover` or key events (so hover/keyboard are NOT SUPPORTED
on every runtime). Flutter listens for `PointerEvent`s on `<flutter-view>` and
types through a hidden `<input>`, so the synthesized `click` reaches
`flt-glass-pane` and is inert — a canvas-only UI has no DOM hit targets.

### Live stream figures (Flutter CanvasKit, 1440×900 member, same host)

- Member capture → encode → send: ~29 fps at 480×300–960×600 (WebRTC
  bandwidth-limited on loopback), 80–160 kbps; agent decode ~29 fps, paint loop
  every 4th rAF (~15 fps) in CSS-paint mode.
- Change-to-agent latency: 20–155 ms (navigation, text entry, resize, relaunch).
- Member CPU (CDP `TaskDuration`): ~1 % idle → ~7.5 % while streaming;
  JS heap flat (~57–61 MB). The previous light-DOM mirror workaround measured
  ~9.4 % under the same load with a 640×400 / 10 fps stream, and offered the
  agent a second canvas.
- 30 fps is the pre-existing Assist canvas rate (`new Canvas(node, id, 30, …)`);
  the proxy copy is gated to it. Lowering it is a one-line tuning knob if
  bandwidth matters more than smoothness.

### Browsers

| Role | Browser | Result |
|---|---|---|
| Member | Chromium 151 | PASS |
| Member | Firefox 153 | PASS (frames + live change). Same-host harness needs `media.peerconnection.ice.loopback=true`; irrelevant off-loopback |
| Member | WebKit 26.5 (Safari engine) | PASS (frames + live change) |
| Agent | Chromium 151 | PASS |
| Agent | Firefox 153 | PASS |
| Agent | WebKit 26.5 | NOT VALIDATED — the harness `ICE_SERVERS` TURN entry (`turn:127.0.0.1:3478?transport=tcp`) is rejected by WebKit's `RTCPeerConnection` (`SyntaxError: Invalid TURN URL query string`) before any canvas code runs |

### Consent / masking (fail-closed)

- With Assist `requestConfirm` on: no canvas `RTCPeerConnection`, no
  `webrtc_canvas_offer`, agent viewport blank until the member clicks Allow;
  Reject keeps it that way; Allow on a later request starts the stream.
- `data-openreplay-hidden` and `data-openreplay-obscured` canvases are never
  captured (Assist now applies the same `isObscured` exclusion as the Session
  Replay recorder); a canvas in a **closed** shadow root is unreachable and is
  not captured; an open-shadow canvas is discovered generically.
- Traces (`__OR_CANVAS_DEBUG__`) carry stage names, ids and sizes only.

## Remaining limitations

- Tracker must load **before** the app creates its WebGL context, or
  `preserveDrawingBuffer` cannot be applied to that context. The proxy
  `drawImage` still helps when the current frame is in the buffer.
- A canvas whose context was transferred to a worker (skwasm-style
  `OffscreenCanvas`) answers `null` to every `getContext` kind; it is detected
  as `unknown` and read through the same `drawImage` proxy, which works when the
  browser keeps the transferred bitmap readable (it does in Chromium, Firefox
  and WebKit for Flutter CanvasKit). WebGPU is not handled.
- Building `tracker-assist` with a bare `tsc` skips the package's
  `replace-req-version` step and leaves the `REQUIRED_TRACKER_VERSION`
  placeholder in `lib/`, which makes Assist refuse to load ("minimum required
  version … is not met"). Use `npm run build` (or apply the substitution).
- `tracker/tracker-assist/package.json` points `@openreplay/tracker` at
  `file:../tracker` for the local build; restore `workspace:*` before an
  upstream PR.
- The `RemoteControl.select` change replaces a call to an `isAuthorized` method
  that does not exist at upstream HEAD (compile error) with the check the rest
  of the file uses.
- CSS-paint mode re-encodes each decoded frame to webp on the agent (one encode
  in flight, frames dropped while busy); it is only used when the player iframe
  cannot paint bitmaps.
- Remote control of a canvas-only UI remains a separate problem (no DOM
  hit targets).
- `tracker/tracker-assist/tests/Assist.test.ts` does not compile against
  upstream HEAD either (references `requestConfirm`, expects `Map`-based
  `calls`); pre-existing, untouched.
