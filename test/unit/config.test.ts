import {describe, expect, it} from 'vitest'
import {resolveConfig} from '../../src/config.js'

const CONFIG_PATH = '/repo/monosplice.config.ts'

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
