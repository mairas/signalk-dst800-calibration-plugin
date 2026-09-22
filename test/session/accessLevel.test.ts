import { describe, it, expect } from 'vitest'
import {
  AccessLevelState,
  ACCESS_LEVEL_1_TTL_MS,
  ACCESS_LEVEL_1_REFRESH_MS
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

  it('re-unlocks before the device expires the level, not after', () => {
    const state = new AccessLevelState()
    state.recordUnlock(T0)
    expect(ACCESS_LEVEL_1_REFRESH_MS).toBeLessThan(ACCESS_LEVEL_1_TTL_MS)
    expect(state.needsUnlock(T0 + ACCESS_LEVEL_1_REFRESH_MS - 1)).toBe(false)
    expect(state.needsUnlock(T0 + ACCESS_LEVEL_1_REFRESH_MS)).toBe(true)
  })

  it('forgets the unlock when the device reports access denied', () => {
    const state = new AccessLevelState()
    state.recordUnlock(T0)
    state.recordDenied()
    expect(state.needsUnlock(T0)).toBe(true)
  })

  it('reports Level 1 unavailable only once the device has refused the unlock', () => {
    const state = new AccessLevelState()
    expect(state.isUnavailable).toBe(false)
    state.markUnavailable()
    expect(state.isUnavailable).toBe(true)
  })

  it('stays unavailable across a later unlock attempt', () => {
    const state = new AccessLevelState()
    state.markUnavailable()
    state.recordUnlock(T0)
    expect(state.isUnavailable).toBe(true)
  })
})
