import fs from 'node:fs'
import path from 'node:path'
import {Args, Flags} from '@oclif/core'
import type {Project, ResolvedSubrepo} from '../config.js'
import {MonospliceCommand} from '../lib/base.js'
import {adoptMessage, applyTreeInto, commitStaged, differingPaths} from '../core/adopt.js'
import {filteredSubtree, hasCommittedFiles} from '../core/filter.js'
import {EMPTY_TREE, GitError, fetchBranch, git, lsRemoteBranch, probePushAccess, revParse} from '../core/git.js'
import {checkImportPreconditions, readSequencer, runImport} from '../core/importer.js'
import {normalizeSubrepoPath} from '../core/paths.js'
import {pullSource, remoteTrackingRef, type SyncView} from '../core/sync.js'
import {
  checkConfigEditPreconditions,
  checkFreeSlot,
  pasteItYourself,
  writeConfigEntry,
} from '../core/vendor.js'
import {
  confirmFirstPublish,
  firstPublish,
  loadView,
  nothingExistsYet,
  pullInProgressMessage,
  reportImportFailure,
  upstreamHasNoBranch,
  type Reporter,
} from '../lib/ops.js'

const ATTACH_HINTS = {
  rename: 'Attach it under another name with `--name <name>`',
  relocate: 'Attach it at a directory that is not already part of a subrepo.',
}

interface AttachFlags {
  name?: string
  branch?: string
  yes: boolean
  'full-history': boolean
  history: boolean
  theirs: boolean
  fork?: string
}

export default class Attach extends MonospliceCommand {
  static description =
    'Connect a folder to a public repo and make first contact; writes the config entry when the folder is not configured yet'

  static args = {
    folder: Args.string({description: 'Directory in this monorepo to connect (or the name of a configured subrepo)', required: true}),
    url: Args.string({
      description: 'Git URL of the public repository. Optional when <folder> is already in your config',
      required: false,
    }),
  }

  static flags = {
    name: Flags.string({description: 'Subrepo name (default: the last segment of <folder>)'}),
    branch: Flags.string({description: 'Branch to sync on both sides (default: main)'}),
    yes: Flags.boolean({
      char: 'y',
      description: 'Answer the first-publish confirmation with yes (required in scripts and CI)',
      default: false,
    }),
    'full-history': Flags.boolean({
      description: 'First publish only: replay every commit touching <folder> instead of one baseline commit',
      default: false,
    }),
    history: Flags.boolean({
      description: 'Replay every public commit into <folder> instead of recording one snapshot commit',
      default: false,
    }),
    theirs: Flags.boolean({
      description: 'When both sides have content, replace <folder> with the public tree',
      default: false,
    }),
    fork: Flags.string({
      description: 'Your fork of the repository: pull from <url>, push patches to this remote',
    }),
  }

  static examples = [
    '<%= config.bin %> <%= command.id %> core git@github.com:you/core.git',
    '<%= config.bin %> <%= command.id %> core',
    '<%= config.bin %> <%= command.id %> packages/lib git@github.com:you/lib.git --name lib',
    '<%= config.bin %> <%= command.id %> core git@github.com:you/core.git --yes --full-history',
    '<%= config.bin %> <%= command.id %> core --history',
    '<%= config.bin %> <%= command.id %> core --theirs',
    '<%= config.bin %> <%= command.id %> vendor/lodash git@github.com:lodash/lodash.git --fork git@github.com:you/lodash.git',
  ]

  async run(): Promise<void> {
    const {args, flags} = await this.parse(Attach)
    const project = await this.requireProject()

    // Which half of `attach` this is, decided by the config — never by a flag.
    const configured = this.findEntry(project, args.folder)
    if (configured) await this.attachConfigured(project, configured, args.folder, args.url, flags)
    else await this.attachNew(project, args.folder, args.url, flags)
  }

  /** The configured subrepo this folder names — by path, or failing that by name. */
  private findEntry(project: Project, folder: string): ResolvedSubrepo | undefined {
    let subPath: string | null = null
    try {
      subPath = normalizeSubrepoPath(folder)
    } catch {
      subPath = null
    }
    const byPath = subPath === null ? undefined : project.subrepos.find((s) => s.path === subPath)
    return byPath ?? project.subrepos.find((s) => s.name === folder)
  }

  // ---------------------------------------------------------------------------------------
  // Already configured: first contact only. Nothing here may touch monosplice.config.ts.
  // ---------------------------------------------------------------------------------------

