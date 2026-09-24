import { describe, it, expect } from 'vitest'
import {
  AccessLevelState,
  ACCESS_LEVEL_1_TTL_MS,
  ACCESS_LEVEL_1_REFRESH_MS,
  REFUSALS_BEFORE_UNAVAILABLE
} from '../../src/session/accessLevel.js'

const T0 = 1_700_000_000_000

describe('AccessLevelState', () => {
  it('needs an unlock before the first one', () => {
    expect(new AccessLevelState().needsUnlock(T0)).toBe(true)
  })

  it('does not need an unlock immediately after one', () => {
    const state = new AccessLevelState()
    state.recordUnlock(T0)
    expect(state.needsUnlock(T0)).toBe(false)
  })

  it('re-unlocks a minute before the device expires the level', () => {
    const state = new AccessLevelState()
    state.recordUnlock(T0)

    expect(ACCESS_LEVEL_1_TTL_MS - ACCESS_LEVEL_1_REFRESH_MS).toBe(60_000)
    expect(state.needsUnlock(T0 + ACCESS_LEVEL_1_REFRESH_MS - 1)).toBe(false)
    expect(state.needsUnlock(T0 + ACCESS_LEVEL_1_REFRESH_MS)).toBe(true)
  })

  it('treats a clock that went backwards as an expired grant', () => {
    const state = new AccessLevelState()
    state.recordUnlock(T0)
    expect(state.needsUnlock(T0 - 1)).toBe(true)
  })

  it('forgets the unlock when the device reports access denied', () => {
    const state = new AccessLevelState()
    state.recordUnlock(T0)
    state.recordDenied()
    expect(state.needsUnlock(T0)).toBe(true)
  })

  it('forgets the unlock after an operation that resets the device', () => {
    const state = new AccessLevelState()
    state.recordUnlock(T0)
    state.forget()
    expect(state.needsUnlock(T0)).toBe(true)
  })

  it('does not give up on one refusal, which may have answered another node', () => {
    const state = new AccessLevelState()

    expect(state.recordRefusal(T0)).toBe(false)
    expect(state.isUnavailable(T0)).toBe(false)
    expect(REFUSALS_BEFORE_UNAVAILABLE).toBe(2)
  })

  it('gives up once the device has refused twice', () => {
    const state = new AccessLevelState()
    state.recordRefusal(T0)

    expect(state.recordRefusal(T0)).toBe(true)
    expect(state.isUnavailable(T0)).toBe(true)
  })

  it('asks again after a grant lifetime, rather than never', () => {
    const state = new AccessLevelState()
    state.recordRefusal(T0)
    state.recordRefusal(T0)

    expect(state.isUnavailable(T0 + ACCESS_LEVEL_1_TTL_MS - 1)).toBe(true)
    expect(state.isUnavailable(T0 + ACCESS_LEVEL_1_TTL_MS)).toBe(false)
  })

  it('does not count refusals a grant lifetime apart as a pair', () => {
    const state = new AccessLevelState()
    state.recordRefusal(T0)

    expect(state.recordRefusal(T0 + ACCESS_LEVEL_1_TTL_MS)).toBe(false)
  })

  it('discards earlier refusals once an unlock succeeds', () => {
    const state = new AccessLevelState()
    state.recordRefusal(T0)
    state.recordUnlock(T0)

    expect(state.recordRefusal(T0)).toBe(false)
    expect(state.isUnavailable(T0)).toBe(false)
  })

  describe('as the console shows it', () => {
    it('is locked before the first unlock', () => {
      expect(new AccessLevelState().view(T0)).toEqual({ state: 'locked' })
    })

    it('is granted until the device expires it, with the time left', () => {
      const state = new AccessLevelState()
      state.recordUnlock(T0)

      expect(state.view(T0 + 1000)).toEqual({
        state: 'granted',
        expiresInMs: ACCESS_LEVEL_1_TTL_MS - 1000
      })
      expect(state.view(T0 + ACCESS_LEVEL_1_TTL_MS)).toEqual({ state: 'locked' })
    })

    it('is locked once the device has denied access, and when the clock went backwards', () => {
      const denied = new AccessLevelState()
      denied.recordUnlock(T0)
      denied.recordDenied()
      const stepped = new AccessLevelState()
      stepped.recordUnlock(T0)

      expect(denied.view(T0 + 1)).toEqual({ state: 'locked' })
      expect(stepped.view(T0 - 1)).toEqual({ state: 'locked' })
    })

    it('is unavailable after the refusals that make it so, until they lapse', () => {
      const state = new AccessLevelState()
      for (let i = 0; i < REFUSALS_BEFORE_UNAVAILABLE; i += 1) {
        state.recordRefusal(T0)
      }

      expect(state.view(T0 + 1000)).toEqual({
        state: 'unavailable',
        retryInMs: ACCESS_LEVEL_1_TTL_MS - 1000
      })
      expect(state.view(T0 + ACCESS_LEVEL_1_TTL_MS)).toEqual({ state: 'locked' })
    })
  })
})
