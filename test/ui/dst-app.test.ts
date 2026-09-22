import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { HealthResponse } from '../../src/types.js'
import '../../src/ui/main.js'

/**
 * Runtime cover for the webapp.
 *
 * The decorator model is set in src/ui/tsconfig.json and read by both tsc and
 * esbuild; nothing but rendering the component actually proves the decorators
 * work, so these tests exist mainly to make that checkable.
 */

const flush = async () => {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

const mount = async () => {
  const el = document.createElement('dst-app')
  document.body.appendChild(el)
  await flush()
  await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete
  return el
}

const text = (el: Element) => el.shadowRoot?.textContent ?? ''

describe('dst-app', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch')
  })

  const respond = (body: HealthResponse) =>
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }))

  it('renders the device the plugin reports', async () => {
    respond({ running: true, selectedDevice: { manufacturerCode: 135, uniqueNumber: 4242 } })

    const el = await mount()

    expect(text(el)).toContain('running')
    expect(text(el)).toContain('4242')
  })

  it('says so when no device is selected', async () => {
    respond({ running: true, selectedDevice: null })

    const el = await mount()

    expect(text(el)).toContain('No device selected')
  })

  it('reports an unauthorised response rather than rendering an empty console', async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response('', { status: 401, statusText: 'Unauthorized' })
    )

    const el = await mount()

    expect(text(el)).toContain('Cannot reach the plugin')
    expect(text(el)).toContain('401')
  })

  it('offers a retry after a failure, and recovers', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('network down'))
    const el = await mount()
    expect(text(el)).toContain('network down')

    respond({ running: true, selectedDevice: null })
    el.shadowRoot?.querySelector('button')?.click()
    await flush()
    await (el as unknown as { updateComplete: Promise<unknown> }).updateComplete

    expect(text(el)).toContain('No device selected')
  })

  it('aborts an in-flight request when the element is detached', async () => {
    let signal: AbortSignal | undefined
    vi.mocked(fetch).mockImplementation((_input, init) => {
      signal = init?.signal ?? undefined
      return new Promise(() => undefined)
    })

    const el = await mount()
    el.remove()

    expect(signal?.aborted).toBe(true)
  })
})
