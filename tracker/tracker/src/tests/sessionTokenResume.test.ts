import { describe, expect, test, beforeEach } from '@jest/globals'
import App from '../main/app/index.js'

/**
 * Regression: the first stop()/start() of a session must resume the same
 * session id. checkSessionToken() only stamped the protocol version when a
 * token already existed, so after the very first start the stored token had no
 * stamp, the next start treated it as stale and requested a brand-new session.
 * Any Assist agent attached to the original session id was orphaned
 * ("Session not found") as soon as the host app paused/resumed capture.
 */
describe('App.checkSessionToken – session resume across stop()/start()', () => {
  const TOKEN_KEY = '__openreplay_token'
  const RESET_KEY = '__openreplay_reset'
  let store: Map<string, string>
  let token: string | undefined
  let fakeApp: any

  const check = (forceNew?: boolean): boolean =>
    (App.prototype as any).checkSessionToken.call(fakeApp, forceNew)

  beforeEach(() => {
    store = new Map()
    token = undefined
    fakeApp = {
      projectKey: 'pk',
      options: { session_token_key: TOKEN_KEY, session_reset_key: RESET_KEY },
      sessionStorage: {
        getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
      },
      session: { getSessionToken: () => token },
    }
  })

  test('first start with no token needs a new session and stamps the version', () => {
    expect(check()).toBe(true)
    expect(store.get(`${TOKEN_KEY}_version`)).toBe('2')
  })

  test('first stop()/start() after a fresh session resumes it (no new session id)', () => {
    expect(check()).toBe(true) // start #1: no token yet
    token = 'tok-from-start-1' // backend handed us a token
    expect(check()).toBe(false) // start #2 must reuse it
    expect(check()).toBe(false) // start #3 too
  })

  test('a token stamped with another protocol version is not resumed', () => {
    token = 'old-token'
    store.set(`${TOKEN_KEY}_version`, '1')
    expect(check()).toBe(true)
    expect(store.get(`${TOKEN_KEY}_version`)).toBe('2')
  })

  test('forceNew still forces a new session even with a valid resumable token', () => {
    check()
    token = 'tok'
    expect(check()).toBe(false)
    expect(check(true)).toBe(true)
  })

  test('resetNextPageSession flag forces a new session even with a valid resumable token', () => {
    check()
    token = 'tok'
    expect(check()).toBe(false)
    store.set(RESET_KEY, 't')
    expect(check()).toBe(true)
  })
})
