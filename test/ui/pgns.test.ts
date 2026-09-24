import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { PgnListResult, PgnWriteResult, ReadResult, SettingInfo } from '../../src/types.js'
import '../../src/ui/main.js'
import {
  FakeEventSource,
  OTHER,
  button,
  probe,
  json,
  mount,
  selected,
  serve,
  settle,
  text
} from './helpers.js'

const READ_AT = '2026-09-24T12:00:00.000Z'

const OVERRIDE: SettingInfo = {
  id: 'transmissionIntervalOverride',
  requirement: 'R17',
  readable: true,
  writable: true,
  requiresLevel1: false,
  qualifiers: null,
  available: 'yes'
}

const LIST: PgnListResult = {
  status: 'answered',
  pgns: [
    {
      pgn: 128267,
      minIntervalMs: 50,
      telemetry: false,
      observedIntervalMs: 1000,
      observedPriority: 3
    },
    {
      pgn: 130316,
      minIntervalMs: 50,
      telemetry: false,
      observedIntervalMs: 2000,
      observedPriority: 5
    },
    {
      pgn: 60928,
      minIntervalMs: 50,
      telemetry: false,
      observedIntervalMs: 0,
      observedPriority: null
    },
    {
      pgn: 126996,
      minIntervalMs: 100,
      telemetry: false,
      observedIntervalMs: 0,
      observedPriority: 6
    },
    {
      pgn: 65409,
      minIntervalMs: 50,
      telemetry: true,
      observedIntervalMs: 0,
      observedPriority: null
    }
  ]
}

interface Sent {
  method: string
  path: string
  body: unknown
}

/** A sensor transmitting LIST; PUTs to /pgns answer from `onWrite`, POSTs from `onRestore`. */
function sensor(
  options: {
    sent?: Sent[]
    onWrite?: (
      pgn: number,
      body: Record<string, number>
    ) => PgnWriteResult | Promise<PgnWriteResult>
    onRestore?: () => unknown
    override?: boolean
    list?: PgnListResult
  } = {}
) {
  serve(
    selected(),
    async (path, init) => {
      const method = init?.method ?? 'GET'
      const body: unknown = init?.body === undefined ? undefined : JSON.parse(init.body as string)
      options.sent?.push({ method, path, body })
      if (method === 'GET' && path === '/settings/transmissionIntervalOverride') {
        return json({
          status: 'answered',
          value: options.override ?? true,
          readAt: READ_AT
        } satisfies ReadResult)
      }
      if (method === 'PUT' && path.startsWith('/pgns/')) {
        const pgn = Number(path.slice('/pgns/'.length))
        return json(
          (await options.onWrite?.(pgn, body as Record<string, number>)) ?? { status: 'applied' }
        )
      }
      if (method === 'POST' && path === '/device/restore') {
        return json((await options.onRestore?.()) ?? { status: 'claimed', probe: selected().probe })
      }
      throw new Error(`Unexpected ${method} ${path}`)
    },
    [OVERRIDE],
    {},
    options.list ?? LIST
  )
}

const pgnRow = (el: Element, pgn: number): Element => {
  const found = el.querySelector(`[data-pgn="${String(pgn)}"]`)
  if (found === null) {
    throw new Error(`No row for PGN ${String(pgn)}`)
  }
  return found
}

const intervalInput = (row: Element) =>
  row.querySelector<HTMLInputElement>('input[aria-label^="Interval"]')

const prioritySelect = (row: Element) =>
  row.querySelector<HTMLSelectElement>('select[aria-label^="Priority"]')

const setInterval_ = async (row: Element, seconds: string) => {
  const input = intervalInput(row)
  if (input === null) {
    throw new Error('No interval input')
  }
  input.value = seconds
  input.dispatchEvent(new Event('input'))
  await settle()
  button(row, 'Set').click()
  await settle()
}

const open = async () => {
  const el = await mount()
  await settle()
  return el
}

