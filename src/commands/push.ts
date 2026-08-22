import {Args, Flags} from '@oclif/core'
import type {ResolvedSubrepo} from '../config.js'
import {MonospliceCommand} from '../lib/base.js'
import {
  DRY_RUN_NOTE,
  confirmFirstPublish,
  exportSubrepo,
  firstPublish,
  loadView,
  planPushDryRun,
  upstreamHasNoBranch,
  type Reporter,
} from '../lib/ops.js'

interface PushFlags {
  yes: boolean
  'export-history': boolean
  'dry-run': boolean
}

export default class Push extends MonospliceCommand {
  static description = 'Export new monorepo commits to the standalone subrepo remotes'

  static args = {
    subrepo: Args.string({description: 'Only push this subrepo (defaults to all)', required: false}),
  }

  static flags = {
    yes: Flags.boolean({
      char: 'y',
      description: 'Answer the first-publish confirmation with yes (required in scripts and CI)',
      default: false,
    }),
    'export-history': Flags.boolean({
      description:
        'First publish only: replay every monorepo commit that touched the subrepo instead of one baseline commit (not to be confused with `attach --import-history`, which replays the standalone repo\'s commits inwards)',
      default: false,
    }),
    'dry-run': Flags.boolean({
      description:
        'List the commits a push would export and write nothing — no remote ref, no commit, no working-tree change. Scan/transform hooks do NOT run on a dry run, so the list is what would be attempted; the hooks still gate the real push and a rejected commit will stop it.',
      default: false,
    }),
  }

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> core',
    '<%= config.bin %> <%= command.id %> --dry-run',
    '<%= config.bin %> <%= command.id %> core --yes',
    '<%= config.bin %> <%= command.id %> core --yes --export-history',
  ]

  async run(): Promise<void> {
    const {args, flags} = await this.parse(Push)
    const project = await this.requireProject()

    // One subrepo refusing (typically: never published, no --yes) must not silence the
    // others, so failures are collected and reported together at the end.
    const reporter = this.collectingReporter()
    const selected = this.selectSubrepos(project, args.subrepo)

    if (flags['dry-run']) {
      await this.eachSubrepo(selected, (subrepo) => this.previewOne(project.root, subrepo, reporter, flags))
      return
    }

    await this.eachSubrepo(selected, (subrepo) => this.pushOne(project.root, subrepo, reporter, flags))
  }

  /** Report the plan and stop. Every call below this line is a read. */
  private async previewOne(
    root: string,
    subrepo: ResolvedSubrepo,
    r: Reporter,
    flags: PushFlags,
  ): Promise<void> {
    const plan = await planPushDryRun(root, subrepo, r, {exportHistory: flags['export-history']})

    if (plan.kind === 'first-publish') {
      const how = plan.exportHistory
        ? `replaying ${plan.commits.length} commit(s)`
        : 'one baseline commit'
      this.log(
        `${subrepo.name}: would publish ${subrepo.path}/ to ${subrepo.remote} (${subrepo.branch}) for the first time — ${how} (${DRY_RUN_NOTE})`,
      )
    } else if (plan.commits.length === 0) {
      this.log(`${subrepo.name}: up to date (${DRY_RUN_NOTE})`)
      return
    } else {
      this.log(`${subrepo.name}: ${plan.commits.length} to push (${DRY_RUN_NOTE})`)
    }

    for (const c of plan.commits) this.log(`  ${c.sha.slice(0, 10)} ${c.subject}`)
  }

  private async pushOne(
    root: string,
    subrepo: ResolvedSubrepo,
    r: Reporter,
    flags: PushFlags,
  ): Promise<void> {
    const view = await loadView(root, subrepo, r)

    if (view.pubHead === null && subrepo.upstream !== undefined) r.fail(upstreamHasNoBranch(subrepo))

    if (view.pubHead === null) {
      const result = await firstPublish(root, subrepo, r, {
        exportHistory: flags['export-history'],
        confirm: () => confirmFirstPublish(subrepo, r, {yes: flags.yes}),
      })
      const how = result.exportHistory ? `replayed ${result.commits} commit(s)` : 'one baseline commit'
      this.log(`✓ ${subrepo.name}: published ${subrepo.path}/ to ${subrepo.remote} (${subrepo.branch}) — ${how}`)
      return
    }

    if (flags['export-history']) {
      r.fail(
        `${subrepo.name}: --export-history only applies to the first publish, and ${subrepo.remote} already has a ${subrepo.branch} branch (${view.pubHead.slice(0, 10)}).
Nothing was pushed. Run \`monosplice push ${subrepo.name}\` to export new commits.`,
      )
    }

    const {pushed, awaiting} = await exportSubrepo(root, subrepo, r, view)
    const fork = subrepo.upstream === undefined ? '' : ` to ${subrepo.remote} (${subrepo.pushBranch})`

    if (pushed > 0) this.log(`✓ ${subrepo.name}: exported ${pushed} commit(s)${fork}`)
    else if (awaiting > 0) {
      this.log(
        `✓ ${subrepo.name}: up to date — ${subrepo.remote} (${subrepo.pushBranch}) already carries ${awaiting} commit(s), awaiting an upstream merge`,
      )
    } else this.log(`✓ ${subrepo.name}: up to date`)
  }
}
