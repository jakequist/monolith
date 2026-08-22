import fs from 'node:fs'
import path from 'node:path'
import {loadProject, type Project, type ResolvedSubrepo} from '../config.js'
import {git, gitOk, revParse} from './git.js'
import {normalizeSubrepoPath} from './paths.js'
import {pullSource} from './sync.js'

/**
 * Turning a git URL and a folder into a subrepo entry, writing it into monosplice.config.ts,
 * and refusing to when the file is not something a regex may safely rewrite. Everything here
 * is pure text or read-only git, so `attach` can run every check before it writes a byte.
 *
 * The module is named for the retired `vendor` command it was extracted from; `attach`
 * absorbed that command and is now its only caller.
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

/** Where in `source` an entry's object literal starts and ends. */
interface EntryRange {
  start: number
  end: number
  text: string
}

/** Index just past the `[` of the last `subrepos: [` line, or null when there is none. */
function findSubreposArray(source: string): number | null {
  const lines = source.split('\n')
  let offset = 0
  let at: number | null = null
  for (const line of lines) {
    if (SUBREPOS_OPEN.test(line)) at = offset + line.indexOf('[') + 1
    offset += line.length + 1
  }
  return at
}

/** Index just past a string literal starting at `i`, or -1 when it is unterminated. */
function skipString(source: string, i: number): number {
  const quote = source[i]
  for (let j = i + 1; j < source.length; j++) {
    const c = source[j]
    if (c === '\\') {
      j++
      continue
    }
    if (c === quote) return j + 1
  }
  return -1
}

/**
 * Split the array that starts at `from` into its top-level object literals. Returns null the
 * moment it sees anything else at that level — a spread, an identifier, a call — because a
 * config that computes its subrepos is not something this module may rewrite.
 */
function scanArrayElements(source: string, from: number): EntryRange[] | null {
  const ranges: EntryRange[] = []
  let depth = 0
  let objStart = -1
  let i = from
  while (i < source.length) {
    const c = source[i]!
    if (c === "'" || c === '"' || c === '`') {
      i = skipString(source, i)
      if (i === -1) return null
      continue
    }
    if (c === '/' && source[i + 1] === '/') {
      const nl = source.indexOf('\n', i)
      i = nl === -1 ? source.length : nl
      continue
    }
    if (c === '/' && source[i + 1] === '*') {
      const close = source.indexOf('*/', i + 2)
      if (close === -1) return null
      i = close + 2
      continue
    }
    if (c === '{' || c === '[' || c === '(') {
      if (depth === 0) {
        if (c !== '{') return null
        objStart = i
      }
      depth++
      i++
      continue
    }
    if (c === '}' || c === ']' || c === ')') {
      if (depth === 0) return c === ']' ? ranges : null
      depth--
      if (depth === 0 && c === '}' && objStart !== -1) {
        ranges.push({start: objStart, end: i + 1, text: source.slice(objStart, i + 1)})
        objStart = -1
      }
      i++
      continue
    }
    if (depth === 0 && c !== ',' && !/\s/.test(c)) return null
    i++
  }
  return null
}

/** A single-quoted, double-quoted or bare `key: 'value'` field of an object literal. */
function readField(text: string, key: string): string | null {
  const re = new RegExp(`(?:^|[\\s{,])["']?${key}["']?\\s*:\\s*(?:'((?:[^'\\\\]|\\\\.)*)'|"((?:[^"\\\\]|\\\\.)*)")`)
  const m = re.exec(text)
  const raw = m?.[1] ?? m?.[2]
  return raw === undefined ? null : raw.replace(/\\(.)/g, '$1')
}

/** The name the loader would give this entry, or null when it cannot be read literally. */
function entryName(text: string): string | null {
  const explicit = readField(text, 'name')
  if (explicit !== null) return explicit
  const entryPath = readField(text, 'path')
  if (entryPath === null) return null
  try {
    return path.posix.basename(normalizeSubrepoPath(entryPath))
  } catch {
    return null
  }
}

/** Cut an entry out, taking its trailing comma and its line with it when it had one to itself. */
function cutRange(source: string, range: EntryRange): string {
  let end = range.end
  while (source[end] === ' ' || source[end] === '\t') end++
  if (source[end] === ',') end++
  let scan = end
  while (source[scan] === ' ' || source[scan] === '\t') scan++
  if (source[scan] === '\r') scan++
  if (source[scan] === '\n') end = scan + 1

  let start = range.start
  while (start > 0 && (source[start - 1] === ' ' || source[start - 1] === '\t')) start--
  if (start > 0 && source[start - 1] !== '\n') start = range.start

  return source.slice(0, start) + source.slice(end)
}

