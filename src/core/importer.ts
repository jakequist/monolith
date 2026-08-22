import fs from 'node:fs/promises'
import path from 'node:path'
import type {ResolvedSubrepo} from '../config.js'
import {EMPTY_TREE, git, gitBuffer, gitOk, readCommit, revList, revParse} from './git.js'
import {makeExcluder} from './paths.js'
import {ORIGIN_TRAILER, appendTrailer} from './trailers.js'

/** The standalone-repo commit currently being replayed, captured so `--continue` can finish it. */
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
 *
 * The last three fields exist so `--abort` can put the monorepo back exactly as it was: the
 * subrepo directory bounds what abort is allowed to touch, `startHead` is where the run
 * began, and `created` is the proof that everything between the two is monosplice's own work.
 */
export interface PullSequencer {
  subrepo: string
  /** Subrepo directory, so `--abort` still works if the config entry was removed meanwhile. */
  path?: string
  current: PullSequencerCommit
  remaining: string[]
  /** Monorepo HEAD before this pull run committed anything. */
  startHead?: string
  /** Monorepo commits this run created before the conflict, oldest first. */
  created?: string[]
}

/** Where a pull run started and what it has committed so far, carried across `--continue`. */
export interface RunProvenance {
  startHead: string
  created: string[]
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
  return path.resolve(root, await git(root, ['rev-parse', '--git-dir']), 'monosplice')
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
  /** Command to retry, so `attach` does not tell the user to run `pull`. */
  retry = `monosplice pull ${subrepo.name}`,
): Promise<string | null> {
  if (!(await revParse(root, 'HEAD'))) {
    return `${root} has no commits yet — commit something before importing from ${subrepo.remote}.`
  }
  const dirty = await git(root, ['status', '--porcelain', '--', subrepo.path])
  if (dirty !== '') {
    return `${subrepo.name}: ${subrepo.path}/ has uncommitted changes:\n${dirty}\nCommit or stash them, then run \`${retry}\` again. Nothing was imported.`
  }
  if (!(await gitOk(root, ['diff', '--cached', '--quiet']))) {
    const staged = await git(root, ['diff', '--cached', '--name-only'])
    return `${subrepo.name}: you have staged changes:\n${staged}\nAn import commits the index, so it would sweep them in. Commit or unstage them, then run \`${retry}\` again. Nothing was imported.`
  }
  return null
}

/** First parent of a commit, or the empty tree for a root commit (also the snapshot case). */
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
The next \`monosplice push ${subrepo.name}\` will DELETE it from ${subrepo.remote}.
Rename the file or drop the pattern from \`exclude\` if you want to keep it in the standalone repo.`
}

/** Either the commit an import created, or the paths its three-way apply left unmerged. */
type ImportStep = {monoSha: string; conflicts?: undefined} | {monoSha?: undefined; conflicts: string[]}

/**
 * Replay one standalone-repo commit onto the work tree. Returns the unmerged paths when the
 * three-way apply conflicted, or the monorepo commit it created when it applied.
 */
async function importOne(
  root: string,
  subrepo: ResolvedSubrepo,
  meta: PullSequencerCommit,
  opts: ImportOptions,
): Promise<ImportStep> {
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
      return {conflicts}
    }
  }

  const names = await git(root, ['diff-tree', '--name-only', '-r', base, meta.sha])
  if (names !== '' && subrepo.exclude.length > 0) {
    const excluded = makeExcluder(subrepo.exclude)
    for (const rel of names.split('\n')) {
      if (excluded(rel)) opts.onWarn?.(excludeWarning(subrepo, rel))
    }
  }

  return {monoSha: await commitImport(root, meta)}
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

/**
 * Replay standalone-repo commits (oldest first) into the monorepo, stopping at the first
 * conflict. `run` carries the provenance of an already-started pull across `--continue`; left
 * out, this call *is* the start of the run.
 */
