import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type {
  ImportPlan,
  ImportResult,
  ReadResult,
  SettingInfo,
  Snapshot,
  WriteResult
} from '../../src/types.js'
import '../../src/ui/main.js'
import {
  DST,
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

const SETTINGS: SettingInfo[] = [
  {
    id: 'depthOffset',
    requirement: 'R10',
    readable: true,
    writable: true,
    requiresLevel1: false,
    qualifiers: null,
    available: 'yes'
  }
]

const SNAPSHOT: Snapshot = {
  schemaVersion: 1,
  takenAt: READ_AT,
  device: DST,
  probed: ['pid:40'],
  settings: [
    { id: 'depthOffset', qualifier: null, value: 0.5 },
    { id: 'temperatureOffset', qualifier: 1, value: 0.25 },
    { id: 'simulateMode', qualifier: null, value: false }
  ],
  unread: [{ id: 'speedCurve', qualifier: null, reason: 'No answer' }]
}

const answered = (value: unknown): ReadResult => ({ status: 'answered', value, readAt: READ_AT })

const PLAN: ImportPlan = {
  source: DST,
  items: [
    { id: 'depthOffset', qualifier: null, action: 'write', value: 0.5, current: answered(0.35) },
    { id: 'temperatureOffset', qualifier: 1, action: 'unchanged', value: 0.25, current: 0.25 },
    {
      id: 'simulateMode',
      qualifier: null,
      action: 'excluded',
      value: false,
      reason: 'Simulate mode puts simulated data on the bus, so it is only ever turned on by hand'
    },
    { id: 'speedCurve', qualifier: null, action: 'missing', reason: 'No answer' }
  ]
}

interface Sent {
  method: string
  path: string
  body: unknown
}

/** A sensor answering the snapshot routes; the rest of the page reads nothing. */
function sensor(
  options: {
    sent?: Sent[]
    plan?: ImportPlan | Response | Promise<Response>
    result?: ImportResult | Response
    snapshot?: Snapshot
  } = {}
) {
  serve(
    selected(),
    (path, init) => {
      const method = init?.method ?? 'GET'
      const body: unknown = init?.body === undefined ? undefined : JSON.parse(init.body as string)
      options.sent?.push({ method, path, body })
      if (method === 'GET' && path === '/snapshot') {
        return json(options.snapshot ?? SNAPSHOT)
      }
      if (method === 'POST' && path === '/snapshot/diff') {
        const plan = options.plan ?? PLAN
        return plan instanceof Response || plan instanceof Promise ? plan : json(plan)
      }
      if (method === 'POST' && path === '/snapshot/import') {
        const result = options.result ?? { source: DST, items: [], complete: true }
        return result instanceof Response ? result : json(result)
      }
      if (method === 'GET' && path.startsWith('/settings/')) {
        return json(answered(0.35))
      }
      throw new Error(`Unexpected ${method} ${path}`)
    },
    SETTINGS
  )
}

const section = (el: Element): Element => {
  const found = el.querySelector('#snapshots')
  if (found === null) {
    throw new Error('No snapshots section')
  }
  return found
}

/** Choose `content` as the file to load, as the browser's file picker would. */
const choose = async (el: Element, content: string, name = 'dst.json') => {
  const input = section(el).querySelector<HTMLInputElement>('input[type="file"]')
  if (input === null) {
    throw new Error('No file input')
  }
  const file = new File([content], name, { type: 'application/json' })
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  input.dispatchEvent(new Event('change'))
  await settle()
  await settle()
}

const open = async () => {
  const el = await mount()
  await settle()
  return el
}

describe('snapshots', () => {
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

  it('saves every setting to a file named for the sensor and the day, and says what it could not read', async () => {
    const saved: { name: string; blob: Blob }[] = []
    let blob: Blob | null = null
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: (b: Blob) => {
        blob = b
        return 'blob:snapshot'
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
    sensor()
    const el = await open()

    button(section(el), 'Save snapshot').click()
    await settle()

    expect(saved.map((s) => s.name)).toEqual(['dst-123456-2026-09-24.json'])
    expect(JSON.parse(await saved[0].blob.text())).toEqual(SNAPSHOT)
    expect(text(section(el))).toContain('Saved dst-123456-2026-09-24.json with 3 settings.')
    expect(text(section(el))).toContain('Not in it: Calibration curve (No answer).')
  })

  it('shows what loading a snapshot would change, in the user’s units, before changing anything', async () => {
    const sent: Sent[] = []
    sensor({ sent })
    const el = await open()

    await choose(el, JSON.stringify(SNAPSHOT))

    expect(sent.filter((s) => s.method === 'POST')).toEqual([
      { method: 'POST', path: '/snapshot/diff', body: SNAPSHOT }
    ])
    const change = section(el).querySelector('[data-item="depthOffset:"]')
    expect(text(change)).toContain('Depth offset')
    expect(text(change)).toContain('0.350 m')
    expect(text(change)).toContain('0.500 m')
    expect(text(section(el).querySelector('[data-item="temperatureOffset:1"]'))).toContain(
      'Already set'
    )
    expect(text(section(el).querySelector('[data-item="simulateMode:"]'))).toContain(
      'only ever turned on by hand'
    )
    expect(text(section(el).querySelector('[data-item="speedCurve:"]'))).toContain(
      'Not in the snapshot: No answer'
    )
    expect(button(section(el), 'Apply 1 change').disabled).toBe(false)
    expect(text(section(el))).not.toContain('another sensor')
  })

  it('applies the snapshot and reports each setting’s outcome', async () => {
    const sent: Sent[] = []
    const refused: WriteResult = {
      status: 'rejected',
      reason: 'Parameter out of range',
      refusedFields: [{ field: 'value', error: 'Parameter out of range' }],
      detail: {
        acknowledgedPgn: 126720,
        src: 22,
        ok: false,
        pgnError: 'Acknowledge',
        intervalPriorityError: 'Acknowledge',
        parameterErrors: [{ index: 5, error: 'Parameter out of range' }],
        missingParameterCodes: 0
      },
      requested: 0.5
    }
    sensor({
      sent,
      plan: {
        source: DST,
        items: [
          {
            id: 'depthOffset',
            qualifier: null,
            action: 'write',
            value: 0.5,
            current: answered(0.35)
          },
          {
            id: 'speedOfSound',
            qualifier: null,
            action: 'write',
            value: 1480,
            current: answered(1500)
          }
        ]
      },
      result: {
        source: DST,
        complete: false,
        items: [
          {
            id: 'depthOffset',
            qualifier: null,
            action: 'write',
            value: 0.5,
            current: answered(0.35),
            outcome: 'failed',
            result: refused
          },
          {
            id: 'speedOfSound',
            qualifier: null,
            action: 'write',
            value: 1480,
            current: answered(1500),
            outcome: 'notAttempted'
          }
        ]
      }
    })
    const el = await open()
    await choose(el, JSON.stringify(SNAPSHOT))

    button(section(el), 'Apply 2 changes').click()
    await settle()

    expect(sent.filter((s) => s.path === '/snapshot/import')).toEqual([
      { method: 'POST', path: '/snapshot/import', body: SNAPSHOT }
    ])
    expect(text(section(el).querySelector('[data-item="depthOffset:"]'))).toContain(
      'The sensor refused 0.500 m: out of its allowed range.'
    )
    expect(text(section(el).querySelector('[data-item="speedOfSound:"]'))).toContain(
      'Not attempted: an earlier change failed.'
    )
    expect(text(section(el))).toContain('The import stopped at the first change that failed.')
  })

  it('keeps the diff when Apply fails, and says settings may have changed', async () => {
    sensor({
      result: new Response(JSON.stringify({ error: 'The sensor is not on the bus.' }), {
        status: 503,
        statusText: 'Service Unavailable',
        headers: { 'Content-Type': 'application/json' }
      })
    })
    const el = await open()
    await choose(el, JSON.stringify(SNAPSHOT))

    button(section(el), 'Apply 1 change').click()
    await settle()

    expect(text(section(el))).not.toContain('is not a snapshot')
    expect(text(section(el))).toContain('The import did not finish: The sensor is not on the bus.')
    expect(text(section(el))).toContain('Some settings may have been written')
    expect(text(section(el))).not.toContain('..')
    expect(section(el).querySelector('[data-item="depthOffset:"]')).not.toBeNull()
    expect(button(section(el), 'Apply 1 change').disabled).toBe(false)
  })

  it('says a diff the plugin could not run is not the file’s fault', async () => {
    sensor({
      plan: new Response(JSON.stringify({ error: 'The sensor is not on the bus.' }), {
        status: 503,
        statusText: 'Service Unavailable',
        headers: { 'Content-Type': 'application/json' }
      })
    })
    const el = await open()

    await choose(el, JSON.stringify(SNAPSHOT))

    expect(text(section(el))).not.toContain('is not a snapshot')
    expect(text(section(el))).toContain(
      'Could not compare dst.json with the sensor: The sensor is not on the bus.'
    )
  })

  it('drops a diff that answers after another sensor was selected', async () => {
    let answer: () => void = () => undefined
    sensor({
      plan: new Promise<Response>((resolve) => {
        answer = () => {
          resolve(json(PLAN))
        }
      })
    })
    const el = await open()
    await choose(el, JSON.stringify(SNAPSHOT))

    FakeEventSource.latest.push({ type: 'device', data: selected({ selected: OTHER }) })
    await settle()
    answer()
    await settle()

    expect(section(el).querySelector('[data-item]')).toBeNull()
    expect(text(section(el))).not.toContain('Apply')
  })

  it('lists the points a curve of the same length would change', async () => {
    const current = [
      { hz: 0, speed: 0 },
      { hz: 10, speed: 1.05 },
      { hz: 25, speed: 2.6 }
    ]
    const snapshotCurve = [
      { hz: 0, speed: 0 },
      { hz: 10, speed: 1.1 },
      { hz: 25, speed: 2.6 }
    ]
    sensor({
      plan: {
        source: DST,
        items: [
          {
            id: 'speedCurve',
            qualifier: null,
            action: 'write',
            value: snapshotCurve,
            current: answered(current)
          }
        ]
      }
    })
    const el = await open()

    await choose(el, JSON.stringify(SNAPSHOT))

    const row = text(section(el).querySelector('[data-item="speedCurve:"]'))
    expect(row).toContain('Point 2: 10.0 Hz 1.05 m/s → 10.0 Hz 1.10 m/s')
    expect(row).not.toContain('Point 1')
    expect(row).not.toContain('Point 3')
  })

  it('says when everything applied', async () => {
    sensor({
      result: {
        source: DST,
        complete: true,
        items: [
          {
            id: 'depthOffset',
            qualifier: null,
            action: 'write',
            value: 0.5,
            current: answered(0.35),
            outcome: 'applied',
            result: { status: 'applied', stored: 0.5, readAt: READ_AT }
          }
        ]
      }
    })
    const el = await open()
    await choose(el, JSON.stringify(SNAPSHOT))

    button(section(el), 'Apply 1 change').click()
    await settle()

    expect(text(section(el).querySelector('[data-item="depthOffset:"]'))).toContain('✓ Stored.')
    expect(text(section(el))).toContain('Every change was applied.')
  })

  it('says the sensor already matches when nothing would change', async () => {
    sensor({ plan: { source: DST, items: [PLAN.items[1]] } })
    const el = await open()

    await choose(el, JSON.stringify(SNAPSHOT))

    expect(text(section(el))).toContain('The sensor already holds everything in this snapshot.')
    expect(section(el).querySelector('button.btn-primary')).toBeNull()
  })

  it('says when the snapshot was taken from another sensor', async () => {
    sensor({ plan: { ...PLAN, source: OTHER } })
    const el = await open()

    await choose(el, JSON.stringify({ ...SNAPSHOT, device: OTHER }))

    expect(text(section(el))).toContain('This snapshot was taken from another sensor')
  })

  it.each([
    ['not JSON', 'depth=0.5', undefined, 'dst.json is not a snapshot: it is not JSON.'],
    [
      'refused by the plugin',
      '{"schemaVersion":7}',
      new Response(JSON.stringify({ error: 'Unsupported schemaVersion 7' }), {
        status: 400,
        statusText: 'Bad Request',
        headers: { 'Content-Type': 'application/json' }
      }),
      'Unsupported schemaVersion 7'
    ]
  ])('refuses a file that is %s', async (_case, content, plan, words) => {
    sensor({ plan })
    const el = await open()

    await choose(el, content)

    expect(text(section(el))).toContain(words)
    expect(section(el).querySelector('[data-item]')).toBeNull()
  })

  it('disables saving and loading while the sensor is off the bus', async () => {
    sensor()
    const el = await open()

    FakeEventSource.latest.push({
      type: 'device',
      data: selected({ location: { state: 'waiting', address: 22 } })
    })
    await settle()

    expect(button(section(el), 'Save snapshot').disabled).toBe(true)
    expect(section(el).querySelector<HTMLInputElement>('input[type="file"]')?.disabled).toBe(true)
  })
})
