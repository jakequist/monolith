import {describe, expect, it} from 'vitest'
import type {ResolvedSubrepo} from '../../src/config.js'
import {checkFreeSlot, insertSubrepoEntry, renderSubrepoEntry} from '../../src/core/vendor.js'

describe('renderSubrepoEntry', () => {
  it('omits name and branch when they equal what the loader would default to', () => {
    expect(
      renderSubrepoEntry({name: 'lodash', path: 'vendor/lodash', remote: 'git@github.com:lodash/lodash.git', branch: 'main'}),
    ).toBe(`{ path: 'vendor/lodash', remote: 'git@github.com:lodash/lodash.git' }`)
  })

  it('writes name and branch when they differ from the defaults', () => {
    expect(
      renderSubrepoEntry({name: 'ld', path: 'third_party/lodash', remote: 'u', branch: '4.17-stable'}),
    ).toBe(`{ name: 'ld', path: 'third_party/lodash', remote: 'u', branch: '4.17-stable' }`)
  })

  it('escapes quotes and backslashes so the literal stays valid', () => {
    expect(renderSubrepoEntry({name: 'x', path: 'vendor/x', remote: "a'b\\c", branch: 'main'})).toBe(
      `{ path: 'vendor/x', remote: 'a\\'b\\\\c' }`,
    )
  })
})

describe('insertSubrepoEntry', () => {
  const entry = `{ path: 'vendor/lodash', remote: 'u' }`

  it('inserts at the top of the array, matching the surrounding indentation', () => {
    const source = ['export default {', '  subrepos: [', "    { path: 'core', remote: 'r' },", '  ],', '}', ''].join('\n')
    expect(insertSubrepoEntry(source, entry)).toBe(
      ['export default {', '  subrepos: [', `    ${entry},`, "    { path: 'core', remote: 'r' },", '  ],', '}', ''].join('\n'),
    )
  })

  it('handles an empty array and preserves the trailing newline', () => {
    const source = 'export default {\n  subrepos: [],\n}\n'
    expect(insertSubrepoEntry(source, entry)).toBeNull()
    expect(insertSubrepoEntry('export default {\n  subrepos: [\n  ],\n}\n', entry)).toBe(
      `export default {\n  subrepos: [\n    ${entry},\n  ],\n}\n`,
    )
  })

  it('uses the LAST array opener, so a commented example above the real one loses', () => {
    const source = [
      '// export default {',
      '//   subrepos: [',
      '//   ],',
      '// }',
      'export default {',
      '  subrepos: [',
      '  ],',
      '}',
      '',
    ].join('\n')
    const out = insertSubrepoEntry(source, entry)
    expect(out).not.toBeNull()
    expect(out!.split('\n')[6]).toBe(`    ${entry},`)
  })

  it('refuses any shape that is not a literal array opened on its own line', () => {
    expect(insertSubrepoEntry('const shared = []\nexport default {\n  subrepos: [...shared],\n}\n', entry)).toBeNull()
    expect(insertSubrepoEntry('export default {subrepos: [\n]}\n', entry)).toBeNull()
    expect(insertSubrepoEntry('export default {\n  subrepos: makeSubrepos(),\n}\n', entry)).toBeNull()
    expect(insertSubrepoEntry('export default {\n  packages: [\n  ],\n}\n', entry)).toBeNull()
  })
})

describe('checkFreeSlot', () => {
  const hints = {rename: 'Rename it', relocate: 'Relocate it.'}
  const configured = (over: Partial<ResolvedSubrepo> = {}): ResolvedSubrepo => ({
    name: 'core',
    path: 'core',
    remote: 'git@github.com:you/core.git',
    branch: 'main',
    pushBranch: 'main',
    exclude: [],
    ...over,
  })
  const entry = {name: 'lib', path: 'packages/lib', remote: 'u', branch: 'main'}

  it('accepts a free name and a free path', () => {
    expect(checkFreeSlot([configured()], entry, hints)).toBeNull()
    expect(checkFreeSlot([], entry, hints)).toBeNull()
  })

  it('rejects a name that is taken, naming the subrepo that holds it', () => {
    const problem = checkFreeSlot([configured()], {...entry, name: 'core'}, hints)
    expect(problem).toContain('A subrepo named core is already configured')
    expect(problem).toContain('monosplice pull core')
    expect(problem).toContain('Rename it')
  })

  it('rejects a path that is taken', () => {
    const problem = checkFreeSlot([configured()], {...entry, path: 'core'}, hints)
    expect(problem).toContain('core is already configured as subrepo core')
    expect(problem).toContain('Relocate it.')
  })

  it('rejects paths that nest either way round', () => {
    expect(checkFreeSlot([configured()], {...entry, path: 'core/inner'}, hints)).toMatch(/may not nest/)
    expect(checkFreeSlot([configured({path: 'packages/lib/deep'})], entry, hints)).toMatch(/may not nest/)
  })

  it('does not treat a shared prefix as nesting', () => {
    expect(checkFreeSlot([configured({path: 'core-tools'})], {...entry, path: 'core'}, hints)).toBeNull()
  })
})
