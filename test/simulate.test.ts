import { describe, it, expect } from 'vitest'
import { simulateStateOf } from '../src/simulate.js'
import type { ProbeResult } from '../src/types.js'

const probe: ProbeResult = {
  level1: { state: 'granted' },
  capabilities: [],
  configurable: 'yes',
  interrupted: false
}

describe('simulateStateOf', () => {
  it('reads the state from a read or a write of simulate mode', () => {
    expect(
      simulateStateOf({
        type: 'setting',
        data: {
          id: 'simulateMode',
          qualifier: null,
          operation: 'read',
          result: { status: 'answered', value: true, readAt: '' }
        }
      })
    ).toBe(true)
    expect(
      simulateStateOf({
        type: 'setting',
        data: {
          id: 'simulateMode',
          qualifier: null,
          operation: 'write',
          result: { status: 'applied', stored: false, readAt: '' }
        }
      })
    ).toBe(false)
  })

  it('does not take a reset as the end of simulate mode', () => {
    expect(simulateStateOf({ type: 'reset', data: { status: 'claimed', probe } })).toBeNull()
  })

  it('learns nothing from another setting or an unanswered read', () => {
    expect(
      simulateStateOf({
        type: 'setting',
        data: {
          id: 'transmissionIntervalOverride',
          qualifier: null,
          operation: 'read',
          result: { status: 'answered', value: true, readAt: '' }
        }
      })
    ).toBeNull()
    expect(
      simulateStateOf({
        type: 'setting',
        data: {
          id: 'simulateMode',
          qualifier: null,
          operation: 'read',
          result: { status: 'unknown', reason: '' }
        }
      })
    ).toBeNull()
  })
})
