import {describe, expect, it} from 'vitest'
import {releaseAssetUrl, versionFromTag} from '../../src/core/release.js'

describe('versionFromTag', () => {
  it('strips a leading v', () => {
    expect(versionFromTag('v1.2.3')).toBe('1.2.3')
  })

  it('accepts a tag that is already a bare version', () => {
    expect(versionFromTag('0.1.0')).toBe('0.1.0')
  })

  it('keeps prerelease and build metadata intact', () => {
    expect(versionFromTag('v1.0.0-rc.1')).toBe('1.0.0-rc.1')
    expect(versionFromTag('v1.0.0+build.5')).toBe('1.0.0+build.5')
  })

  it('only strips the first v', () => {
    expect(versionFromTag('vv1.0.0')).toBe('v1.0.0')
  })

  it('ignores surrounding whitespace', () => {
    expect(versionFromTag('  v1.2.3\n')).toBe('1.2.3')
  })

  it('rejects tags with nothing left after the v', () => {
    expect(() => versionFromTag('')).toThrow()
    expect(() => versionFromTag('   ')).toThrow()
    expect(() => versionFromTag('v')).toThrow()
  })
})

describe('releaseAssetUrl', () => {
  it('points at the versioned asset of that version’s release', () => {
    expect(releaseAssetUrl('1.2.3')).toBe(
      'https://github.com/jakequist/monosplice/releases/download/v1.2.3/monosplice-1.2.3.tgz',
    )
  })
})
