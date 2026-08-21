/**
 * Trailer keys that record the cross-repo commit mapping.
 *
 * - Public commits exported from the monorepo carry `Monosplice-Source: <mono-sha>`.
 * - Monorepo commits imported from a public repo carry `Monosplice-Origin: <pub-sha>`,
 *   marking that pub commit as reflected in the monorepo.
 *
 * Import skips pub commits carrying Monosplice-Source (our own exports). Export
 * relies on tree equality, not trailers: pure imports are no-ops against the pub
 * tip and get dropped, while conflicted imports (merges of mono + pub edits)
 * export their resolution. Together these prevent ping-pong without ever losing
 * merge resolutions.
 */
export const SOURCE_TRAILER = 'Monosplice-Source'
export const ORIGIN_TRAILER = 'Monosplice-Origin'

const TRAILER_LINE = /^[A-Za-z0-9-]+:\s.+$/

/** Split a commit message into paragraphs (blocks separated by blank lines). */
function paragraphs(message: string): string[] {
  return message.replace(/\r\n/g, '\n').trimEnd().split(/\n{2,}/)
}

function isTrailerBlock(block: string): boolean {
  const lines = block.split('\n')
  return lines.length > 0 && lines.every((l) => TRAILER_LINE.test(l))
}

/**
 * Read a trailer value from a commit message. Mirrors git's semantics closely
 * enough for monosplice's own trailers: only the final paragraph counts, and only
 * when that whole paragraph is a trailer block.
 */
export function getTrailer(message: string, key: string): string | undefined {
  const blocks = paragraphs(message)
  if (blocks.length === 0) return undefined
  const last = blocks[blocks.length - 1]!
  // A message that is only one paragraph has no trailer block (it's the subject).
  if (blocks.length === 1) return undefined
  if (!isTrailerBlock(last)) return undefined
  for (const line of last.split('\n')) {
    const idx = line.indexOf(':')
    if (idx !== -1 && line.slice(0, idx) === key) return line.slice(idx + 1).trim()
  }
  return undefined
}

/**
 * Append a trailer to a commit message, extending an existing trailer block if
 * the message ends with one, otherwise starting a new block.
 */
export function appendTrailer(message: string, key: string, value: string): string {
  const body = message.replace(/\r\n/g, '\n').trimEnd()
  if (body === '') return `${key}: ${value}\n`
  const blocks = paragraphs(body)
  const last = blocks[blocks.length - 1]!
  if (blocks.length > 1 && isTrailerBlock(last)) {
    return `${body}\n${key}: ${value}\n`
  }
  return `${body}\n\n${key}: ${value}\n`
}
