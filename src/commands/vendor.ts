import fs from 'node:fs'
import path from 'node:path'
import {Args, Flags} from '@oclif/core'
import {loadProject, type Project, type ResolvedSubrepo} from '../config.js'
import {MonospliceCommand} from '../lib/base.js'
import {applyTreeInto, commitStaged, vendorMessage} from '../core/adopt.js'
import {hasCommittedFiles} from '../core/filter.js'
import {EMPTY_TREE, GitError, fetchBranch, git, lsRemoteBranch, revParse} from '../core/git.js'
import {readSequencer} from '../core/importer.js'
import {normalizeSubrepoPath} from '../core/paths.js'
import {pullSource, remoteTrackingRef} from '../core/sync.js'
import {
  checkVendorPreconditions,
  deriveVendorName,
  insertSubrepoEntry,
  renderSubrepoEntry,
} from '../core/vendor.js'
import {pullInProgressMessage} from '../lib/ops.js'

export default class Vendor extends MonospliceCommand {
  static description = 'Add a third-party repository as a tracked subrepo, in one commit'

  static args = {
    url: Args.string({description: 'Git URL of the repository to vendor', required: true}),
  }

  static flags = {
    path: Flags.string({description: 'Directory to vendor into (default: vendor/<name>)'}),
    name: Flags.string({description: 'Subrepo name (default: the repo basename of the URL)'}),
    branch: Flags.string({description: 'Branch to track', default: 'main'}),
    fork: Flags.string({
      description: 'Your fork of the repository: pull from <url>, push patches to this remote',
    }),
  }

  static examples = [
    '<%= config.bin %> <%= command.id %> git@github.com:lodash/lodash.git',
    '<%= config.bin %> <%= command.id %> https://github.com/lodash/lodash.git --path third_party/lodash',
    '<%= config.bin %> <%= command.id %> git@github.com:lodash/lodash.git --branch 4.17-stable',
    '<%= config.bin %> <%= command.id %> git@github.com:lodash/lodash.git --fork git@github.com:you/lodash.git',
  ]

  async run(): Promise<void> {
    const {args, flags} = await this.parse(Vendor)
    const project = await this.requireProject()
    const root = project.root
    const url = args.url

    const entry = this.plan(url, flags)
    this.requireFreeSlot(project, entry)

    // Everything below writes something. Nothing above did.
    const state = await readSequencer(root)
    if (state) this.error(await pullInProgressMessage(root, state))
    const problem = await checkVendorPreconditions(root, `monosplice vendor ${url}`)
    if (problem) this.error(problem)
    await this.requireFreePath(root, entry)

    // The tree, the anchor and every later sync decision come from the pull source: with
    // `--fork` that is upstream, and the fork is only ever written to by `push`.
    const source = pullSource(entry)
    const pubHead = await this.resolveRemoteHead(root, entry)
    await fetchBranch(root, source, entry.branch, remoteTrackingRef(entry.name))

    await this.writeConfigEntry(project, entry)

    await git(root, ['add', '--', project.configPath])
    const pubTree = await git(root, ['rev-parse', `${pubHead}^{tree}`])
    await applyTreeInto(root, entry, EMPTY_TREE, pubTree)
    await commitStaged(root, vendorMessage(entry, pubHead))

    this.log(`✓ vendored ${entry.name} at ${entry.path} (tracking ${source}#${entry.branch})`)
    this.log(
      `  \`monosplice pull ${entry.name}\` brings in upstream updates; your own commits under ${entry.path}/ are three-way merged with them.`,
    )
    if (entry.upstream !== undefined) {
      this.log(
        `  \`monosplice push ${entry.name}\` rebuilds ${entry.remote} (${entry.pushBranch}) as ${source}'s ${entry.branch} plus your patches — open the PR from there.`,
      )
    }
  }

  /** Turn the URL and flags into the subrepo entry the rest of monosplice already understands. */
  private plan(
    url: string,
    flags: {path?: string; name?: string; branch: string; fork?: string},
  ): ResolvedSubrepo {
    if (flags.fork === url) {
      this.error(
        `--fork ${flags.fork} is the same URL you are vendoring, so there is no fork to push to.\nNothing was changed. Drop --fork, or point it at your own fork of ${url}.`,
      )
    }
    const name = flags.name ?? deriveVendorName(url)
    if (!name) {
      this.error(
        `Cannot derive a subrepo name from ${JSON.stringify(url)}.\nNothing was changed. Re-run with an explicit name:\n  monosplice vendor ${url} --name <name>`,
      )
    }
    let subPath: string
    try {
      subPath = normalizeSubrepoPath(flags.path ?? `vendor/${name}`)
    } catch (err) {
      this.error(`${(err as Error).message}\nNothing was changed. Pick another directory with \`--path <dir>\`.`)
    }
    return {
      name,
      path: subPath,
      // With a fork, `remote` is where we push and the vendored URL becomes `upstream`.
      remote: flags.fork ?? url,
      ...(flags.fork === undefined ? {} : {upstream: url}),
      branch: flags.branch,
      pushBranch: flags.branch,
      exclude: [],
    }
  }

