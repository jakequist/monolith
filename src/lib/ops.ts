import type {ResolvedSubrepo} from '../config.js'
import {checkExportPreconditions, planExport, runExport} from '../core/exporter.js'
import {GitError} from '../core/git.js'
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

/** Derive the sync view, turning an unreachable remote into a user-facing error. */
export async function loadView(root: string, subrepo: ResolvedSubrepo, r: Reporter): Promise<SyncView> {
  return loadSyncView(root, subrepo).catch((err: unknown) => {
    if (err instanceof GitError) {
      r.fail(`${subrepo.name}: cannot reach remote ${subrepo.remote}\n${err.stderr}`)
    }
    throw err
  })
}

export function requireSeeded(subrepo: ResolvedSubrepo, view: SyncView, r: Reporter): void {
  if (view.pubHead === null) {
    r.fail(
      `${subrepo.name}: ${subrepo.remote} has no ${subrepo.branch} branch — this subrepo has not been seeded.\nRun \`monolith seed ${subrepo.name}\` to publish it for the first time.`,
    )
  }
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
  requireSeeded(subrepo, view, r)

  const problem = await checkImportPreconditions(root, subrepo)
  if (problem) r.fail(problem)

  const result = await runImport(root, subrepo, view.unreflectedPub, {
    onWarn: (message) => r.warn(message),
  }).catch((err: unknown) => reportImportFailure(subrepo, err, r))

  return result.imported.length
}

/** Export every pending monorepo commit. Returns how many public commits were created. */
export async function exportSubrepo(root: string, subrepo: ResolvedSubrepo, r: Reporter): Promise<number> {
  const view = await loadView(root, subrepo, r)
  requireSeeded(subrepo, view, r)

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
