import logger from '@/logger';
import MessageManager from 'Player/web/MessageManager';
import { Socket } from 'socket.io-client';
import { toast } from 'react-toastify';
import {
  clearCanvasCssFrame,
  paintCanvasCssFrame,
} from 'Player/web/managers/canvasCssPaint';

/** Encode quality for the CSS-paint path: a second lossy pass over already-
 * lossy video frames, never leaves the agent's machine. */
const CSS_FRAME_MIME = 'image/webp';
const CSS_FRAME_QUALITY = 0.8;

/** How long to wait for the replayed <canvas> node after its track arrives. */
const NODE_LOOKUP_INTERVAL_MS = 250;
const NODE_LOOKUP_ATTEMPTS = 20;

interface LiveCanvasData {
  video: HTMLVideoElement;
  canvas: HTMLCanvasElement;
  canvasCtx: CanvasRenderingContext2D;
  /**
   * CSS-paint path only: a private 2d canvas living in the *agent* document
   * (where scripting is enabled) that the decoded video frame is drawn into and
   * encoded from. The replayed canvas cannot be encoded — under the sandbox
   * its bitmap is never painted, and we do not draw into it at all.
   */
  staging?: HTMLCanvasElement;
  stagingCtx?: CanvasRenderingContext2D | null;
  /** One toBlob in flight per canvas: drop frames rather than queue them. */
  encoding: boolean;
  /** Blob URL currently displayed, revoked when the next frame replaces it. */
  blobUrl: string;
}

export default class CanvasReceiver {
  private streams: Map<string, MediaStream> = new Map();

  // Store RTCPeerConnection for each remote peer
  private connections: Map<string, RTCPeerConnection> = new Map();

  private cId: string;

  private frameCounter = 0;

  /** True while the rAF draw loop is scheduled (it exits when nothing is left). */
  private drawing = false;

  private canvasesData = new Map<string, LiveCanvasData>();

  // sendSignal – for sending signals (offer/answer/ICE)
  constructor(
    private readonly peerIdPrefix: string,
    private readonly config: RTCIceServer[],
    private readonly getNode: MessageManager['getNode'],
    private readonly agentInfo: Record<string, any>,
    private readonly socket: Socket,
    /**
     * The player document has scripting disabled (sandbox without
     * allow-scripts), so drawImage() into the replayed canvas is never shown.
     * Frames are then painted as the canvas element's CSS background instead
     * — the same mechanism CanvasManager uses for Session Replay.
     */
    private readonly useCssPaint: boolean = false,
  ) {
    // Form an id like in PeerJS
    this.cId = `${this.peerIdPrefix}-${this.agentInfo.id}-canvas`;

    this.socket.on(
      'webrtc_canvas_offer',
      (data: { data: { offer: RTCSessionDescriptionInit; id: string } }) => {
        const { offer, id } = data.data;
        if (checkId(id, this.cId)) {
          this.handleOffer(offer, id);
        }
      },
    );

    this.socket.on(
      'webrtc_canvas_ice_candidate',
      (data: { data: { candidate: RTCIceCandidateInit; id: string } }) => {
        const { candidate, id } = data.data;
        if (checkId(id, this.cId)) {
          this.handleCandidate(candidate, id);
        }
      },
    );

    this.socket.on('webrtc_canvas_stop', (data: { id: string }) => {
      const { id } = data;
      const canvasId = getCanvasId(id);
      this.connections.get(id)?.close();
      this.connections.delete(id);
      this.streams.delete(canvasId);
      this.disposeCanvasData(canvasId);
    });

    this.socket.on('webrtc_canvas_restart', () => {
      this.clear();
    });
  }

