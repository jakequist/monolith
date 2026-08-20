import fs from 'node:fs/promises'
import path from 'node:path'
import type {ResolvedSubrepo} from '../config.js'
import {EMPTY_TREE, git, gitBuffer, gitOk, readCommit, revParse} from './git.js'
import {makeExcluder} from './paths.js'
import {ORIGIN_TRAILER, appendTrailer} from './trailers.js'

/** The public commit currently being replayed, captured so `--continue` can finish it. */
export interface PullSequencerCommit {
  sha: string
  message: string
  authorName: string
  authorEmail: string
  /** raw format: "<unix-ts> <tz>" */
  authorDate: string
}

/**
 * Transient state for an interrupted import. Lives under the git dir, never in the work
 * tree and never committed: it is a sequencer like `.git/rebase-merge`, not project state.
 */
export interface PullSequencer {
  subrepo: string
  current: PullSequencerCommit
  remaining: string[]
}

export class ImportConflictError extends Error {
  constructor(
    readonly subrepoName: string,
    readonly pubSha: string,
    readonly conflicts: string[],
    readonly statePath: string,
  ) {
    super(`import of ${pubSha} into ${subrepoName} conflicted`)
    this.name = 'ImportConflictError'
  }
}

export interface ImportResult {
  imported: string[]
}

export interface ImportOptions {
  /** Called once per imported path that the config would exclude from export. */
  onWarn?: (message: string) => void
}

const STATE_FILE = 'pull-state.json'

async function stateDir(root: string): Promise<string> {
  return path.resolve(root, await git(root, ['rev-parse', '--git-dir']), 'monolith')
}

export async function sequencerPath(root: string): Promise<string> {
  return path.join(await stateDir(root), STATE_FILE)
}

export async function readSequencer(root: string): Promise<PullSequencer | null> {
  let raw: string
  try {
    raw = await fs.readFile(await sequencerPath(root), 'utf8')
  } catch {
    return null
  }
  return JSON.parse(raw) as PullSequencer
}

async function writeSequencer(root: string, state: PullSequencer): Promise<string> {
  const dir = await stateDir(root)
  await fs.mkdir(dir, {recursive: true})
  const file = path.join(dir, STATE_FILE)
  await fs.writeFile(file, `${JSON.stringify(state, null, 2)}\n`)
  return file
}

export async function clearSequencer(root: string): Promise<void> {
  await fs.rm(await sequencerPath(root), {force: true})
}

/** Paths git reports as unmerged in the index, or [] when the merge is resolved. */
export async function unmergedPaths(root: string): Promise<string[]> {
  const out = await git(root, ['diff', '--name-only', '--diff-filter=U'])
  return out === '' ? [] : out.split('\n')
}

/**
 * Import is the only operation that writes to the work tree and index, so it insists on
 * finding both pristine: anything staged would be swept into the import commit, and
 * anything modified under the subrepo would make `git apply --index` fail halfway.
 */
export async function checkImportPreconditions(
  root: string,
  subrepo: ResolvedSubrepo,
): Promise<string | null> {
  if (!(await revParse(root, 'HEAD'))) {
    return `${root} has no commits yet — commit something before importing from ${subrepo.remote}.`
  }
  const dirty = await git(root, ['status', '--porcelain', '--', subrepo.path])
  if (dirty !== '') {
    return `${subrepo.name}: ${subrepo.path}/ has uncommitted changes:\n${dirty}\nCommit or stash them, then run \`monolith pull ${subrepo.name}\` again. Nothing was imported.`
  }
  if (!(await gitOk(root, ['diff', '--cached', '--quiet']))) {
    const staged = await git(root, ['diff', '--cached', '--name-only'])
    return `${subrepo.name}: you have staged changes:\n${staged}\nAn import commits the index, so it would sweep them in. Commit or unstage them, then run \`monolith pull ${subrepo.name}\` again. Nothing was imported.`
  }
  return null
}

/** First parent of a commit, or the empty tree for a root commit (also the "adopt" case). */
async function diffBase(root: string, sha: string): Promise<string> {
  const line = await git(root, ['rev-list', '--parents', '-n', '1', sha])
  return line.split(' ')[1] ?? EMPTY_TREE
}