/**
 * The reverse of `insertSubrepoEntry`: delete the entry the loader would name `name`, or
 * return null when the file does not spell it out plainly enough to edit. Deliberately as
 * naive as its counterpart — every top-level element must be an object literal whose `name`
 * (or `path`) is a string literal, and exactly one of them may match.
 */
export function removeSubrepoEntry(source: string, name: string): string | null {
  const at = findSubreposArray(source)
  if (at === null) return null
  const ranges = scanArrayElements(source, at)
  if (ranges === null) return null

  const hits: EntryRange[] = []
  for (const range of ranges) {
    const resolved = entryName(range.text)
    // An entry monosplice cannot read might BE the one to delete; refuse rather than guess.
    if (resolved === null) return null
    if (resolved === name) hits.push(range)
  }
  if (hits.length !== 1) return null
  return cutRange(source, hits[0]!)
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

/** The config could not have an entry removed from it. The file is back to its original bytes. */
export interface ConfigRemoveFailure {
  reason: string
}

/** Why the config monosplice just trimmed cannot be trusted, or null when it checks out. */
async function removedMismatch(project: Project, entry: ResolvedSubrepo): Promise<string | null> {
  let reloaded: Project | null
  try {
    reloaded = await loadProject(project.root)
  } catch (err) {
    return `the rewritten config does not load:\n${(err as Error).message}`
  }
  if (!reloaded) return 'the config file vanished while monosplice was writing it'
  if (reloaded.subrepos.some((s) => s.name === entry.name)) {
    return `the rewritten config still has a subrepo named ${entry.name}`
  }
  const expected = project.subrepos.filter((s) => s.name !== entry.name)
  if (reloaded.subrepos.length !== expected.length) {
    return `the rewritten config resolves to ${reloaded.subrepos.length} subrepo(s) where ${expected.length} were expected`
  }
  for (const [i, want] of expected.entries()) {
    const got = reloaded.subrepos[i]!
    if (
      got.name !== want.name ||
      got.path !== want.path ||
      got.remote !== want.remote ||
      got.branch !== want.branch ||
      got.upstream !== want.upstream ||
      got.pushBranch !== want.pushBranch
    ) {
      return `the rewritten config changed subrepo ${want.name}, which monosplice was not asked to touch`
    }
  }
  return null
}

/**
 * Delete the entry textually, then prove it by reloading the config through the real loader:
 * the named subrepo must be gone and every other one must resolve exactly as it did before.
 * If either half fails the original bytes go back and the caller tells the user what to
 * delete by hand — the same bargain `writeConfigEntry` makes in the other direction.
 */
export async function removeConfigEntry(
  project: Project,
  entry: ResolvedSubrepo,
): Promise<ConfigRemoveFailure | null> {
  const original = fs.readFileSync(project.configPath)
  const updated = removeSubrepoEntry(original.toString('utf8'), entry.name)
  if (updated === null) {
    return {reason: `no plain \`subrepos: [\` entry for ${entry.name} that a text edit can safely remove`}
  }

  fs.writeFileSync(project.configPath, updated)
  const wrong = await removedMismatch(project, entry)
  if (wrong) {
    fs.writeFileSync(project.configPath, original)
    return {reason: wrong}
  }
  return null
}

/**
 * What to print when monosplice will not delete the entry itself: the removal is a two-line
 * instruction, so it goes to stdout and the error names what to run once it is done.
 */
export function deleteItYourself(
  configPath: string,
  entry: ResolvedSubrepo,
  failure: ConfigRemoveFailure,
): {log: string; error: string} {
  return {
    log: `Delete the \`subrepos\` entry for ${entry.name} (${entry.path}/ tracking ${pullSource(entry)}) from ${configPath}.\n`,
    error: `monosplice cannot safely edit ${configPath}: ${failure.reason}.
Nothing was changed — the config is untouched and no commit was made. Delete the entry described above by hand and commit it; ${entry.path}/ and its history stay exactly as they are either way.`,
  }
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
 * Writing a new entry stages a config edit and commits the index, so — unlike `pull`, which
 * only cares about the subrepo directory — it insists the whole tracked tree is clean.
 * Untracked files are ignored: they are never committed, and an untracked directory sitting
 * at the target path is reported by the caller's own existence check, in far clearer words.
 */
export async function checkConfigEditPreconditions(
  root: string,
  retry: string,
  /** Gerund naming what the command is doing, e.g. "Attaching". */
  verb = 'Attaching',
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
