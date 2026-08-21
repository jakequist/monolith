import readline from 'node:readline/promises'
import type {ResolvedSubrepo} from '../config.js'
import {
  checkExportPreconditions,
  planExport,
  publishBaseline,
  publishFullHistory,
  runExport,
} from '../core/exporter.js'
import {hasCommittedFiles} from '../core/filter.js'
import {GitError, revParse} from '../core/git.js'
import {
  ImportConflictError,
  type PullSequencer,
  checkImportPreconditions,
  runImport,
  sequencerPath,
} from '../core/importer.js'
import {loadSyncView, pullSource, type SyncView} from '../core/sync.js'

/**
 * How a command talks to the terminal. Keeps the per-subrepo operations shared by
 * `push`, `pull`, `sync` and `status` free of oclif, without duplicating their wording.
 */
export interface Reporter {
  log(message: string): void
  /** Non-fatal notice; goes to stderr so stdout stays pipeable. */
  warn(message: string): void
  fail(message: string): never
}

/**
 * A single subrepo refused to proceed. `push` collects these so one unpublished subrepo
 * cannot stop the others from exporting (S90); commands that must stay all-or-nothing
 * simply let it propagate.
 */
export class SubrepoFailure extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SubrepoFailure'
  }
}

/** Derive the sync view, turning an unreachable source repository into a user-facing error. */
export async function loadView(root: string, subrepo: ResolvedSubrepo, r: Reporter): Promise<SyncView> {
  return loadSyncView(root, subrepo).catch((err: unknown) => {
    if (err instanceof GitError) {
      const what = subrepo.upstream === undefined ? 'remote' : 'upstream'
      r.fail(`${subrepo.name}: cannot reach ${what} ${pullSource(subrepo)}\n${err.stderr}`)
    }
    throw err
  })
}

/** Neither side has anything: the one matrix cell where no monosplice command can help. */
export function nothingExistsYet(subrepo: ResolvedSubrepo): string {
  return `${subrepo.name}: nothing exists yet — ${subrepo.path}/ has no committed files at HEAD, and ${pullSource(subrepo)} has no ${subrepo.branch} branch.
Commit something under ${subrepo.path}/ and run \`monosplice push ${subrepo.name} --yes\` to publish it, or run \`monosplice attach ${subrepo.path}\` once the remote has content.`
}

/** The public branch has history, but nothing on either side references the other. */
export function unrelatedRemote(subrepo: ResolvedSubrepo, consequence: string): string {
  return `${subrepo.name}: ${pullSource(subrepo)} (${subrepo.branch}) has history that is unrelated to this monorepo — no commit on either side references the other.
${consequence} To connect the two repositories, run:
  monosplice attach ${subrepo.path}`
}

/** Stop unless the public branch exists, distinguishing "not published" from "nothing at all". */
export async function requirePublished(
  root: string,
  subrepo: ResolvedSubrepo,
  view: SyncView,
  r: Reporter,
): Promise<void> {
  if (view.pubHead !== null) return
  if (subrepo.upstream !== undefined) r.fail(upstreamHasNoBranch(subrepo))
  const head = await revParse(root, 'HEAD')
  if (!head || !(await hasCommittedFiles(root, head, subrepo))) r.fail(nothingExistsYet(subrepo))
  r.fail(
    `${subrepo.name}: ${subrepo.remote} has no ${subrepo.branch} branch — this subrepo has not been published yet.\nRun \`monosplice push ${subrepo.name} --yes\` to publish ${subrepo.path}/ for the first time.`,
  )
}

/**
 * Triangular first contact has no sensible answer: the fork branch is built *on* the upstream
 * head, so with no upstream branch there is nothing to base it on and publishing a fork from
 * scratch would defeat the point of the triangle.
 */
export function upstreamHasNoBranch(subrepo: ResolvedSubrepo): string {
  return `${subrepo.name}: upstream ${subrepo.upstream} has no ${subrepo.branch} branch, so monosplice has nothing to base the fork branch on.
Nothing was changed. Fix \`upstream\` or \`branch\` in your config, or drop \`upstream\` to publish ${subrepo.path}/ to ${subrepo.remote} directly:
  monosplice push ${subrepo.name} --yes`
}

