import {describe, expect, it} from 'vitest'
import {resolveConfig} from '../../src/config.js'
import {renderSubrepoEntry} from '../../src/core/vendor.js'

const CONFIG_PATH = '/repo/monosplice.config.ts'

describe('resolveConfig: triangular fields', () => {
  it('defaults pushBranch to branch and leaves upstream undefined', () => {
    const [plain] = resolveConfig({subrepos: [{path: 'core', remote: 'fork'}]}, CONFIG_PATH)
    expect(plain).toMatchObject({branch: 'main', pushBranch: 'main'})
    expect(plain?.upstream).toBeUndefined()

    const [tri] = resolveConfig(
      {subrepos: [{path: 'vendor/lodash', remote: 'fork', upstream: 'upstream', branch: '4.x'}]},
      CONFIG_PATH,
    )
    expect(tri).toMatchObject({upstream: 'upstream', branch: '4.x', pushBranch: '4.x'})
  })

  it('keeps an explicit pushBranch', () => {
    const [s] = resolveConfig(
      {subrepos: [{path: 'vendor/lodash', remote: 'fork', upstream: 'up', pushBranch: 'patches'}]},
      CONFIG_PATH,
    )
    expect(s).toMatchObject({branch: 'main', pushBranch: 'patches'})
  })

  it('rejects pushBranch without upstream', () => {
    expect(() =>
      resolveConfig({subrepos: [{path: 'core', remote: 'fork', pushBranch: 'patches'}]}, CONFIG_PATH),
    ).toThrow(/pushBranch requires upstream/)
  })

  it('rejects an upstream equal to remote', () => {
    expect(() =>
      resolveConfig({subrepos: [{path: 'core', remote: 'same', upstream: 'same'}]}, CONFIG_PATH),
    ).toThrow(/upstream/)
  })

  it('rejects an empty upstream', () => {
    expect(() =>
      resolveConfig({subrepos: [{path: 'core', remote: 'fork', upstream: ''}]}, CONFIG_PATH),
    ).toThrow(/upstream/)
  })
})

describe('renderSubrepoEntry: triangular fields', () => {
  it('renders upstream and omits a default pushBranch', () => {
    expect(
      renderSubrepoEntry({
        name: 'lodash',
        path: 'vendor/lodash',
        remote: 'git@github.com:me/lodash.git',
        branch: 'main',
        upstream: 'git@github.com:lodash/lodash.git',
        pushBranch: 'main',
      }),
    ).toBe(
      "{ path: 'vendor/lodash', remote: 'git@github.com:me/lodash.git', upstream: 'git@github.com:lodash/lodash.git' }",
    )
  })

  it('renders a non-default pushBranch', () => {
    expect(
      renderSubrepoEntry({
        name: 'lodash',
        path: 'vendor/lodash',
        remote: 'fork',
        branch: '4.x',
        upstream: 'up',
        pushBranch: 'patches',
      }),
    ).toBe("{ path: 'vendor/lodash', remote: 'fork', branch: '4.x', upstream: 'up', pushBranch: 'patches' }")
  })

  it('is unchanged for a plain subrepo', () => {
    expect(renderSubrepoEntry({name: 'lodash', path: 'vendor/lodash', remote: 'up', branch: 'main'})).toBe(
      "{ path: 'vendor/lodash', remote: 'up' }",
    )
  })
})
