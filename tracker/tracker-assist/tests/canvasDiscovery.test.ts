import { describe, expect, test, afterEach } from '@jest/globals'
import { findShadowRootCanvases } from '../src/canvasDiscovery'

/**
 * Regression: renderers such as Flutter CanvasKit paint into a <canvas> inside
 * an open shadow root (<flt-glass-pane> → #shadow-root → <canvas>). The
 * tracker's scanTree() never descends into shadow roots, so Assist never saw
 * the canvas and the agent got a blank live view. Discovery must be generic
 * (any open shadow root, any depth), not keyed on framework tag names.
 */
describe('findShadowRootCanvases', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  test('finds a canvas inside an open shadow root regardless of host tag name', () => {
    const host = document.createElement('x-renderer')
    document.body.appendChild(host)
    const canvas = document.createElement('canvas')
    host.attachShadow({ mode: 'open' }).appendChild(canvas)

    expect(findShadowRootCanvases(document)).toEqual([canvas])
  })

  test('descends into nested shadow roots', () => {
    const outer = document.createElement('outer-host')
    document.body.appendChild(outer)
    const outerRoot = outer.attachShadow({ mode: 'open' })
    const inner = document.createElement('inner-host')
    outerRoot.appendChild(inner)
    const canvas = document.createElement('canvas')
    inner.attachShadow({ mode: 'open' }).appendChild(canvas)

    expect(findShadowRootCanvases(document)).toEqual([canvas])
  })

  test('ignores light-DOM canvases (the tracker already reports those)', () => {
    const light = document.createElement('canvas')
    document.body.appendChild(light)

    expect(findShadowRootCanvases(document)).toEqual([])
  })

  test('cannot see into closed shadow roots', () => {
    const host = document.createElement('closed-host')
    document.body.appendChild(host)
    host.attachShadow({ mode: 'closed' }).appendChild(document.createElement('canvas'))

    expect(findShadowRootCanvases(document)).toEqual([])
  })

  test('returns every canvas when a shadow root holds several', () => {
    const host = document.createElement('multi-host')
    document.body.appendChild(host)
    const root = host.attachShadow({ mode: 'open' })
    const a = document.createElement('canvas')
    const b = document.createElement('canvas')
    root.appendChild(a)
    root.appendChild(b)

    expect(findShadowRootCanvases(document)).toEqual([a, b])
  })
})
