import fs from 'node:fs'
import path from 'node:path'
import {loadProject, type Project, type ResolvedSubrepo} from '../config.js'
import {git, gitOk, revParse} from './git.js'
import {pullSource} from './sync.js'

/**
 * `vendor` is sugar: it derives a subrepo entry from a git URL, writes it into
 * monosplice.config.ts, and hands the rest to the adopt machinery. Everything here is pure
 * text or read-only git, so the command can run every check before it writes a byte.
 *
 * `attach` is the same sugar aimed at a path the user names, so both commands share this
 * module: the slot check, the config insertion and the paste-it-yourself fallback are one
 * implementation with the wording that differs passed in.
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

/** How a command tells the user to pick a different name or a different directory. */
export interface SlotHints {
  /** Clause, no trailing period: "Vendor it under another name with `--name <name>`". */
  rename: string
  /** Full sentence: "Pick another directory with `--path <dir>`." */
  relocate: string
}

/**
 * Why this name/path pair cannot become a new subrepo, or null when the slot is free. Both
 * halves must be free, and the path may not nest inside (or contain) a configured subrepo —
 * the config loader would reject the file monosplice is about to write anyway.
 */
export function checkFreeSlot(
  subrepos: readonly ResolvedSubrepo[],
  entry: VendorEntry,
  hints: SlotHints,
): string | null {
  for (const s of subrepos) {
    if (s.name === entry.name) {
      return `A subrepo named ${entry.name} is already configured (${s.path}/ tracking ${s.remote}).\nNothing was changed. ${hints.rename}, or run \`monosplice pull ${s.name}\` if this is the one you meant.`
    }
    if (s.path === entry.path) {
      return `${entry.path} is already configured as subrepo ${s.name}.\nNothing was changed. ${hints.relocate}`
    }
    if (s.path.startsWith(`${entry.path}/`) || entry.path.startsWith(`${s.path}/`)) {
      return `subrepo paths may not nest: ${entry.path} and ${s.path} (subrepo ${s.name}) would sit inside one another.\nNothing was changed. ${hints.relocate}`
    }
  }
  return null
}

/** The config could not be edited safely. The file is back to its original bytes. */
export interface ConfigWriteFailure {
  /** The rendered entry, for the user to paste in by hand. */
  snippet: string
  /** Why monosplice will not touch the file. */
  reason: string
}

/** Why the config monosplice just wrote cannot be trusted, or null when it checks out. */
async function reloadedMismatch(root: string, entry: ResolvedSubrepo): Promise<string | null> {
  let reloaded: Project | null
  try {
    reloaded = await loadProject(root)
  } catch (err) {
    return `the rewritten config does not load:\n${(err as Error).message}`
  }
  if (!reloaded) return 'the config file vanished while monosplice was writing it'
  const found = reloaded.subrepos.find((s) => s.name === entry.name)
  if (!found) return `the rewritten config has no subrepo named ${entry.name}`
  if (
    found.path !== entry.path ||
    found.remote !== entry.remote ||
    found.branch !== entry.branch ||
    found.upstream !== entry.upstream ||
    found.pushBranch !== entry.pushBranch
  ) {
    return `the rewritten config resolves ${entry.name} to ${found.path}/ tracking ${pullSource(found)} (${found.branch}), not what monosplice wrote`
  }
  return null
}

/**
 * Append the entry textually, then prove it by reloading the config through the real loader.
 * If either half fails the original bytes go back and the caller hands the user the snippet —
 * a half-rewritten config file is far worse than one the user pastes into themselves.
 */
export async function writeConfigEntry(
  project: Project,
  entry: ResolvedSubrepo,
): Promise<ConfigWriteFailure | null> {
  const snippet = renderSubrepoEntry(entry)
  const original = fs.readFileSync(project.configPath)
  const updated = insertSubrepoEntry(original.toString('utf8'), snippet)
  if (updated === null) return {snippet, reason: 'no `subrepos: [` line to insert into'}

  fs.writeFileSync(project.configPath, updated)
  const wrong = await reloadedMismatch(project.root, entry)
  if (wrong) {
    fs.writeFileSync(project.configPath, original)
    return {snippet, reason: wrong}
  }
  return null
}

/**
 * What to print when monosplice will not edit the config: the entry goes to stdout so it can
 * be piped or copy-pasted, and the error names the command to run once it is pasted in.
 */
export function pasteItYourself(
  configPath: string,
  failure: ConfigWriteFailure,
  nextCommand: string,
): {log: string; error: string} {
  return {
    log: `Add this to the \`subrepos\` array in ${configPath}:\n\n  ${failure.snippet},\n`,
    error: `monosplice cannot safely edit ${configPath}: ${failure.reason}.\nNothing was changed — the config is untouched and no commit was made. Paste the entry printed above into your config, then run:\n  ${nextCommand}`,
  }
}

/**
 * `vendor` and `attach` stage a config edit and commit the index, so — unlike `pull`, which
 * only cares about the subrepo directory — they insist the whole tracked tree is clean.
 * Untracked files are ignored: they are never committed, and an untracked directory sitting
 * at the target path is reported by the caller's own existence check, in far clearer words.
 */
export async function checkConfigEditPreconditions(
  root: string,
  retry: string,
  /** Gerund naming what the command is doing, e.g. "Vendoring" / "Attaching". */
  verb = 'Vendoring',
): Promise<string | null> {
  if (!(await revParse(root, 'HEAD'))) {
    return `${root} has no commits yet — commit something before ${verb.toLowerCase()} into it. Nothing was changed.`
  }
  if (!(await gitOk(root, ['diff', '--cached', '--quiet']))) {
    const staged = await git(root, ['diff', '--cached', '--name-only'])
    return `you have staged changes:\n${staged}\n${verb} commits the index, so it would sweep them in. Commit or unstage them, then run \`${retry}\` again. Nothing was changed.`
  }
  const dirty = await git(root, ['status', '--porcelain', '--untracked-files=no'])
  if (dirty !== '') {
    return `the working tree has uncommitted changes:\n${dirty}\n${verb} edits your config and commits it, so it needs a clean tree. Commit or stash them, then run \`${retry}\` again. Nothing was changed.`
  }
  return null
}
