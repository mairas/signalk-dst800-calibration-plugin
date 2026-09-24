import { describe, it, expect } from 'vitest'
import { describeValue } from '../../src/ui/settings.js'
import { SI, unitFor } from '../../src/ui/units.js'

const metres = unitFor(SI, { category: 'distance' })

describe('describeValue', () => {
  it('names the trip and the total of a distance log', () => {
    expect(describeValue({ kind: 'tripReset' }, metres, { tripLog: 1852, log: 12000 })).toBe(
      'trip 1852 m, total 12000 m'
    )
  })

  it('leaves out a total the value does not carry, as in a trip reset', () => {
    expect(describeValue({ kind: 'tripReset' }, metres, { tripLog: 0 })).toBe('trip 0 m')
  })
})
