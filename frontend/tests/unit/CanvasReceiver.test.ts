import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import CanvasReceiver from '../../app/player/web/assist/CanvasReceiver';
import {
  clearCanvasCssFrame,
  paintCanvasCssFrame,
} from '../../app/player/web/managers/canvasCssPaint';

jest.mock('react-toastify', () => ({
  toast: { error: jest.fn(), dismiss: jest.fn() },
}));

jest.mock('@/logger', () => ({
  __esModule: true,
  default: { log: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));

/**
 * Regression: the player iframe is sandboxed without allow-scripts, so a
 * <canvas> in it renders fallback content instead of its bitmap. Live Assist
 * used to drawImage() into that bitmap and the agent saw a blank canvas even
 * though frames were arriving. Under useCssPaint the receiver must paint each
 * decoded frame as the element's CSS background instead (as CanvasManager does
 * for Session Replay) and never touch the invisible bitmap.
 */

type Handler = (...args: any[]) => void;

function fakeSocket() {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    on: jest.fn((ev: string, h: Handler) => {
      handlers.set(ev, h);
    }),
    emit: jest.fn(),
    fire(ev: string, payload: unknown) {
      handlers.get(ev)?.(payload);
    },
  };
}

function fakeVideo(w = 320, h = 180) {
  return {
    videoWidth: w,
    videoHeight: h,
    readyState: 4,
    paused: false,
    play: jest.fn(() => Promise.resolve()),
  } as unknown as HTMLVideoElement;
}

let createdBlobs: string[];
let revokedBlobs: string[];
let toBlobCallbacks: Array<(b: Blob | null) => void>;
let stagingCanvases: HTMLCanvasElement[];
let realCreateElement: typeof document.createElement;

beforeEach(() => {
  createdBlobs = [];
  revokedBlobs = [];
  toBlobCallbacks = [];
  stagingCanvases = [];
  let n = 0;
  (URL as any).createObjectURL = jest.fn(() => {
    const u = `blob:test/${++n}`;
    createdBlobs.push(u);
    return u;
  });
  (URL as any).revokeObjectURL = jest.fn((u: string) => {
    revokedBlobs.push(u);
  });
  // Encoding is async in the browser; capture the callback so tests control
  // when (and whether) it completes.
  Object.defineProperty(HTMLCanvasElement.prototype, 'toBlob', {
    configurable: true,
    value: jest.fn(function (this: HTMLCanvasElement, cb: (b: Blob | null) => void) {
      toBlobCallbacks.push(cb);
    }),
  });
  realCreateElement = document.createElement.bind(document);
  jest.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
    const el = realCreateElement(tag);
    if (tag === 'canvas') stagingCanvases.push(el as HTMLCanvasElement);
    return el;
  }) as typeof document.createElement);
  (window as any).requestAnimationFrame = jest.fn();
  // Pre-decode step: jsdom never loads blob: URLs, so resolve immediately.
  Object.defineProperty(HTMLImageElement.prototype, 'decode', {
    configurable: true,
    value: jest.fn(() => Promise.resolve()),
  });
});

/** Let the toBlob -> decode -> commit chain settle. */
const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  jest.restoreAllMocks();
});

function setup(useCssPaint: boolean) {
  const canvas = realCreateElement('canvas');
  canvas.width = 640;
  canvas.height = 360;
  document.body.appendChild(canvas);
  const node = { node: canvas } as any;
  const getNode = jest.fn(() => node) as any;
  const socket = fakeSocket();
  const receiver = new CanvasReceiver(
    'peer',
    [],
    getNode,
    { id: 'agent-1' },
    socket as any,
    useCssPaint,
  );
  const video = fakeVideo();
  const ctx = canvas.getContext('2d') as any;
  // Mirror what ontrack does once the node is resolved.
  (receiver as any).canvasesData.set('7', {
    video,
    canvas,
    canvasCtx: ctx,
    encoding: false,
    blobUrl: '',
  });
  return { receiver, canvas, ctx, video, socket };
}

describe('canvasCssPaint helpers', () => {
  it('paints a stretched, content-box anchored background and clears it', () => {
    const c = document.createElement('canvas');
    paintCanvasCssFrame(c, 'blob:x/1');
    expect(c.style.backgroundImage).toContain('blob:x/1');
    expect(c.style.backgroundSize).toBe('100% 100%');
    expect(c.style.backgroundRepeat).toBe('no-repeat');
    expect(c.style.backgroundOrigin).toBe('content-box');
    expect(c.style.backgroundClip).toBe('content-box');
    clearCanvasCssFrame(c);
    expect(c.style.backgroundImage).toBe('');
    expect(c.style.backgroundSize).toBe('');
  });
});

