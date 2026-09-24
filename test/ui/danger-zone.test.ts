import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { PgnListResult, ResetResult, SettingInfo } from '../../src/types.js'
import '../../src/ui/main.js'
import {
  FakeEventSource,
  OTHER,
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

const PGNS: PgnListResult = {
  status: 'answered',
  pgns: [
    {
      pgn: 128267,
      minIntervalMs: 50,
      telemetry: false,
      observedIntervalMs: 1000,
      observedPriority: 3
    }
  ]
}

interface Sent {
  method: string
  path: string
  body: unknown
}

type Answer = ResetResult | Response | Promise<Response>

/**
 * A sensor whose restart requests answer through `onRestart`. The console's
 * own probe is held open: a real one would ask the sensor, and here it must
 * not pass for a restart.
 */
function sensor(options: { sent?: Sent[]; onRestart?: () => Answer; probes?: string[] } = {}) {
  serve(
    selected(),
    async (path, init) => {
      const method = init?.method ?? 'GET'
      const body: unknown = init?.body === undefined ? undefined : JSON.parse(init.body as string)
      if (method === 'POST' && path === '/device/probe') {
        options.probes?.push(path)
        return new Promise<Response>(() => undefined)
      }
      if (method === 'POST') {
        options.sent?.push({ method, path, body })
        const answer = options.onRestart?.() ?? { status: 'claimed', probe }
        return answer instanceof Promise || answer instanceof Response ? answer : json(answer)
      }
      return json({ status: 'answered', value: 0.35, readAt: READ_AT })
    },
    SETTINGS,
    {},
    PGNS
  )
}

/** A restart request that answers when the test says so. */
function held(): { answer: (result: ResetResult) => void; onRestart: () => Promise<Response> } {
  let resolve: (response: Response) => void = () => undefined
  return {
    answer: (result) => {
      resolve(json(result))
    },
    onRestart: () =>
      new Promise<Response>((r) => {
        resolve = r
      })
  }
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

const askToRestart = async (el: Element) => {
  button(zone(el), 'Restart sensor…').click()
  await settle()
  button(zone(el), 'Restart').click()
  await settle()
}

/** The plugin's side of a restart: the probe goes, then comes back with the claim. */
const restartOnBus = async (outcome: 'claimed' | 'lost') => {
  FakeEventSource.latest.push({ type: 'device', data: selected({ probe: null }) })
  await settle()
  if (outcome === 'claimed') {
    FakeEventSource.latest.push({ type: 'reset', data: { status: 'claimed', probe } })
    FakeEventSource.latest.push({ type: 'device', data: selected() })
    await settle()
  }
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
    expect(text(zone(el))).toContain(
      'Sent. The sensor claimed its address again, as it does after a restart.'
    )
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
    expect(text(zone(el))).toContain(
      'Sent. The sensor claimed its address again, as it does after a restart.'
    )
    expect(text(zone(el))).toContain('read again to show what it now holds')
    // A claim is not proof of a restore, so the console does not say it was restored.
    expect(text(zone(el))).not.toContain('restored')
  })

  it('asks for the word again after Cancel', async () => {
    sensor()
    const el = await open()

    button(zone(el), 'Restore factory settings…').click()
    await settle()
    await type(confirmation(el), 'RESTORE')
    button(zone(el), 'Cancel').click()
    await settle()
    button(zone(el), 'Restore factory settings…').click()
    await settle()

    expect(confirmation(el).value).toBe('')
    expect(button(zone(el), 'Restore factory settings').disabled).toBe(true)
  })

  it('closes a typed confirmation when another sensor is selected', async () => {
    const sent: Sent[] = []
    sensor({ sent })
    const el = await open()

    button(zone(el), 'Restore factory settings…').click()
    await settle()
    await type(confirmation(el), 'RESTORE')

    // The other sensor was probed before, so its sections render at once.
    FakeEventSource.latest.push({ type: 'device', data: selected({ selected: OTHER }) })
    await settle()

    expect(zone(el).querySelector('input[type="text"]')).toBeNull()
    expect([...zone(el).querySelectorAll('button')].map((b) => b.textContent.trim())).not.toContain(
      'Restore factory settings'
    )
    expect(sent).toEqual([])
  })

  it('points to exporting the settings before a factory restore', async () => {
    sensor()
    const el = await open()

    button(zone(el), 'Restore factory settings…').click()
    await settle()

    expect(zone(el).querySelector('a[href="#snapshots"]')).not.toBeNull()
  })

  it('keeps the outcome while the section is gone for the restart', async () => {
    const restart = held()
    const probes: string[] = []
    sensor({ onRestart: restart.onRestart, probes })
    const el = await open()
    const before = el.querySelector('dst-danger-zone')

    await askToRestart(el)
    await restartOnBus('claimed')

    expect(el.querySelector('dst-danger-zone')).not.toBe(before)
    expect(text(el.querySelector('dst-settings'))).toContain('The sensor is restarting')
    // The plugin probes after the claim; the console must not probe a rebooting sensor.
    expect(probes).toEqual([])

    restart.answer({ status: 'claimed', probe })
    await settle()

    expect(text(zone(el))).toContain(
      'Sent. The sensor claimed its address again, as it does after a restart.'
    )
  })

  it('says the sensor did not come back, although no section is left to say it in', async () => {
    const restart = held()
    sensor({ onRestart: restart.onRestart })
    const el = await open()

    await askToRestart(el)
    await restartOnBus('lost')

    expect(el.querySelector('#danger')).toBeNull()

    restart.answer({ status: 'lost', reason: 'The sensor did not claim an address again' })
    await settle()

    expect(text(el.querySelector('dst-settings'))).toContain(
      'Sent, but the sensor didn’t come back: The sensor did not claim an address again.'
    )
  })

  it('probes the sensor again once a restart it did not come back from is over', async () => {
    const restart = held()
    const probes: string[] = []
    sensor({ onRestart: restart.onRestart, probes })
    const el = await open()

    await askToRestart(el)
    await restartOnBus('lost')
    restart.answer({ status: 'lost', reason: 'The sensor did not claim an address again' })
    FakeEventSource.latest.push({
      type: 'reset',
      data: { status: 'lost', reason: 'The sensor did not claim an address again' }
    })
    await settle()
    // Later it is heard again, still without a probe.
    FakeEventSource.latest.push({ type: 'device', data: selected({ probe: null }) })
    await settle()

    expect(probes).toEqual(['/device/probe'])
    expect(el.querySelector('dst-settings')).not.toBeNull()
  })

  it('keeps each section’s restart outcome in that section', async () => {
    sensor()
    const el = await open()

    await askToRestart(el)

    expect(text(zone(el))).toContain('claimed its address again')
    expect(text(el.querySelector('#network'))).not.toContain('claimed its address')

    button(el.querySelector('#network') ?? el, 'Restore default priorities…').click()
    await settle()
    button(el.querySelector('#network') ?? el, 'Restore and restart').click()
    await settle()

    expect(text(el.querySelector('#network'))).toContain('claimed its address again')
    expect(text(zone(el))).not.toContain('claimed its address')
  })

  it('offers no second restart while one is in flight', async () => {
    const restart = held()
    sensor({ onRestart: restart.onRestart })
    const el = await open()

    button(zone(el), 'Restore factory settings…').click()
    await settle()
    await type(confirmation(el), 'RESTORE')
    button(el.querySelector('#network') ?? el, 'Restore default intervals…').click()
    await settle()
    button(el.querySelector('#network') ?? el, 'Restore and restart').click()
    await settle()

    expect(button(zone(el), 'Restore factory settings').disabled).toBe(true)
    expect(button(zone(el), 'Restart sensor…').disabled).toBe(true)
  })

  it('says the console lost the answer when the request fails after it may have gone out', async () => {
    sensor({ onRestart: () => Promise.reject(new TypeError('Failed to fetch')) })
    const el = await open()

    await askToRestart(el)

    expect(text(zone(el))).not.toContain('Not sent')
    expect(text(zone(el))).toContain('The console lost the answer: Failed to fetch.')
    expect(text(zone(el))).toContain('The sensor may have restarted')
  })

  it.each([
    [
      503,
      'Service Unavailable',
      'The sensor is not on the bus.',
      'Not sent: The sensor is not on the bus.'
    ],
    [400, 'Bad Request', 'Send an option', 'Not sent: Send an option.'],
    [502, 'Bad Gateway', 'Upstream failed', 'The console lost the answer: Upstream failed.']
  ])(
    'reports a %i before or after the send accordingly',
    async (status, statusText, error, words) => {
      sensor({
        onRestart: () =>
          new Response(JSON.stringify({ error }), {
            status,
            statusText,
            headers: { 'Content-Type': 'application/json' }
          })
      })
      const el = await open()

      await askToRestart(el)

      expect(text(zone(el))).toContain(words)
    }
  )

  it.each([
    [{ status: 'notSent', reason: 'Level 1 was refused' }, 'Not sent: Level 1 was refused.'],
    [
      { status: 'lost', reason: 'The sensor did not claim an address again' },
      'Sent, but the sensor didn’t come back: The sensor did not claim an address again.'
    ]
  ] as [ResetResult, string][])('reports %j in words', async (result, words) => {
    sensor({ onRestart: () => result })
    const el = await open()

    await askToRestart(el)

    expect(text(zone(el))).toContain(words)
  })

  it('drops an outcome that answers after another sensor was selected', async () => {
    const restart = held()
    sensor({ onRestart: restart.onRestart })
    const el = await open()

    await askToRestart(el)
    FakeEventSource.latest.push({ type: 'device', data: selected({ selected: OTHER }) })
    await settle()

    expect(text(zone(el))).not.toContain('restarting')

    restart.answer({ status: 'claimed', probe })
    await settle()

    expect(text(zone(el))).not.toContain('claimed its address')
  })

  it('disables every restart control while the sensor is off the bus', async () => {
    sensor()
    const el = await open()

    button(zone(el), 'Restore factory settings…').click()
    await settle()
    await type(confirmation(el), 'RESTORE')
    FakeEventSource.latest.push({
      type: 'device',
      data: selected({ location: { state: 'waiting', address: 22 } })
    })
    await settle()

    expect(button(zone(el), 'Restart sensor…').disabled).toBe(true)
    expect(button(zone(el), 'Restore factory settings').disabled).toBe(true)
  })
})
