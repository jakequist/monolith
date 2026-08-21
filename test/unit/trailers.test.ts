import {describe, expect, it} from 'vitest'
import {appendTrailer, getTrailer, ORIGIN_TRAILER, SOURCE_TRAILER} from '../../src/core/trailers.js'

describe('trailers', () => {
  it('appends a trailer as a new block after a plain message', () => {
    expect(appendTrailer('feat: add thing', SOURCE_TRAILER, 'abc123')).toBe(
      'feat: add thing\n\nMonosplice-Source: abc123\n',
    )
  })

  it('appends into an existing trailer block', () => {
    const msg = 'feat: add thing\n\nLonger body here.\n\nSigned-off-by: Someone <s@x.y>\n'
    const out = appendTrailer(msg, ORIGIN_TRAILER, 'def456')
    expect(out).toBe(
      'feat: add thing\n\nLonger body here.\n\nSigned-off-by: Someone <s@x.y>\nMonosplice-Origin: def456\n',
    )
  })

  it('round-trips: getTrailer reads what appendTrailer wrote', () => {
    const out = appendTrailer('fix: bug\n\nBody paragraph.', SOURCE_TRAILER, 'cafe01')
    expect(getTrailer(out, SOURCE_TRAILER)).toBe('cafe01')
    expect(getTrailer(out, ORIGIN_TRAILER)).toBeUndefined()
  })

  it('does not read a subject line as a trailer', () => {
    expect(getTrailer('Monosplice-Source: not-really', SOURCE_TRAILER)).toBeUndefined()
  })

  it('only reads the final block', () => {
    const msg = 'subj\n\nMonosplice-Source: old\n\nActual final paragraph of prose.'
    expect(getTrailer(msg, SOURCE_TRAILER)).toBeUndefined()
  })

  it('handles multi-trailer final blocks', () => {
    const msg = 'subj\n\nMonosplice-Source: aaa\nMonosplice-Origin: bbb\n'
    expect(getTrailer(msg, SOURCE_TRAILER)).toBe('aaa')
    expect(getTrailer(msg, ORIGIN_TRAILER)).toBe('bbb')
  })
})