  async handleOffer(
    offer: RTCSessionDescriptionInit,
    id: string,
  ): Promise<void> {
    const pc = new RTCPeerConnection({
      iceServers: this.config,
    });

    // Save the connection
    this.connections.set(id, pc);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        const candidate =
          typeof event.candidate.toJSON === 'function'
            ? event.candidate.toJSON()
            : event.candidate;
        this.socket.emit('webrtc_canvas_ice_candidate', {
          candidate,
          id,
        });
      }
    };

    pc.ontrack = (event) => {
      const stream = event.streams[0];
      if (stream) {
        // Detect canvasId from remote peer id
        const canvasId = getCanvasId(id);
        this.streams.set(canvasId, stream);
        canvasAgentTrace('TRACK_RECEIVED', {
          canvasId,
          tracks: stream.getTracks().length,
        });
        this.attachWhenNodeArrives(canvasId, stream, id);
      }
    };

    await pc.setRemoteDescription(new RTCSessionDescription(offer));

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await new Promise<void>((resolve) => {
      if (pc.iceGatheringState === 'complete') {
        resolve();
        return;
      }
      const done = () => {
        pc.removeEventListener('icegatheringstatechange', onChange);
        resolve();
      };
      const onChange = () => {
        if (pc.iceGatheringState === 'complete') done();
      };
      pc.addEventListener('icegatheringstatechange', onChange);
      window.setTimeout(done, 2500);
    });

    this.socket.emit('webrtc_canvas_answer', { answer: pc.localDescription, id });
  }

  /**
   * The WebRTC track and the DOM message that creates the <canvas> node travel
   * on different channels, so the node may land shortly after the track. Poll
   * for it (bounded) instead of giving up after a single fixed delay.
   */
  private attachWhenNodeArrives(
    canvasId: string,
    stream: MediaStream,
    peerId: string,
    attempt = 0,
  ) {
    window.setTimeout(() => {
      // Stopped or superseded while waiting.
      if (this.connections.get(peerId)?.connectionState === 'closed') return;
      if (this.streams.get(canvasId) !== stream) return;
      const node = this.getNode(parseInt(canvasId, 10));
      const target = resolvePaintTarget(node);
      if (!target) {
        if (attempt + 1 < NODE_LOOKUP_ATTEMPTS) {
          this.attachWhenNodeArrives(canvasId, stream, peerId, attempt + 1);
        } else {
          logger.log('NODE', canvasId, 'IS NOT FOUND');
        }
        return;
      }
      const videoEl = spawnVideo(stream);
      this.disposeCanvasData(canvasId);
      this.canvasesData.set(canvasId, {
        video: videoEl,
        canvas: target.canvas,
        canvasCtx: target.ctx,
        encoding: false,
        blobUrl: '',
      });
      canvasAgentTrace('FRAME_RECEIVED', {
        canvasId,
        cssPaint: this.useCssPaint ? 1 : 0,
        attempt,
      });
      this.startDrawLoop();
    }, NODE_LOOKUP_INTERVAL_MS);
  }

  async handleCandidate(
    candidate: RTCIceCandidateInit,
    id: string,
  ): Promise<void> {
    const pc = this.connections.get(id);
    if (pc) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (e) {
        console.error('Error adding ICE candidate', e);
      }
    }
  }

  clear() {
    this.connections.forEach((pc) => {
      pc.close();
    });
    this.connections.clear();
    this.streams.clear();
    Array.from(this.canvasesData.keys()).forEach((id) =>
      this.disposeCanvasData(id),
    );
  }

  /**
   * Stop painting one canvas and release everything it holds: the displayed
   * blob URL, the staging canvas, and the CSS frame left on the replayed
   * element (so an ended stream never lingers as a frozen picture).
   */
  private disposeCanvasData(canvasId: string) {
    const data = this.canvasesData.get(canvasId);
    if (!data) return;
    this.canvasesData.delete(canvasId);
    if (data.blobUrl) {
      URL.revokeObjectURL(data.blobUrl);
      data.blobUrl = '';
    }
    if (data.staging) {
      data.staging.width = 0;
      data.staging.height = 0;
      data.staging = undefined;
      data.stagingCtx = undefined;
    }
    if (this.useCssPaint) {
      clearCanvasCssFrame(data.canvas);
    }
  }

  private paintedFrames = 0;

  private tracedRendered = new Set<string>();

  /**
   * CSS-paint path (see constructor). Copy the decoded video frame into the
   * agent-side staging canvas, encode it, and set it as the replayed canvas's
   * background. The staging canvas tracks the video's intrinsic size so the
   * encoder never up- or down-samples the frame; the CSS background then
   * stretches it into the canvas content box exactly like drawImage would.
   */
  private paintCssFrame(id: string, data: LiveCanvasData) {
    const { video, canvas } = data;
    if (data.encoding || video.readyState < 2) return;
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (w === 0 || h === 0) return;
    if (!data.staging) {
      data.staging = document.createElement('canvas');
      data.stagingCtx = data.staging.getContext('2d');
    }
    const { staging, stagingCtx } = data;
    if (!stagingCtx) return;
    if (staging.width !== w || staging.height !== h) {
      staging.width = w;
      staging.height = h;
    }
    stagingCtx.drawImage(video, 0, 0, w, h);
    data.encoding = true;
    staging.toBlob(
      (blob) => {
        // Stopped (or re-registered) while encoding: drop the frame.
        if (!blob || this.canvasesData.get(id) !== data) {
          data.encoding = false;
          return;
        }
        const url = URL.createObjectURL(blob);
        // Swapping background-image to a not-yet-decoded URL paints nothing
        // until it lands, which at ~15fps reads as flicker. Decode it in this
        // (same-origin) document first so the swap hits the image cache.
        const commit = () => {
          data.encoding = false;
          if (this.canvasesData.get(id) !== data) {
            URL.revokeObjectURL(url);
            return;
          }
          paintCanvasCssFrame(canvas, url);
          const previous = data.blobUrl;
          data.blobUrl = url;
          if (previous) URL.revokeObjectURL(previous);
          this.paintedFrames += 1;
          if (!this.tracedRendered.has(id)) {
            this.tracedRendered.add(id);
            canvasAgentTrace('FRAME_RENDERED', {
              canvasId: id,
              cssPaint: 1,
              w,
              h,
            });
          }
        };
        // Created in the canvas's own (player) document so the decoded
        // resource is the one that document's style resolution will hit.
        const img = (canvas.ownerDocument || document).createElement('img');
        img.src = url;
        if (typeof img.decode === 'function') {
          img.decode().then(commit, commit);
        } else {
          commit();
        }
      },
      CSS_FRAME_MIME,
      CSS_FRAME_QUALITY,
    );
  }

  /** Start the rAF paint loop unless one is already running. */
  private startDrawLoop() {
    if (this.drawing) return;
    this.drawing = true;
    this.frameCounter = 0;
    this.draw();
  }

  /** One paint tick (every 4th frame); reschedules itself while there is a canvas to paint. */
  draw = () => {
    if (this.frameCounter % 4 === 0) {
      if (this.canvasesData.size === 0) {
        this.drawing = false;
        return;
      }
      this.canvasesData.forEach((canvasData, id) => {
        const { video, canvas, canvasCtx } = canvasData;
        const node = this.getNode(parseInt(id, 10));
        if (!node) {
          this.disposeCanvasData(id);
          return;
        }
        if (video.paused) {
          void video.play().catch(() => {});
        }
        if (this.useCssPaint) {
          this.paintCssFrame(id, canvasData);
        } else {
          canvasCtx.drawImage(video, 0, 0, canvas.width, canvas.height);
          if (video.videoWidth > 0) this.paintedFrames += 1;
          if (!this.tracedRendered.has(id) && video.videoWidth > 0) {
            this.tracedRendered.add(id);
            canvasAgentTrace('FRAME_RENDERED', { canvasId: id, cssPaint: 0 });
          }
        }
        publishAgentLive({
          canvasId: id,
          videoW: video.videoWidth,
          videoH: video.videoHeight,
          frames: this.paintedFrames,
          ready: video.readyState,
          cssPaint: this.useCssPaint,
          inDom: canvas.isConnected,
        });
      });
    }
    this.frameCounter++;
    requestAnimationFrame(() => this.draw());
  };
}

