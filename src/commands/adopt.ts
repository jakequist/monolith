import {Args, Flags} from '@oclif/core'
import type {ResolvedSubrepo} from '../config.js'
import {MonolithCommand} from '../lib/base.js'
import {applyTreeInto, commitAdopt, differingPaths} from '../core/adopt.js'
import {filteredSubtree, hasCommittedFiles} from '../core/filter.js'
import {EMPTY_TREE, git, revParse} from '../core/git.js'
import {checkImportPreconditions, readSequencer, runImport} from '../core/importer.js'
import type {SyncView} from '../core/sync.js'
import {
  loadView,
  nothingExistsYet,
  pullInProgressMessage,
  reportImportFailure,
  type Reporter,
} from '../lib/ops.js'

export default class Adopt extends MonolithCommand {
  static description = 'Connect a subrepo to a public remote that already has its own history'

  static args = {
    subrepo: Args.string({description: 'Name of the subrepo to adopt', required: true}),
  }

  static flags = {
    history: Flags.boolean({
      description: 'Replay every public commit instead of recording one snapshot commit',
      default: false,
    }),
    theirs: Flags.boolean({
      description: 'When both sides have content, replace the local directory with the public tree',
      default: false,
    }),
  }

  static examples = [
    '<%= config.bin %> <%= command.id %> core',
    '<%= config.bin %> <%= command.id %> core --history',
    '<%= config.bin %> <%= command.id %> core --theirs',
  ]

  async run(): Promise<void> {
    const {args, flags} = await this.parse(Adopt)
    const project = await this.requireProject()
    const subrepo = this.selectSubrepos(project, args.subrepo)[0]
    if (!subrepo) this.error(`Unknown subrepo ${JSON.stringify(args.subrepo)}.`)
    const root = project.root
    const r = this.reporter()

    // Preconditions before the network: a dirty tree must be reported without side effects,
    // not after a fetch has already written a tracking ref.
    const state = await readSequencer(root)
    if (state) this.error(await pullInProgressMessage(root, state))
    const problem = await checkImportPreconditions(root, subrepo, `monolith adopt ${subrepo.name}`)
    if (problem) this.error(problem)

    const view = await loadView(root, subrepo, r)
    const pubHead = await this.requireAdoptable(root, subrepo, view)

    // checkImportPreconditions already refused a monorepo with no commits.
    const head = (await revParse(root, 'HEAD')) ?? 'HEAD'
    const count = (await hasCommittedFiles(root, head, subrepo))
      ? await this.adoptOverContent(root, subrepo, head, pubHead, r, flags)
      : await this.adoptIntoEmptyPath(root, subrepo, view, pubHead, r, flags)

    this.log(
      `✓ ${subrepo.name}: adopted ${subrepo.remote} (${subrepo.branch}) at ${pubHead.slice(0, 10)} — ${count} commit(s)`,
    )
    this.log(`  ${subrepo.path}/ and the remote are now in sync; push and pull as usual.`)
  }

  /** Stop unless this really is inbound first contact. Returns the public head. */
  private async requireAdoptable(
    root: string,
    subrepo: ResolvedSubrepo,
    view: SyncView,
  ): Promise<string> {
    if (view.pubHead === null) {
      const head = await revParse(root, 'HEAD')
      if (!head || !(await hasCommittedFiles(root, head, subrepo))) this.error(nothingExistsYet(subrepo))
      this.error(
        `${subrepo.name}: ${subrepo.remote} has no ${subrepo.branch} branch, so there is nothing to adopt.
Run \`monolith push ${subrepo.name} --yes\` to publish ${subrepo.path}/ instead.`,
      )
    }
    if (view.related) {
      this.error(
        `${subrepo.name}: already connected to ${subrepo.remote} — monolith trailers already link the two repositories, so there is nothing to adopt.
Nothing was changed. Run \`monolith pull ${subrepo.name}\` to import new public commits, \`monolith push ${subrepo.name}\` to export new monorepo commits, or \`monolith sync ${subrepo.name}\` for both.`,
      )
    }
    return view.pubHead
  }

  /** The subrepo directory does not exist yet: take the public repo wholesale. */
  private async adoptIntoEmptyPath(
    root: string,
    subrepo: ResolvedSubrepo,
    view: SyncView,
    pubHead: string,
    r: Reporter,
    flags: {history: boolean},
  ): Promise<number> {
    if (flags.history) {
      const result = await runImport(root, subrepo, view.unreflectedPub, {
        onWarn: (message) => this.logToStderr(message),
      }).catch((err: unknown) => reportImportFailure(subrepo, err, r))
      return result.imported.length
    }

    const pubTree = await git(root, ['rev-parse', `${pubHead}^{tree}`])
    await applyTreeInto(root, subrepo, EMPTY_TREE, pubTree)
    await commitAdopt(root, subrepo, pubHead)
    return 1
  }

  /** Both sides have content: either the trees already agree, or the user must choose. */
  private async adoptOverContent(
    root: string,
    subrepo: ResolvedSubrepo,
    head: string,
    pubHead: string,
    r: Reporter,
    flags: {history: boolean; theirs: boolean},
  ): Promise<number> {
    if (flags.history) {
      this.error(
        `${subrepo.name}: --history replays the public history into an empty path, but ${subrepo.path}/ already has committed files.
Nothing was changed. Run \`monolith adopt ${subrepo.name}\` (add --theirs if the public tree should win).`,
      )
    }

    const monoTree = (await filteredSubtree(root, head, subrepo).catch((err: unknown) => {
      r.fail(`${subrepo.name}: ${(err as Error).message}\nNothing was changed.`)
    })) ?? EMPTY_TREE
    const pubTree = await git(root, ['rev-parse', `${pubHead}^{tree}`])

    if (monoTree !== pubTree && !flags.theirs) {
      const paths = await differingPaths(root, monoTree, pubTree)
      this.error(
        `${subrepo.name}: ${subrepo.path}/ and ${subrepo.remote} (${subrepo.branch}) both have content, and their trees differ:
${paths.map((p) => `  ${p}`).join('\n')}
Nothing was changed. Either make the two trees match and run \`monolith adopt ${subrepo.name}\` again, or take the public tree wholesale:
  monolith adopt ${subrepo.name} --theirs`,
      )
    }

    if (monoTree !== pubTree) await applyTreeInto(root, subrepo, monoTree, pubTree)
    await commitAdopt(root, subrepo, pubHead)
    return 1
  }
}
