import {Args} from '@oclif/core'
import {MonospliceCommand} from '../lib/base.js'
import {readSequencer} from '../core/importer.js'
import {exportSubrepo, importSubrepo, pullInProgressMessage} from '../lib/ops.js'

export default class Sync extends MonospliceCommand {
  static description = 'Pull then push each subrepo, converging the monorepo with its standalone remotes'

  static args = {
    subrepo: Args.string({description: 'Only sync this subrepo (defaults to all)', required: false}),
  }

  static examples = ['<%= config.bin %> <%= command.id %>', '<%= config.bin %> <%= command.id %> core']

  async run(): Promise<void> {
    const {args} = await this.parse(Sync)
    const project = await this.requireProject()
    const root = project.root

    const state = await readSequencer(root)
    if (state) this.error(pullInProgressMessage(state))

    const reporter = this.collectingReporter()
    // Import before export for each subrepo: publishing from a half-converged monorepo would
    // export work the standalone repo has not been reconciled with. A subrepo that refuses is
    // collected and the next one still runs — except a conflict, which halts the run.
    await this.eachSubrepo(this.selectSubrepos(project, args.subrepo), async (subrepo) => {
      const imported = await importSubrepo(root, subrepo, reporter)
      const {pushed} = await exportSubrepo(root, subrepo, reporter)

      if (imported === 0 && pushed === 0) this.log(`✓ ${subrepo.name}: up to date`)
      else this.log(`✓ ${subrepo.name}: imported ${imported}, exported ${pushed}`)
    })
  }
}
