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

    expect(state.recordRefusal()).toBe(false)
    expect(state.isUnavailable).toBe(false)
    expect(REFUSALS_BEFORE_UNAVAILABLE).toBe(2)
  })

  it('gives up once the device has refused twice', () => {
    const state = new AccessLevelState()
    state.recordRefusal()

    expect(state.recordRefusal()).toBe(true)
    expect(state.isUnavailable).toBe(true)
  })

  it('discards earlier refusals once an unlock succeeds', () => {
    const state = new AccessLevelState()
    state.recordRefusal()
    state.recordUnlock(T0)

    expect(state.recordRefusal()).toBe(false)
    expect(state.isUnavailable).toBe(false)
  })
})