  private async attachConfigured(
    project: Project,
    entry: ResolvedSubrepo,
    folder: string,
    url: string | undefined,
    flags: AttachFlags,
  ): Promise<void> {
    const root = project.root
    const source = pullSource(entry)
    const retry = `monosplice attach ${folder}`

    if (url !== undefined && url !== source) {
      this.error(
        `${entry.name}: ${entry.path}/ is already configured to track ${source} (${entry.branch}), not ${url}.
Nothing was changed — the config is untouched and no commit was made. Run \`${retry}\` to connect it to ${source}, or edit ${project.configPath} if you really mean to point ${entry.name} at ${url}.`,
      )
    }
    if (flags.fork !== undefined) {
      this.error(
        `${entry.name}: ${entry.path}/ is already configured, so --fork has nothing to write.
Nothing was changed — the config is untouched and no commit was made. Edit ${project.configPath}: set \`remote\` to ${flags.fork} and add \`upstream: '${entry.remote}'\`, then run \`${retry}\`.`,
      )
    }
    if (flags.name !== undefined && flags.name !== entry.name) {
      this.error(
        `${entry.name}: ${entry.path}/ is already configured under the name ${entry.name}, so --name ${flags.name} would not be honoured.
Nothing was changed. Drop --name, or rename the subrepo in ${project.configPath}.`,
      )
    }
    if (flags.branch !== undefined && flags.branch !== entry.branch) {
      this.error(
        `${entry.name}: ${entry.path}/ is already configured to track branch ${entry.branch}, not ${flags.branch}.
Nothing was changed. Drop --branch, or change \`branch\` in ${project.configPath}.`,
      )
    }

    const r = this.reporter()
    // Preconditions before the network: a dirty tree must be reported without side effects,
    // not after a fetch has already written a tracking ref.
    const state = await readSequencer(root)
    if (state) this.error(await pullInProgressMessage(root, state))
    const problem = await checkImportPreconditions(root, entry, retry)
    if (problem) this.error(problem)

    const view = await loadView(root, entry, r)

    // checkImportPreconditions already refused a monorepo with no commits.
    const head = (await revParse(root, 'HEAD')) ?? 'HEAD'
    const hasContent = await hasCommittedFiles(root, head, entry)

    if (view.pubHead === null) {
      await this.publishConfigured(root, entry, hasContent, flags)
      return
    }
    if (view.related) {
      this.error(
        `${entry.name}: already connected to ${source} — monosplice trailers already link the two repositories, so there is nothing to attach.
Nothing was changed. Run \`monosplice pull ${entry.name}\` to import new public commits, \`monosplice push ${entry.name}\` to export new monorepo commits, or \`monosplice sync ${entry.name}\` for both.`,
      )
    }

    const pubHead = view.pubHead
    const count = hasContent
      ? await this.snapshotOverContent(root, entry, head, pubHead, retry, r, flags)
      : await this.snapshotIntoEmptyPath(root, entry, view, pubHead, r, flags)

    this.log(
      `✓ ${entry.name}: attached ${source} (${entry.branch}) at ${pubHead.slice(0, 10)} — ${count} commit(s)`,
    )
    this.log(`  ${entry.path}/ and the remote are now in sync; push and pull as usual.`)
    // Triangular entries push to their own fork; probing it (or hinting at adding an
    // upstream that already exists) would only mislead.
    if (entry.upstream === undefined) {
      await this.warnIfReadOnly(root, entry, pubHead, this.configuredForkHint(project, entry))
    }
  }

  /** Outbound first contact for a configured subrepo: the remote branch does not exist yet. */
  private async publishConfigured(
    root: string,
    entry: ResolvedSubrepo,
    hasContent: boolean,
    flags: AttachFlags,
  ): Promise<void> {
    const r = this.reporter()
    if (entry.upstream !== undefined) this.error(upstreamHasNoBranch(entry))
    if (!hasContent) this.error(nothingExistsYet(entry))
    if (flags.history) {
      this.error(
        `${entry.name}: --history replays public commits into ${entry.path}/, but ${entry.remote} has no ${entry.branch} branch yet.
Nothing was changed. Drop --history to publish ${entry.path}/ instead, adding --full-history to replay every monorepo commit that touched it.`,
      )
    }

    const result = await firstPublish(root, entry, r, {
      fullHistory: flags['full-history'],
      confirm: () => confirmFirstPublish(entry, r, {yes: flags.yes}),
    })
    const how = result.fullHistory ? `replayed ${result.commits} commit(s)` : 'one baseline commit'
    this.log(`✓ ${entry.name}: published ${entry.path}/ to ${entry.remote} (${entry.branch}) — ${how}`)
  }

