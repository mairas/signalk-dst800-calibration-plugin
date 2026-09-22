import { describe, it, expect, beforeAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { PLUGIN_ID } from '../src/index.js'

/**
 * What the published tarball contains.
 *
 * Separate from the unit suite because it builds: `npm test` stays hermetic
 * and side-effect free, and this runs on Linux only, in its own CI job.
 */

interface PackResult {
  files: { path: string }[]
}

interface PackageManifest {
  name: string
  version: string
  files: string[]
  signalk?: { screenshots?: string[]; appIcon?: string }
}

const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as PackageManifest
let paths: string[]

beforeAll(() => {
  execFileSync('npm', ['run', 'build'], { stdio: 'ignore' })
  execFileSync('npm', ['run', 'build:ui'], { stdio: 'ignore' })
  // --ignore-scripts: the prepare script would otherwise run again here and
  // print Vite's build log onto stdout, ahead of the JSON. It is also what the
  // shared Signal K CI passes, so both see the same tarball.
  paths = (
    JSON.parse(
      execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
        encoding: 'utf8'
      })
    ) as PackResult[]
  )[0].files.map((f) => f.path)
}, 180_000)

describe('published package contents', () => {
  it('is published under the plugin id', () => {
    expect(manifest.name).toBe(PLUGIN_ID)
  })

  it('keeps VERSION and package.json in step', () => {
    // publish-npm.yml refuses to publish when these disagree.
    expect(readFileSync('VERSION', 'utf8').trim()).toBe(manifest.version)
  })

  it('ships the built plugin and webapp', () => {
    expect(paths).toContain('dist/index.js')
    expect(paths).toContain('public/index.html')
  })

  it('does not ship sources or offline analysis tools', () => {
    expect(paths.filter((p) => p.startsWith('src/'))).toEqual([])
    expect(paths.filter((p) => p.startsWith('tools/'))).toEqual([])
  })

  it('does not ship test scaffolding', () => {
    // Keyed on the compiled path, not the source prefix: a helper under src/
    // would be emitted into dist/ and walk straight past a src/ check.
    expect(paths.filter((p) => p.includes('/test/') || p.startsWith('test/'))).toEqual([])
  })

  it('names nothing in files that the tarball does not contain', () => {
    // npm drops a files entry that matches nothing, without warning.
    for (const entry of manifest.files) {
      expect(paths.some((p) => p === entry || p.startsWith(`${entry}/`))).toBe(true)
    }
  })

  it('ships every screenshot and icon its Signal K metadata names', () => {
    const declared = [...(manifest.signalk?.screenshots ?? [])]
    if (manifest.signalk?.appIcon !== undefined) {
      declared.push(manifest.signalk.appIcon)
    }
    for (const asset of declared) {
      expect(paths).toContain(asset.replace(/^\.\//, ''))
    }
  })
})