/** Shared by `pull` and `sync`: neither may start while a sequencer sits on disk. */
export async function pullInProgressMessage(root: string, state: PullSequencer): Promise<string> {
  return `A pull of ${state.subrepo} is already in progress.\nResolve the conflict, \`git add\` the files, then run:\n  monosplice pull --continue\nTo abort instead, delete ${await sequencerPath(root)}.`
}

export function reportImportFailure(subrepo: ResolvedSubrepo, err: unknown, r: Reporter): never {
  if (err instanceof ImportConflictError) {
    r.fail(
      `${subrepo.name}: importing ${err.pubSha.slice(0, 10)} conflicts with local changes.\nConflicted files:\n${err.conflicts.map((f) => `  ${f}`).join('\n')}\nEdit each file to resolve the markers, \`git add\` it, then run:\n  monosplice pull --continue\nTo abort instead, delete ${err.statePath}.`,
    )
  }
  if (err instanceof GitError) r.fail(`${subrepo.name}: ${err.message}`)
  r.fail(`${subrepo.name}: ${(err as Error).message}`)
}

/** Import every unreflected public commit. Returns how many landed. */
export async function importSubrepo(root: string, subrepo: ResolvedSubrepo, r: Reporter): Promise<number> {
  const view = await loadView(root, subrepo, r)
  await requirePublished(root, subrepo, view, r)
  if (!view.related) r.fail(unrelatedRemote(subrepo, 'Nothing was imported.'))

  const problem = await checkImportPreconditions(root, subrepo)
  if (problem) r.fail(problem)

  const result = await runImport(root, subrepo, view.unreflectedPub, {
    onWarn: (message) => r.warn(message),
  }).catch((err: unknown) => reportImportFailure(subrepo, err, r))

  return result.imported.length
}

/** What one export run did, from the caller's point of view. */
export interface ExportSummary {
  /** Commits written to the remote by this run. */
  pushed: number
  /**
   * Triangular only: commits the fork branch already carries byte-for-byte, so nothing was
   * written. They stay "to push" until upstream merges them.
   */
  awaiting: number
}

/** Export every pending monorepo commit. */
export async function exportSubrepo(
  root: string,
  subrepo: ResolvedSubrepo,
  r: Reporter,
  loaded?: SyncView,
): Promise<ExportSummary> {
  const view = loaded ?? (await loadView(root, subrepo, r))
  await requirePublished(root, subrepo, view, r)
  if (!view.related) r.fail(unrelatedRemote(subrepo, `Nothing was pushed to ${subrepo.remote}.`))

  const unsafe = await checkExportPreconditions(root, subrepo, view)
  if (unsafe) r.fail(unsafe)

  if (view.unreflectedPub.length > 0) {
    r.fail(
      `${subrepo.name}: ${view.unreflectedPub.length} commit(s) on ${pullSource(subrepo)} have not been imported yet.\nNothing was pushed. Run \`monosplice pull ${subrepo.name}\` first, then push again.`,
    )
  }

  const {candidates} = await planExport(root, subrepo, view)
  const result = await runExport(root, subrepo, view, {candidates}).catch((err: unknown) => {
    // Everything up to the push is local, so in triangular mode a git failure here is the
    // fork's — never upstream's, which this code path does not write to at all.
    if (subrepo.upstream !== undefined && err instanceof GitError) {
      r.fail(
        `${subrepo.name}: cannot push to fork remote ${subrepo.remote} (${subrepo.pushBranch})\n${err.stderr || err.message}\nNothing was pushed. Fix \`remote\` in your config or your network/credentials, then run \`monosplice push ${subrepo.name}\` again.`,
      )
    }
    if (err instanceof GitError) r.fail(`${subrepo.name}: ${err.message}`)
    r.fail(`${subrepo.name}: ${(err as Error).message}\nNothing was pushed to ${subrepo.remote}.`)
  })

  return result.pushed
    ? {pushed: result.exported.length, awaiting: 0}
    : {pushed: 0, awaiting: result.exported.length}
}

