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
    requiresLevel1: true,
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
  info('productInformation', 'yes', { writable: false }),
  info('simulateMode', 'yes')
]

/** What the device holds, by `id` or `id?qualifier=n`. */
const HELD: Record<string, unknown> = {
  depthOffset: 0.35,
  'temperatureOffset?qualifier=0': 0.5,
  'temperatureOffset?qualifier=1': 0,
  'temperatureOffset?qualifier=2': -0.25,
  productInformation: {
    productCode: 1,
    modelId: 'DST800',
    softwareVersionCode: '2.1',
    modelVersion: 'rev B',
    modelSerialCode: '0123456'
  },
  simulateMode: false
}

const answered = (value: unknown): ReadResult => ({ status: 'answered', value, readAt: READ_AT })

/** Serve the settings list and answer reads from `held`; writes go to `onWrite`. */
function device(
  options: {
    onWrite?: Handler
    reads?: string[]
    held?: Record<string, unknown>
    /** Answers first; `undefined` passes the request on. */
    overrides?: (path: string, init?: RequestInit) => Response | undefined
    server?: Record<string, unknown>
  } = {}
) {
  const held = { ...HELD, ...options.held }
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
          slot in held ? answered(held[slot]) : { status: 'unknown', reason: 'No answer' }
        )
      }
      if (init?.method === 'PUT' && options.onWrite !== undefined) {
        return options.onWrite(path, init)
      }
      throw new Error(`Unexpected ${init?.method ?? 'GET'} ${path}`)
    },
    SETTINGS,
    options.server
  )
  return held
}

const row = (el: Element, slot: string): Element => {
  const found = el.querySelector(`[data-slot="${slot}"]`)
  if (found === null) {
    throw new Error(`No row for ${slot}`)
  }
  return found
}

const input = (row: Element, index = 0): HTMLInputElement => row.querySelectorAll('input')[index]

const type = async (row: Element, value: string, index = 0) => {
  const field = input(row, index)
  field.value = value
  field.dispatchEvent(new Event('input'))
  await settle()
}

