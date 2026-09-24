import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { ReadResult, SettingInfo, WriteResult } from '../../src/types.js'
import '../../src/ui/main.js'
import {
  FakeEventSource,
  OTHER,
  button,
  json,
  mount,
  selected,
  serve,
  settle,
  text
} from './helpers.js'

const READ_AT = '2026-09-24T12:00:00.000Z'

const CURVE_INFO: SettingInfo = {
  id: 'speedCurve',
  requirement: 'R9',
  readable: true,
  writable: true,
  requiresLevel1: true,
  qualifiers: null,
  available: 'yes'
}

const HELD = [
  { hz: 0, speed: 0 },
  { hz: 5, speed: 1.03 },
  { hz: 10, speed: 2.06 }
]

/** The server's own nautical preset: speeds in knots. */
const KNOTS = {
  '/signalk/v1/applicationData/user/unitpreferences/1.0.0': { activePreset: 'nautical-metric' },
  '/signalk/v1/unitpreferences/presets/nautical-metric': {
    categories: { speed: { baseUnit: 'm/s', targetUnit: 'kn', displayFormat: '0.0' } }
  },
  '/signalk/v1/unitpreferences/definitions': {
    'm/s': {
      conversions: {
        kn: { formula: 'value * 1.94384', inverseFormula: 'value * 0.514444', symbol: 'kn' }
      }
    }
  }
}

const answered = (value: unknown): ReadResult => ({ status: 'answered', value, readAt: READ_AT })

/** Serve a sensor holding `held`; writes go to `onWrite`, with each body recorded in `bodies`. */
function curveDevice(
  options: {
    held?: unknown
    onWrite?: (value: unknown) => WriteResult
    bodies?: unknown[]
    reads?: string[]
  } = {}
) {
  let held: unknown = options.held ?? HELD
  serve(
    selected(),
    (path, init) => {
      if ((init?.method ?? 'GET') === 'GET' && path === '/settings/speedCurve') {
        options.reads?.push(path)
        return json(answered(held))
      }
      if (init?.method === 'PUT' && path === '/settings/speedCurve') {
        const body = JSON.parse(init.body as string) as { value: unknown }
        options.bodies?.push(body.value)
        const result = options.onWrite?.(body.value) ?? {
          status: 'applied',
          stored: body.value,
          readAt: READ_AT
        }
        if (result.status === 'applied') {
          held = result.stored
        }
        return json(result)
      }
      throw new Error(`Unexpected ${init?.method ?? 'GET'} ${path}`)
    },
    [CURVE_INFO],
    KNOTS
  )
}

const curve = (el: Element): Element => {
  const found = el.querySelector('[data-slot="speedCurve:"]')
  if (found === null) {
    throw new Error('No speed curve')
  }
  return found
}

/** The table's inputs: frequency and speed per point. */
const cells = (el: Element): HTMLInputElement[][] =>
  [...curve(el).querySelectorAll('tbody tr')].map((tr) => [...tr.querySelectorAll('input')])

const values = (el: Element): string[][] => cells(el).map((row) => row.map((input) => input.value))

const type = async (field: HTMLInputElement, value: string) => {
  field.value = value
  field.dispatchEvent(new Event('input'))
  await settle()
}

const open = async () => {
  const el = await mount()
  await settle()
  return el
}