describe('CanvasReceiver live canvas painting', () => {
  it('bitmap mode draws the video into the replayed canvas (scripting enabled)', () => {
    const { receiver, canvas, ctx, video } = setup(false);
    receiver.draw();
    expect(ctx.drawImage).toHaveBeenCalledWith(video, 0, 0, 640, 360);
    expect(canvas.style.backgroundImage).toBe('');
    expect(toBlobCallbacks).toHaveLength(0);
  });

  it('CSS-paint mode never draws into the invisible bitmap and paints the frame as background', async () => {
    const { receiver, canvas, ctx, video } = setup(true);
    receiver.draw();
    // The replayed canvas bitmap is not painted under the sandbox — don't waste a decode on it.
    expect(ctx.drawImage).not.toHaveBeenCalled();
    // A staging canvas in the agent document takes the decoded frame at the video's intrinsic size.
    expect(stagingCanvases).toHaveLength(1);
    const staging = stagingCanvases[0];
    expect(staging.width).toBe(320);
    expect(staging.height).toBe(180);
    const ctxResults = (staging.getContext as any).mock.results;
    const stagingCtx = ctxResults[ctxResults.length - 1].value;
    expect(stagingCtx.drawImage).toHaveBeenCalledWith(video, 0, 0, 320, 180);
    expect(staging.toBlob).toHaveBeenCalledWith(
      expect.any(Function),
      'image/webp',
      expect.any(Number),
    );
    expect(toBlobCallbacks).toHaveLength(1);
    toBlobCallbacks[0](new Blob(['x']));
    await flush();
    expect(canvas.style.backgroundImage).toContain(createdBlobs[0]);
    expect(canvas.style.backgroundSize).toBe('100% 100%');
    expect(canvas.style.backgroundOrigin).toBe('content-box');
  });

  it('CSS-paint mode keeps one encode in flight and releases the replaced blob', async () => {
    const { receiver, canvas } = setup(true);
    receiver.draw(); // frame 1 -> encode #1 in flight
    (receiver as any).frameCounter = 0;
    receiver.draw(); // encode still in flight -> frame dropped, not queued
    expect(toBlobCallbacks).toHaveLength(1);
    toBlobCallbacks[0](new Blob(['1']));
    await flush();
    (receiver as any).frameCounter = 0;
    receiver.draw(); // frame 2 -> encode #2
    expect(toBlobCallbacks).toHaveLength(2);
    toBlobCallbacks[1](new Blob(['2']));
    await flush();
    expect(canvas.style.backgroundImage).toContain(createdBlobs[1]);
    expect(canvas.style.backgroundImage).not.toContain(createdBlobs[0]);
    expect(revokedBlobs).toEqual([createdBlobs[0]]);
  });

  it('CSS-paint mode drops a frame whose encode finishes after the stream stopped', async () => {
    const { receiver, canvas, socket } = setup(true);
    receiver.draw();
    socket.fire('webrtc_canvas_stop', { id: 'peer-agent-1-canvas-7' });
    toBlobCallbacks[0](new Blob(['late']));
    await flush();
    expect(canvas.style.backgroundImage).toBe('');
    expect(createdBlobs).toHaveLength(0);
    expect((receiver as any).canvasesData.size).toBe(0);
  });

  it('stop and clear remove the CSS frame and revoke the displayed blob', async () => {
    const { receiver, canvas, socket } = setup(true);
    receiver.draw();
    toBlobCallbacks[0](new Blob(['1']));
    await flush();
    expect(canvas.style.backgroundImage).not.toBe('');
    socket.fire('webrtc_canvas_stop', { id: 'peer-agent-1-canvas-7' });
    expect(canvas.style.backgroundImage).toBe('');
    expect(revokedBlobs).toEqual([createdBlobs[0]]);

    // clear() (webrtc_canvas_restart / disconnect) does the same for every canvas.
    const again = setup(true);
    again.receiver.draw();
    toBlobCallbacks[toBlobCallbacks.length - 1](new Blob(['2']));
    await flush();
    expect(again.canvas.style.backgroundImage).not.toBe('');
    again.receiver.clear();
    expect(again.canvas.style.backgroundImage).toBe('');
    expect((again.receiver as any).canvasesData.size).toBe(0);
  });

  it('CSS-paint mode waits for decodable video before encoding', () => {
    const { receiver, video } = setup(true);
    (video as any).readyState = 1;
    receiver.draw();
    expect(toBlobCallbacks).toHaveLength(0);
    (video as any).readyState = 4;
    (video as any).videoWidth = 0;
    (receiver as any).frameCounter = 0;
    receiver.draw();
    expect(toBlobCallbacks).toHaveLength(0);
  });
});

describe('CanvasReceiver CSS-paint pre-decode', () => {
  it('decodes the frame before swapping the background so the swap never paints blank', async () => {
    const { receiver, canvas } = setup(true);
    let resolveDecode: () => void = () => {};
    (HTMLImageElement.prototype.decode as any).mockImplementationOnce(
      () => new Promise<void>((r) => { resolveDecode = r; }),
    );
    receiver.draw();
    toBlobCallbacks[0](new Blob(['1']));
    await flush();
    // Not committed until decoded — and still "in flight" so no second encode starts.
    expect(canvas.style.backgroundImage).toBe('');
    (receiver as any).frameCounter = 0;
    receiver.draw();
    expect(toBlobCallbacks).toHaveLength(1);
    resolveDecode();
    await flush();
    expect(canvas.style.backgroundImage).toContain(createdBlobs[0]);
  });
});
