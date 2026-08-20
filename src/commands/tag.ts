import {Args} from '@oclif/core'
import type {ResolvedSubrepo} from '../config.js'
import {MonolithCommand} from '../lib/base.js'
import {computeExports, planExport} from '../core/exporter.js'
import {GitError, git, pushRef} from '../core/git.js'
import type {SyncView} from '../core/sync.js'
import {loadView, requireSeeded} from '../lib/ops.js'

export default class Tag extends MonolithCommand {
  static description = 'Tag the public commit that corresponds to the current monorepo HEAD'

  static args = {
    subrepo: Args.string({description: 'Name of the subrepo to tag', required: true}),
    tag: Args.string({description: 'Tag name to create on the public remote', required: true}),
  }

  static examples = ['<%= config.bin %> <%= command.id %> core v1.0.0']

  async run(): Promise<void> {
    const {args} = await this.parse(Tag)
    const project = await this.requireProject()
    const subrepo = this.selectSubrepos(project, args.subrepo)[0]
    if (!subrepo) this.error(`Unknown subrepo ${JSON.stringify(args.subrepo)}.`)
    const root = project.root
    const reporter = this.reporter()

    const view = await loadView(root, subrepo, reporter)
    requireSeeded(subrepo, view, reporter)
    // requireSeeded exits the process when pubHead is null; TS cannot see that.
    const pubHead = view.pubHead!

    // A tag is a promise that "this public commit is what the monorepo says it is",
    // so it may only be created when both sides are already reflected in each other.
    await this.requireNothingToPush(root, subrepo, view)
    this.requireNothingToPull(subrepo, view)
    await this.requireTagIsFree(root, subrepo, args.tag)

    await pushRef(root, subrepo.remote, pubHead, `refs/tags/${args.tag}`).catch((err: unknown) => {
      if (err instanceof GitError) {
        this.error(`${subrepo.name}: could not create tag ${args.tag} on ${subrepo.remote}\n${err.stderr}`)
      }
      throw err
    })

    this.log(`✓ ${subrepo.name}: tagged ${args.tag} (${pubHead.slice(0, 10)})`)
  }

  private async requireNothingToPush(
    root: string,
    subrepo: ResolvedSubrepo,
    view: SyncView,
  ): Promise<void> {
    const {candidates} = await planExport(root, subrepo, view)
    const planned = await computeExports(root, subrepo, view, candidates).catch((err: unknown) => {
      this.error(
        `${subrepo.name}: cannot tell what is unexported — ${(err as Error).message}\nNo tag was created on ${subrepo.remote}.`,
      )
    })
    if (planned.length === 0) return

    this.error(
      `${subrepo.name}: ${planned.length} commit(s) have not been exported yet, so ${subrepo.remote} does not match monorepo HEAD.
Tagging now would name a public commit that is missing that work. No tag was created.
Run \`monolith push ${subrepo.name}\` first, then tag again.`,
    )
  }

  private requireNothingToPull(subrepo: ResolvedSubrepo, view: SyncView): void {
    if (view.unreflectedPub.length === 0) return

    this.error(
      `${subrepo.name}: ${view.unreflectedPub.length} commit(s) on ${subrepo.remote} have not been imported yet.
Tagging now would name public work the monorepo has never seen. No tag was created.
Run \`monolith pull ${subrepo.name}\` first, then tag again.`,
    )
  }

  private async requireTagIsFree(root: string, subrepo: ResolvedSubrepo, tag: string): Promise<void> {
    const existing = await git(root, ['ls-remote', subrepo.remote, `refs/tags/${tag}`]).catch(
      (err: unknown) => {
        if (err instanceof GitError) {
          this.error(`${subrepo.name}: cannot reach remote ${subrepo.remote}\n${err.stderr}`)
        }
        throw err
      },
    )
    if (existing === '') return

    const sha = existing.split('\t')[0] ?? '(unknown)'
    this.error(
      `${subrepo.name}: tag ${tag} already exists on ${subrepo.remote} (${sha.slice(0, 10)}).
Monolith never moves an existing public tag. Pick another name, or delete it yourself with:
  git push ${subrepo.remote} :refs/tags/${tag}`,
    )
  }
}