  /** The subrepo directory has no committed files: take the public repo wholesale. */
  private async snapshotIntoEmptyPath(
    root: string,
    entry: ResolvedSubrepo,
    view: SyncView,
    pubHead: string,
    r: Reporter,
    flags: AttachFlags,
  ): Promise<number> {
    if (flags.history) return this.replayPublicHistory(root, entry, view.unreflectedPub, r)

    const pubTree = await git(root, ['rev-parse', `${pubHead}^{tree}`])
    await applyTreeInto(root, entry, EMPTY_TREE, pubTree)
    await commitStaged(root, adoptMessage(entry, pubHead))
    return 1
  }

  /** Both sides have content: either the trees already agree, or the user must choose. */
  private async snapshotOverContent(
    root: string,
    entry: ResolvedSubrepo,
    head: string,
    pubHead: string,
    retry: string,
    r: Reporter,
    flags: AttachFlags,
  ): Promise<number> {
    if (flags.history) this.error(this.historyNeedsEmptyPath(entry, retry))

    const monoTree =
      (await filteredSubtree(root, head, entry).catch((err: unknown) => {
        r.fail(`${entry.name}: ${(err as Error).message}\nNothing was changed.`)
      })) ?? EMPTY_TREE
    const pubTree = await git(root, ['rev-parse', `${pubHead}^{tree}`])

    if (monoTree !== pubTree && !flags.theirs) {
      this.error(await this.treesDiffer(root, entry, monoTree, pubTree, retry, 'Nothing was changed.'))
    }

    if (monoTree !== pubTree) await applyTreeInto(root, entry, monoTree, pubTree)
    await commitStaged(root, adoptMessage(entry, pubHead))
    return 1
  }

  // ---------------------------------------------------------------------------------------
  // Not configured yet: write the entry, then make the same first-contact move.
  // ---------------------------------------------------------------------------------------

  private async attachNew(
    project: Project,
    folder: string,
    url: string | undefined,
    flags: AttachFlags,
  ): Promise<void> {
    const root = project.root
    if (url === undefined) {
      const known = project.subrepos.map((s) => s.name).join(', ') || '(none)'
      this.error(
        `${folder} is not a configured subrepo, so monosplice needs the repository URL to create the entry:
  monosplice attach ${folder} <git-url>
Nothing was changed. Configured subrepos: ${known}`,
      )
    }
    const retry = `monosplice attach ${folder} ${url}`

    const entry = this.plan(folder, url, flags)
    const taken = checkFreeSlot(project.subrepos, entry, ATTACH_HINTS)
    if (taken) this.error(taken)

    // Everything below writes something. Nothing above did.
    const state = await readSequencer(root)
    if (state) this.error(await pullInProgressMessage(root, state))
    const problem = await checkConfigEditPreconditions(root, retry)
    if (problem) this.error(problem)

    // The tree, the anchor and every later sync decision come from the pull source: with
    // `--fork` that is upstream, and the fork is only ever written to by `push`.
    const source = pullSource(entry)
    const pubHead = await this.resolveRemoteHead(root, entry)
    const head = (await revParse(root, 'HEAD')) ?? 'HEAD'
    const hasContent = await hasCommittedFiles(root, head, entry)
    if (!hasContent) this.requireFreePath(root, entry, retry)

    if (pubHead === null) {
      if (entry.upstream !== undefined) {
        this.error(
          `${entry.name}: upstream ${source} has no ${entry.branch} branch, so there is nothing to attach to and no base for the fork branch.
Nothing was changed — the config is untouched and no commit was made. Check the URL, or name the right branch with \`--branch <branch>\`.`,
        )
      }
      if (!hasContent) {
        this.error(
          `${nothingExistsYet(entry)}\nNothing was changed — the config is untouched. Run \`${retry}\` again once either side has content.`,
        )
      }
      if (flags.history) {
        this.error(
          `${entry.name}: --history replays public commits into ${entry.path}/, but ${source} has no ${entry.branch} branch yet.
Nothing was changed — the config is untouched and no commit was made. Drop --history to publish ${entry.path}/ instead, adding --full-history to replay every monorepo commit that touched it.`,
        )
      }
      await this.attachAndPublish(project, entry, flags)
      return
    }

    await this.attachToHistory(project, entry, {head, pubHead, hasContent, retry, flags})
  }

