import {Args, Flags} from '@oclif/core'
import type {Project} from '../config.js'
import {MonospliceCommand} from '../lib/base.js'
import {
  type PullSequencer,
  continueImport,
  readSequencer,
  unmergedPaths,
} from '../core/importer.js'
import {
  NO_PULL_IN_PROGRESS,
  exportSubrepo,
  importSubrepo,
  pullInProgressMessage,
  reportImportFailure,
  resolveOrAbort,
} from '../lib/ops.js'

/** `sync` finishes its own interrupted run, so its conflict names its own verb. */
const SYNC_CONTINUE = 'monosplice sync --continue'

export default class Sync extends MonospliceCommand {
  static description = 'Pull then push each subrepo, converging the monorepo with its standalone remotes'

  static args = {
    subrepo: Args.string({description: 'Only sync this subrepo (defaults to all)', required: false}),
  }

  static flags = {
    continue: Flags.boolean({
      description:
        'Finish a sync that stopped on a conflict, after resolving and `git add`: completes the import, then pushes every subrepo (the push phase never ran)',
      default: false,
    }),
  }

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> core',
    '<%= config.bin %> <%= command.id %> --continue',
  ]

  async run(): Promise<void> {
    const {args, flags} = await this.parse(Sync)
    const project = await this.requireProject()
    const root = project.root

    const state = await readSequencer(root)
    if (flags.continue) {
      if (!state) this.error(NO_PULL_IN_PROGRESS)
    } else if (state) {
      this.error(pullInProgressMessage(state, SYNC_CONTINUE))
    }

    // Resolved before anything is written, so an unknown name refuses without side effects.
    // The subrepo that was interrupted is always part of the walk, even when a different one
    // was named: it is the one whose push phase never ran.
    const selected = this.selectSubrepos(project, args.subrepo)
    const interrupted = state ? project.subrepos.find((s) => s.name === state.subrepo) : undefined
    const walk = interrupted && !selected.includes(interrupted) ? [interrupted, ...selected] : selected

    // Commits the interrupted import landed before the walk resumes. They belong to the
    // subrepo's tally below, which would otherwise report the resumed pull as "imported 0".
    const resumed = new Map<string, number>()
    if (state) resumed.set(state.subrepo, await this.resume(project, state))

    const reporter = this.collectingReporter()
    // Import before export for each subrepo: publishing from a half-converged monorepo would
    // export work the standalone repo has not been reconciled with. A subrepo that refuses is
    // collected and the next one still runs — except a conflict, which halts the run.
    //
    // After a `--continue` this walks EVERY selected subrepo again, push included: the
    // interrupted run never reached its push phase, and a subrepo that is already converged
    // simply reports "up to date".
    await this.eachSubrepo(walk, async (subrepo) => {
      const imported = (resumed.get(subrepo.name) ?? 0) + (await importSubrepo(root, subrepo, reporter, SYNC_CONTINUE))
      const {pushed} = await exportSubrepo(root, subrepo, reporter)

      if (imported === 0 && pushed === 0) this.log(`✓ ${subrepo.name}: up to date`)
      else this.log(`✓ ${subrepo.name}: imported ${imported}, exported ${pushed}`)
    })
  }

  /** Finish the commit the user just resolved, exactly as `pull --continue` does. */
  private async resume(project: Project, state: PullSequencer): Promise<number> {
    const root = project.root
    const subrepo = project.subrepos.find((s) => s.name === state.subrepo)
    if (!subrepo) {
      this.error(
        `The interrupted pull references subrepo ${JSON.stringify(state.subrepo)}, which is no longer in your config.
Nothing was changed. Restore the entry in your config, or run \`monosplice pull --abort\` to throw the import away.`,
      )
    }

    const unmerged = await unmergedPaths(root)
    if (unmerged.length > 0) {
      this.error(
        `${subrepo.name}: these files are still unmerged:\n${unmerged.map((f) => `  ${f}`).join('\n')}\nNothing was changed. Resolve them, \`git add\` each one, then run:\n${resolveOrAbort(SYNC_CONTINUE)}`,
      )
    }

    // Not the collecting reporter: this runs before the walk, so a second conflict has no
    // walk to be collected into and must stop the command where it stands.
    const result = await continueImport(root, subrepo, state, {
      onWarn: (message) => this.logToStderr(message),
    }).catch((err: unknown) => reportImportFailure(subrepo, err, this.reporter(), SYNC_CONTINUE))

    return result.imported.length
  }
}
