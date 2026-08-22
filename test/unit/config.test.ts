import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {afterEach, describe, expect, it} from 'vitest'
import {CONFIG_FILENAMES, MultipleConfigsError, findConfig, resolveConfig} from '../../src/config.js'

const CONFIG_PATH = '/repo/monosplice.config.ts'

const dirs: string[] = []
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'monosplice-config-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, {recursive: true, force: true})
})

// S165: .js is first-class, .cjs is accepted, and two of them at once is an error.
describe('findConfig', () => {
  it('accepts every documented extension', () => {
    expect(CONFIG_FILENAMES).toEqual([
      'monosplice.config.ts',
      'monosplice.config.mts',
      'monosplice.config.js',
      'monosplice.config.mjs',
      'monosplice.config.cjs',
    ])
    for (const name of CONFIG_FILENAMES) {
      const dir = tempDir()
      fs.writeFileSync(path.join(dir, name), 'export default {subrepos: []}\n')
      expect(findConfig(dir)).toBe(path.join(dir, name))
    }
  })

  it('walks up and returns null when there is nothing to find', () => {
    const dir = tempDir()
    fs.mkdirSync(path.join(dir, 'a/b'), {recursive: true})
    fs.writeFileSync(path.join(dir, 'monosplice.config.js'), 'export default {subrepos: []}\n')
    expect(findConfig(path.join(dir, 'a/b'))).toBe(path.join(dir, 'monosplice.config.js'))
    expect(findConfig(tempDir())).toBeNull()
  })

  it('refuses to guess when one directory holds two config files, naming both', () => {
    const dir = tempDir()
    fs.writeFileSync(path.join(dir, 'monosplice.config.js'), 'export default {subrepos: []}\n')
    fs.writeFileSync(path.join(dir, 'monosplice.config.ts'), 'export default {subrepos: []}\n')

    let thrown: unknown
    try {
      findConfig(dir)
    } catch (err) {
      thrown = err
    }
    expect(thrown).toBeInstanceOf(MultipleConfigsError)
    const message = (thrown as Error).message
    expect(message).toContain(path.join(dir, 'monosplice.config.js'))
    expect(message).toContain(path.join(dir, 'monosplice.config.ts'))
    expect(message).toMatch(/delete/i)
  })
})

describe('resolveConfig', () => {
  it('applies defaults (name from path basename, branch main)', () => {
    const [s] = resolveConfig(
      {subrepos: [{path: 'packages/taka-core', remote: 'git@github.com:me/taka-core.git'}]},
      CONFIG_PATH,
    )
    expect(s).toMatchObject({
      name: 'taka-core',
      path: 'packages/taka-core',
      branch: 'main',
      exclude: [],
    })
  })

  it('names the offending field on validation errors', () => {
    expect(() => resolveConfig({subrepos: [{path: 'core'}]}, CONFIG_PATH)).toThrow(/subrepos\.0\.remote/)
    expect(() => resolveConfig({}, CONFIG_PATH)).toThrow(/subrepos/)
    expect(() => resolveConfig({subrepos: [{path: '', remote: 'x'}]}, CONFIG_PATH)).toThrow(/path/)
  })

  it('rejects duplicates and nested subrepo paths', () => {
    const dup = {subrepos: [
      {path: 'core', remote: 'a'},
      {path: 'core', remote: 'b'},
    ]}
    expect(() => resolveConfig(dup, CONFIG_PATH)).toThrow(/duplicate/)

    const nested = {subrepos: [
      {path: 'core', remote: 'a'},
      {path: 'core/sub', remote: 'b'},
    ]}
    expect(() => resolveConfig(nested, CONFIG_PATH)).toThrow(/nest/)
  })
})
