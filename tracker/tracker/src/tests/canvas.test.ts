// @ts-nocheck
import { describe, expect, test, jest, beforeEach, afterEach } from '@jest/globals'
import CanvasRecorder from '../main/app/canvas'
import App from '../main/app/index.js'

describe('CanvasRecorder', () => {
  let appMock: jest.Mocked<App>
  let canvasRecorder: CanvasRecorder
  let nodeMock: Node

  beforeEach(() => {
    // @ts-ignore
    appMock = {}
    appMock.nodes = {
      scanTree: jest.fn(),
      attachNodeCallback: jest.fn(),
      getID: jest.fn().mockReturnValue(1),
      getNode: jest.fn(),
    }
    appMock.sanitizer = {
      isObscured: jest.fn().mockReturnValue(false),
      isHidden: jest.fn().mockReturnValue(false),
    }
    appMock.attachResanitizeCallback = jest.fn()
    appMock.timestamp = jest.fn().mockReturnValue(1000)
    appMock.send = jest.fn()
    appMock.debug = {
      log: jest.fn(),
      error: jest.fn(),
    }
    appMock.session = {
      getSessionToken: jest.fn().mockReturnValue('token'),
    }
    appMock.options = {
      ingestPoint: 'http://example.com',
    }

    canvasRecorder = new CanvasRecorder(appMock, { fps: 30, quality: 'medium' })
    nodeMock = document.createElement('canvas')
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  describe('startTracking', () => {
    test('scans tree and attaches node callback after timeout', () => {
      jest.useFakeTimers()
      canvasRecorder.startTracking()
      jest.advanceTimersByTime(500)
      expect(appMock.nodes.scanTree).toHaveBeenCalled()
      expect(appMock.nodes.attachNodeCallback).toHaveBeenCalled()
      jest.useRealTimers()
    })
  })

  describe('restartTracking', () => {
    test('clears previous intervals and rescans the tree', () => {
      const clearSpy = jest.spyOn(canvasRecorder, 'clear')
      canvasRecorder.restartTracking()
      expect(clearSpy).toHaveBeenCalled()
      expect(appMock.nodes.scanTree).toHaveBeenCalled()
    })
  })

  describe('captureCanvas', () => {
    test('captures canvas and starts observing it', () => {
      const observeMock = jest.fn()
      window.IntersectionObserver = jest.fn().mockImplementation((callback) => {
        return {
          observe: observeMock,
          disconnect: jest.fn(),
        }
      })

      canvasRecorder.captureCanvas(nodeMock)
      expect(observeMock).toHaveBeenCalledWith(nodeMock)
    })

    test('does not capture canvas if it is obscured', () => {
      appMock.sanitizer.isObscured.mockReturnValue(true)
      const observeMock = jest.fn()
      window.IntersectionObserver = jest.fn().mockImplementation((callback) => {
        return {
          observe: observeMock,
          disconnect: jest.fn(),
        }
      })

      canvasRecorder.captureCanvas(nodeMock)
      expect(observeMock).not.toHaveBeenCalled()
    })
  })

  describe('recordCanvas', () => {
    test('records canvas and sends snapshots at intervals', () => {
      jest.useFakeTimers()
      canvasRecorder.recordCanvas(nodeMock, 1)
      jest.advanceTimersByTime(1000 / 30)
      expect(appMock.send).toHaveBeenCalled()
      jest.useRealTimers()
    })

    // Regression: a canvas inside an open shadow root (Flutter CanvasKit, web
    // components) is connected to the document but document.contains() is
    // false for it. The recorder used to treat that as "removed" on the first
    // tick and stop, so shadow-DOM canvases never produced replay snapshots.
    test('keeps recording a canvas that lives inside a shadow root', () => {
      jest.useFakeTimers()
      const host = document.createElement('div')
      document.body.appendChild(host)
      const shadowCanvas = host.attachShadow({ mode: 'open' }).appendChild(document.createElement('canvas'))
      expect(document.contains(shadowCanvas)).toBe(false)
      expect(shadowCanvas.isConnected).toBe(true)

      canvasRecorder.recordCanvas(shadowCanvas, 7)
      jest.advanceTimersByTime((1000 / 30) * 3)
      expect(canvasRecorder['snapshots'][7]).toBeDefined()
      expect(canvasRecorder['intervals'].has(7)).toBe(true)
      expect(appMock.debug.log).not.toHaveBeenCalledWith(
        'Canvas element not in sync',
        expect.anything(),
        expect.anything(),
      )

      // Detaching the shadow host is a real removal and must still stop it.
      host.remove()
      jest.advanceTimersByTime(1000 / 30)
      expect(canvasRecorder['intervals'].has(7)).toBe(false)
      jest.useRealTimers()
    })
  })

  describe('clear', () => {
    test('clears intervals and snapshots', () => {
      const clearIntervalSpy = jest.spyOn(global, 'clearInterval')
      canvasRecorder.recordCanvas(nodeMock, 1)
      canvasRecorder.clear()
      expect(clearIntervalSpy).toHaveBeenCalled()
      expect(canvasRecorder['snapshots']).toEqual({})
    })
  })
})