  /** Turn the folder and the URL into the subrepo entry the rest of monosplice understands. */
  private plan(folder: string, url: string, flags: AttachFlags): ResolvedSubrepo {
    if (flags.fork === url) {
      this.error(
        `--fork ${flags.fork} is the same URL you are attaching, so there is no fork to push to.\nNothing was changed. Drop --fork, or point it at your own fork of ${url}.`,
      )
    }
    let subPath: string
    try {
      subPath = normalizeSubrepoPath(folder)
    } catch (err) {
      this.error(`${(err as Error).message}\nNothing was changed. Name a directory inside this monorepo.`)
    }
    const branch = flags.branch ?? 'main'
    return {
      name: flags.name ?? path.posix.basename(subPath),
      path: subPath,
      // With a fork, `remote` is where we push and the attached URL becomes `upstream`.
      remote: flags.fork ?? url,
      ...(flags.fork === undefined ? {} : {upstream: url}),
      branch,
      pushBranch: branch,
      exclude: [],
    }
  }

  /**
   * A path with no committed files must also be empty on disk: the tree is applied with
   * `git apply --index`, which would fail halfway over files git has never seen.
   */
  private requireFreePath(root: string, entry: ResolvedSubrepo, retry: string): void {
    if (!fs.existsSync(path.join(root, entry.path))) return
    this.error(
      `${entry.path} already exists in ${root}, but has no committed files, so monosplice will not write the public tree over it.
Nothing was changed — the config is untouched and no commit was made. Remove it (or commit its contents), then run \`${retry}\` again.`,
    )
  }

