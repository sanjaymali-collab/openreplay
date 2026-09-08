// @ts-nocheck
import { describe, expect, test, beforeEach, afterEach } from '@jest/globals'
import { installPreserveDrawingBuffer } from '../main/app/preserveDrawingBuffer'

describe('installPreserveDrawingBuffer', () => {
  const original = HTMLCanvasElement.prototype.getContext

  afterEach(() => {
    HTMLCanvasElement.prototype.getContext = original
    delete HTMLCanvasElement.prototype.__orPreserveDrawingBuffer
  })

  test('defaults preserveDrawingBuffer on webgl contexts', () => {
    const seen: Array<{ type: string; attrs: any }> = []
    HTMLCanvasElement.prototype.getContext = function (type, attrs) {
      seen.push({ type, attrs })
      return original.call(this, '2d')
    }
    installPreserveDrawingBuffer()
    const canvas = document.createElement('canvas')
    canvas.getContext('webgl', { antialias: false })
    expect(seen[0].attrs.preserveDrawingBuffer).toBe(true)
    expect(seen[0].attrs.antialias).toBe(false)
  })

  test('does not force-overwrite an explicit false', () => {
    const seen: Array<{ type: string; attrs: any }> = []
    HTMLCanvasElement.prototype.getContext = function (type, attrs) {
      seen.push({ type, attrs })
      return original.call(this, '2d')
    }
    installPreserveDrawingBuffer()
    const canvas = document.createElement('canvas')
    canvas.getContext('webgl2', { preserveDrawingBuffer: false })
    expect(seen[0].attrs.preserveDrawingBuffer).toBe(false)
  })

  test('leaves 2d getContext attributes unchanged', () => {
    const seen: Array<{ type: string; attrs: any }> = []
    HTMLCanvasElement.prototype.getContext = function (type, attrs) {
      seen.push({ type, attrs })
      return original.call(this, type, attrs)
    }
    installPreserveDrawingBuffer()
    const canvas = document.createElement('canvas')
    canvas.getContext('2d', { alpha: true })
    expect(seen[0].attrs.preserveDrawingBuffer).toBeUndefined()
    expect(seen[0].attrs.alpha).toBe(true)
  })
})
