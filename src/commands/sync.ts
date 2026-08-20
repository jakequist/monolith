import {Args} from '@oclif/core'
import {MonolithCommand} from '../lib/base.js'
import {readSequencer} from '../core/importer.js'
import {exportSubrepo, importSubrepo, pullInProgressMessage} from '../lib/ops.js'

export default class Sync extends MonolithCommand {
  static description = 'Pull then push each subrepo, converging the monorepo with its public remotes'

  static args = {
    subrepo: Args.string({description: 'Only sync this subrepo (defaults to all)', required: false}),
  }

  static examples = ['<%= config.bin %> <%= command.id %>', '<%= config.bin %> <%= command.id %> core']

  async run(): Promise<void> {
    const {args} = await this.parse(Sync)
    const project = await this.requireProject()
    const root = project.root

    const state = await readSequencer(root)
    if (state) this.error(await pullInProgressMessage(root, state))

    const reporter = this.reporter()
    // Import before export, one subrepo at a time: a conflict must stop everything, or a
    // later subrepo would be published from a monorepo that is only half converged.
    for (const subrepo of this.selectSubrepos(project, args.subrepo)) {
      const imported = await importSubrepo(root, subrepo, reporter)
      const exported = await exportSubrepo(root, subrepo, reporter)

      if (imported === 0 && exported === 0) this.log(`✓ ${subrepo.name}: up to date`)
      else this.log(`✓ ${subrepo.name}: imported ${imported}, exported ${exported}`)
    }
  }
}