export async function runImport(
  root: string,
  subrepo: ResolvedSubrepo,
  candidates: string[],
  opts: ImportOptions = {},
  run?: RunProvenance,
): Promise<ImportResult> {
  const startHead = run?.startHead ?? ((await revParse(root, 'HEAD')) ?? '')
  const created = [...(run?.created ?? [])]
  const imported: string[] = []
  for (const [idx, sha] of candidates.entries()) {
    const meta = await readSequencerCommit(root, sha)
    const step = await importOne(root, subrepo, meta, opts)
    if (step.conflicts !== undefined) {
      const statePath = await writeSequencer(root, {
        subrepo: subrepo.name,
        path: subrepo.path,
        current: meta,
        remaining: candidates.slice(idx + 1),
        startHead,
        created,
      })
      throw new ImportConflictError(subrepo.name, sha, step.conflicts, statePath)
    }
    created.push(step.monoSha)
    imported.push(sha)
  }
  return {imported}
}

/**
 * Finish the commit the user just resolved, then carry on with what was left. A later
 * candidate can conflict too, which simply rewrites the sequencer — with the same run
 * provenance, so `--abort` after the second conflict still rewinds the whole pull.
 */
export async function continueImport(
  root: string,
  subrepo: ResolvedSubrepo,
  state: PullSequencer,
  opts: ImportOptions = {},
): Promise<ImportResult> {
  const sha = await commitImport(root, state.current)
  await clearSequencer(root)
  const run: RunProvenance = {
    startHead: state.startHead ?? sha,
    created: [...(state.created ?? []), sha],
  }
  const rest = await runImport(root, subrepo, state.remaining, opts, run)
  return {imported: [state.current.sha, ...rest.imported]}
}

export interface AbortResult {
  /** True when the monorepo was rewound all the way to the pre-pull HEAD. */
  rewound: boolean
  /** Monorepo commits this pull created and abort discarded (oldest first). */
  discarded: string[]
  /** Commits this pull created that abort kept, because history moved after they landed. */
  kept: string[]
  /** HEAD before the pull started, when the sequencer recorded it. */
  startHead: string | null
}

/**
 * Are the commits between `startHead` and HEAD exactly the ones this pull run created?
 * That is the whole proof: anything else on the walk is somebody's work monosplice did not
 * make, and rewinding past it would destroy it.
 */
async function runOwnsHistory(root: string, startHead: string, created: string[]): Promise<boolean> {
  if (!(await gitOk(root, ['merge-base', '--is-ancestor', startHead, 'HEAD']))) return false
  const walk = await revList(root, [`${startHead}..HEAD`]).catch(() => null)
  if (walk === null) return false
  return walk.length === created.length && walk.every((sha, i) => sha === created[created.length - 1 - i])
}

/**
 * Put the subrepo directory — and nothing else — back to how `target` has it: index first
 * (which also drops the conflict stages), then the work tree, then the files the aborted
 * import created, which are untracked by now. Import required the path to be pristine before
 * it started, so "untracked under the path" means "made by this pull".
 */
async function restoreSubrepoPath(root: string, subPath: string, target: string): Promise<void> {
  await git(root, ['reset', '--quiet', target, '--', subPath])
  // Nothing to check out when the path has no files at `target` and none in the index.
  await gitOk(root, ['checkout', '--quiet', '--', subPath])
  await git(root, ['clean', '-fdq', '--', subPath])
  await git(root, ['reset', '--quiet', '--soft', target])
}

/**
 * Abandon an interrupted import. Rewinds to the pre-pull HEAD when the sequencer can prove
 * every commit since is one this run made; otherwise it undoes only the conflicted step and
 * says which commits it left behind. Never touches anything outside the subrepo path.
 */
export async function abortImport(root: string, subPath: string, state: PullSequencer): Promise<AbortResult> {
  const head = await git(root, ['rev-parse', 'HEAD'])
  const created = state.created ?? []
  const startHead = state.startHead ?? null
  const provable = startHead !== null && (await runOwnsHistory(root, startHead, created))

  await restoreSubrepoPath(root, subPath, provable ? startHead! : head)
  await clearSequencer(root)

  return {
    rewound: provable,
    discarded: provable ? created : [],
    kept: provable ? [] : created,
    startHead,
  }
}
