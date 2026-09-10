/**
 * Paint a frame onto a replayed <canvas> as its CSS background.
 *
 * The player iframe is sandboxed without allow-scripts (see Screen.ts), so
 * scripting is disabled for its document — and per the HTML spec a <canvas>
 * in a script-disabled document renders its *fallback content* instead of its
 * bitmap. drawImage() still fills the bitmap (getImageData reads it straight
 * back), nothing throws and nothing logs, so the canvas just silently stays
 * blank. A CSS background is painted either way and reproduces drawImage's
 * stretch-to-content-box geometry exactly.
 *
 * Shared by the replay path (CanvasManager) and the live Assist path
 * (CanvasReceiver) so both render identically under the sandbox.
 */

/**
 * Frame currently painted on each canvas. The paint lives in the inline
 * style, which the virtual DOM rewrites wholesale whenever the recorded page
 * set the element's `style` attribute (`node.setAttribute('style', …)`). That
 * rewrite is deferred to the iframe's load for a (re)created document, so a
 * seek into a later document paints the frame first and then loses it to the
 * queued attribute — the canvas stays blank until the next snapshot. The
 * virtual DOM re-asserts the frame from this map after every style rewrite.
 */
const paintedFrames = new WeakMap<Element, string>();

function applyFrameStyle(canvasEl: HTMLCanvasElement, blobUrl: string): void {
  Object.assign(canvasEl.style, {
    backgroundImage: `url("${blobUrl}")`,
    backgroundSize: '100% 100%',
    backgroundRepeat: 'no-repeat',
    // The bitmap is painted into the content box, so anchor the background
    // there too — otherwise a padded canvas would be offset against it.
    backgroundOrigin: 'content-box',
    backgroundClip: 'content-box',
  });
}

export function paintCanvasCssFrame(
  canvasEl: HTMLCanvasElement,
  blobUrl: string,
): void {
  paintedFrames.set(canvasEl, blobUrl);
  applyFrameStyle(canvasEl, blobUrl);
}

/**
 * Frame each canvas is currently decoding. Only the most recent request may
 * commit, so a burst of frames (seek, fast-forward) never paints out of order.
 */
const pendingFrames = new WeakMap<Element, string>();

/**
 * Like paintCanvasCssFrame, but decode the image before swapping it in.
 *
 * Swapping `background-image` straight to a not-yet-loaded blob URL paints the
 * canvas with no background at all until the image lands — for a ~1fps canvas
 * stream that is a white flash on every frame. Decoding through an <img>
 * created in the canvas's own document first means the swap hits the image
 * cache and the previous frame stays on screen until the new one is ready.
 * Falls back to an immediate swap when decode() is unavailable or fails.
 */
export function paintCanvasCssFrameDecoded(
  canvasEl: HTMLCanvasElement,
  blobUrl: string,
): void {
  pendingFrames.set(canvasEl, blobUrl);
  const commit = () => {
    // Superseded by a newer frame while decoding: drop this one.
    if (pendingFrames.get(canvasEl) !== blobUrl) return;
    pendingFrames.delete(canvasEl);
    paintCanvasCssFrame(canvasEl, blobUrl);
  };
  const img = (canvasEl.ownerDocument || document).createElement('img');
  img.src = blobUrl;
  if (typeof img.decode === 'function') {
    img.decode().then(commit, commit);
  } else {
    commit();
  }
}

/** Remove a previously painted CSS frame so a stale image never lingers. */
export function clearCanvasCssFrame(canvasEl: HTMLCanvasElement): void {
  paintedFrames.delete(canvasEl);
  pendingFrames.delete(canvasEl);
  Object.assign(canvasEl.style, {
    backgroundImage: '',
    backgroundSize: '',
    backgroundRepeat: '',
    backgroundOrigin: '',
    backgroundClip: '',
  });
}

/**
 * Re-assert the painted frame after the element's `style` attribute was
 * replaced by a recorded mutation. No-op for elements without a frame.
 */
export function restoreCanvasCssFrame(el: Element): void {
  const blobUrl = paintedFrames.get(el);
  if (blobUrl !== undefined) {
    applyFrameStyle(el as HTMLCanvasElement, blobUrl);
  }
}