/**
 * Debug-only (window.__OR_CANVAS_DEBUG__) window global with the live render
 * state, read by the live-canvas QA harness. No-op otherwise.
 */
function publishAgentLive(state: Record<string, unknown>): void {
  if (!isCanvasDebug()) return;
  try {
    (window as Window & { __OR_AGENT_LIVE__?: Record<string, unknown> }).__OR_AGENT_LIVE__ =
      state;
  } catch {
    /* ignore */
  }
}

function isCanvasDebug(): boolean {
  try {
    return (
      typeof window !== 'undefined' &&
      Boolean((window as Window & { __OR_CANVAS_DEBUG__?: boolean }).__OR_CANVAS_DEBUG__)
    );
  } catch {
    return false;
  }
}

function resolvePaintTarget(node: { node: Node } | undefined): {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
} | null {
  const el = node && (node.node as HTMLCanvasElement | undefined);
  if (!el || (el as Element).tagName !== 'CANVAS') return null;
  try {
    const ctx = el.getContext('2d');
    if (ctx) return { canvas: el, ctx };
  } catch {
    /* WebGL canvas — cannot paint 2d onto the same element */
  }
  return null;
}

function spawnVideo(stream: MediaStream) {
  const videoEl = document.createElement('video');

  videoEl.srcObject = stream;
  // Set the IDL properties, not just content attributes: `muted` set via
  // setAttribute after creation does not mute the element, and an unmuted
  // video is blocked by autoplay policy until a user gesture — which is what
  // used to surface as "Click to unpause canvas stream" on every connect.
  videoEl.muted = true;
  videoEl.autoplay = true;
  videoEl.playsInline = true;
  videoEl.setAttribute('autoplay', 'true');
  videoEl.setAttribute('muted', 'true');
  videoEl.setAttribute('playsinline', 'true');
  videoEl.setAttribute('crossorigin', 'anonymous');

  videoEl
    .play()
    .then(() => true)
    .catch(() => {
      toast.error('Click to unpause canvas stream', {
        autoClose: false,
        toastId: 'canvas-stream',
      });
      // we allow that if user just reloaded the page
    });

  const clearListeners = () => {
    document.removeEventListener('click', startStream);
    videoEl.removeEventListener('playing', clearListeners);
  };
  videoEl.addEventListener('playing', clearListeners);

  const startStream = () => {
    videoEl
      .play()
      .then(() => {
        toast.dismiss('canvas-stream');
        clearListeners();
      })
      .then(() => console.log('unpaused'))
      .catch(() => {
        // we allow that if user just reloaded the page
      });
    document.removeEventListener('click', startStream);
  };
  document.addEventListener('click', startStream);

  return videoEl;
}