async function commitImport(root: string, c: PullSequencerCommit): Promise<string> {
  // --allow-empty: when the monorepo independently made the identical change the patch is
  // a no-op, but the commit (and its Origin trailer) is what marks the pub commit
  // reflected — skip it and push would refuse forever.
  await git(root, ['commit', '--allow-empty', '--no-verify', '-m', appendTrailer(c.message, ORIGIN_TRAILER, c.sha)], {
    env: {
      GIT_AUTHOR_NAME: c.authorName,
      GIT_AUTHOR_EMAIL: c.authorEmail,
      GIT_AUTHOR_DATE: c.authorDate,
    },
  })
  return git(root, ['rev-parse', 'HEAD'])
}

function excludeWarning(subrepo: ResolvedSubrepo, relPath: string): string {
  return `warning: ${subrepo.name}: imported ${subrepo.path}/${relPath}, but it matches an exclude pattern in your config.
The next \`monolith push ${subrepo.name}\` will DELETE it from ${subrepo.remote}.
Rename the file or drop the pattern from \`exclude\` if you want to keep it public.`
}

/**
 * Replay one public commit onto the work tree. Returns the unmerged paths when the
 * three-way apply conflicted, or null when it applied and was committed.
 */
async function importOne(
  root: string,
  subrepo: ResolvedSubrepo,
  meta: PullSequencerCommit,
  opts: ImportOptions,
): Promise<string[] | null> {
  const base = await diffBase(root, meta.sha)
  const patch = await gitBuffer(root, ['diff-tree', '--binary', '-M', '-p', base, meta.sha])

  if (patch.length > 0) {
    try {
      // --3way merges concurrent monorepo edits instead of rejecting; the blobs it needs
      // are already local because loadSyncView fetched the public branch.
      await git(root, ['apply', '--3way', '--index', `--directory=${subrepo.path}`], {input: patch})
    } catch (err) {
      const conflicts = await unmergedPaths(root)
      if (conflicts.length === 0) throw err
      return conflicts
    }
  }

  const names = await git(root, ['diff-tree', '--name-only', '-r', base, meta.sha])
  if (names !== '' && subrepo.exclude.length > 0) {
    const excluded = makeExcluder(subrepo.exclude)
    for (const rel of names.split('\n')) {
      if (excluded(rel)) opts.onWarn?.(excludeWarning(subrepo, rel))
    }
  }

  await commitImport(root, meta)
  return null
}

async function readSequencerCommit(root: string, sha: string): Promise<PullSequencerCommit> {
  const meta = await readCommit(root, sha)
  return {
    sha: meta.sha,
    message: meta.message,
    authorName: meta.authorName,
    authorEmail: meta.authorEmail,
    authorDate: meta.authorDate,
  }
}

/** Replay public commits (oldest first) into the monorepo, stopping at the first conflict. */
export async function runImport(
  root: string,
  subrepo: ResolvedSubrepo,
  candidates: string[],
  opts: ImportOptions = {},
): Promise<ImportResult> {
  const imported: string[] = []
  for (const [idx, sha] of candidates.entries()) {
    const meta = await readSequencerCommit(root, sha)
    const conflicts = await importOne(root, subrepo, meta, opts)
    if (conflicts) {
      const statePath = await writeSequencer(root, {
        subrepo: subrepo.name,
        current: meta,
        remaining: candidates.slice(idx + 1),
      })
      throw new ImportConflictError(subrepo.name, sha, conflicts, statePath)
    }
    imported.push(sha)
  }
  return {imported}
}

/**
 * Finish the commit the user just resolved, then carry on with what was left. A later
 * candidate can conflict too, which simply rewrites the sequencer.
 */
export async function continueImport(
  root: string,
  subrepo: ResolvedSubrepo,
  state: PullSequencer,
  opts: ImportOptions = {},
): Promise<ImportResult> {
  await commitImport(root, state.current)
  await clearSequencer(root)
  const rest = await runImport(root, subrepo, state.remaining, opts)
  return {imported: [state.current.sha, ...rest.imported]}
}
