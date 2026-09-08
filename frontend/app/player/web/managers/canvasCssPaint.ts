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
export function paintCanvasCssFrame(
  canvasEl: HTMLCanvasElement,
  blobUrl: string,
): void {
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

/** Remove a previously painted CSS frame so a stale image never lingers. */
export function clearCanvasCssFrame(canvasEl: HTMLCanvasElement): void {
  Object.assign(canvasEl.style, {
    backgroundImage: '',
    backgroundSize: '',
    backgroundRepeat: '',
    backgroundOrigin: '',
    backgroundClip: '',
  });
}