/** Debug-only (window.__OR_CANVAS_DEBUG__) pipeline trace; never logs pixels. */
function canvasAgentTrace(
  stage: 'TRACK_RECEIVED' | 'FRAME_RECEIVED' | 'FRAME_RENDERED',
  detail: Record<string, string | number>,
): void {
  if (!isCanvasDebug()) return;
  try {
    // eslint-disable-next-line no-console
    console.debug('[openreplay-canvas]', stage, detail);
  } catch {
    /* ignore */
  }
}

function checkId(id: string, cId: string): boolean {
  return id.includes(cId);
}

function getCanvasId(id: string): string {
  const fromMarker = id.split('-canvas-')[1];
  if (fromMarker) return fromMarker;
  return id.split('-')[4];
}

/** simple peer example
 * // @ts-ignore
 *     const peer = new SLPeer({ initiator: false })
 *     socket.on('c_signal', ({ data }) => {
 *       console.log('got signal', data)
 *       peer.signal(data.data);
 *       peer.canvasId = data.id;
 *     });
 *
 *     peer.on('signal', (data: any) => {
 *       socket.emit('c_signal', data);
 *     });
 *     peer.on('stream', (stream: MediaStream) => {
 *       console.log('stream ready', stream, peer.canvasId);
 *       this.streams.set(peer.canvasId, stream)
 *       setTimeout(() => {
 *         const node = this.getNode(peer.canvasId)
 *         console.log(peer.canvasId, this.streams, node)
 *         spawnVideo(this.streams.get(peer.canvasId)?.clone(), node, this.screen)
 *       }, 500)
 *     })
 *     peer.on('error', console.error)
 *
 * */
