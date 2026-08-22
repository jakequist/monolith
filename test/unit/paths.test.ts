import {describe, expect, it} from 'vitest'
import {makeExcluder, normalizeSubrepoPath} from '../../src/core/paths.js'

describe('makeExcluder', () => {
  it('matches nothing with no patterns', () => {
    const ex = makeExcluder([])
    expect(ex('anything.txt')).toBe(false)
  })

  it('matches globs including dotfiles and nested paths', () => {
    const ex = makeExcluder(['**/INTERNAL.md', 'secrets/**', '.private-*'])
    expect(ex('INTERNAL.md')).toBe(true)
    expect(ex('docs/INTERNAL.md')).toBe(true)
    expect(ex('secrets/key.pem')).toBe(true)
    expect(ex('.private-notes')).toBe(true)
    expect(ex('README.md')).toBe(false)
    expect(ex('src/secrets.ts')).toBe(false)
  })
})

describe('normalizeSubrepoPath', () => {
  it('strips slashes', () => {
    expect(normalizeSubrepoPath('/taka-core/')).toBe('taka-core')
    expect(normalizeSubrepoPath('packages/lib')).toBe('packages/lib')
  })

  it('rejects root and escaping paths', () => {
    expect(() => normalizeSubrepoPath('/')).toThrow()
    expect(() => normalizeSubrepoPath('.')).toThrow()
    expect(() => normalizeSubrepoPath('a/../b')).toThrow()
  })

  // S166: the README quickstart types `attach ./core`, and shell completion produces it.
  it('tolerates a leading ./ and normalizes it away', () => {
    expect(normalizeSubrepoPath('./core')).toBe('core')
    expect(normalizeSubrepoPath('./packages/lib')).toBe('packages/lib')
    expect(normalizeSubrepoPath('./core/')).toBe('core')
    expect(normalizeSubrepoPath('.//core')).toBe('core')
    expect(normalizeSubrepoPath('././core')).toBe('core')
  })

  it('still rejects bare . and .. once the leading ./ is gone', () => {
    expect(() => normalizeSubrepoPath('./')).toThrow()
    expect(() => normalizeSubrepoPath('./.')).toThrow()
    expect(() => normalizeSubrepoPath('./..')).toThrow()
    expect(() => normalizeSubrepoPath('./../core')).toThrow()
    expect(() => normalizeSubrepoPath('./a/./b')).toThrow()
  })
})
