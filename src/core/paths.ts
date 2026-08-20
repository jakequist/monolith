import picomatch from 'picomatch'

/**
 * Build a predicate for the config's `exclude` globs. Paths are relative to the
 * subrepo root (no leading slash). `dot: true` so patterns match dotfiles.
 */
export function makeExcluder(patterns: readonly string[]): (relPath: string) => boolean {
  if (patterns.length === 0) return () => false
  const isMatch = picomatch([...patterns], {dot: true})
  return (relPath) => isMatch(relPath)
}

/** Normalize a configured subrepo path: strip leading/trailing slashes, reject escapes. */
export function normalizeSubrepoPath(p: string): string {
  const cleaned = p.replace(/^\/+/, '').replace(/\/+$/, '')
  if (cleaned === '' || cleaned === '.') throw new Error(`subrepo path may not be the repo root: ${JSON.stringify(p)}`)
  const segments = cleaned.split('/')
  if (segments.some((s) => s === '..' || s === '.')) {
    throw new Error(`subrepo path may not contain '.' or '..' segments: ${JSON.stringify(p)}`)
  }
  return cleaned
}