  /** The name and the path must both be free, and the path may not nest inside a subrepo. */
  private requireFreeSlot(project: Project, entry: ResolvedSubrepo): void {
    for (const s of project.subrepos) {
      if (s.name === entry.name) {
        this.error(
          `A subrepo named ${entry.name} is already configured (${s.path}/ tracking ${s.remote}).\nNothing was changed. Vendor it under another name with \`--name <name>\`, or run \`monosplice pull ${s.name}\` if this is the one you meant.`,
        )
      }
      if (s.path === entry.path) {
        this.error(
          `${entry.path} is already configured as subrepo ${s.name}.\nNothing was changed. Pick another directory with \`--path <dir>\`.`,
        )
      }
      if (s.path.startsWith(`${entry.path}/`) || entry.path.startsWith(`${s.path}/`)) {
        this.error(
          `subrepo paths may not nest: ${entry.path} and ${s.path} (subrepo ${s.name}) would sit inside one another.\nNothing was changed. Pick another directory with \`--path <dir>\`.`,
        )
      }
    }
  }

  /** Nothing may exist at the target path — not on disk, and not in the monorepo's history. */
  private async requireFreePath(root: string, entry: ResolvedSubrepo): Promise<void> {
    if (fs.existsSync(path.join(root, entry.path))) {
      this.error(
        `${entry.path} already exists in ${root}.\nNothing was changed. Remove it, or vendor into a different directory with \`--path <dir>\`.`,
      )
    }
    const head = (await revParse(root, 'HEAD')) ?? 'HEAD'
    if (await hasCommittedFiles(root, head, entry)) {
      this.error(
        `${entry.path}/ already has committed files in this monorepo, so there is nothing to vendor into it.\nNothing was changed. Add the subrepo to your config by hand and run \`monosplice adopt ${entry.name}\`, or vendor into a different directory with \`--path <dir>\`.`,
      )
    }
  }

  private async resolveRemoteHead(root: string, entry: ResolvedSubrepo): Promise<string> {
    const source = pullSource(entry)
    const what = entry.upstream === undefined ? 'remote' : 'upstream'
    const pubHead = await lsRemoteBranch(root, source, entry.branch).catch((err: unknown) => {
      if (err instanceof GitError) {
        this.error(`${entry.name}: cannot reach ${what} ${source}\n${err.stderr}`)
      }
      throw err
    })
    if (pubHead === null) {
      this.error(
        `${entry.name}: ${source} has no ${entry.branch} branch, so there is nothing to vendor.\nNothing was changed. Check the URL, or name the right branch with \`--branch <branch>\`.`,
      )
    }
    return pubHead
  }

  /**
   * Append the entry textually, then prove it by reloading the config through the real
   * loader. If either half fails the original bytes go back and the user gets the snippet —
   * a half-rewritten config file is far worse than one the user pastes into themselves.
   */
  private async writeConfigEntry(project: Project, entry: ResolvedSubrepo): Promise<void> {
    const snippet = renderSubrepoEntry(entry)
    const original = fs.readFileSync(project.configPath)
    const updated = insertSubrepoEntry(original.toString('utf8'), snippet)
    if (updated === null) {
      this.pasteItYourself(project.configPath, entry, snippet, 'no `subrepos: [` line to insert into')
    }

    fs.writeFileSync(project.configPath, updated)
    const wrong = await this.reloadedMismatch(project.root, entry)
    if (wrong) {
      fs.writeFileSync(project.configPath, original)
      this.pasteItYourself(project.configPath, entry, snippet, wrong)
    }
  }

  /** Why the config monosplice just wrote cannot be trusted, or null when it checks out. */
  private async reloadedMismatch(root: string, entry: ResolvedSubrepo): Promise<string | null> {
    let reloaded: Project | null
    try {
      reloaded = await loadProject(root)
    } catch (err) {
      return `the rewritten config does not load:\n${(err as Error).message}`
    }
    if (!reloaded) return 'the config file vanished while monosplice was writing it'
    const found = reloaded.subrepos.find((s) => s.name === entry.name)
    if (!found) return `the rewritten config has no subrepo named ${entry.name}`
    if (
      found.path !== entry.path ||
      found.remote !== entry.remote ||
      found.branch !== entry.branch ||
      found.upstream !== entry.upstream ||
      found.pushBranch !== entry.pushBranch
    ) {
      return `the rewritten config resolves ${entry.name} to ${found.path}/ tracking ${pullSource(found)} (${found.branch}), not what monosplice wrote`
    }
    return null
  }

  /** Exit non-zero, but leave the entry on stdout so it can be piped or copy-pasted. */
  private pasteItYourself(
    configPath: string,
    entry: ResolvedSubrepo,
    snippet: string,
    reason: string,
  ): never {
    this.log(`Add this to the \`subrepos\` array in ${configPath}:`)
    this.log('')
    this.log(`  ${snippet},`)
    this.log('')
    this.error(
      `monosplice cannot safely edit ${configPath}: ${reason}.\nNothing was changed — the config is untouched and no commit was made. Paste the entry printed above into your config, then run:\n  monosplice adopt ${entry.name}`,
    )
  }
}
