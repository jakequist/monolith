import {Args, Flags} from '@oclif/core'
import type {ResolvedSubrepo} from '../config.js'
import {MonolithCommand} from '../lib/base.js'
import {filteredSubtree} from '../core/filter.js'
import {runExport} from '../core/exporter.js'
import {
  EMPTY_TREE,
  GitError,
  commitTree,
  git,
  lsRemoteBranch,
  lsTreeRecursive,
  pushRef,
  readCommit,
  revList,
  revParse,
} from '../core/git.js'
import {remoteTrackingRef, type SyncView} from '../core/sync.js'
import {SOURCE_TRAILER, appendTrailer} from '../core/trailers.js'

export default class Seed extends MonolithCommand {
  static description = 'Publish a subrepo to its public remote for the first time'

  static args = {
    subrepo: Args.string({description: 'Name of the subrepo to publish', required: true}),
  }

  static flags = {
    'full-history': Flags.boolean({
      description: 'Replay every commit touching the subrepo instead of one squashed import',
      default: false,
    }),
  }

  static examples = [
    '<%= config.bin %> <%= command.id %> core',
    '<%= config.bin %> <%= command.id %> core --full-history',
  ]

  async run(): Promise<void> {
    const {args, flags} = await this.parse(Seed)
    const project = await this.requireProject()
    const subrepo = this.selectSubrepos(project, args.subrepo)[0]
    if (!subrepo) this.error(`Unknown subrepo ${JSON.stringify(args.subrepo)}.`)
    const root = project.root

    const remoteHead = await lsRemoteBranch(root, subrepo.remote, subrepo.branch).catch((err: unknown) => {
      if (err instanceof GitError) {
        this.error(`${subrepo.name}: cannot reach remote ${subrepo.remote}\n${err.stderr}`)
      }
      throw err
    })
    if (remoteHead !== null) {
      this.error(
        `${subrepo.name}: ${subrepo.remote} already has a ${subrepo.branch} branch (${remoteHead.slice(0, 10)}).\nIt looks like this subrepo is already seeded — use \`monolith push ${subrepo.name}\` to export new commits, or \`monolith pull ${subrepo.name}\` to import what is already there.`,
      )
    }

    const head = await revParse(root, 'HEAD')
    if (!head) {
      this.error(`${root} has no commits yet — commit something under ${subrepo.path}/ before seeding.`)
    }

    // Check the raw subtree before hooks so "nothing committed here" beats any hook error.
    const rawEntries = await lsTreeRecursive(root, `${head}:${subrepo.path}`).catch(() => [])
    if (rawEntries.length === 0) {
      this.error(
        `${subrepo.name}: ${subrepo.path}/ has no committed files at HEAD — nothing to publish, nothing was pushed.\nCommit some files under ${subrepo.path}/ and try again.`,
      )
    }

    const count = flags['full-history']
      ? await this.seedFullHistory(root, subrepo, head)
      : await this.seedSquashed(root, subrepo, head)

    this.log(`✓ ${subrepo.name}: seeded ${subrepo.remote} (${subrepo.branch}) with ${count} commit(s)`)
  }

  private async seedSquashed(
    root: string,
    subrepo: ResolvedSubrepo,
    head: string,
  ): Promise<number> {
    const tree = await filteredSubtree(root, head, subrepo).catch((err: unknown) => {
      this.error(`${subrepo.name}: ${(err as Error).message}\nNothing was pushed to ${subrepo.remote}.`)
    })
    if (tree === null || tree === EMPTY_TREE) {
      this.error(
        `${subrepo.name}: nothing to publish from ${subrepo.path}/ after applying exclude patterns — nothing was pushed.`,
      )
    }

    const meta = await readCommit(root, head)
    const message = appendTrailer(`Initial import of ${subrepo.name}\n`, SOURCE_TRAILER, meta.sha)
    const pubSha = await commitTree(root, {
      tree,
      parents: [],
      message,
      authorName: meta.committerName,
      authorEmail: meta.committerEmail,
      authorDate: meta.committerDate,
      committerName: meta.committerName,
      committerEmail: meta.committerEmail,
      committerDate: meta.committerDate,
    })

    await pushRef(root, subrepo.remote, pubSha, `refs/heads/${subrepo.branch}`)
    await git(root, ['update-ref', remoteTrackingRef(subrepo.name), pubSha])
    return 1
  }

  private async seedFullHistory(
    root: string,
    subrepo: ResolvedSubrepo,
    head: string,
  ): Promise<number> {
    const shas = await revList(root, ['--reverse', '--topo-order', head, '--', subrepo.path])
    const view: SyncView = {
      trackingRef: remoteTrackingRef(subrepo.name),
      pubHead: null,
      exportedMonoToPub: new Map(),
      importedPubShas: new Set(),
      exportBaseMono: null,
      unreflectedPub: [],
    }
    const result = await runExport(root, subrepo, view, {
      candidates: shas.map((monoSha) => ({monoSha})),
    }).catch((err: unknown) => {
      if (err instanceof GitError) this.error(`${subrepo.name}: ${err.message}`)
      this.error(`${subrepo.name}: ${(err as Error).message}\nNothing was pushed to ${subrepo.remote}.`)
    })
    if (result.exported.length === 0) {
      this.error(
        `${subrepo.name}: nothing to publish from ${subrepo.path}/ after applying exclude patterns — nothing was pushed.`,
      )
    }
    return result.exported.length
  }
}
