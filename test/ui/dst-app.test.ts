import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { API_BASE, RECONNECT_MS } from '../../src/ui/api.js'
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

      button(el, 'Change sensor').click()
      await settle()
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
      expect(text(el.querySelector('dst-sensor-header h1'))).toContain('DSM150')
    })

    it('asks for a device when none is selected', async () => {
      serve(selected({ selected: null, location: null, access: null }))

      const el = await mount()

      expect(text(el)).toContain('Choose the sensor to configure')
      expect(el.querySelectorAll('dst-device-picker tbody tr')).toHaveLength(2)
      expect(el.querySelector('dst-sensor-header h1')?.textContent).toContain(
        'Airmar DST configuration'
      )
    })
  })

  describe('the selected device', () => {
    it('names the device and where it is on the bus', async () => {
      serve(selected())

      const header = (await mount()).querySelector('dst-sensor-header')

      expect(text(header)).toMatch(/Airmar DST800.*Online.*Address 22.*Serial 0123456/)
    })

    it('says the sensor is offline while it has not been heard, rather than showing it as present', async () => {
      serve(selected({ location: { state: 'waiting', address: 22 }, access: null }))

      const el = await mount()

      expect(text(el)).toContain('Sensor offline')
      expect(text(el)).not.toContain('Address 22')
    })

    it('follows the device as the event stream reports it, without a reload', async () => {
      serve(selected({ location: { state: 'waiting', address: null }, access: null }))
      const el = await mount()

      FakeEventSource.latest.push({ type: 'device', data: selected() })
      await settle()

      expect(text(el)).not.toContain('Sensor offline')
      expect(text(el)).toContain('Address 22')
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

      expect(text(el)).toContain('The sensor refused Level 1 access')
      expect(text(el)).toContain('The console asks again in 10:00')
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

      expect(text(el.querySelector('[role="alert"]'))).toContain('Every device on the network')

      FakeEventSource.latest.push(simulate(false))
      await settle()

      expect(el.querySelector('[role="alert"]')).toBeNull()
    })

    it('turns simulate mode off from the warning, without a confirmation', async () => {
      const bodies: unknown[] = []
      serve(selected(), (path, init) => {
        bodies.push([init?.method, path, JSON.parse(init?.body as string)])
        return json({ status: 'applied', stored: false, readAt: '2026-09-24T09:00:00.000Z' })
      })
      const el = await mount()
      FakeEventSource.latest.push(simulate(true))
      await settle()

      button(el.querySelector('[role="alert"]') ?? el, 'Turn off simulate mode').click()
      await settle()

      expect(bodies).toEqual([['PUT', '/settings/simulateMode', { value: false }]])
    })

    it.each([
      [
        'a refused request',
        () => new Response('', { status: 401, statusText: 'Unauthorized' }),
        'admin login'
      ],
      [
        'an answer other than applied',
        () => json({ status: 'notSent', reason: 'Access Level 1 refused' }),
        'Not sent: Access Level 1 refused'
      ]
    ])('shows %s from Turn off in the warning itself', async (_what, answer, words) => {
      serve(selected(), answer)
      const el = await mount()
      FakeEventSource.latest.push(simulate(true))
      await settle()

      button(el.querySelector('[role="alert"]') ?? el, 'Turn off simulate mode').click()
      await settle()

      expect(text(el.querySelector('[role="alert"]'))).toContain(words)
      expect(text(el)).not.toContain('Could not check what the sensor supports')
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
    it('probes a sensor that is on the bus and has no probe yet, once', async () => {
      const posts: string[] = []
      serve(selected({ probe: null }), (path) => {
        posts.push(path)
        return json(probe)
      })
      const el = await mount()

      expect(posts).toEqual(['/device/probe'])
      expect(text(el)).not.toContain('Checking what the sensor supports')

      FakeEventSource.latest.push({ type: 'device', data: selected({ probe: null }) })
      await settle()

      expect(posts).toHaveLength(1)
    })

    it('probes a sensor selected while another was still being probed', async () => {
      const posts: string[] = []
      let first: (response: Response) => void = () => undefined
      serve(selected({ probe: null }), (path, init) => {
        if (init?.method === 'PUT') {
          return json(
            selected({ selected: OTHER, location: { state: 'present', address: 35 }, probe: null })
          )
        }
        posts.push(path)
        return posts.length === 1
          ? new Promise((resolve) => {
              first = resolve
            })
          : json(probe)
      })
      const el = await mount()

      button(el, 'Change sensor').click()
      await settle()
      button(el.querySelectorAll('dst-device-picker tbody tr')[1], 'Select').click()
      await settle()
      first(json(probe))
      await settle()

      expect(posts).toHaveLength(2)
    })

    it('probes again after the plugin restarted under an open console', async () => {
      const posts: string[] = []
      serve(selected({ probe: null }), (path) => {
        posts.push(path)
        return json(probe)
      })
      await mount()
      const first = FakeEventSource.latest
      first.onopen?.()
      expect(posts).toHaveLength(1)

      // The plugin restarts: the stream drops, reopens, and the probe is gone.
      first.onerror?.()
      await vi.advanceTimersByTimeAsync(RECONNECT_MS)
      FakeEventSource.latest.onopen?.()
      FakeEventSource.latest.push({ type: 'device', data: selected({ probe: null }) })
      await settle()

      expect(posts).toEqual(['/device/probe', '/device/probe'])
    })

    it('waits until the sensor is heard before probing it', async () => {
      const posts: string[] = []
      serve(
        selected({ probe: null, location: { state: 'waiting', address: 22 }, access: null }),
        (path) => {
          posts.push(path)
          return json(probe)
        }
      )
      await mount()

      expect(posts).toEqual([])

      FakeEventSource.latest.push({ type: 'device', data: selected({ probe: null }) })
      await settle()

      expect(posts).toEqual(['/device/probe'])
    })

    it('does not keep probing after the server refused the first one', async () => {
      const posts: string[] = []
      serve(selected({ probe: null }), (path) => {
        posts.push(path)
        return new Response('', { status: 401, statusText: 'Unauthorized' })
      })
      const el = await mount()

      FakeEventSource.latest.push({ type: 'device', data: selected({ probe: null }) })
      await settle()

      expect(posts).toHaveLength(1)
      expect(text(el)).toContain('admin login')
    })

    it('offers to try a failed probe again', async () => {
      let refuse = true
      const posts: string[] = []
      serve(selected({ probe: null }), (path) => {
        posts.push(path)
        return refuse
          ? json({ error: 'The device has not been heard at its address' }, 503)
          : json(probe)
      })
      const el = await mount()

      expect(text(el)).toContain('Could not check what the sensor supports')

      refuse = false
      button(el, 'Try again').click()
      await settle()

      expect(posts).toHaveLength(2)
      expect(text(el)).not.toContain('Could not check what the sensor supports')
    })

    it('drops a probe result that returns after another sensor was selected', async () => {
      let answer: (response: Response) => void = () => undefined
      serve(
        selected({ probe: null }),
        () =>
          new Promise((resolve) => {
            answer = resolve
          })
      )
      const el = await mount()

      FakeEventSource.latest.push({
        type: 'device',
        data: selected({
          selected: OTHER,
          location: { state: 'waiting', address: 35 },
          access: null,
          probe: null
        })
      })
      answer(json(probe))
      await settle()

      expect(text(el)).toContain('Checking what the sensor supports')
    })

    it('shows the plugin’s reason when a probe cannot run', async () => {
      serve(selected({ probe: null }), () =>
        json({ error: 'The device has not been heard at its address' }, 503)
      )
      const el = await mount()

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
      vi.mocked(fetch).mockImplementation((input, init) => {
        if ((input as string).startsWith(API_BASE)) {
          signal = init?.signal ?? undefined
        }
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
