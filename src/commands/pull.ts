import {Args, Flags} from '@oclif/core'
import type {ResolvedSubrepo} from '../config.js'
import {MonospliceCommand} from '../lib/base.js'
import {RESOLVE_OR_ABORT, importSubrepo, pullInProgressMessage, reportImportFailure} from '../lib/ops.js'
import {
  type AbortResult,
  type PullSequencer,
  abortImport,
  continueImport,
  readSequencer,
  unmergedPaths,
} from '../core/importer.js'

export default class Pull extends MonospliceCommand {
  static description = 'Import new standalone-repo commits into the monorepo'

  static args = {
    subrepo: Args.string({description: 'Only pull this subrepo (defaults to all)', required: false}),
  }

  static flags = {
    continue: Flags.boolean({
      description: 'Finish an import that stopped on a conflict, after resolving and `git add`',
      default: false,
    }),
    abort: Flags.boolean({
      description: 'Abandon an import that stopped on a conflict, restoring the pre-pull state',
      default: false,
    }),
  }

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> core',
    '<%= config.bin %> <%= command.id %> --continue',
    '<%= config.bin %> <%= command.id %> --abort',
  ]

  async run(): Promise<void> {
    const {args, flags} = await this.parse(Pull)
    const project = await this.requireProject()
    const root = project.root
    const state = await readSequencer(root)

    if (flags.abort && flags.continue) {
      this.error(
        '--continue and --abort do the opposite things, so monosplice will not guess between them.\nNothing was changed. Run `monosplice pull --continue` to finish the import, or `monosplice pull --abort` to throw it away.',
      )
    }

    if (flags.abort) {
      await this.abort(root, project.subrepos, state)
      return
    }

    if (flags.continue) {
      if (!state) {
        this.error(
          'No pull is in progress — nothing to continue.\nRun `monosplice pull` to import new standalone-repo commits.',
        )
      }
      const interrupted = project.subrepos.find((s) => s.name === state.subrepo)
      if (!interrupted) this.missingEntry(state)
      const rest = this.selectSubrepos(project, args.subrepo).filter((s) => s.name !== state.subrepo)
      await this.eachSubrepo([interrupted, ...rest], (subrepo) =>
        subrepo.name === state.subrepo ? this.resume(root, subrepo, state) : this.pullOne(root, subrepo),
      )
      return
    }

    if (state) this.error(pullInProgressMessage(state))

    await this.eachSubrepo(this.selectSubrepos(project, args.subrepo), (subrepo) => this.pullOne(root, subrepo))
  }

  /**
   * Throw the interrupted import away. The subrepo path comes from the sequencer, so this
   * still works when the config entry was removed while the pull sat unfinished.
   */
  private async abort(root: string, subrepos: ResolvedSubrepo[], state: PullSequencer | null): Promise<void> {
    if (!state) {
      this.error(
        'No pull is in progress — nothing to abort.\nNothing was changed. Run `monosplice pull` to import new standalone-repo commits.',
      )
    }
    const subPath = state.path ?? subrepos.find((s) => s.name === state.subrepo)?.path
    if (subPath === undefined) this.missingEntry(state)

    const result = await abortImport(root, subPath, state)
    for (const line of this.describeAbort(state, subPath, result)) this.log(line)
  }

  private describeAbort(state: PullSequencer, subPath: string, result: AbortResult): string[] {
    const name = state.subrepo
    if (!result.rewound) {
      const head = result.startHead === null ? null : result.startHead.slice(0, 10)
      return [
        `✓ ${name}: pull aborted — dropped the conflicted import of ${state.current.sha.slice(0, 10)} and restored ${subPath}/.`,
        `  The ${result.kept.length} commit(s) this pull had already imported were KEPT: monorepo history has moved since they landed, and monosplice will not rewind past work it did not create.${
          head === null ? '' : ` Pre-pull HEAD was ${head} — \`git reset --hard ${head}\` would undo the rest.`
        }`,
      ]
    }
    if (result.discarded.length === 0) {
      return [`✓ ${name}: pull aborted — nothing had been imported; ${subPath}/ is as it was before the pull.`]
    }
    return [
      `✓ ${name}: pull aborted — rewound ${result.discarded.length} imported commit(s); ${subPath}/ is as it was before the pull.`,
    ]
  }

  private missingEntry(state: PullSequencer): never {
    return this.error(
      `The interrupted pull references subrepo ${JSON.stringify(state.subrepo)}, which is no longer in your config.
Nothing was changed. Restore the entry in your config, or run \`monosplice pull --abort\` to throw the import away.`,
    )
  }

  private async resume(root: string, subrepo: ResolvedSubrepo, state: PullSequencer): Promise<void> {
    const unmerged = await unmergedPaths(root)
    if (unmerged.length > 0) {
      this.error(
        `${subrepo.name}: these files are still unmerged:\n${unmerged.map((f) => `  ${f}`).join('\n')}\nNothing was changed. Resolve them, \`git add\` each one, then run:\n${RESOLVE_OR_ABORT}`,
      )
    }

    const reporter = this.collectingReporter()
    const result = await continueImport(root, subrepo, state, {
      onWarn: (message) => this.logToStderr(message),
    }).catch((err: unknown) => reportImportFailure(subrepo, err, reporter))

    this.report(subrepo, result.imported.length)
  }

  private async pullOne(root: string, subrepo: ResolvedSubrepo): Promise<void> {
    const imported = await importSubrepo(root, subrepo, this.collectingReporter())
    this.report(subrepo, imported)
  }

  private report(subrepo: ResolvedSubrepo, count: number): void {
    if (count === 0) this.log(`✓ ${subrepo.name}: up to date`)
    else this.log(`✓ ${subrepo.name}: imported ${count} commit(s)`)
  }
}
