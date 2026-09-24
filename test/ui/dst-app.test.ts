import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { RECONNECT_MS } from '../../src/ui/api.js'
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
import type { ServerEvent } from '../../src/types.js'

describe('dst-app', () => {
  beforeEach(() => {
    vi.useFakeTimers()
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

  describe('choosing a device', () => {
    it('lists every candidate with its model and serial, and marks the selected one', async () => {
      serve(selected())

      const el = await mount()
      const rows = [...el.querySelectorAll('dst-device-picker tbody tr')]

      expect(rows.map(text)).toEqual([
        expect.stringContaining('DST800'),
        expect.stringContaining('DSM150')
      ])
      expect(text(rows[0])).toContain('0123456')
      expect(rows[0].getAttribute('aria-current')).toBe('true')
      expect(rows[1].getAttribute('aria-current')).toBeNull()
    })

    it('saves a selection with the plugin and shows the device it now follows', async () => {
      const bodies: unknown[] = []
      serve(selected({ selected: null, location: null, access: null }), (path, init) => {
        bodies.push([init?.method, path, JSON.parse(init?.body as string)])
        return json(selected({ selected: OTHER, location: { state: 'present', address: 35 } }))
      })
      const el = await mount()

      button(el.querySelectorAll('dst-device-picker tbody tr')[1], 'Select').click()
      await settle()

      expect(bodies).toEqual([['PUT', '/device', { device: OTHER }]])
      expect(text(el.querySelector('dst-device-status'))).toContain('DSM150')
    })

    it('asks for a device when none is selected', async () => {
      serve(selected({ selected: null, location: null, access: null }))

      const el = await mount()

      expect(text(el)).toContain('Choose the sensor to configure')
      expect(el.querySelector('dst-device-status')).toBeNull()
    })
  })

  describe('the selected device', () => {
    it('names the device and where it is on the bus', async () => {
      serve(selected())

      const status = (await mount()).querySelector('dst-device-status')

      expect(text(status)).toMatch(/Airmar DST800.*0123456.*address 22/)
    })

    it('says it is waiting while the device has not been heard, rather than showing it as present', async () => {
      serve(selected({ location: { state: 'waiting', address: 22 }, access: null }))

      const el = await mount()

      expect(text(el)).toContain('Waiting for the device')
      expect(text(el)).not.toContain('address 22')
    })

    it('follows the device as the event stream reports it, without a reload', async () => {
      serve(selected({ location: { state: 'waiting', address: null }, access: null }))
      const el = await mount()

      FakeEventSource.latest.push({ type: 'device', data: selected() })
      await settle()

      expect(text(el)).not.toContain('Waiting for the device')
      expect(text(el)).toContain('address 22')
    })
  })

  describe('access level', () => {
    it('counts the remaining validity down', async () => {
      serve(selected({ access: { state: 'granted', expiresInMs: 14 * 60_000 + 5_000 } }))
      const el = await mount()

      expect(text(el)).toContain('Level 1 unlocked, 14:05 left')

      await vi.advanceTimersByTimeAsync(2_000)

      expect(text(el)).toContain('14:03 left')
    })

    it('reads as locked once the grant has run out', async () => {
      serve(selected({ access: { state: 'granted', expiresInMs: 1_000 } }))
      const el = await mount()

      await vi.advanceTimersByTimeAsync(2_000)

      expect(text(el)).toContain('Level 1 locked')
    })

    it('says when the plugin will ask again after the device refused', async () => {
      serve(selected({ access: { state: 'unavailable', retryInMs: 10 * 60_000 } }))

      const el = await mount()

      expect(text(el)).toContain('Level 1 refused by the device, asking again in 10:00')
    })
  })

  describe('simulate mode', () => {
    const simulate = (value: boolean): ServerEvent => ({
      type: 'setting',
      data: {
        id: 'simulateMode',
        qualifier: null,
        operation: 'read',
        result: { status: 'answered', value, readAt: '2026-09-24T09:00:00.000Z' }
      }
    })

    it('warns that every consumer on the bus receives simulated data while the sensor simulates', async () => {
      serve(selected())
      const el = await mount()

      expect(el.querySelector('[role="alert"]')).toBeNull()

      FakeEventSource.latest.push(simulate(true))
      await settle()

      expect(text(el.querySelector('[role="alert"]'))).toContain(
        'every device on the NMEA 2000 bus'
      )

      FakeEventSource.latest.push(simulate(false))
      await settle()

      expect(el.querySelector('[role="alert"]')).toBeNull()
    })

    it('forgets what it knew about simulate mode when another device is selected', async () => {
      serve(selected())
      const el = await mount()
      FakeEventSource.latest.push(simulate(true))
      await settle()

      FakeEventSource.latest.push({ type: 'device', data: selected({ selected: OTHER }) })
      await settle()

      expect(el.querySelector('[role="alert"]')).toBeNull()
    })
  })

  describe('probing', () => {
    it('probes on request and shows what the device answered', async () => {
      const requests: unknown[] = []
      serve(selected(), (path, init) => {
        requests.push([init?.method, path])
        return json(probe)
      })
      const el = await mount()

      button(el, 'Probe').click()
      await settle()

      expect(requests).toEqual([['POST', '/device/probe']])
      expect(text(el)).toContain('1 of 2 capabilities answered')
    })

    it('drops a probe result that returns after another sensor was selected', async () => {
      let answer: (response: Response) => void = () => undefined
      serve(
        selected(),
        () =>
          new Promise((resolve) => {
            answer = resolve
          })
      )
      const el = await mount()
      button(el, 'Probe').click()
      await settle()

      FakeEventSource.latest.push({
        type: 'device',
        data: selected({ selected: OTHER, location: { state: 'present', address: 35 } })
      })
      answer(json(probe))
      await settle()

      expect(text(el)).not.toContain('capabilities answered')
      expect(text(el)).toContain('Not probed yet')
    })

    it('shows the plugin’s reason when a probe cannot run', async () => {
      serve(selected(), () => json({ error: 'The device has not been heard at its address' }, 503))
      const el = await mount()

      button(el, 'Probe').click()
      await settle()

      expect(text(el)).toContain('The device has not been heard at its address')
    })
  })

  describe('connection', () => {
    it('explains a login the server refuses, rather than rendering an empty console', async () => {
      vi.mocked(fetch).mockResolvedValue(
        new Response('', { status: 401, statusText: 'Unauthorized' })
      )

      const el = await mount()

      expect(text(el)).toContain('admin login')
      expect(FakeEventSource.instances).toHaveLength(0)
    })

    it('offers a retry after a failure, and recovers', async () => {
      vi.mocked(fetch).mockRejectedValue(new Error('network down'))
      const el = await mount()
      expect(text(el)).toContain('network down')

      serve(selected())
      button(el, 'Retry').click()
      await settle()

      expect(text(el)).toContain('DST800')
    })

    it('opens the event stream again after it fails', async () => {
      serve(selected())
      await mount()
      const first = FakeEventSource.latest

      first.onerror?.()
      await vi.advanceTimersByTimeAsync(RECONNECT_MS)

      expect(first.closed).toBe(true)
      expect(FakeEventSource.instances).toHaveLength(2)
    })

    it('stops loading and closes the event stream when the console is removed', async () => {
      let signal: AbortSignal | undefined
      vi.mocked(fetch).mockImplementation((_input, init) => {
        signal = init?.signal ?? undefined
        return new Promise(() => undefined)
      })
      const loading = await mount()
      loading.remove()

      serve(selected())
      const loaded = await mount()
      loaded.remove()

      expect(signal?.aborted).toBe(true)
      expect(FakeEventSource.latest.closed).toBe(true)
    })
  })
})
