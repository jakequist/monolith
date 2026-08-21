import path from 'node:path'
import {Args, Flags} from '@oclif/core'
import type {Project, ResolvedSubrepo} from '../config.js'
import {MonospliceCommand} from '../lib/base.js'
import {adoptMessage, applyTreeInto, commitStaged, differingPaths} from '../core/adopt.js'
import {filteredSubtree, hasCommittedFiles} from '../core/filter.js'
import {EMPTY_TREE, GitError, fetchBranch, git, lsRemoteBranch, revParse} from '../core/git.js'
import {readSequencer} from '../core/importer.js'
import {normalizeSubrepoPath} from '../core/paths.js'
import {remoteTrackingRef} from '../core/sync.js'
import {
  checkConfigEditPreconditions,
  checkFreeSlot,
  pasteItYourself,
  writeConfigEntry,
} from '../core/vendor.js'
import {
  confirmFirstPublish,
  firstPublish,
  nothingExistsYet,
  pullInProgressMessage,
} from '../lib/ops.js'

const ATTACH_HINTS = {
  rename: 'Attach it under another name with `--name <name>`',
  relocate: 'Attach it at a directory that is not already part of a subrepo.',
}

interface AttachFlags {
  name?: string
  branch: string
  yes: boolean
  'full-history': boolean
  theirs: boolean
}

export default class Attach extends MonospliceCommand {
  static description = 'Connect a folder to a public repo: write the config entry and make first contact'

  static args = {
    folder: Args.string({description: 'Directory in this monorepo to connect', required: true}),
    url: Args.string({description: 'Git URL of the public repository', required: true}),
  }

  static flags = {
    name: Flags.string({description: 'Subrepo name (default: the last segment of <folder>)'}),
    branch: Flags.string({description: 'Branch to sync on both sides', default: 'main'}),
    yes: Flags.boolean({
      char: 'y',
      description: 'Answer the first-publish confirmation with yes (required in scripts and CI)',
      default: false,
    }),
    'full-history': Flags.boolean({
      description: 'First publish only: replay every commit touching <folder> instead of one baseline commit',
      default: false,
    }),
    theirs: Flags.boolean({
      description: 'When both sides have content, replace <folder> with the public tree',
      default: false,
    }),
  }

  static examples = [
    '<%= config.bin %> <%= command.id %> core git@github.com:you/core.git',
    '<%= config.bin %> <%= command.id %> packages/lib git@github.com:you/lib.git --name lib',
    '<%= config.bin %> <%= command.id %> core git@github.com:you/core.git --yes --full-history',
    '<%= config.bin %> <%= command.id %> core git@github.com:you/core.git --theirs',
  ]

  async run(): Promise<void> {
    const {args, flags} = await this.parse(Attach)
    const project = await this.requireProject()
    const root = project.root
    const retry = `monosplice attach ${args.folder} ${args.url}`

    const entry = this.plan(args.folder, args.url, flags)
    const taken = checkFreeSlot(project.subrepos, entry, ATTACH_HINTS)
    if (taken) this.error(taken)

    // Everything below writes something. Nothing above did.
    const state = await readSequencer(root)
    if (state) this.error(await pullInProgressMessage(root, state))
    const problem = await checkConfigEditPreconditions(root, retry, 'Attaching')
    if (problem) this.error(problem)

    // Which of the four first-contact cells this is, decided — never configured.
    const pubHead = await this.resolveRemoteHead(root, entry)
    const head = (await revParse(root, 'HEAD')) ?? 'HEAD'
    const hasContent = await hasCommittedFiles(root, head, entry)

    if (pubHead === null) {
      if (!hasContent) {
        this.error(
          `${nothingExistsYet(entry)}\nNothing was changed — the config is untouched. Run \`${retry}\` again once either side has content.`,
        )
      }
      await this.attachAndPublish(project, entry, flags)
      return
    }

    await this.attachToHistory(project, entry, {head, pubHead, hasContent, retry, theirs: flags.theirs})
  }

  /** Turn the folder and the URL into the subrepo entry the rest of monosplice understands. */
  private plan(folder: string, url: string, flags: {name?: string; branch: string}): ResolvedSubrepo {
    let subPath: string
    try {
      subPath = normalizeSubrepoPath(folder)
    } catch (err) {
      this.error(`${(err as Error).message}\nNothing was changed. Name a directory inside this monorepo.`)
    }
    return {
      name: flags.name ?? path.posix.basename(subPath),
      path: subPath,
      remote: url,
      branch: flags.branch,
      pushBranch: flags.branch,
      exclude: [],
    }
  }

