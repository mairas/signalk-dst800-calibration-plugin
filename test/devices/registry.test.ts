import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { FakeBus } from '../helpers/FakeBus.js'
import { addressClaim, pgnReply } from '../helpers/replies.js'
import { sourcesTree, type TreeDevice } from '../helpers/sources.js'
import { DeviceRegistry, PRESENCE_WINDOW_MS, parseCanName } from '../../src/devices/registry.js'
import type { DeviceKey } from '../../src/types.js'
import { PGN } from '../../src/protocol/pids.js'

const DST: TreeDevice = {
  address: 22,
  uniqueNumber: 123456,
  manufacturerCode: 'Airmar',
  modelId: 'DST800',
  serial: 'SN42'
}
const DST_KEY: DeviceKey = { manufacturerCode: 135, uniqueNumber: 123456 }

/** Airmar hardware sold under another brand, claiming that brand's code. */
const REBADGED: TreeDevice = {
  address: 40,
  uniqueNumber: 777,
  manufacturerCode: 'Garmin',
  modelId: 'DST810'
}
const REBADGED_KEY: DeviceKey = { manufacturerCode: 229, uniqueNumber: 777 }

describe('parseCanName', () => {
  it('reads the unique number and manufacturer code out of a CAN NAME', () => {
    expect(parseCanName('c097820010e1e240')).toEqual({
      manufacturerCode: 135,
      uniqueNumber: 123456
    })
  })

  it.each(['', 'zz', '1'.repeat(17), 'c0978200 10e1e240'])('rejects %j', (text) => {
    expect(parseCanName(text)).toBeNull()
  })
})

