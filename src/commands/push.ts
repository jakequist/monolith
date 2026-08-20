import {Args} from '@oclif/core'
import {MonolithCommand} from '../lib/base.js'
import {exportSubrepo} from '../lib/ops.js'

export default class Push extends MonolithCommand {
  static description = 'Export new monorepo commits to the public subrepo remotes'

  static args = {
    subrepo: Args.string({description: 'Only push this subrepo (defaults to all)', required: false}),
  }

  static examples = ['<%= config.bin %> <%= command.id %>', '<%= config.bin %> <%= command.id %> core']

  async run(): Promise<void> {
    const {args} = await this.parse(Push)
    const project = await this.requireProject()
    const reporter = this.reporter()

    for (const subrepo of this.selectSubrepos(project, args.subrepo)) {
      const exported = await exportSubrepo(project.root, subrepo, reporter)
      if (exported === 0) this.log(`✓ ${subrepo.name}: up to date`)
      else this.log(`✓ ${subrepo.name}: exported ${exported} commit(s)`)
    }
  }
}