describe('speed curve', () => {
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

  it('reads the curve and shows each point, speed in the user’s unit, in the table and the plot', async () => {
    curveDevice()
    const el = await open()

    expect(values(el)).toEqual([
      ['0.0', '0.00'],
      ['5.0', '2.00'],
      ['10.0', '4.00']
    ])
    expect(text(curve(el))).toContain('kn')
    expect(curve(el).querySelectorAll('svg .dst-curve-point')).toHaveLength(3)
    expect(el.querySelector('#calibration')).not.toBeNull()
  })

  it('writes the edited curve in SI units', async () => {
    const bodies: unknown[] = []
    curveDevice({ bodies })
    const el = await open()

    await type(cells(el)[2][1], '5.00')
    button(curve(el), 'Save').click()
    await settle()

    expect(bodies).toEqual([
      [
        { hz: 0, speed: 0 },
        { hz: 5, speed: expect.closeTo(1.03, 2) as number },
        { hz: 10, speed: expect.closeTo(2.572, 3) as number }
      ]
    ])
    expect(text(curve(el))).toContain('Stored')
    expect(values(el)[2]).toEqual(['10.0', '5.00'])
  })

  it('adds and removes points, and Cancel goes back to what the sensor holds', async () => {
    curveDevice()
    const el = await open()

    button(curve(el), 'Add point').click()
    await settle()
    await type(cells(el)[3][0], '15')
    await type(cells(el)[3][1], '6')
    curve(el).querySelector<HTMLButtonElement>('[aria-label="Remove point 1"]')?.click()
    await settle()

    expect(values(el)).toEqual([
      ['5.0', '2.00'],
      ['10.0', '4.00'],
      ['15', '6']
    ])
    expect(curve(el).querySelectorAll('svg .dst-curve-point')).toHaveLength(3)

    button(curve(el), 'Cancel').click()
    await settle()

    expect(values(el)).toEqual([
      ['0.0', '0.00'],
      ['5.0', '2.00'],
      ['10.0', '4.00']
    ])
  })

  it('writes a curve with its last point removed', async () => {
    const bodies: unknown[] = []
    curveDevice({ bodies })
    const el = await open()

    curve(el).querySelector<HTMLButtonElement>('[aria-label="Remove point 3"]')?.click()
    await settle()
    button(curve(el), 'Save').click()
    await settle()

    expect(bodies).toEqual([
      [
        { hz: 0, speed: 0 },
        { hz: 5, speed: expect.closeTo(1.03, 2) as number }
      ]
    ])
  })

  it.each([
    ['falls below the point before it', '4', 'Point 3: frequency must be above point 2’s 5.0 Hz'],
    ['stores as the same 0.1 Hz step', '5.04', 'Point 3: frequency must be above point 2’s 5.0 Hz'],
    ['is not a number', 'fast', 'Point 3: enter a frequency'],
    ['is out of range', '7000', 'Point 3: frequency must be between 0 and 6553.2 Hz']
  ])(
    'refuses in the browser a frequency that %s, naming the point',
    async (_case, typed, words) => {
      const bodies: unknown[] = []
      curveDevice({ bodies })
      const el = await open()

      await type(cells(el)[2][0], typed)

      expect(text(curve(el))).toContain(words)
      expect(cells(el)[2][0].classList).toContain('is-invalid')
      expect(button(curve(el), 'Save').disabled).toBe(true)
      expect(bodies).toEqual([])
    }
  )

  it('refuses a speed outside what the sensor stores, in the user’s unit', async () => {
    curveDevice()
    const el = await open()

    await type(cells(el)[1][1], '-1')

    expect(text(curve(el))).toContain('Point 2: speed must be between 0.00 and 1273.84 kn')
    expect(cells(el)[1][1].classList).toContain('is-invalid')
  })

  it('stops at 25 points', async () => {
    const full = Array.from({ length: 25 }, (_, i) => ({ hz: i, speed: i / 10 }))
    curveDevice({ held: full })
    const el = await open()

    expect(cells(el)).toHaveLength(25)
    expect(button(curve(el), 'Add point').disabled).toBe(true)
    expect(text(curve(el))).toContain('at most 25 points')
  })

  it('names the points the sensor refused and marks their fields', async () => {
    curveDevice({
      onWrite: (value) => ({
        status: 'rejected',
        reason: 'Parameter out of range',
        refusedFields: [{ field: 'point 2 speed', error: 'Parameter out of range' }],
        detail: {
          acknowledgedPgn: 126720,
          src: 22,
          ok: false,
          pgnError: 'Acknowledge',
          intervalPriorityError: 'Acknowledge',
          parameterErrors: [{ index: 5, error: 'Parameter out of range' }],
          missingParameterCodes: 0
        },
        requested: value
      })
    })
    const el = await open()

    await type(cells(el)[1][1], '3')
    button(curve(el), 'Save').click()
    await settle()

    expect(text(curve(el))).toContain('The sensor refused point 2 speed: out of its allowed range.')
    expect(cells(el)[1][1].classList).toContain('is-invalid')
    expect(values(el)[1]).toEqual(['5.0', '3'])
  })

  it('reads an unanswered write back, and finds the curve asked for at the stored resolution', async () => {
    const reads: string[] = []
    let held: unknown = HELD
    serve(
      selected(),
      (path, init) => {
        if (init?.method === 'PUT') {
          const body = JSON.parse(init.body as string) as { value: { hz: number; speed: number }[] }
          // The sensor quantises: 0.01 m/s.
          held = body.value.map((p) => ({ hz: p.hz, speed: Math.round(p.speed * 100) / 100 }))
          return json({ status: 'unknown', reason: 'No answer' } satisfies WriteResult)
        }
        reads.push(path)
        return json(answered(held))
      },
      [CURVE_INFO],
      KNOTS
    )
    const el = await open()

    await type(cells(el)[2][1], '5.00')
    button(curve(el), 'Save').click()
    await settle()

    expect(reads).toHaveLength(2)
    expect(text(curve(el))).toContain('didn’t acknowledge the write, but it now holds')
  })

  it('disables editing while the sensor is off the bus', async () => {
    curveDevice()
    const el = await open()

    FakeEventSource.latest.push({
      type: 'device',
      data: selected({ location: { state: 'waiting', address: 22 } })
    })
    await settle()

    expect(values(el)[1]).toEqual(['5.0', '2.00'])
    expect(
      cells(el)
        .flat()
        .every((input) => input.disabled)
    ).toBe(true)
    expect(button(curve(el), 'Add point').disabled).toBe(true)
  })
  describe('factory curve', () => {
    const FACTORY = [
      { hz: 0, speed: 0 },
      { hz: 20, speed: 2 },
      { hz: 80, speed: 8 }
    ]

    it('restores the factory curve after a confirmation, and shows the curve the sensor then holds', async () => {
      const bodies: unknown[] = []
      curveDevice({
        bodies,
        onWrite: (value) =>
          value === 'factory'
            ? { status: 'applied', stored: FACTORY, readAt: READ_AT }
            : { status: 'invalid', reason: 'unexpected' }
      })
      const el = await open()

      button(curve(el), 'Restore factory curve…').click()
      await settle()

      expect(text(curve(el))).toContain('replaces the curve on the sensor')
      expect(curve(el).querySelector('a[href="#snapshots"]')).not.toBeNull()
      expect(bodies).toEqual([])

      button(curve(el), 'Restore factory curve').click()
      await settle()

      expect(bodies).toEqual(['factory'])
      expect(values(el)).toEqual([
        ['0.0', '0.00'],
        ['20.0', '3.89'],
        ['80.0', '15.55']
      ])
      expect(text(curve(el))).toContain('Stored')
    })

    it('sends nothing when the confirmation is cancelled', async () => {
      const bodies: unknown[] = []
      curveDevice({ bodies })
      const el = await open()

      button(curve(el), 'Restore factory curve…').click()
      await settle()
      button(curve(el), 'Cancel').click()
      await settle()

      expect(bodies).toEqual([])
      expect(text(curve(el))).not.toContain('replaces the curve on the sensor')
    })

    it('says the sensor refused a restore, with its reason', async () => {
      curveDevice({
        onWrite: (value) => ({
          status: 'rejected',
          reason: 'Access denied',
          refusedFields: [],
          detail: {
            acknowledgedPgn: 126720,
            src: 22,
            ok: false,
            pgnError: 'Access denied',
            intervalPriorityError: 'Acknowledge',
            parameterErrors: [],
            missingParameterCodes: 0
          },
          requested: value
        })
      })
      const el = await open()

      button(curve(el), 'Restore factory curve…').click()
      await settle()
      button(curve(el), 'Restore factory curve').click()
      await settle()

      expect(text(curve(el))).toContain(
        'The sensor refused the factory curve: it needs Level 1 access.'
      )
    })

    it('cannot restore while the sensor is off the bus', async () => {
      curveDevice()
      const el = await open()

      FakeEventSource.latest.push({
        type: 'device',
        data: selected({ location: { state: 'waiting', address: 22 } })
      })
      await settle()

      expect(button(curve(el), 'Restore factory curve…').disabled).toBe(true)
    })
  })

  describe('as CSV', () => {
    /** Capture the files the page saves, as the browser's download would. */
    const downloads = () => {
      const saved: { name: string; blob: Blob }[] = []
      let blob: Blob | null = null
      vi.stubGlobal('URL', {
        ...URL,
        createObjectURL: (b: Blob) => {
          blob = b
          return 'blob:curve'
        },
        revokeObjectURL: () => undefined
      })
      vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
        this: HTMLAnchorElement
      ) {
        if (blob !== null) {
          saved.push({ name: this.download, blob })
        }
      })
      return saved
    }

    /** Choose `content` as the CSV to import, as the browser's file picker would. */
    const importCsv = async (el: Element, content: string) => {
      const input = curve(el).querySelector<HTMLInputElement>('input[type="file"]')
      if (input === null) {
        throw new Error('No file input')
      }
      Object.defineProperty(input, 'files', {
        value: [new File([content], 'curve.csv', { type: 'text/csv' })],
        configurable: true
      })
      input.dispatchEvent(new Event('change'))
      await settle()
      await settle()
    }

    it('exports the curve with its unit in the header, named for the sensor and the day', async () => {
      const saved = downloads()
      curveDevice()
      const el = await open()

      button(curve(el), 'Export CSV').click()
      await settle()

      expect(saved.map((s) => s.name)).toEqual(['dst-123456-curve-2026-09-24.csv'])
      expect(await saved[0].blob.text()).toBe(
        'frequency_hz,speed_kn\n0.0,0.00\n5.0,2.00\n10.0,4.00\n'
      )
    })

    it('exports unsaved edits, and says they are not on the sensor yet', async () => {
      const saved = downloads()
      curveDevice()
      const el = await open()

      await type(cells(el)[2][1], '5.00')
      button(curve(el), 'Export CSV').click()
      await settle()

      expect(await saved[0].blob.text()).toContain('10.0,5.00\n')
      expect(text(curve(el))).toContain('not saved to the sensor')
    })

    it('does not export a table with problems', async () => {
      curveDevice()
      const el = await open()

      await type(cells(el)[2][0], '4')

      expect(button(curve(el), 'Export CSV').disabled).toBe(true)
    })

    it('imports a file into the table as an unsaved edit, and Save writes it in SI', async () => {
      const bodies: unknown[] = []
      curveDevice({ bodies })
      const el = await open()

      await importCsv(el, 'frequency_hz,speed_kn\n0,0\n8,3.00\n16,6.00\n')

      expect(values(el)).toEqual([
        ['0.0', '0.00'],
        ['8.0', '3.00'],
        ['16.0', '6.00']
      ])
      expect(bodies).toEqual([])

      button(curve(el), 'Save').click()
      await settle()

      expect(bodies).toEqual([
        [
          { hz: 0, speed: 0 },
          { hz: 8, speed: expect.closeTo(1.543, 3) as number },
          { hz: 16, speed: expect.closeTo(3.087, 3) as number }
        ]
      ])
    })

    it('converts a file in m/s into the table’s knots', async () => {
      curveDevice()
      const el = await open()

      await importCsv(el, 'frequency_hz,speed_m/s\n0,0\n10,2.06\n')

      expect(values(el)).toEqual([
        ['0.0', '0.00'],
        ['10.0', '4.00']
      ])
    })

    it('accepts semicolons between the values', async () => {
      curveDevice()
      const el = await open()

      await importCsv(el, 'frequency_hz;speed_kn\r\n0;0\r\n8;3.00\r\n')

      expect(values(el)).toEqual([
        ['0.0', '0.00'],
        ['8.0', '3.00']
      ])
    })

    it('puts a file the sensor would refuse in the table, marked, with Save disabled', async () => {
      curveDevice()
      const el = await open()
      const rows = Array.from({ length: 26 }, (_, i) => `${String(i)},${String(i / 10)}`)

      await importCsv(el, `frequency_hz,speed_kn\n${rows.join('\n')}\n`)

      expect(cells(el)).toHaveLength(26)
      expect(text(curve(el))).toContain('A curve holds 1 to 25 points.')
      expect(button(curve(el), 'Save').disabled).toBe(true)
    })

    it('keeps blank and non-numeric cells as written, marked, with Save disabled', async () => {
      curveDevice()
      const el = await open()

      await importCsv(el, 'frequency_hz,speed_kn\n0,0\n,3.00\n16,abc\n')

      expect(values(el)).toEqual([
        ['0.0', '0.00'],
        ['', '3.00'],
        ['16.0', 'abc']
      ])
      expect(text(curve(el))).toContain('Point 2: enter a frequency.')
      expect(text(curve(el))).toContain('Point 3: enter a speed.')
      expect(button(curve(el), 'Save').disabled).toBe(true)
    })

    it('empties the table for a file with a header and no points, and says why it cannot be saved', async () => {
      curveDevice()
      const el = await open()

      await importCsv(el, 'frequency_hz,speed_kn\n')

      expect(cells(el)).toHaveLength(0)
      expect(text(curve(el))).toContain('A curve holds 1 to 25 points.')
    })

    it('says a file that matches the sensor’s curve changes nothing', async () => {
      curveDevice()
      const el = await open()

      await importCsv(el, 'frequency_hz,speed_kn\n0.0,0.00\n5.0,2.00\n10.0,4.00\n')

      expect(text(curve(el))).toContain('matches the curve the sensor holds')
      expect(
        [...curve(el).querySelectorAll('button')].map((b) => b.textContent.trim())
      ).not.toContain('Save')
    })

    it('says a file that matches the sensor’s curve changes nothing, even over an unsaved edit', async () => {
      curveDevice()
      const el = await open()

      await type(cells(el)[2][1], '5.00')
      await importCsv(el, 'frequency_hz,speed_kn\n0.0,0.00\n5.0,2.00\n10.0,4.00\n')

      expect(text(curve(el))).toContain('matches the curve the sensor holds')
    })

    it('exports the decimals a speed needs to store what the table holds', async () => {
      const saved = downloads()
      curveDevice()
      const el = await open()

      await importCsv(el, 'frequency_hz,speed_kn\n0,0\n20,3.0049\n')
      button(curve(el), 'Export CSV').click()
      await settle()

      // 3.00 kn would store 1.54 m/s; the table's 3.0049 stores 1.55.
      const line = (await saved[0].blob.text()).split('\n')[2]
      const [hz, speed] = line.split(',')
      expect(hz).toBe('20.0')
      expect(Math.round((Number(speed) * 0.514444) / 0.01)).toBe(155)
    })

    it('reads spreadsheet dialects: quotes, CR line endings, capitals and blank lines', async () => {
      curveDevice()
      const el = await open()

      await importCsv(el, '"Frequency_Hz";"Speed_KN"\r0;0\r8;3.00\r;\r;\r')

      expect(values(el)).toEqual([
        ['0.0', '0.00'],
        ['8.0', '3.00']
      ])
    })

    it('keeps a fitting script’s decimals in the table’s own unit, so only the sensor rounds', async () => {
      const bodies: unknown[] = []
      curveDevice({ bodies })
      const el = await open()

      await importCsv(el, 'frequency_hz,speed_kn\n0,0\n20,3.0049\n')

      // At the table's 2 decimals, 3.00 kn would store 1.54 m/s, not the file's 1.55.
      expect(values(el)[1]).toEqual(['20.0', '3.0049'])

      button(curve(el), 'Save').click()
      await settle()
      expect(bodies).toEqual([
        [
          { hz: 0, speed: 0 },
          { hz: 20, speed: expect.closeTo(3.0049 * 0.514444, 5) as number }
        ]
      ])
    })

    it('converts another unit with enough decimals that it does not round before the sensor', async () => {
      const bodies: unknown[] = []
      curveDevice({ bodies })
      const el = await open()

      await importCsv(el, 'frequency_hz,speed_m/s\n0,0\n20,1.5453\n')
      button(curve(el), 'Save').click()
      await settle()

      expect(bodies).toEqual([
        [
          { hz: 0, speed: 0 },
          { hz: 20, speed: expect.closeTo(1.5453, 4) as number }
        ]
      ])
    })

    it('forgets what an import said once it is cancelled', async () => {
      curveDevice()
      const el = await open()

      await importCsv(el, 'frequency_hz,speed_kn\n0,0\n8,3.00\n')
      button(curve(el), 'Cancel').click()
      await settle()

      expect(text(curve(el))).not.toContain('Imported')
      expect(values(el)[1]).toEqual(['5.0', '2.00'])
    })

    it('drops an imported curve when another sensor is selected', async () => {
      const bodies: unknown[] = []
      curveDevice({ bodies })
      const el = await open()

      await importCsv(el, 'frequency_hz,speed_kn\n0,0\n8,3.00\n')
      FakeEventSource.latest.push({ type: 'device', data: selected({ selected: OTHER }) })
      await settle()

      expect(text(curve(el))).not.toContain('Imported')
      expect(
        [...curve(el).querySelectorAll('button')].map((b) => b.textContent.trim())
      ).not.toContain('Save')
      expect(bodies).toEqual([])
    })

    it.each([
      ['no header', '0,0\n8,3\n', 'The first line must name the columns'],
      ['an unknown unit', 'frequency_hz,speed_furlongs\n0,0\n', 'furlongs is not a speed unit'],
      ['decimal commas', 'frequency_hz;speed_kn\n0;0\n8;3,5\n', 'decimal commas'],
      ['a row of three values', 'frequency_hz,speed_kn\n0,0\n8,3,5\n', 'Line 3 has 3 values']
    ])('refuses a file with %s and leaves the table as it was', async (_case, content, words) => {
      curveDevice()
      const el = await open()

      await importCsv(el, content)

      expect(text(curve(el))).toContain(words)
      expect(values(el)).toEqual([
        ['0.0', '0.00'],
        ['5.0', '2.00'],
        ['10.0', '4.00']
      ])
    })
  })
})
