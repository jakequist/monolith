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
import {loadSyncView, type SyncView} from '../core/sync.js'

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

/** Derive the sync view, turning an unreachable remote into a user-facing error. */
export async function loadView(root: string, subrepo: ResolvedSubrepo, r: Reporter): Promise<SyncView> {
  return loadSyncView(root, subrepo).catch((err: unknown) => {
    if (err instanceof GitError) {
      r.fail(`${subrepo.name}: cannot reach remote ${subrepo.remote}\n${err.stderr}`)
    }
    throw err
  })
}

/** Neither side has anything: the one matrix cell where no monolith command can help. */
export function nothingExistsYet(subrepo: ResolvedSubrepo): string {
  return `${subrepo.name}: nothing exists yet — ${subrepo.path}/ has no committed files at HEAD, and ${subrepo.remote} has no ${subrepo.branch} branch.
Commit something under ${subrepo.path}/ and run \`monolith push ${subrepo.name} --yes\` to publish it, or run \`monolith adopt ${subrepo.name}\` once the remote has content.`
}

/** The public branch has history, but nothing on either side references the other. */
export function unrelatedRemote(subrepo: ResolvedSubrepo, consequence: string): string {
  return `${subrepo.name}: ${subrepo.remote} (${subrepo.branch}) has history that is unrelated to this monorepo — no commit on either side references the other.
${consequence} To connect the two repositories, run:
  monolith adopt ${subrepo.name}`
}

/** Stop unless the public branch exists, distinguishing "not published" from "nothing at all". */
export async function requirePublished(
  root: string,
  subrepo: ResolvedSubrepo,
  view: SyncView,
  r: Reporter,
): Promise<void> {
  if (view.pubHead !== null) return
  const head = await revParse(root, 'HEAD')
  if (!head || !(await hasCommittedFiles(root, head, subrepo))) r.fail(nothingExistsYet(subrepo))
  r.fail(
    `${subrepo.name}: ${subrepo.remote} has no ${subrepo.branch} branch — this subrepo has not been published yet.\nRun \`monolith push ${subrepo.name} --yes\` to publish ${subrepo.path}/ for the first time.`,
  )
}

/** Shared by `pull` and `sync`: neither may start while a sequencer sits on disk. */
export async function pullInProgressMessage(root: string, state: PullSequencer): Promise<string> {
  return `A pull of ${state.subrepo} is already in progress.\nResolve the conflict, \`git add\` the files, then run:\n  monolith pull --continue\nTo abort instead, delete ${await sequencerPath(root)}.`
}

export function reportImportFailure(subrepo: ResolvedSubrepo, err: unknown, r: Reporter): never {
  if (err instanceof ImportConflictError) {
    r.fail(
      `${subrepo.name}: importing ${err.pubSha.slice(0, 10)} conflicts with local changes.\nConflicted files:\n${err.conflicts.map((f) => `  ${f}`).join('\n')}\nEdit each file to resolve the markers, \`git add\` it, then run:\n  monolith pull --continue\nTo abort instead, delete ${err.statePath}.`,
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

/** Export every pending monorepo commit. Returns how many public commits were created. */
export async function exportSubrepo(
  root: string,
  subrepo: ResolvedSubrepo,
  r: Reporter,
  loaded?: SyncView,
): Promise<number> {
  const view = loaded ?? (await loadView(root, subrepo, r))
  await requirePublished(root, subrepo, view, r)
  if (!view.related) r.fail(unrelatedRemote(subrepo, `Nothing was pushed to ${subrepo.remote}.`))

  const unsafe = await checkExportPreconditions(root, subrepo, view)
  if (unsafe) r.fail(unsafe)

  if (view.unreflectedPub.length > 0) {
    r.fail(
      `${subrepo.name}: ${view.unreflectedPub.length} commit(s) on ${subrepo.remote} have not been imported yet.\nNothing was pushed. Run \`monolith pull ${subrepo.name}\` first, then push again.`,
    )
  }

  const {candidates} = await planExport(root, subrepo, view)
  const result = await runExport(root, subrepo, view, {candidates}).catch((err: unknown) => {
    if (err instanceof GitError) r.fail(`${subrepo.name}: ${err.message}`)
    r.fail(`${subrepo.name}: ${(err as Error).message}\nNothing was pushed to ${subrepo.remote}.`)
  })

  return result.exported.length
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
