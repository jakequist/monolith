import {describe, expect, it} from 'vitest'
import {deriveVendorName, insertSubrepoEntry, renderSubrepoEntry} from '../../src/core/vendor.js'

describe('deriveVendorName', () => {
  it('takes the repo basename from every URL form monolith is likely to see', () => {
    expect(deriveVendorName('git@github.com:lodash/lodash.git')).toBe('lodash')
    expect(deriveVendorName('https://github.com/lodash/lodash.git')).toBe('lodash')
    expect(deriveVendorName('https://github.com/lodash/lodash')).toBe('lodash')
    expect(deriveVendorName('ssh://git@github.com:2222/lodash/lodash.git')).toBe('lodash')
    expect(deriveVendorName('file:///srv/mirrors/lodash.git')).toBe('lodash')
    expect(deriveVendorName('/srv/mirrors/lodash.git')).toBe('lodash')
    expect(deriveVendorName('../siblings/lodash')).toBe('lodash')
  })

  it('handles scp syntax with no path, trailing slashes, fragments and whitespace', () => {
    expect(deriveVendorName('git@github.com:lodash.git')).toBe('lodash')
    expect(deriveVendorName('https://github.com/lodash/lodash.git/')).toBe('lodash')
    expect(deriveVendorName('  https://github.com/lodash/lodash.git  ')).toBe('lodash')
    expect(deriveVendorName('https://github.com/lodash/lodash.git#main')).toBe('lodash')
  })

  it('keeps a name that only looks like a suffix, and is case-insensitive about .git', () => {
    expect(deriveVendorName('https://github.com/x/gitignore.git')).toBe('gitignore')
    expect(deriveVendorName('https://github.com/x/lodash.GIT')).toBe('lodash')
    expect(deriveVendorName('https://github.com/x/dot.files.git')).toBe('dot.files')
  })

  it('refuses to guess when there is no usable segment', () => {
    expect(deriveVendorName('')).toBeNull()
    expect(deriveVendorName('/')).toBeNull()
    expect(deriveVendorName('https://github.com/x/.git')).toBeNull()
    expect(deriveVendorName('/srv/mirrors/../.git')).toBeNull()
    expect(deriveVendorName('git@github.com:owner/we ird.git')).toBeNull()
  })
})

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
