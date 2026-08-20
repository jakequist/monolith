import {Args, Flags} from '@oclif/core'
import type {ResolvedSubrepo} from '../config.js'
import {MonolithCommand} from '../lib/base.js'
import {GitError} from '../core/git.js'
import {
  ImportConflictError,
  type PullSequencer,
  checkImportPreconditions,
  continueImport,
  readSequencer,
  runImport,
  sequencerPath,
  unmergedPaths,
} from '../core/importer.js'
import {loadSyncView} from '../core/sync.js'

export default class Pull extends MonolithCommand {
  static description = 'Import new public subrepo commits into the monorepo'

  static args = {
    subrepo: Args.string({description: 'Only pull this subrepo (defaults to all)', required: false}),
  }

  static flags = {
    continue: Flags.boolean({
      description: 'Finish an import that stopped on a conflict, after resolving and `git add`',
      default: false,
    }),
  }

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> core',
    '<%= config.bin %> <%= command.id %> --continue',
  ]

  async run(): Promise<void> {
    const {args, flags} = await this.parse(Pull)
    const project = await this.requireProject()
    const root = project.root
    const state = await readSequencer(root)

    if (flags.continue) {
      if (!state) {
        this.error(
          'No pull is in progress — nothing to continue.\nRun `monolith pull` to import new public commits.',
        )
      }
      await this.resume(root, project.subrepos, state)
      const rest = this.selectSubrepos(project, args.subrepo).filter((s) => s.name !== state.subrepo)
      for (const subrepo of rest) await this.pullOne(root, subrepo)
      return
    }

    if (state) {
      this.error(
        `A pull of ${state.subrepo} is already in progress.\nResolve the conflict, \`git add\` the files, then run:\n  monolith pull --continue\nTo abort instead, delete ${await sequencerPath(root)}.`,
      )
    }

    for (const subrepo of this.selectSubrepos(project, args.subrepo)) await this.pullOne(root, subrepo)
  }

  private async resume(root: string, subrepos: ResolvedSubrepo[], state: PullSequencer): Promise<void> {
    const subrepo = subrepos.find((s) => s.name === state.subrepo)
    if (!subrepo) {
      this.error(
        `The interrupted pull references subrepo ${JSON.stringify(state.subrepo)}, which is no longer in your config.\nRestore it, or delete the pull-state.json file under your git dir to abort.`,
      )
    }

    const unmerged = await unmergedPaths(root)
    if (unmerged.length > 0) {
      this.error(
        `${subrepo.name}: these files are still unmerged:\n${unmerged.map((f) => `  ${f}`).join('\n')}\nResolve them, \`git add\` each one, then run:\n  monolith pull --continue`,
      )
    }

    const result = await continueImport(root, subrepo, state, {
      onWarn: (message) => this.logToStderr(message),
    }).catch((err: unknown) => this.reportImportFailure(subrepo, err))

    this.report(subrepo, result.imported.length)
  }

  private async pullOne(root: string, subrepo: ResolvedSubrepo): Promise<void> {
    const view = await loadSyncView(root, subrepo).catch((err: unknown) => {
      if (err instanceof GitError) {
        this.error(`${subrepo.name}: cannot reach remote ${subrepo.remote}\n${err.stderr}`)
      }
      throw err
    })

    if (view.pubHead === null) {
      this.error(
        `${subrepo.name}: ${subrepo.remote} has no ${subrepo.branch} branch — this subrepo has not been seeded.\nRun \`monolith seed ${subrepo.name}\` to publish it for the first time.`,
      )
    }

    const problem = await checkImportPreconditions(root, subrepo)
    if (problem) this.error(problem)

    const result = await runImport(root, subrepo, view.unreflectedPub, {
      onWarn: (message) => this.logToStderr(message),
    }).catch((err: unknown) => this.reportImportFailure(subrepo, err))

    this.report(subrepo, result.imported.length)
  }

  private report(subrepo: ResolvedSubrepo, count: number): void {
    if (count === 0) this.log(`✓ ${subrepo.name}: up to date`)
    else this.log(`✓ ${subrepo.name}: imported ${count} commit(s)`)
  }

  private reportImportFailure(subrepo: ResolvedSubrepo, err: unknown): never {
    if (err instanceof ImportConflictError) {
      this.error(
        `${subrepo.name}: importing ${err.pubSha.slice(0, 10)} conflicts with local changes.\nConflicted files:\n${err.conflicts.map((f) => `  ${f}`).join('\n')}\nEdit each file to resolve the markers, \`git add\` it, then run:\n  monolith pull --continue\nTo abort instead, delete ${err.statePath}.`,
      )
    }
    if (err instanceof GitError) this.error(`${subrepo.name}: ${err.message}`)
    this.error(`${subrepo.name}: ${(err as Error).message}`)
  }
}
