/**
 * Generic WebGL capture support for Session Replay and Assist.
 *
 * captureStream() / drawImage() on a WebGL canvas read the drawing buffer.
 * Browsers clear that buffer by default after composite unless
 * preserveDrawingBuffer is set at getContext() time. This cannot be applied
 * after the context exists.
 *
 * Installed once, before application code creates WebGL contexts. Not
 * framework-specific (Flutter CanvasKit, Three.js, Pixi, etc.).
 */

const PATCHED = '__orPreserveDrawingBuffer'

export function installPreserveDrawingBuffer(): void {
  const proto = HTMLCanvasElement.prototype as HTMLCanvasElement & {
    [PATCHED]?: boolean
  }
  if (proto[PATCHED]) {
    return
  }
  proto[PATCHED] = true
  const original = proto.getContext
  proto.getContext = function (
    this: HTMLCanvasElement,
    type: string,
    attributes?: CanvasRenderingContext2DSettings | WebGLContextAttributes,
  ) {
    if (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl') {
      attributes = Object.assign({ preserveDrawingBuffer: true }, attributes || {})
    }
    return original.call(this, type, attributes)
  } as typeof proto.getContext
}