  /** The public head, null when the remote has no such branch yet. */
  private async resolveRemoteHead(root: string, entry: ResolvedSubrepo): Promise<string | null> {
    return lsRemoteBranch(root, entry.remote, entry.branch).catch((err: unknown) => {
      if (err instanceof GitError) {
        this.error(
          `${entry.name}: cannot reach remote ${entry.remote}\n${err.stderr}\nNothing was changed — the config is untouched and no commit was made.`,
        )
      }
      throw err
    })
  }

  /**
   * Outbound first contact: the folder has content and the remote is empty. The config entry
   * is committed on its own first, so the confirmation the publish needs can be answered
   * later with the `push` command the refusal names — without editing anything by hand.
   */
  private async attachAndPublish(
    project: Project,
    entry: ResolvedSubrepo,
    flags: AttachFlags,
  ): Promise<void> {
    const root = project.root
    await this.insertEntry(project, entry, `monosplice push ${entry.name} --yes`)
    await git(root, ['add', '--', project.configPath])
    await commitStaged(root, `Attach ${entry.name}: track ${entry.remote} (${entry.branch})`)
    this.log(`✓ attached ${entry.name} at ${entry.path} (tracking ${entry.remote}#${entry.branch})`)

    const r = this.reporter()
    const result = await firstPublish(root, entry, r, {
      fullHistory: flags['full-history'],
      confirm: () =>
        confirmFirstPublish(entry, r, {
          yes: flags.yes,
          stateNote: `The config entry for ${entry.name} was committed, but nothing was pushed.`,
          cancelNote: ` The config entry was committed — run \`monosplice push ${entry.name} --yes\` when you are ready.`,
        }),
    })
    const how = result.fullHistory ? `replayed ${result.commits} commit(s)` : 'one baseline commit'
    this.log(`✓ ${entry.name}: published ${entry.path}/ to ${entry.remote} (${entry.branch}) — ${how}`)
  }

  /**
   * Inbound first contact: the remote already has history. Adopt semantics, except the config
   * entry rides along in the same commit — the anchor and the entry that gives it meaning
   * belong together, exactly as `vendor` records them.
   */
  private async attachToHistory(
    project: Project,
    entry: ResolvedSubrepo,
    ctx: {head: string; pubHead: string; hasContent: boolean; retry: string; theirs: boolean},
  ): Promise<void> {
    const root = project.root
    await fetchBranch(root, entry.remote, entry.branch, remoteTrackingRef(entry.name))

    const pubTree = await git(root, ['rev-parse', `${ctx.pubHead}^{tree}`])
    const monoTree = ctx.hasContent ? ((await filteredSubtree(root, ctx.head, entry)) ?? EMPTY_TREE) : EMPTY_TREE

    if (ctx.hasContent && monoTree !== pubTree && !ctx.theirs) {
      const paths = await differingPaths(root, monoTree, pubTree)
      this.error(
        `${entry.name}: ${entry.path}/ and ${entry.remote} (${entry.branch}) both have content, and their trees differ:
${paths.map((p) => `  ${p}`).join('\n')}
Nothing was changed — the config is untouched and no commit was made. Either make the two trees match and run \`${ctx.retry}\` again, or take the public tree wholesale:
  ${ctx.retry} --theirs`,
      )
    }

    await this.insertEntry(project, entry, `monosplice adopt ${entry.name}`)
    await git(root, ['add', '--', project.configPath])
    if (monoTree !== pubTree) await applyTreeInto(root, entry, monoTree, pubTree)
    await commitStaged(root, adoptMessage(entry, ctx.pubHead))

    this.log(
      `✓ attached ${entry.name} at ${entry.path} (tracking ${entry.remote}#${entry.branch}) @ ${ctx.pubHead.slice(0, 10)}`,
    )
    this.log(`  ${entry.path}/ and the remote are now in sync; push and pull as usual.`)
  }

  /** Write the entry, or exit non-zero leaving it on stdout so it can be copy-pasted. */
  private async insertEntry(project: Project, entry: ResolvedSubrepo, nextCommand: string): Promise<void> {
    const failure = await writeConfigEntry(project, entry)
    if (!failure) return
    const {log, error} = pasteItYourself(project.configPath, failure, nextCommand)
    this.log(log)
    this.error(error)
  }
}