describe('DeviceRegistry', () => {
  let bus: FakeBus
  let tree: Record<string, unknown>
  let registry: DeviceRegistry
  let changes: number
  let errors: unknown[]

  const build = (devices: TreeDevice[]) => {
    tree = sourcesTree(devices)
    registry = new DeviceRegistry({
      sources: () => tree,
      subscribe: (handler) => bus.subscribe(handler),
      now: () => Date.now(),
      onError: (error) => errors.push(error)
    })
    registry.onChange(() => {
      changes += 1
    })
  }

  /** Any periodic frame from `src`, which is what presence is made of. */
  const heard = (src: number) => {
    bus.deliver(pgnReply(PGN.distanceLog, { src }))
  }

  beforeEach(() => {
    vi.useFakeTimers()
    bus = new FakeBus()
    changes = 0
    errors = []
  })

  afterEach(() => {
    registry.close()
    vi.useRealTimers()
  })

  describe('candidates', () => {
    it('lists a device in the sources tree with its model and serial', () => {
      build([DST])

      expect(registry.candidates()).toEqual([
        {
          key: DST_KEY,
          location: { state: 'waiting', address: 22 },
          manufacturerName: 'Airmar',
          modelId: 'DST800',
          serial: 'SN42'
        }
      ])
    })

    it('offers a device whose Address Claim names another manufacturer', () => {
      build([DST, REBADGED])

      expect(registry.candidates().map((c) => c.key)).toEqual([DST_KEY, REBADGED_KEY])
    })

    it('names no manufacturer where canboatjs has only the code', () => {
      build([{ address: 50, uniqueNumber: 9, manufacturerCode: 2000 }])

      expect(registry.candidates()[0]?.manufacturerName).toBeNull()
    })

    it('lists a device seen through two gateways once', () => {
      build([DST, { ...DST, label: 'can1' }])

      expect(registry.candidates()).toHaveLength(1)
    })

    it('ignores what it cannot read in the sources tree', () => {
      build([DST])
      tree = {
        ...tree,
        broken: null,
        nmea0183: { GP: { talker: 'GP' } },
        can9: {
          label: 'can9',
          '3': { n2k: { src: '3', canName: 'not hex' } },
          c097820010e1e240: { n2k: { src: 'c097820010e1e240', canName: 'c097820010e1e240' } },
          '254': { n2k: { src: '254', canName: 'c097820010e1e241' } }
        }
      }

      expect(registry.candidates().map((c) => c.key)).toEqual([DST_KEY])
    })

    it('survives a sources tree that is not an object at all', () => {
      build([])
      tree = 'nothing' as unknown as Record<string, unknown>

      expect(registry.candidates()).toEqual([])
    })
  })

  describe('presence', () => {
    it('reports waiting until the device is heard, then present', () => {
      build([DST])

      expect(registry.locate(DST_KEY)).toEqual({ state: 'waiting', address: 22 })

      heard(22)

      expect(registry.locate(DST_KEY)).toEqual({ state: 'present', address: 22 })
      expect(changes).toBe(1)
    })

    it('reports waiting again when the device falls silent', async () => {
      build([DST])
      heard(22)
      changes = 0

      await vi.advanceTimersByTimeAsync(PRESENCE_WINDOW_MS + 1000)

      expect(registry.locate(DST_KEY)).toEqual({ state: 'waiting', address: 22 })
      expect(changes).toBe(1)
    })

    it('stays present while the device keeps talking', async () => {
      build([DST])
      for (let i = 0; i < 5; i += 1) {
        heard(22)
        await vi.advanceTimersByTimeAsync(PRESENCE_WINDOW_MS / 2)
      }

      expect(registry.locate(DST_KEY).state).toBe('present')
    })

    it('does not attribute one device’s frames to another', () => {
      build([DST, REBADGED])
      heard(40)

      expect(registry.locate(DST_KEY).state).toBe('waiting')
      expect(registry.locate(REBADGED_KEY)).toEqual({ state: 'present', address: 40 })
    })

    it('reports an unknown device as waiting with no address', () => {
      build([DST])

      expect(registry.locate({ manufacturerCode: 135, uniqueNumber: 1 })).toEqual({
        state: 'waiting',
        address: null
      })
    })
  })

  describe('address changes', () => {
    it('follows a re-claim at a new address before the sources tree catches up', () => {
      build([DST])
      heard(22)
      changes = 0

      bus.deliver(addressClaim(DST, 31))

      expect(registry.locate(DST_KEY)).toEqual({ state: 'present', address: 31 })
      expect(changes).toBe(1)
    })

    it('drops the old address when another device claims it', () => {
      build([DST])
      bus.deliver(addressClaim({ uniqueNumber: 5, manufacturerCode: 'Garmin' }, 22))

      expect(registry.locate(DST_KEY)).toEqual({ state: 'waiting', address: null })
    })

    it('reports waiting when the device loses its address, and finds it when it claims again', () => {
      build([DST])
      heard(22)

      bus.deliver(addressClaim(DST, 254))

      expect(registry.locate(DST_KEY)).toEqual({ state: 'waiting', address: null })

      bus.deliver(addressClaim(DST, 31))

      expect(registry.locate(DST_KEY)).toEqual({ state: 'present', address: 31 })
    })

    it('keeps a device at its address while a newcomer contends for it', () => {
      build([DST])
      bus.deliver(addressClaim(DST, 22))
      changes = 0

      bus.deliver(addressClaim({ uniqueNumber: 5, manufacturerCode: 'Garmin' }, 22))

      expect(registry.locate(DST_KEY)).toEqual({ state: 'present', address: 22 })
      expect(changes).toBe(0)

      // The DST loses arbitration and claims elsewhere.
      bus.deliver(addressClaim(DST, 23))

      expect(registry.locate(DST_KEY)).toEqual({ state: 'present', address: 23 })
    })

    it('prefers the address a device is heard at when the tree holds two', () => {
      // One label, so the object keys iterate in ascending order: the stale
      // leaf at 22 comes first.
      build([
        { ...DST, address: 31 },
        { ...DST, address: 22 }
      ])
      heard(31)

      expect(registry.locate(DST_KEY)).toEqual({ state: 'present', address: 31 })
      expect(registry.candidates()).toHaveLength(1)
    })

    it('finds a device absent at start once it claims and the tree records it', async () => {
      build([])

      expect(registry.locate(DST_KEY)).toEqual({ state: 'waiting', address: null })

      tree = sourcesTree([{ ...DST, address: 31 }])
      bus.deliver(addressClaim(DST, 31))
      await vi.advanceTimersByTimeAsync(0)

      expect(registry.locate(DST_KEY)).toEqual({ state: 'present', address: 31 })
      expect(changes).toBeGreaterThan(0)
    })

    it('reports a move the sources tree shows without a claim the plugin heard', async () => {
      build([DST])
      heard(22)
      changes = 0

      tree = sourcesTree([{ ...DST, address: 31 }])
      await vi.advanceTimersByTimeAsync(PRESENCE_WINDOW_MS / 2)

      expect(registry.locate(DST_KEY).address).toBe(31)
      expect(changes).toBe(1)
    })

    it('matches a live claim by number when canboatjs cannot name the manufacturer', () => {
      const unnamed: TreeDevice = { address: 50, uniqueNumber: 9, manufacturerCode: 2000 }
      build([unnamed])

      bus.deliver(addressClaim(unnamed, 51))

      expect(registry.locate({ manufacturerCode: 2000, uniqueNumber: 9 })).toEqual({
        state: 'present',
        address: 51
      })
    })

    it('does not confuse two devices sharing a unique number across manufacturers', () => {
      build([DST, { ...REBADGED, uniqueNumber: DST.uniqueNumber }])

      bus.deliver(addressClaim({ ...REBADGED, uniqueNumber: DST.uniqueNumber }, 60))

      expect(registry.locate(DST_KEY).address).toBe(22)
    })
  })

  describe('failures that must not reach the server', () => {
    it('contains a listener that throws', () => {
      build([DST])
      registry.onChange(() => {
        throw new Error('listener bug')
      })

      expect(() => {
        heard(22)
      }).not.toThrow()
      expect(errors).toHaveLength(1)
    })

    it('contains a sources accessor that throws', () => {
      build([DST])
      registry.close()
      registry = new DeviceRegistry({
        sources: () => {
          throw new Error('tree unavailable')
        },
        subscribe: (handler) => bus.subscribe(handler),
        now: () => Date.now(),
        onError: (error) => errors.push(error)
      })

      expect(registry.candidates()).toEqual([])
      expect(() => {
        bus.deliver(addressClaim(DST, 22))
      }).not.toThrow()
    })

    it('stops listening when closed', () => {
      build([DST])
      registry.close()
      heard(22)

      expect(changes).toBe(0)
    })
  })
})
