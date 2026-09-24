import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { ResetResult, SettingInfo } from '../../src/types.js'
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

interface Sent {
  method: string
  path: string
  body: unknown
}

/** A sensor whose restart requests answer through `onRestart`. */
function sensor(
  options: { sent?: Sent[]; onRestart?: () => ResetResult | Promise<Response> } = {}
) {
  serve(
    selected(),
    async (path, init) => {
      const method = init?.method ?? 'GET'
      const body: unknown = init?.body === undefined ? undefined : JSON.parse(init.body as string)
      if (method === 'POST') {
        options.sent?.push({ method, path, body })
        const answer = options.onRestart?.() ?? { status: 'claimed', probe }
        return answer instanceof Promise ? answer : json(answer)
      }
      return json({ status: 'answered', value: 0.35, readAt: READ_AT })
    },
    SETTINGS
  )
}

const zone = (el: Element): Element => {
  const found = el.querySelector('#danger')
  if (found === null) {
    throw new Error('No danger zone')
  }
  return found
}

const confirmation = (el: Element): HTMLInputElement => {
  const input = zone(el).querySelector<HTMLInputElement>('input[type="text"]')
  if (input === null) {
    throw new Error('No confirmation input')
  }
  return input
}

const type = async (input: HTMLInputElement, value: string) => {
  input.value = value
  input.dispatchEvent(new Event('input'))
  await settle()
}

const open = async () => {
  const el = await mount()
  await settle()
  return el
}

describe('danger zone', () => {
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

  it('is the last section, and listed in the header menu', async () => {
    sensor()
    const el = await open()

    const sections = [...el.querySelectorAll('section[id]')].map((s) => s.id)
    expect(sections.at(-1)).toBe('danger')
    expect(el.querySelector('dst-sensor-header a[href="#danger"]')).not.toBeNull()
  })

  it('restarts the sensor after a confirmation that says what is kept and what ends', async () => {
    const sent: Sent[] = []
    sensor({ sent })
    const el = await open()

    button(zone(el), 'Restart sensor…').click()
    await settle()

    expect(text(zone(el))).toContain('Stored settings are kept')
    expect(text(zone(el))).toContain('Level 1 access and simulate mode end')
    expect(sent).toEqual([])

    button(zone(el), 'Restart').click()
    await settle()

    expect(sent).toEqual([{ method: 'POST', path: '/device/reset', body: undefined }])
    expect(text(zone(el))).toContain('✓ The sensor restarted.')
  })

  it('restores factory settings only once the confirmation is typed exactly', async () => {
    const sent: Sent[] = []
    sensor({ sent })
    const el = await open()

    button(zone(el), 'Restore factory settings…').click()
    await settle()

    expect(text(zone(el))).toContain('including the speed calibration curve')
    const restore = () => button(zone(el), 'Restore factory settings')
    expect(restore().disabled).toBe(true)

    await type(confirmation(el), 'restore')
    expect(restore().disabled).toBe(true)
    await type(confirmation(el), 'RESTORE ')
    expect(restore().disabled).toBe(true)

    await type(confirmation(el), 'RESTORE')
    expect(restore().disabled).toBe(false)
    restore().click()
    await settle()

    expect(sent).toEqual([{ method: 'POST', path: '/device/restore', body: { option: 'all' } }])
    expect(text(zone(el))).toContain('✓ Factory settings restored. The sensor restarted.')
  })

  it('points to exporting the settings before a factory restore', async () => {
    sensor()
    const el = await open()

    button(zone(el), 'Restore factory settings…').click()
    await settle()

    expect(zone(el).querySelector('a[href="#snapshots"]')).not.toBeNull()
  })

  it('keeps the outcome through the restart it causes', async () => {
    let answer: () => void = () => undefined
    sensor({
      onRestart: () =>
        new Promise<Response>((resolve) => {
          answer = () => {
            resolve(json({ status: 'claimed', probe }))
          }
        })
    })
    const el = await open()

    button(zone(el), 'Restart sensor…').click()
    await settle()
    button(zone(el), 'Restart').click()
    await settle()

    FakeEventSource.latest.push({ type: 'device', data: selected({ probe: null }) })
    FakeEventSource.latest.push({ type: 'reset', data: { status: 'claimed', probe } })
    FakeEventSource.latest.push({ type: 'device', data: selected() })
    await settle()

    expect(text(zone(el))).toContain('The sensor is restarting')

    answer()
    await settle()

    expect(text(zone(el))).toContain('✓ The sensor restarted.')
  })

  it.each([
    [{ status: 'notSent', reason: 'Level 1 was refused' }, 'Not sent: Level 1 was refused.'],
    [
      { status: 'lost', reason: 'The sensor did not claim an address again' },
      'Sent, but the sensor didn’t come back: The sensor did not claim an address again.'
    ]
  ] as [ResetResult, string][])('reports %j in words', async (result, words) => {
    sensor({ onRestart: () => result })
    const el = await open()

    button(zone(el), 'Restart sensor…').click()
    await settle()
    button(zone(el), 'Restart').click()
    await settle()

    expect(text(zone(el))).toContain(words)
  })

  it('disables both actions while the sensor is off the bus', async () => {
    sensor()
    const el = await open()

    FakeEventSource.latest.push({
      type: 'device',
      data: selected({ location: { state: 'waiting', address: 22 } })
    })
    await settle()

    expect(button(zone(el), 'Restart sensor…').disabled).toBe(true)
    expect(button(zone(el), 'Restore factory settings…').disabled).toBe(true)
  })
})
