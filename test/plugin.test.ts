import { describe, it, expect, beforeAll } from 'vitest'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import plugin, { PLUGIN_ID } from '../src/index.js'
import { createMockServerAPI } from '../src/test/MockServerAPI.js'

interface PackedFile {
  path: string
}

interface PackResult {
  files: PackedFile[]
}

interface PackageManifest {
  name: string
  version: string
  signalk?: { screenshots?: string[]; appIcon?: string }
}

describe('plugin lifecycle', () => {
  it('exposes the Signal K plugin interface', () => {
    const app = createMockServerAPI()
    const p = plugin(app as never)

    expect(p.id).toBe(PLUGIN_ID)
    expect(p.name).toBeTruthy()
    expect(p.description).toBeTruthy()
    expect(typeof p.start).toBe('function')
    expect(typeof p.stop).toBe('function')
  })

  it('leaves no listeners registered after start then stop', () => {
    const app = createMockServerAPI()
    const p = plugin(app as never)

    p.start({}, () => undefined)
    void p.stop()

    expect(app.listenerCount()).toBe(0)
  })

  it('reports its status to the server on start and stop', () => {
    const app = createMockServerAPI()
    const p = plugin(app as never)

    p.start({}, () => undefined)
    void p.stop()

    expect(app.statuses).toEqual(['Started', 'Stopped'])
    expect(app.errors).toEqual([])
  })

  it('returns a usable schema before it has ever been configured', () => {
    const app = createMockServerAPI()
    const p = plugin(app as never)

    const { schema } = p
    const resolved: unknown = typeof schema === 'function' ? schema() : schema

    expect(resolved).toBeTypeOf('object')
    expect((resolved as { type: string }).type).toBe('object')
  })
})

describe('published package contents', () => {
  const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as PackageManifest
  let paths: string[]

  // The tarball only contains build output once the build has run, so this
  // check builds rather than depending on the order commands happen to run in.
  //
  // execSync rather than execFileSync: on Windows npm is npm.cmd, which
  // execFileSync cannot resolve without a shell, and Node refuses to spawn a
  // .cmd through one since the CVE-2024-27980 fix. These commands are
  // literals, so a shell adds no injection surface.
  const npm = (command: string, capture: boolean) =>
    execSync(`npm ${command}`, {
      stdio: capture ? 'pipe' : 'ignore',
      encoding: 'utf8'
    })

  beforeAll(() => {
    npm('run build', false)
    npm('run build:ui', false)
    paths = (JSON.parse(npm('pack --dry-run --json', true)) as PackResult[])[0].files.map(
      (f) => f.path
    )
  }, 180_000)

  it('is published under the new package name', () => {
    expect(manifest.name).toBe(PLUGIN_ID)
  })

  it('keeps VERSION and package.json in step', () => {
    // publish-npm.yml refuses to publish when these disagree, so a drift
    // here fails the release rather than this test.
    expect(readFileSync('VERSION', 'utf8').trim()).toBe(manifest.version)
  })

  it('ships the built plugin and webapp', () => {
    expect(paths.some((p) => p.startsWith('dist/'))).toBe(true)
    expect(paths.some((p) => p.startsWith('public/'))).toBe(true)
  })

  it('does not ship sources or offline analysis tools', () => {
    expect(paths.some((p) => p.startsWith('src/'))).toBe(false)
    expect(paths.some((p) => p.startsWith('tools/'))).toBe(false)
  })

  it('ships every screenshot and icon its Signal K metadata names', () => {
    for (const shot of manifest.signalk?.screenshots ?? []) {
      expect(paths).toContain(shot.replace(/^\.\//, ''))
    }
    if (manifest.signalk?.appIcon !== undefined) {
      expect(paths).toContain(manifest.signalk.appIcon.replace(/^\.\//, ''))
    }
  })
})
