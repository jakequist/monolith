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

/**
 * Normalize a configured subrepo path: strip leading/trailing slashes and a leading `./`,
 * reject escapes.
 *
 * The `./` tolerance is not cosmetic: it is what a shell's own tab-completion produces, and
 * what the README quickstart types (`attach ./core`). Only the *leading* prefix is forgiven —
 * a `.` or `..` anywhere else still means the caller is pointing outside the subrepo.
 */
export function normalizeSubrepoPath(p: string): string {
  let cleaned = p.replace(/^\/+/, '').replace(/\/+$/, '')
  while (cleaned.startsWith('./')) cleaned = cleaned.slice(2).replace(/^\/+/, '')
  if (cleaned === '' || cleaned === '.') throw new Error(`subrepo path may not be the repo root: ${JSON.stringify(p)}`)
  const segments = cleaned.split('/')
  if (segments.some((s) => s === '..' || s === '.')) {
    throw new Error(`subrepo path may not contain '.' or '..' segments: ${JSON.stringify(p)}`)
  }
  return cleaned
}
