import path from 'node:path'
import {git, gitOk, revParse} from './git.js'

/**
 * `vendor` is sugar: it derives a subrepo entry from a git URL, writes it into
 * monolith.config.ts, and hands the rest to the adopt machinery. Everything here is pure
 * text or read-only git, so the command can run every check before it writes a byte.
 */

/** A subrepo entry as it exists before the config knows about it. */
export interface VendorEntry {
  name: string
  path: string
  remote: string
  branch: string
  /** Set by `--fork`: `remote` is then the fork and this is where the tree comes from. */
  upstream?: string
  /** Branch pushed on the fork. Omitted from the rendered entry when it equals `branch`. */
  pushBranch?: string
}

/** Names we are willing to invent for the user: one safe path segment, nothing clever. */
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * Repo basename of a git URL, minus `.git`. Handles scp-style (`git@host:owner/repo.git`),
 * URL forms (`https://host/owner/repo`, `ssh://git@host:22/owner/repo.git`) and plain
 * filesystem paths. Returns null when the result would not be a usable name — the command
 * then asks for `--name` instead of guessing.
 */
export function deriveVendorName(url: string): string | null {
  let rest = url.trim()
  const fragment = rest.search(/[#?]/)
  if (fragment !== -1) rest = rest.slice(0, fragment)
  rest = rest.replace(/[/\\]+$/, '')

  let last = rest.split(/[/\\]/).pop() ?? ''
  // scp-style URLs put host and path on either side of a colon, with no slash between.
  const colon = last.lastIndexOf(':')
  if (colon !== -1) last = last.slice(colon + 1)
  last = last.replace(/\.git$/i, '')

  return SAFE_NAME.test(last) ? last : null
}

/** Single-quoted JS string literal. Config files are hand-edited, so keep them readable. */
function quote(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`
}

/**
 * The entry to write into the config, in the same style the README documents. `name`,
 * `branch` and `pushBranch` are omitted when they equal what the loader would default to
 * anyway.
 */
export function renderSubrepoEntry(entry: VendorEntry): string {
  const fields: string[] = []
  if (entry.name !== path.posix.basename(entry.path)) fields.push(`name: ${quote(entry.name)}`)
  fields.push(`path: ${quote(entry.path)}`)
  fields.push(`remote: ${quote(entry.remote)}`)
  if (entry.branch !== 'main') fields.push(`branch: ${quote(entry.branch)}`)
  if (entry.upstream !== undefined) fields.push(`upstream: ${quote(entry.upstream)}`)
  if (entry.upstream !== undefined && entry.pushBranch !== undefined && entry.pushBranch !== entry.branch) {
    fields.push(`pushBranch: ${quote(entry.pushBranch)}`)
  }
  return `{ ${fields.join(', ')} }`
}

/** `subrepos: [` on a line of its own — the only shape this inserter claims to understand. */
const SUBREPOS_OPEN = /^([ \t]*)subrepos:\s*\[\s*$/

/**
 * Insert an entry at the top of the config's `subrepos` array, or return null when the file
 * does not have a literal array to insert into. Deliberately naive: a config that computes
 * its subrepos (spread, imported variable, function call) is not something a regex should
 * rewrite, and the caller prints a paste-able snippet instead.
 */
export function insertSubrepoEntry(source: string, entry: string): string | null {
  const lines = source.split('\n')
  let at = -1
  let indent = ''
  for (const [i, line] of lines.entries()) {
    const m = SUBREPOS_OPEN.exec(line)
    if (m) {
      at = i
      indent = m[1] ?? ''
    }
  }
  if (at === -1) return null
  lines.splice(at + 1, 0, `${indent}  ${entry},`)
  return lines.join('\n')
}

/**
 * Vendoring stages a config edit and commits the index, so — unlike `pull`, which only cares
 * about the subrepo directory — it insists the whole tracked tree is clean. Untracked files
 * are ignored: they are never committed, and an untracked directory sitting at the target
 * path is reported by the caller's own existence check, in far clearer words.
 */
export async function checkVendorPreconditions(root: string, retry: string): Promise<string | null> {
  if (!(await revParse(root, 'HEAD'))) {
    return `${root} has no commits yet — commit something before vendoring into it. Nothing was changed.`
  }
  if (!(await gitOk(root, ['diff', '--cached', '--quiet']))) {
    const staged = await git(root, ['diff', '--cached', '--name-only'])
    return `you have staged changes:\n${staged}\nVendoring commits the index, so it would sweep them in. Commit or unstage them, then run \`${retry}\` again. Nothing was changed.`
  }
  const dirty = await git(root, ['status', '--porcelain', '--untracked-files=no'])
  if (dirty !== '') {
    return `the working tree has uncommitted changes:\n${dirty}\nVendoring edits your config and commits it together with the vendored tree, so it needs a clean tree. Commit or stash them, then run \`${retry}\` again. Nothing was changed.`
  }
  return null
}