const press = async (row: Element, key: string) => {
  input(row).dispatchEvent(new KeyboardEvent('keydown', { key }))
  await settle()
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
    it('reads each offered, readable setting once and fills its control with the value', async () => {
      const reads: string[] = []
      device({ reads })
      const el = await mount()
      await settle()

      expect(reads).toEqual([
        'temperatureOffset?qualifier=0',
        'temperatureOffset?qualifier=1',
        'temperatureOffset?qualifier=2',
        'depthOffset',
        'productInformation',
        'simulateMode'
      ])
      expect(input(row(el, 'depthOffset:')).value).toBe('0.350')
      expect(text(row(el, 'depthOffset:'))).toContain('m')
      expect(input(row(el, 'temperatureOffset:2')).value).toBe('-0.250')
      expect(text(row(el, 'temperatureOffset:2'))).toContain('Optional water sensor offset')
    })

    it('puts the sensor’s software and serial in the header', async () => {
      device()
      const el = await mount()
      await settle()

      expect(text(el.querySelector('dst-sensor-header'))).toMatch(/Serial 0123456.*Software 2\.1/)
    })

    it('says when the values were read, once for the page, and ages it', async () => {
      device()
      const el = await mount()
      await settle()

      expect(text(el.querySelector('dst-settings'))).toContain('Read from the sensor 0 s ago')

      await vi.advanceTimersByTimeAsync(90_000)

      expect(text(el.querySelector('dst-settings'))).toContain('Read from the sensor 2 min ago')
    })

    it('reads everything again on request', async () => {
      const reads: string[] = []
      device({ reads })
      const el = await mount()
      await settle()
      const first = reads.length

      button(el.querySelector('dst-settings') ?? el, 'Read again').click()
      await settle()

      expect(reads).toHaveLength(first * 2)
    })

    it('reads again once a probe the plugin dropped comes back', async () => {
      const reads: string[] = []
      device({ reads })
      const el = await mount()
      await settle()
      const first = reads.length

      FakeEventSource.latest.push({ type: 'device', data: selected({ probe: null }) })
      await settle()
      FakeEventSource.latest.push({ type: 'device', data: selected({ probe }) })
      await settle()

      expect(reads).toHaveLength(first * 2)
      expect(input(row(el, 'depthOffset:')).value).toBe('0.350')
    })

    it('shows nothing for a capability the probe found unsupported', async () => {
      device()
      const el = await mount()

      expect(el.querySelector('[data-slot^="temperatureFilter"]')).toBeNull()
    })

    it('offers to check again for a capability that went unanswered', async () => {
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

      expect(text(placeholder)).toContain('didn’t answer when checked')

      button(placeholder, 'Check again').click()
      await settle()

      expect(probes).toEqual(['/device/probe'])
    })

    it('says a write-only setting cannot be read back, and never asks for it', async () => {
      const reads: string[] = []
      device({ reads })
      const el = await mount()
      await settle()

      expect(reads).not.toContain('speedFilter')
      expect(text(row(el, 'speedFilter:'))).toContain('cannot report this setting back')
    })

    it('checks what a sensor supports before showing its settings', async () => {
      serve(selected({ probe: null }), () => new Promise(() => undefined), SETTINGS)

      const el = await mount()

      expect(text(el.querySelector('dst-settings'))).toContain('Checking what the sensor supports')
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

    it.each([
      [
        'the sensor',
        {
          status: 'rejected',
          reason: 'Access denied',
          detail: {
            acknowledgedPgn: 128267,
            src: 22,
            ok: false,
            pgnError: 'Access denied',
            intervalPriorityError: 'Acknowledge',
            parameterErrors: [],
            missingParameterCodes: 0
          }
        },
        'The sensor refused the read: it needs Level 1 access.'
      ],
      [
        'the plugin',
        { status: 'rejected', reason: 'Access Level 1 is unavailable on this device' },
        'Not read: Access Level 1 is unavailable on this device.'
      ]
    ])(
      'says a read was refused by %s, not that it went unanswered',
      async (_by, refusal, words) => {
        device({
          overrides: (path) => (path === '/settings/depthOffset' ? json(refusal) : undefined)
        })
        const el = await mount()
        await settle()

        expect(text(row(el, 'depthOffset:'))).toContain(words)
        expect(text(row(el, 'depthOffset:'))).not.toContain('didn’t answer')
      }
    )

    it('keeps the last values while the sensor is off the bus, and disables editing', async () => {
      device()
      const el = await mount()
      await settle()

      FakeEventSource.latest.push({
        type: 'device',
        data: selected({ probe, location: { state: 'waiting', address: 22 } })
      })
      await settle()

      expect(text(el.querySelector('dst-sensor-header'))).toContain('Sensor offline')
      expect(input(row(el, 'depthOffset:')).value).toBe('0.350')
      expect(input(row(el, 'depthOffset:')).disabled).toBe(true)
    })

    it('shows a value another console wrote, unless the user is editing it', async () => {
      device()
      const el = await mount()
      await settle()
      const push = (value: number) => {
        FakeEventSource.latest.push({
          type: 'setting',
          data: { id: 'depthOffset', qualifier: null, operation: 'write', result: answered(value) }
        })
      }

      push(0.42)
      await settle()

      expect(input(row(el, 'depthOffset:')).value).toBe('0.420')

      await type(row(el, 'depthOffset:'), '0.5')
      push(0.43)
      await settle()

      expect(input(row(el, 'depthOffset:')).value).toBe('0.5')
      expect(text(row(el, 'depthOffset:'))).toContain('Sensor has 0.430 m')
    })
  })

  describe('units', () => {
    const IMPERIAL = {
      '/signalk/v1/applicationData/user/unitpreferences/1.0.0': { activePreset: 'imperial-us' },
      '/signalk/v1/unitpreferences/presets/imperial-us': {
        categories: {
          depth: { baseUnit: 'm', targetUnit: 'foot' },
          temperature: { baseUnit: 'K', targetUnit: 'F' }
        }
      },
      '/signalk/v1/unitpreferences/definitions': {
        m: {
          conversions: {
            foot: { formula: 'value * 3.28084', inverseFormula: 'value / 3.28084', symbol: 'ft' }
          }
        },
        K: {
          conversions: {
            F: {
              formula: '(value - 273.15) * 9/5 + 32',
              inverseFormula: '(value - 32) * 5/9 + 273.15',
              symbol: '°F'
            }
          }
        }
      }
    }

    it('shows no values until the unit preferences have loaded, so none changes unit mid-edit', async () => {
      device({ server: IMPERIAL })
      const answer = vi.mocked(fetch).getMockImplementation()
      let release: () => void = () => undefined
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      vi.mocked(fetch).mockImplementation((input, init) =>
        (input as string).startsWith('/signalk/')
          ? gate.then(() => answer?.(input, init) ?? Promise.reject(new Error('no mock')))
          : (answer?.(input, init) ?? Promise.reject(new Error('no mock')))
      )
      const el = await mount()
      await settle()

      expect(el.querySelector('[data-slot="depthOffset:"]')).toBeNull()

      release()
      await settle()

      expect(input(row(el, 'depthOffset:')).value).toBe('1.148')
    })

    it('shows values in the user’s units and writes what they type back in SI', async () => {
      const bodies: unknown[] = []
      device({
        server: IMPERIAL,
        onWrite: (_path, init) => {
          bodies.push(JSON.parse(init?.body as string))
          return json({ status: 'applied', stored: 0.6096, readAt: READ_AT })
        }
      })
      const el = await mount()
      await settle()
      const depth = row(el, 'depthOffset:')

      expect(input(depth).value).toBe('1.148')
      expect(text(depth)).toContain('ft')
      expect(input(row(el, 'temperatureOffset:0')).value).toBe('0.900')
      expect(text(row(el, 'temperatureOffset:0'))).toContain('°F')

      await type(depth, '2')
      await press(depth, 'Enter')

      expect(bodies).toHaveLength(1)
      expect((bodies[0] as { value: number }).value).toBeCloseTo(0.6096, 4)
    })
  })

  describe('editing', () => {
    it('offers Save and Cancel only once the value differs from the sensor’s', async () => {
      device()
      const el = await mount()
      await settle()
      const depth = row(el, 'depthOffset:')

      expect(text(depth)).not.toContain('Save')

      await type(depth, '0.5')

      expect(text(depth)).toContain('Save')
      expect(text(depth)).toContain('Sensor has 0.350 m')

      await type(depth, '0.350')

      expect(text(depth)).not.toContain('Save')
    })

    it('restores the sensor’s value on Cancel and on Escape', async () => {
      device()
      const el = await mount()
      await settle()
      const depth = row(el, 'depthOffset:')

      await type(depth, '0.5')
      button(depth, 'Cancel').click()
      await settle()

      expect(input(depth).value).toBe('0.350')

      await type(depth, '0.6')
      await press(depth, 'Escape')

      expect(input(depth).value).toBe('0.350')
    })

    it('does not offer to save what is not a number', async () => {
      device()
      const el = await mount()
      await settle()
      const depth = row(el, 'depthOffset:')

      await type(depth, 'deep')

      expect(button(depth, 'Save').disabled).toBe(true)
      expect(text(depth)).toContain('Enter a number')
    })

    it('marks settings that need Level 1', async () => {
      device()
      const el = await mount()
      await settle()

      expect(text(row(el, 'temperatureOffset:1'))).toContain('Level 1')
      expect(text(row(el, 'depthOffset:'))).not.toContain('Level 1')
    })
  })

  describe('writing', () => {
    const writeDepth = async (
      answer: WriteResult | Response,
      held: Record<string, unknown> = {}
    ) => {
      const bodies: unknown[] = []
      let finish: (response: Response) => void = () => undefined
      const holding = device({
        onWrite: (path, init) => {
          bodies.push([path, JSON.parse(init?.body as string)])
          return new Promise((resolve) => {
            finish = resolve
          })
        }
      })
      const el = await mount()
      await settle()
      await type(row(el, 'depthOffset:'), '0.5')
      button(row(el, 'depthOffset:'), 'Save').click()
      await settle()
      const pending = text(row(el, 'depthOffset:'))
      // What a read after the write finds, where the write went unanswered.
      Object.assign(holding, held)
      finish(answer instanceof Response ? answer : json(answer))
      await settle()
      return { el, bodies, pending, depth: row(el, 'depthOffset:') }
    }

    it('shows Saving while the write runs, then Stored with the value the sensor read back', async () => {
      const { bodies, pending, depth } = await writeDepth({
        status: 'applied',
        stored: 0.5,
        readAt: READ_AT
      })

      expect(bodies).toEqual([['/settings/depthOffset', { value: 0.5 }]])
      expect(pending).toContain('Saving')
      expect(text(depth)).toContain('Stored.')
      expect(input(depth).value).toBe('0.500')
    })

    it('lets the Stored notice go after a few seconds', async () => {
      const { depth } = await writeDepth({ status: 'applied', stored: 0.5, readAt: READ_AT })

      await vi.advanceTimersByTimeAsync(5000)

      expect(text(depth)).not.toContain('Stored.')
    })

    it('says what the sensor refused and why, and keeps the attempt to correct', async () => {
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
        requested: 0.5,
        readBack: answered(0.35),
        storedMatches: false
      })

      expect(text(depth)).toContain(
        'The sensor refused 0.500 m: out of its allowed range. It has 0.350 m.'
      )
      expect(input(depth).value).toBe('0.5')
      expect(input(depth).classList.contains('is-invalid')).toBe(true)
    })

    it('reads a setting back after the sensor did not answer the write, and reports what it holds', async () => {
      const { depth } = await writeDepth({ status: 'unknown', reason: 'No answer' })

      expect(text(depth)).toContain('The sensor didn’t answer. It has 0.350 m.')
    })

    it('reports a write that arrived although the sensor did not answer it', async () => {
      const { depth } = await writeDepth(
        { status: 'unknown', reason: 'No answer' },
        { depthOffset: 0.5 }
      )

      expect(text(depth)).not.toContain('Stored.')
      expect(text(depth)).toContain(
        'The sensor didn’t acknowledge the write, but it now holds 0.500 m.'
      )
      expect(input(depth).value).toBe('0.500')
    })

    it('shows the plugin’s reason for a value it refused before the bus', async () => {
      const { depth } = await writeDepth(
        json({ error: 'Depth offset must be between -32.764 and 32.764, not 99' }, 400)
      )

      expect(text(depth)).toContain('must be between -32.764 and 32.764')
    })

    it('turns simulate mode on only after the user acknowledges what it does', async () => {
      const bodies: unknown[] = []
      device({
        onWrite: (path, init) => {
          bodies.push([path, JSON.parse(init?.body as string)])
          return json({ status: 'applied', stored: true, readAt: READ_AT })
        }
      })
      const el = await mount()
      await settle()

      button(row(el, 'simulateMode:'), 'Turn on simulate mode…').click()
      await settle()

      expect(button(row(el, 'simulateMode:'), 'Turn simulate mode on').disabled).toBe(true)

      const understood = row(el, 'simulateMode:').querySelector('input[type="checkbox"]')
      ;(understood as HTMLInputElement).checked = true
      understood?.dispatchEvent(new Event('change'))
      await settle()
      button(row(el, 'simulateMode:'), 'Turn simulate mode on').click()
      await settle()

      expect(bodies).toEqual([['/settings/simulateMode', { value: true }]])
    })
  })
})
