import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { ReadResult, SettingInfo, WriteResult } from '../../src/types.js'
import '../../src/ui/main.js'
import {
  FakeEventSource,
  button,
  json,
  mount,
  probe,
  selected,
  serve,
  settle,
  text,
  type Handler
} from './helpers.js'

const READ_AT = '2026-09-24T12:00:00.000Z'

const info = (
  id: string,
  available: SettingInfo['available'],
  overrides: Partial<SettingInfo> = {}
): SettingInfo => ({
  id,
  requirement: 'R0',
  readable: true,
  writable: true,
  requiresLevel1: false,
  qualifiers: null,
  available,
  ...overrides
})

const SETTINGS: SettingInfo[] = [
  info('speedCurve', 'yes'),
  info('temperatureOffset', 'yes', {
    qualifiers: [
      { value: 0, label: 'Device Sensor' },
      { value: 1, label: 'Onboard Water Sensor' },
      { value: 2, label: 'Optional Water Sensor' }
    ]
  }),
  info('depthOffset', 'yes'),
  info('speedOfSound', 'unknown'),
  info('speedFilter', 'yes', { readable: false }),
  info('temperatureFilter', 'no', { readable: false }),
  info('simulateMode', 'yes')
]

/** What the device holds, by `id` or `id?qualifier=n`. */
const HELD: Record<string, unknown> = {
  depthOffset: 0.35,
  'temperatureOffset?qualifier=0': 0.5,
  'temperatureOffset?qualifier=1': 0,
  'temperatureOffset?qualifier=2': -0.25,
  simulateMode: false
}

const answered = (value: unknown): ReadResult => ({ status: 'answered', value, readAt: READ_AT })

/** Serve the settings list and answer reads from `HELD`; writes go to `onWrite`. */
function device(
  options: {
    onWrite?: Handler
    reads?: string[]
    /** Answers first; `undefined` passes the request on. */
    overrides?: (path: string, init?: RequestInit) => Response | undefined
  } = {}
) {
  serve(
    selected({ probe }),
    (path, init) => {
      const override = options.overrides?.(path, init)
      if (override !== undefined) {
        return override
      }
      const slot = path.replace('/settings/', '')
      if ((init?.method ?? 'GET') === 'GET' && path.startsWith('/settings/')) {
        options.reads?.push(slot)
        return json(
          slot in HELD ? answered(HELD[slot]) : { status: 'unknown', reason: 'No answer' }
        )
      }
      if (init?.method === 'PUT' && options.onWrite !== undefined) {
        return options.onWrite(path, init)
      }
      throw new Error(`Unexpected ${init?.method ?? 'GET'} ${path}`)
    },
    SETTINGS
  )
}

const row = (el: Element, slot: string): Element => {
  const found = el.querySelector(`[data-slot="${slot}"]`)
  if (found === null) {
    throw new Error(`No row for ${slot}`)
  }
  return found
}

const type = (row: Element, value: string, index = 0) => {
  const input = row.querySelectorAll('input')[index]
  input.value = value
  input.dispatchEvent(new Event('input'))
}

