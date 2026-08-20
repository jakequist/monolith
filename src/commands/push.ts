import {Args} from '@oclif/core'
import {MonolithCommand} from '../lib/base.js'
import {planExport, runExport} from '../core/exporter.js'
import {GitError} from '../core/git.js'
import {loadSyncView} from '../core/sync.js'

export default class Push extends MonolithCommand {
  static description = 'Export new monorepo commits to the public subrepo remotes'

  static args = {
    subrepo: Args.string({description: 'Only push this subrepo (defaults to all)', required: false}),
  }

  static examples = ['<%= config.bin %> <%= command.id %>', '<%= config.bin %> <%= command.id %> core']

  async run(): Promise<void> {
    const {args} = await this.parse(Push)
    const project = await this.requireProject()

    for (const subrepo of this.selectSubrepos(project, args.subrepo)) {
      const view = await loadSyncView(project.root, subrepo).catch((err: unknown) => {
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

      if (view.unreflectedPub.length > 0) {
        this.error(
          `${subrepo.name}: ${view.unreflectedPub.length} commit(s) on ${subrepo.remote} have not been imported yet.\nNothing was pushed. Run \`monolith pull ${subrepo.name}\` first, then push again.`,
        )
      }

      const {candidates} = await planExport(project.root, subrepo, view)
      const result = await runExport(project.root, subrepo, view, {candidates}).catch((err: unknown) => {
        if (err instanceof GitError) this.error(`${subrepo.name}: ${err.message}`)
        this.error(`${subrepo.name}: ${(err as Error).message}\nNothing was pushed to ${subrepo.remote}.`)
      })

      if (result.exported.length === 0) this.log(`✓ ${subrepo.name}: up to date`)
      else this.log(`✓ ${subrepo.name}: exported ${result.exported.length} commit(s)`)
    }
  }
}
