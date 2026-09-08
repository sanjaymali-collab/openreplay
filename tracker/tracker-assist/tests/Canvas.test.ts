import { describe, expect, test, jest, beforeEach, afterEach } from '@jest/globals'
import { createCanvasCapture } from '../src/Canvas'

function mockStream(): MediaStream {
  return {
    getTracks: () => [{ stop: jest.fn(), kind: 'video', enabled: true }],
    getVideoTracks: () => [{ stop: jest.fn(), kind: 'video', enabled: true }],
  } as unknown as MediaStream
}

describe('createCanvasCapture', () => {
  let captureStreamCalls: HTMLCanvasElement[]

  beforeEach(() => {
    captureStreamCalls = []
    // jsdom has no captureStream
    HTMLCanvasElement.prototype.captureStream = function () {
      captureStreamCalls.push(this)
      return mockStream()
    }
  })

  afterEach(() => {
    // @ts-expect-error restore
    delete HTMLCanvasElement.prototype.captureStream
    jest.restoreAllMocks()
  })

  test('2d canvas uses captureStream on the source canvas', () => {
    const canvas = document.createElement('canvas')
    // jsdom has no 2d context without the optional `canvas` package.
    canvas.getContext = ((type: string) =>
      type === '2d' ? ({ drawImage: jest.fn() } as unknown as CanvasRenderingContext2D) : null) as unknown as typeof canvas.getContext
    const handle = createCanvasCapture(canvas, 15)
    expect(handle.source).toBe('direct')
    expect(handle.context).toBe('2d')
    expect(captureStreamCalls).toHaveLength(1)
    expect(captureStreamCalls[0]).toBe(canvas)
    handle.stopCopy()
  })

  test('webgl canvas streams a 2d proxy, not the webgl source', () => {
    const canvas = document.createElement('canvas')
    const gl = {} as WebGLRenderingContext
    const orig = canvas.getContext.bind(canvas)
    canvas.getContext = ((type: string) => {
      if (type === 'webgl2' || type === 'webgl' || type === 'experimental-webgl') {
        return gl
      }
      return orig(type as '2d')
    }) as typeof canvas.getContext

    const handle = createCanvasCapture(canvas, 15)
    expect(handle.source).toBe('webgl-proxy')
    expect(handle.context).toBe('webgl2')
    expect(captureStreamCalls).toHaveLength(1)
    expect(captureStreamCalls[0]).not.toBe(canvas)
    expect(captureStreamCalls[0].tagName).toBe('CANVAS')
    handle.stopCopy()
  })

  test('stopCopy cancels the proxy copy loop', () => {
    const canvas = document.createElement('canvas')
    canvas.getContext = (() => ({})) as unknown as typeof canvas.getContext
    const handle = createCanvasCapture(canvas, 8)
    expect(() => handle.stopCopy()).not.toThrow()
  })

  test('webgl proxy copies at most fps times per second even with several tickers', () => {
    // rAF + Worker + setInterval all drive copy(); the source canvas must not
    // be drawImage'd more often than the requested fps (BS: renderer pegging).
    jest.useFakeTimers()
    let now = 0
    jest.spyOn(performance, 'now').mockImplementation(() => now)
    const rafCbs: FrameRequestCallback[] = []
    ;(window as any).requestAnimationFrame = (cb: FrameRequestCallback) => {
      rafCbs.push(cb)
      return rafCbs.length
    }
    ;(window as any).cancelAnimationFrame = jest.fn()
    ;(window as any).Worker = undefined

    const src = document.createElement('canvas')
    src.width = 100
    src.height = 50
    const drawImage = jest.fn()
    const realCreate = document.createElement.bind(document)
    jest.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      const el = realCreate(tag)
      if (tag === 'canvas') {
        ;(el as HTMLCanvasElement).getContext = (() => ({
          drawImage,
          getImageData: () => ({ data: new Uint8ClampedArray(4) }),
        })) as any
      }
      return el
    }) as typeof document.createElement)
    src.getContext = ((type: string) => (type === 'webgl2' ? ({} as any) : null)) as any

    const handle = createCanvasCapture(src, 10) // -> one copy per 100ms
    drawImage.mockClear()
    // Simulate 1s: 60 rAF ticks + 20 interval ticks, clock advancing 1000/80 ms each.
    for (let i = 0; i < 80; i++) {
      now += 12.5
      const cb = rafCbs.shift()
      cb?.(now)
      if (i % 4 === 3) jest.advanceTimersByTime(50)
    }
    expect(drawImage.mock.calls.length).toBeGreaterThanOrEqual(9)
    expect(drawImage.mock.calls.length).toBeLessThanOrEqual(11)
    handle.stopCopy()
    jest.useRealTimers()
  })
})