describe('settings', () => {
  beforeEach(() => {
    vi.useFakeTimers({ now: Date.parse(READ_AT) })
    FakeEventSource.instances = []
    vi.stubGlobal('EventSource', FakeEventSource)
    vi.spyOn(globalThis, 'fetch')
  })

  afterEach(() => {
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  describe('reading', () => {
    it('reads each offered, readable setting once and shows its value with its age', async () => {
      const reads: string[] = []
      device({ reads })
      const el = await mount()
      await settle()

      expect(reads).toEqual([
        'temperatureOffset?qualifier=0',
        'temperatureOffset?qualifier=1',
        'temperatureOffset?qualifier=2',
        'depthOffset',
        'simulateMode'
      ])
      expect(text(row(el, 'depthOffset:'))).toContain('0.350 m')
      expect(text(row(el, 'depthOffset:'))).toContain('0 s ago')
      expect(text(row(el, 'temperatureOffset:2'))).toMatch(/optional water sensor.*-0\.250 K/i)
    })

    it('ages each value as time passes', async () => {
      device()
      const el = await mount()
      await settle()

      await vi.advanceTimersByTimeAsync(90_000)

      expect(text(row(el, 'depthOffset:'))).toContain('2 min ago')
    })

    it('shows nothing for a capability the probe found unsupported', async () => {
      device()
      const el = await mount()

      expect(el.querySelector('[data-slot^="temperatureFilter"]')).toBeNull()
    })

    it('explains a capability that went unanswered and offers to probe again', async () => {
      const probes: string[] = []
      device({
        overrides: (path, init) => {
          if (init?.method === 'POST') {
            probes.push(path)
            return json(probe)
          }
          return undefined
        }
      })
      const el = await mount()
      const placeholder = row(el, 'speedOfSound:')

      expect(text(placeholder)).toContain('did not answer')

      button(placeholder, 'Probe again').click()
      await settle()

      expect(probes).toEqual(['/device/probe'])
    })

    it('says a write-only setting cannot be read back, and never asks for it', async () => {
      const reads: string[] = []
      device({ reads })
      const el = await mount()
      await settle()

      expect(reads).not.toContain('speedFilter')
      expect(text(row(el, 'speedFilter:'))).toContain('cannot report')
    })

    it('asks for a probe before a sensor has one', async () => {
      serve(selected({ probe: null }), undefined, SETTINGS)

      const el = await mount()

      expect(text(el.querySelector('dst-settings'))).toContain('Probe the sensor to see')
      expect(el.querySelector('[data-slot]')).toBeNull()
    })

    it('stops reading after the server asks for an admin login, and says so', async () => {
      const reads: string[] = []
      serve(
        selected({ probe }),
        (path) => {
          reads.push(path)
          return new Response('', { status: 401, statusText: 'Unauthorized' })
        },
        SETTINGS
      )
      const el = await mount()
      await settle()

      expect(reads).toHaveLength(1)
      expect(text(el.querySelector('dst-settings'))).toContain('admin login')
    })

    it('shows values as last read while the sensor is not on the bus, and offers no write', async () => {
      device()
      const el = await mount()
      await settle()

      FakeEventSource.latest.push({
        type: 'device',
        data: selected({ probe, location: { state: 'waiting', address: 22 } })
      })
      await settle()

      expect(text(el.querySelector('dst-settings'))).toContain('from its last read')
      expect(text(row(el, 'depthOffset:'))).toContain('0.350 m')
      expect(button(row(el, 'depthOffset:'), 'Write').disabled).toBe(true)
    })

    it('shows a value another console read or wrote', async () => {
      device()
      const el = await mount()
      await settle()

      FakeEventSource.latest.push({
        type: 'setting',
        data: { id: 'depthOffset', qualifier: null, operation: 'write', result: answered(0.42) }
      })
      await settle()

      expect(text(row(el, 'depthOffset:'))).toContain('0.420 m')
    })
  })

  describe('writing', () => {
    const writeDepth = async (answer: WriteResult | Response) => {
      const bodies: unknown[] = []
      let finish: (response: Response) => void = () => undefined
      device({
        onWrite: (path, init) => {
          bodies.push([path, JSON.parse(init?.body as string)])
          return new Promise((resolve) => {
            finish = resolve
          })
        }
      })
      const el = await mount()
      await settle()
      const depth = row(el, 'depthOffset:')
      type(depth, '0.5')
      await settle()
      button(depth, 'Write').click()
      await settle()
      const pending = text(row(el, 'depthOffset:'))
      finish(answer instanceof Response ? answer : json(answer))
      await settle()
      return { el, bodies, pending, depth: row(el, 'depthOffset:') }
    }

    it('shows the write as pending, then as stored with the value the device read back', async () => {
      const { bodies, pending, depth } = await writeDepth({
        status: 'applied',
        stored: 0.5,
        readAt: READ_AT
      })

      expect(bodies).toEqual([['/settings/depthOffset', { value: 0.5 }]])
      expect(pending).toContain('Writing')
      expect(text(depth)).toContain('Stored.')
      expect(text(depth)).toContain('0.500 m')
    })

    it('names the field and the device’s error when the device refuses a write', async () => {
      const { depth } = await writeDepth({
        status: 'rejected',
        reason: 'Parameter out of range',
        refusedFields: [{ field: 'value', error: 'Parameter out of range' }],
        detail: {
          acknowledgedPgn: 126208,
          src: 22,
          ok: false,
          pgnError: 'Acknowledge',
          intervalPriorityError: 'Acknowledge',
          parameterErrors: [{ index: 3, error: 'Parameter out of range' }],
          missingParameterCodes: 0
        },
        requested: 0.5
      })

      expect(text(depth)).toContain('Refused by the device (value: Parameter out of range)')
      expect(depth.querySelector('.text-danger-emphasis')).not.toBeNull()
    })

    it('marks a write the device never answered differently from a refusal', async () => {
      const { depth } = await writeDepth({ status: 'unknown', reason: 'No answer' })

      expect(text(depth)).toContain('No answer from the device')
      expect(depth.querySelector('.text-danger-emphasis')).toBeNull()
      expect(depth.querySelector('.text-warning-emphasis')).not.toBeNull()
    })

    it('shows the plugin’s reason for a value it refused before the bus', async () => {
      const { depth } = await writeDepth(
        json({ error: 'Depth offset must be between -32.764 and 32.764, not 99' }, 400)
      )

      expect(text(depth)).toContain('must be between -32.764 and 32.764')
    })

    it('turns simulate mode on only after the user confirms what it does', async () => {
      const bodies: unknown[] = []
      device({
        onWrite: (path, init) => {
          bodies.push([path, JSON.parse(init?.body as string)])
          return json({ status: 'applied', stored: true, readAt: READ_AT })
        }
      })
      const el = await mount()
      await settle()
      const simulate = row(el, 'simulateMode:')

      button(simulate, 'Turn on…').click()
      await settle()

      expect(bodies).toEqual([])
      expect(text(row(el, 'simulateMode:'))).toContain('every device on the bus')

      button(row(el, 'simulateMode:'), 'Turn simulate mode on').click()
      await settle()

      expect(bodies).toEqual([['/settings/simulateMode', { value: true }]])
    })
  })
})