describe('PGN intervals and priorities', () => {
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

  it('lists what the sensor transmits by name, in the NMEA 2000 output section', async () => {
    sensor()
    const el = await open()
    const section = el.querySelector('#network')

    expect(text(pgnRow(el, 128267))).toContain('Water depth')
    expect(text(pgnRow(el, 128267))).toContain('128267')
    expect(section?.contains(pgnRow(el, 65409))).toBe(true)
    expect(intervalInput(pgnRow(el, 128267))).not.toBeNull()
    expect(prioritySelect(pgnRow(el, 128267))).not.toBeNull()
  })

  it('fills each row with the interval and priority measured on the bus, and says so', async () => {
    sensor()
    const el = await open()

    expect(intervalInput(pgnRow(el, 128267))?.value).toBe('1.00')
    expect(prioritySelect(pgnRow(el, 128267))?.value).toBe('3')
    expect(text(pgnRow(el, 128267))).toContain('Measured: every 1.00 s, priority 3')
    expect(text(el.querySelector('#network'))).toContain('measured from what the sensor sends')
  })

  it('says a message the sensor does not send on its own is not sent periodically', async () => {
    sensor()
    const el = await open()

    expect(intervalInput(pgnRow(el, 65409))?.value).toBe('')
    expect(text(pgnRow(el, 65409))).toContain('Measured: not sent periodically')
  })

  it('offers Set only once a value differs from the measured one', async () => {
    sensor()
    const el = await open()
    const row = pgnRow(el, 128267)

    expect(button(row, 'Set').disabled).toBe(true)
    expect(button(row, 'Set priority').disabled).toBe(true)

    const input = intervalInput(row)
    if (input === null) {
      throw new Error('No interval input')
    }
    input.value = '0.5'
    input.dispatchEvent(new Event('input'))
    await settle()

    expect(button(row, 'Set').disabled).toBe(false)
  })

  it('measures again after a write, and the row follows the new measurement', async () => {
    let lists = 0
    serve(
      selected(),
      (path, init) => {
        const method = init?.method ?? 'GET'
        if (method === 'GET' && path === '/pgns') {
          lists += 1
          return json({
            status: 'answered',
            pgns: [
              {
                pgn: 128267,
                minIntervalMs: 50,
                telemetry: false,
                observedIntervalMs: lists === 1 ? 1000 : 500,
                observedPriority: 3
              }
            ]
          } satisfies PgnListResult)
        }
        if (method === 'PUT') {
          return json({ status: 'applied', observedIntervalMs: 500 } satisfies PgnWriteResult)
        }
        return json({ status: 'answered', value: true, readAt: READ_AT } satisfies ReadResult)
      },
      [OVERRIDE],
      {},
      null
    )
    const el = await open()

    await setInterval_(pgnRow(el, 128267), '0.5')
    await settle()

    expect(lists).toBe(2)
    expect(intervalInput(pgnRow(el, 128267))?.value).toBe('0.50')
    expect(text(pgnRow(el, 128267))).toContain('Measured: every 0.50 s')
  })

  it('lists messages sent only on request without controls', async () => {
    sensor()
    const el = await open()

    expect(el.querySelector('[data-pgn="60928"]')).toBeNull()
    expect(text(el.querySelector('#network'))).toMatch(
      /Also sent on request:.*Address claim.*Product information/
    )
  })

  it('warns on a PGN the plugin’s own telemetry reads', async () => {
    sensor()
    const el = await open()

    expect(text(pgnRow(el, 65409))).toContain('The plugin reads this')
    expect(text(pgnRow(el, 128267))).not.toContain('The plugin reads this')
  })

  it('sets an interval typed in seconds, and reports the period it then timed', async () => {
    const sent: Sent[] = []
    let answer: (result: PgnWriteResult) => void = () => undefined
    sensor({
      sent,
      onWrite: () =>
        new Promise((resolve) => {
          answer = resolve
        })
    })
    const el = await open()

    await setInterval_(pgnRow(el, 128267), '0.5')

    expect(sent.filter((s) => s.method === 'PUT')).toEqual([
      { method: 'PUT', path: '/pgns/128267', body: { intervalMs: 500 } }
    ])
    expect(text(pgnRow(el, 128267))).toContain('Timing the sensor’s next frames')

    answer({ status: 'applied', observedIntervalMs: 512 })
    await settle()

    expect(text(pgnRow(el, 128267))).toContain('✓ The sensor now sends it every 0.51 s.')
  })

  it.each([
    ['0.01', 'From 0.05 to 60 s.'],
    ['61', 'From 0.05 to 60 s.'],
    ['often', 'From 0.05 to 60 s.']
  ])('refuses an interval of %s s in the browser', async (typed, words) => {
    const sent: Sent[] = []
    sensor({ sent })
    const el = await open()
    const input = intervalInput(pgnRow(el, 128267))
    if (input === null) {
      throw new Error('No interval input')
    }

    input.value = typed
    input.dispatchEvent(new Event('input'))
    await settle()

    expect(text(pgnRow(el, 128267))).toContain(words)
    expect(input.classList).toContain('is-invalid')
    expect(button(pgnRow(el, 128267), 'Set').disabled).toBe(true)
  })

  it('quotes the stricter minimum for a fast-packet PGN', async () => {
    sensor({
      list: {
        status: 'answered',
        pgns: [
          {
            pgn: 128275,
            minIntervalMs: 100,
            telemetry: false,
            observedIntervalMs: 1000,
            observedPriority: 6
          }
        ]
      }
    })
    const el = await open()
    const input = intervalInput(pgnRow(el, 128275))
    if (input === null) {
      throw new Error('No interval input')
    }

    input.value = '0.05'
    input.dispatchEvent(new Event('input'))
    await settle()

    expect(text(pgnRow(el, 128275))).toContain('From 0.1 to 60 s.')
  })

  it.each([
    [
      { status: 'observedDiffers', requestedIntervalMs: 1000, observedIntervalMs: 2000 },
      'The sensor sends it every 2.00 s, not 1.00 s.'
    ],
    [
      { status: 'unconfirmed', reason: 'sent 1 times' },
      'The sensor didn’t refuse it, but sent it too seldom to time.'
    ],
    [
      {
        status: 'rejected',
        reason: 'Parameter out of range',
        detail: {
          acknowledgedPgn: 128267,
          src: 22,
          ok: false,
          pgnError: 'Acknowledge',
          intervalPriorityError: 'Parameter out of range',
          parameterErrors: [],
          missingParameterCodes: 0
        }
      },
      'The sensor refused it: out of its allowed range.'
    ],
    [{ status: 'notSent', reason: 'Level 1 was refused' }, 'Not sent: Level 1 was refused.']
  ] as [PgnWriteResult, string][])('reports %j in words', async (result, words) => {
    sensor({ onWrite: () => result })
    const el = await open()

    await setInterval_(pgnRow(el, 128267), '1')

    expect(text(pgnRow(el, 128267))).toContain(words)
  })

  it('sets a priority', async () => {
    const sent: Sent[] = []
    sensor({ sent })
    const el = await open()
    const select = prioritySelect(pgnRow(el, 128267))
    if (select === null) {
      throw new Error('No priority select')
    }

    select.value = '2'
    select.dispatchEvent(new Event('change'))
    await settle()
    button(pgnRow(el, 128267), 'Set priority').click()
    await settle()

    expect(sent.filter((s) => s.method === 'PUT')).toEqual([
      { method: 'PUT', path: '/pgns/128267', body: { priority: 2 } }
    ])
    expect(text(pgnRow(el, 128267))).toContain('✓ Priority 2 stored.')
  })

  it('says a shorter interval than the sensor measures at waits for the per-message setting', async () => {
    sensor({ override: false })
    const el = await open()

    expect(text(el.querySelector('#network'))).toContain(
      'The sensor sends no message faster than it measures'
    )
  })

  it('shows each message’s default and the allowed range before anything is typed', async () => {
    sensor()
    const el = await open()

    expect(text(pgnRow(el, 128267))).toContain('Default every 1.00 s, priority 3')
    expect(text(pgnRow(el, 65409))).toContain('Default not sent, priority 7')
    expect(text(pgnRow(el, 128267))).toContain('0.05 to 60 s')
    expect(text(pgnRow(el, 130316))).not.toContain('Default')
  })

  it.each([
    ['Restore default intervals…', 'updateRates'],
    ['Restore default priorities…', 'priorities']
  ])('restores defaults after a confirmation: %s', async (label, option) => {
    const sent: Sent[] = []
    sensor({ sent })
    const el = await open()
    const section = el.querySelector('#network') ?? el
    await setInterval_(pgnRow(el, 128267), '1')

    button(section, label).click()
    await settle()

    expect(text(section)).toContain('The sensor restarts to apply this')
    expect(sent.filter((s) => s.method === 'POST')).toEqual([])

    button(section, 'Restore and restart').click()
    await settle()

    expect(sent.filter((s) => s.method === 'POST')).toEqual([
      { method: 'POST', path: '/device/restore', body: { option } }
    ])
    expect(text(section)).toContain('The sensor claimed its address again')
    // What was set before the restart no longer describes the sensor.
    expect(text(pgnRow(el, 128267))).not.toContain('Stored')
    expect(intervalInput(pgnRow(el, 128267))?.value).toBe('1.00')
  })

  it('keeps a restore’s outcome through the restart it causes', async () => {
    let answer: (result: unknown) => void = () => undefined
    sensor({
      onRestore: () =>
        new Promise((resolve) => {
          answer = resolve
        })
    })
    const el = await open()
    const section = () => el.querySelector('#network') ?? el

    button(section(), 'Restore default intervals…').click()
    await settle()
    button(section(), 'Restore and restart').click()
    await settle()

    // The plugin follows the sensor through its restart: probe gone, then reset.
    FakeEventSource.latest.push({ type: 'device', data: selected({ probe: null }) })
    await settle()
    FakeEventSource.latest.push({
      type: 'reset',
      data: { status: 'claimed', probe }
    })
    FakeEventSource.latest.push({ type: 'device', data: selected() })
    await settle()
    answer({ status: 'claimed', probe })
    await settle()

    expect(text(section())).toContain('The sensor claimed its address again')
  })

  it('says how a restore went while the list is still being read again', async () => {
    let lists = 0
    let answer: () => void = () => undefined
    serve(
      selected(),
      (path, init) => {
        const method = init?.method ?? 'GET'
        if (method === 'GET' && path === '/pgns') {
          lists += 1
          // The first list loads; the one after the restart is still on its way.
          return lists === 1 ? json(LIST) : new Promise<Response>(() => undefined)
        }
        if (method === 'POST') {
          return new Promise<Response>((resolve) => {
            answer = () => {
              resolve(json({ status: 'claimed', probe }))
            }
          })
        }
        return json({ status: 'answered', value: true, readAt: READ_AT } satisfies ReadResult)
      },
      [OVERRIDE],
      {},
      null
    )
    const el = await open()
    const section = () => el.querySelector('#network') ?? el

    button(section(), 'Restore default priorities…').click()
    await settle()
    button(section(), 'Restore and restart').click()
    await settle()
    FakeEventSource.latest.push({ type: 'device', data: selected({ probe: null }) })
    FakeEventSource.latest.push({ type: 'reset', data: { status: 'claimed', probe } })
    FakeEventSource.latest.push({ type: 'device', data: selected() })
    await settle()

    expect(text(section())).toContain('The sensor is restarting')

    answer()
    await settle()

    expect(el.querySelector('[data-pgn]')).toBeNull()
    expect(text(section())).toContain('The sensor claimed its address again')
  })

  it('drops a PGN list that arrives after another sensor was selected', async () => {
    let answerFirst: (list: PgnListResult) => void = () => undefined
    let calls = 0
    serve(
      selected(),
      (path, init) => {
        if ((init?.method ?? 'GET') === 'GET' && path === '/pgns') {
          calls += 1
          return calls === 1
            ? new Promise<Response>((resolve) => {
                answerFirst = (list) => {
                  resolve(json(list))
                }
              })
            : json({ status: 'answered', pgns: [] } satisfies PgnListResult)
        }
        return json({ status: 'answered', value: true, readAt: READ_AT } satisfies ReadResult)
      },
      [OVERRIDE],
      {},
      null
    )
    const el = await open()

    FakeEventSource.latest.push({ type: 'device', data: selected({ selected: OTHER }) })
    await settle()
    answerFirst(LIST)
    await settle()

    expect(el.querySelector('[data-pgn]')).toBeNull()
  })

  it('says why the list could not be read', async () => {
    sensor({ list: { status: 'unknown', reason: 'No answer' } })
    const el = await open()

    expect(text(el.querySelector('#network'))).toContain(
      'The sensor didn’t answer when asked what it transmits.'
    )
  })
})
