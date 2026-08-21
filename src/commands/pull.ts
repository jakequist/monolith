import {Args, Flags} from '@oclif/core'
import type {ResolvedSubrepo} from '../config.js'
import {MonospliceCommand} from '../lib/base.js'
import {importSubrepo, pullInProgressMessage, reportImportFailure} from '../lib/ops.js'
import {type PullSequencer, continueImport, readSequencer, unmergedPaths} from '../core/importer.js'

export default class Pull extends MonospliceCommand {
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
          'No pull is in progress — nothing to continue.\nRun `monosplice pull` to import new public commits.',
        )
      }
      await this.resume(root, project.subrepos, state)
      const rest = this.selectSubrepos(project, args.subrepo).filter((s) => s.name !== state.subrepo)
      for (const subrepo of rest) await this.pullOne(root, subrepo)
      return
    }

    if (state) this.error(await pullInProgressMessage(root, state))

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
        `${subrepo.name}: these files are still unmerged:\n${unmerged.map((f) => `  ${f}`).join('\n')}\nResolve them, \`git add\` each one, then run:\n  monosplice pull --continue`,
      )
    }

    const reporter = this.reporter()
    const result = await continueImport(root, subrepo, state, {
      onWarn: (message) => this.logToStderr(message),
    }).catch((err: unknown) => reportImportFailure(subrepo, err, reporter))

    this.report(subrepo, result.imported.length)
  }

  private async pullOne(root: string, subrepo: ResolvedSubrepo): Promise<void> {
    const imported = await importSubrepo(root, subrepo, this.reporter())
    this.report(subrepo, imported)
  }

  private report(subrepo: ResolvedSubrepo, count: number): void {
    if (count === 0) this.log(`✓ ${subrepo.name}: up to date`)
    else this.log(`✓ ${subrepo.name}: imported ${count} commit(s)`)
  }
}