/** Wording that differs between the commands that can trigger a first publish. */
export interface ConfirmFirstPublishOptions {
  /** Skip the question entirely (`--yes`). */
  yes: boolean
  /**
   * Sentence describing what already happened, used in place of "Nothing was pushed." —
   * `attach` has committed the config entry by the time it asks, and must say so.
   */
  stateNote?: string
  /** Extra sentence appended when the user answers no at a terminal. */
  cancelNote?: string
}

/**
 * Publishing to a public remote is irreversible, so the very first push asks. At a terminal
 * that is a prompt; anywhere else it is a refusal naming the exact command, because a CI job
 * must never publish a repository by accident. Never returns when the answer is no.
 */
export async function confirmFirstPublish(
  subrepo: ResolvedSubrepo,
  r: Reporter,
  opts: ConfirmFirstPublishOptions,
): Promise<void> {
  if (opts.yes) return
  const stateNote = opts.stateNote ?? 'Nothing was pushed.'

  if (process.stdin.isTTY && process.stdout.isTTY) {
    const rl = readline.createInterface({input: process.stdin, output: process.stdout})
    let answer: string
    try {
      answer = await rl.question(
        `${subrepo.remote} (${subrepo.branch}) is empty. Publish ${subrepo.name}'s current tree as its first public commit? [y/N] `,
      )
    } finally {
      rl.close()
    }
    if (/^y(es)?$/i.test(answer.trim())) return
    r.fail(`${subrepo.name}: cancelled — nothing was pushed to ${subrepo.remote}.${opts.cancelNote ?? ''}`)
  }

  r.fail(
    `${subrepo.name}: ${subrepo.remote} has no ${subrepo.branch} branch — this would be the first publish of ${subrepo.path}/.
${stateNote} Publishing to a public remote cannot be undone, so monosplice asks first; there is no terminal here to ask at. Run:
  monosplice push ${subrepo.name} --yes
Add --full-history to replay every monorepo commit that touched ${subrepo.path}/ instead of publishing one baseline commit.`,
  )
}

export interface FirstPublishOptions {
  /** Replay every commit touching the path instead of publishing one baseline commit. */
  fullHistory: boolean
  /**
   * Asked once the preflight checks pass and only then — a subrepo with nothing in it must
   * report that, not prompt about publishing nothing. Must fail (never return) to cancel.
   */
  confirm: () => Promise<void>
}

export interface FirstPublishResult {
  commits: number
  fullHistory: boolean
}

/**
 * Outbound first contact. This is what `seed` used to be, now reachable only through `push`
 * so the default path for a new subrepo is one command with one question.
 */
export async function firstPublish(
  root: string,
  subrepo: ResolvedSubrepo,
  r: Reporter,
  opts: FirstPublishOptions,
): Promise<FirstPublishResult> {
  const head = await revParse(root, 'HEAD')
  if (!head) {
    r.fail(`${root} has no commits yet — commit something under ${subrepo.path}/ before publishing ${subrepo.name}.`)
  }
  if (!(await hasCommittedFiles(root, head, subrepo))) r.fail(nothingExistsYet(subrepo))

  await opts.confirm()

  const nothingLeft = `${subrepo.name}: nothing to publish from ${subrepo.path}/ after applying exclude patterns — nothing was pushed.`

  if (opts.fullHistory) {
    const result = await publishFullHistory(root, subrepo, head).catch((err: unknown) => {
      if (err instanceof GitError) r.fail(`${subrepo.name}: ${err.message}`)
      r.fail(`${subrepo.name}: ${(err as Error).message}\nNothing was pushed to ${subrepo.remote}.`)
    })
    if (result.exported.length === 0) r.fail(nothingLeft)
    return {commits: result.exported.length, fullHistory: true}
  }

  const pubSha = await publishBaseline(root, subrepo, head).catch((err: unknown) => {
    if (err instanceof GitError) r.fail(`${subrepo.name}: ${err.message}`)
    r.fail(`${subrepo.name}: ${(err as Error).message}\nNothing was pushed to ${subrepo.remote}.`)
  })
  if (pubSha === null) r.fail(nothingLeft)
  return {commits: 1, fullHistory: false}
}
