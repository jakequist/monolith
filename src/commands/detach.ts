import {Args} from '@oclif/core'
import type {Project, ResolvedSubrepo} from '../config.js'
import {MonospliceCommand} from '../lib/base.js'
import {commitStaged} from '../core/adopt.js'
import {git} from '../core/git.js'
import {readSequencer} from '../core/importer.js'
import {normalizeSubrepoPath} from '../core/paths.js'
import {pullSource} from '../core/sync.js'
import {checkConfigEditPreconditions, deleteItYourself, removeConfigEntry} from '../core/vendor.js'

export default class Detach extends MonospliceCommand {
  static description =
    'Stop tracking a subrepo: remove its entry from the config, keeping the folder and all of its history'

  static args = {
    subrepo: Args.string({description: 'Subrepo to stop tracking (its name, or its folder)', required: true}),
  }

  static examples = [
    '<%= config.bin %> <%= command.id %> core',
    '<%= config.bin %> <%= command.id %> packages/lib',
  ]

  async run(): Promise<void> {
    const {args} = await this.parse(Detach)
    const project = await this.requireProject()
    const root = project.root

    const entry = this.findEntry(project, args.subrepo)
    if (!entry) {
      this.error(
        `Unknown subrepo ${JSON.stringify(args.subrepo)}. Configured subrepos: ${project.subrepos.map((s) => s.name).join(', ') || '(none)'}
Nothing was changed.`,
      )
    }

    const retry = `monosplice detach ${args.subrepo}`

    // Everything below writes something. Nothing above did — and nothing here, or anywhere in
    // this command, opens a network connection: detaching is a config edit, not a sync.
    const state = await readSequencer(root)
    if (state && state.subrepo === entry.name) {
      this.error(
        `A pull of ${entry.name} is unfinished, so detaching it now would strand the import mid-flight.
Nothing was changed. Finish it with \`monosplice pull --continue\`, or throw it away with \`monosplice pull --abort\`, then run \`${retry}\` again.`,
      )
    }
    const problem = await checkConfigEditPreconditions(root, retry, 'Detaching')
    if (problem) this.error(problem)

    const failure = await removeConfigEntry(project, entry)
    if (failure) {
      const {log, error} = deleteItYourself(project.configPath, entry, failure)
      this.log(log)
      this.error(error)
    }

    const source = pullSource(entry)
    await git(root, ['add', '--', project.configPath])
    await commitStaged(root, `Detach ${entry.name}: stop tracking ${source}`)

    this.log(`✓ detached ${entry.name} — ${project.configPath} no longer tracks ${source}`)
    this.log(`  ${entry.path}/ is kept exactly as it is, and every commit stays in your monorepo history.`)
    this.log(
      `  The Monosplice trailers on those commits are inert now: nothing is pushed or pulled for ${entry.name} any more.`,
    )
    this.log('  To connect it again later:')
    this.log(`    monosplice attach ${entry.path} ${source}${entry.upstream === undefined ? '' : ` --fork ${entry.remote}`}`)
  }

  /** The configured subrepo this argument names — by name, or failing that by path. */
  private findEntry(project: Project, arg: string): ResolvedSubrepo | undefined {
    const byName = project.subrepos.find((s) => s.name === arg)
    if (byName) return byName
    let subPath: string
    try {
      subPath = normalizeSubrepoPath(arg)
    } catch {
      return undefined
    }
    return project.subrepos.find((s) => s.path === subPath)
  }
}