  /** The public head, null when the remote has no such branch yet. */
  private async resolveRemoteHead(root: string, entry: ResolvedSubrepo): Promise<string | null> {
    const source = pullSource(entry)
    const what = entry.upstream === undefined ? 'remote' : 'upstream'
    return lsRemoteBranch(root, source, entry.branch).catch((err: unknown) => {
      if (err instanceof GitError) {
        this.error(
          `${entry.name}: cannot reach ${what} ${source}\n${err.stderr}\nNothing was changed — the config is untouched and no commit was made.`,
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
    await this.commitEntry(project, entry, `monosplice push ${entry.name} --yes`)
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
   * Inbound first contact: the remote already has history. The config entry rides along in
   * the same commit — the anchor and the entry that gives it meaning belong together. With
   * `--history` it cannot: each replayed commit is its own, so the entry is committed first.
   */
  private async attachToHistory(
    project: Project,
    entry: ResolvedSubrepo,
    ctx: {head: string; pubHead: string; hasContent: boolean; retry: string; flags: AttachFlags},
  ): Promise<void> {
    const root = project.root
    const source = pullSource(entry)
    const r = this.reporter()
    await fetchBranch(root, source, entry.branch, remoteTrackingRef(entry.name))

    const pubTree = await git(root, ['rev-parse', `${ctx.pubHead}^{tree}`])
    const monoTree = ctx.hasContent ? ((await filteredSubtree(root, ctx.head, entry)) ?? EMPTY_TREE) : EMPTY_TREE

    if (ctx.flags.history && ctx.hasContent) this.error(this.historyNeedsEmptyPath(entry, ctx.retry))

    if (ctx.hasContent && monoTree !== pubTree && !ctx.flags.theirs) {
      this.error(
        await this.treesDiffer(
          root,
          entry,
          monoTree,
          pubTree,
          ctx.retry,
          'Nothing was changed — the config is untouched and no commit was made.',
        ),
      )
    }

    let replayed = 0
    if (ctx.flags.history) {
      await this.commitEntry(project, entry, `${ctx.retry} --history`)
      const view = await loadView(root, entry, r)
      replayed = await this.replayPublicHistory(root, entry, view.unreflectedPub, r)
    } else {
      await this.insertEntry(project, entry, `monosplice attach ${entry.path}`)
      await git(root, ['add', '--', project.configPath])
      if (monoTree !== pubTree) await applyTreeInto(root, entry, monoTree, pubTree)
      await commitStaged(root, adoptMessage(entry, ctx.pubHead))
    }

    const how = ctx.flags.history ? ` — replayed ${replayed} commit(s)` : ''
    this.log(
      `✓ attached ${entry.name} at ${entry.path} (tracking ${source}#${entry.branch}) @ ${ctx.pubHead.slice(0, 10)}${how}`,
    )
    this.log(`  ${entry.path}/ and the remote are now in sync; push and pull as usual.`)
    if (entry.upstream !== undefined) {
      this.log(
        `  \`monosplice push ${entry.name}\` rebuilds ${entry.remote} (${entry.pushBranch}) as ${source}'s ${entry.branch} plus your patches — open the PR from there.`,
      )
      return
    }
    await this.warnIfReadOnly(root, entry, ctx.pubHead, `${ctx.retry} --fork <your-fork-url>`)
  }

  /** Write the entry, or exit non-zero leaving it on stdout so it can be copy-pasted. */
  private async insertEntry(project: Project, entry: ResolvedSubrepo, nextCommand: string): Promise<void> {
    const failure = await writeConfigEntry(project, entry)
    if (!failure) return
    const {log, error} = pasteItYourself(project.configPath, failure, nextCommand)
    this.log(log)
    this.error(error)
  }

  /** Write the entry and commit it on its own, so what follows starts from a clean index. */
  private async commitEntry(project: Project, entry: ResolvedSubrepo, nextCommand: string): Promise<void> {
    await this.insertEntry(project, entry, nextCommand)
    await git(project.root, ['add', '--', project.configPath])
    await commitStaged(project.root, `Attach ${entry.name}: track ${pullSource(entry)} (${entry.branch})`)
  }

  // ---------------------------------------------------------------------------------------
  // Shared moves and shared wording.
  // ---------------------------------------------------------------------------------------

  /** Replay every unreflected public commit into the subrepo. Returns how many landed. */
  private async replayPublicHistory(
    root: string,
    entry: ResolvedSubrepo,
    candidates: string[],
    r: Reporter,
  ): Promise<number> {
    const result = await runImport(root, entry, candidates, {
      onWarn: (message) => this.logToStderr(message),
    }).catch((err: unknown) => reportImportFailure(entry, err, r))
    return result.imported.length
  }

  private historyNeedsEmptyPath(entry: ResolvedSubrepo, retry: string): string {
    return `${entry.name}: --history replays the public history into an empty path, but ${entry.path}/ already has committed files.
Nothing was changed. Run \`${retry}\` (add --theirs if the public tree should win).`
  }

  private async treesDiffer(
    root: string,
    entry: ResolvedSubrepo,
    monoTree: string,
    pubTree: string,
    retry: string,
    stateNote: string,
  ): Promise<string> {
    const paths = await differingPaths(root, monoTree, pubTree)
    return `${entry.name}: ${entry.path}/ and ${pullSource(entry)} (${entry.branch}) both have content, and their trees differ:
${paths.map((p) => `  ${p}`).join('\n')}
${stateNote} Either make the two trees match and run \`${retry}\` again, or take the public tree wholesale:
  ${retry} --theirs`
  }

  /**
   * Advisory only. Attaching proves you can *read* the remote; pushing needs rights this
   * command never exercised, and finding that out on the first `push` — after the anchor
   * commit is already in your history — is the worst possible moment. Never blocks, never
   * changes the exit code: a probe that cannot decide must not veto a successful attach.
   */
  private async warnIfReadOnly(
    root: string,
    entry: ResolvedSubrepo,
    pubHead: string,
    forkHint: string,
  ): Promise<void> {
    const refusal = await probePushAccess(root, entry.remote, pubHead, entry.branch)
    if (refusal === null) return
    this.logToStderr(
      `warning: ${entry.name}: attached, but a dry-run push to ${entry.remote} was refused:
${refusal
  .split('\n')
  .map((line) => `  ${line}`)
  .join('\n')}
\`monosplice pull ${entry.name}\` will still work; \`monosplice push ${entry.name}\` will most likely fail. If you cannot push to ${entry.remote}, connect through a fork of it instead:
  ${forkHint}`,
    )
  }

  /** A configured entry cannot be re-attached with `--fork`, so name the config edit instead. */
  private configuredForkHint(project: Project, entry: ResolvedSubrepo): string {
    return `edit ${project.configPath}: set \`remote\` to your fork and add \`upstream: '${entry.remote}'\``
  }
}
