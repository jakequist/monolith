import {Args} from '@oclif/core'
import type {ResolvedSubrepo} from '../config.js'
import {MonolithCommand} from '../lib/base.js'
import {computeExports, exportBaseRewritten, planExport} from '../core/exporter.js'
import {filteredSubtree} from '../core/filter.js'
import {git, revList} from '../core/git.js'
import {readSequencer, sequencerPath} from '../core/importer.js'
import {loadSyncView, type SyncView} from '../core/sync.js'
import {ORIGIN_TRAILER, SOURCE_TRAILER} from '../core/trailers.js'

export default class Doctor extends MonolithCommand {
  static description = 'Report the derived sync points for every subrepo and verify they match reality'

  static args = {
    subrepo: Args.string({description: 'Only check this subrepo (defaults to all)', required: false}),
  }

  static examples = ['<%= config.bin %> <%= command.id %>', '<%= config.bin %> <%= command.id %> core']

  private problems = 0

  async run(): Promise<void> {
    const {args} = await this.parse(Doctor)
    const project = await this.requireProject()
    const root = project.root

    const state = await readSequencer(root)
    if (state) {
      this.problems += 1
      this.log(`✗ an unfinished pull of ${state.subrepo} is recorded in ${await sequencerPath(root)}`)
      this.log('  Resolve the conflict, `git add` the files, then run `monolith pull --continue`.')
      this.log('  To abort that import instead, delete the file.')
      this.log('')
    }

    const subrepos = this.selectSubrepos(project, args.subrepo)
    const fetchedPubShas = new Set<string>()
    let importedPubShas = new Set<string>()

    for (const subrepo of subrepos) {
      const view = await this.checkSubrepo(root, subrepo)
      if (view) {
        for (const sha of await revList(root, [view.trackingRef])) fetchedPubShas.add(sha)
        importedPubShas = view.importedPubShas
      }
      this.log('')
    }

    // Only meaningful with every subrepo in view: a Monolith-Origin trailer in monorepo
    // history may belong to any of the configured public repos.
    if (!args.subrepo) this.checkOrigins(importedPubShas, fetchedPubShas)

    if (this.problems === 0) {
      this.log('✓ all checks passed')
      return
    }
    this.error(`${this.problems} problem(s) found — see the report above.`, {exit: 1})
  }

  private problem(headline: string, ...detail: string[]): void {
    this.problems += 1
    this.log(`  ✗ ${headline}`)
    for (const line of detail) this.log(`    ${line}`)
  }

  private note(headline: string, ...detail: string[]): void {
    this.log(`  ! ${headline}`)
    for (const line of detail) this.log(`    ${line}`)
  }

  private async checkSubrepo(root: string, subrepo: ResolvedSubrepo): Promise<SyncView | null> {
    this.log(subrepo.name)
    this.log(`  path:          ${subrepo.path}/`)
    this.log(`  remote:        ${subrepo.remote} (${subrepo.branch})`)

    let view: SyncView
    try {
      view = await loadSyncView(root, subrepo)
    } catch (err) {
      this.problem(
        `cannot reach ${subrepo.remote}`,
        ...(err as Error).message.split('\n'),
        'Fix the URL in your config or your network/credentials, then run `monolith doctor` again.',
      )
      return null
    }

    if (view.pubHead === null) {
      this.problem(
        `not published yet — ${subrepo.remote} has no ${subrepo.branch} branch.`,
        `Run \`monolith push ${subrepo.name} --yes\` to publish it for the first time.`,
      )
      return null
    }

    this.log(`  pub head:      ${view.pubHead}`)
    if (view.lastExportedMono) {
      const pub = view.exportedMonoToPub.get(view.lastExportedMono) ?? '(unknown)'
      this.log(`  last exported: mono ${view.lastExportedMono}`)
      this.log(`                 pub  ${pub}`)
    } else {
      this.log('  last exported: (nothing yet)')
    }

    await this.reportCounts(root, subrepo, view)

    for (const broken of view.brokenSourceRefs) {
      this.problem(
        `public commit ${broken.pubSha} carries ${SOURCE_TRAILER}: ${broken.monoSha}, but that monorepo commit does not exist in this clone.`,
        'Usually the monorepo clone is missing history (a shallow or partial clone), or `remote` points',
        'at a repository that was published from a different monorepo.',
        'Run `git fetch --unshallow` (or fix `remote` in your config); monolith refuses to export until',
        'the mapping resolves, so nothing can be published on top of a history it cannot see.',
      )
    }

    if (await exportBaseRewritten(root, view)) {
      this.problem(
        `the last exported monorepo commit ${view.lastExportedMono} is no longer an ancestor of HEAD.`,
        'Monorepo history was rewritten (rebase, amend or force-push) underneath it, so the export range',
        'is meaningless and `monolith push` will refuse.',
        'Restore that commit (see `git reflog`) or re-point the branch at history that contains it.',
      )
    }

    await this.verifyMapping(root, subrepo, view)
    return view
  }

  private async reportCounts(root: string, subrepo: ResolvedSubrepo, view: SyncView): Promise<void> {
    const {candidates} = await planExport(root, subrepo, view)
    let ahead = candidates.length
    let hookError: string | undefined
    try {
      ahead = (await computeExports(root, subrepo, view, candidates)).length
    } catch (err) {
      hookError = (err as Error).message
    }
    this.log(`  to push: ${ahead}, to pull: ${view.unreflectedPub.length}`)
    if (hookError) {
      this.problem(
        `a configured hook rejects a pending commit: ${hookError}`,
        `\`monolith push ${subrepo.name}\` will fail until that commit is fixed or the hook is changed.`,
      )
    }
  }

  /** The cursor claims pub commit X exported mono commit Y; check the trees agree. */
  private async verifyMapping(root: string, subrepo: ResolvedSubrepo, view: SyncView): Promise<void> {
    if (!view.lastExportedMono) return
    const pubSha = view.exportedMonoToPub.get(view.lastExportedMono)
    if (!pubSha) return

    const [expected, actual] = await Promise.all([
      filteredSubtree(root, view.lastExportedMono, subrepo).catch(() => null),
      git(root, ['rev-parse', `${pubSha}^{tree}`]).catch(() => null),
    ])
    if (expected === null || actual === null || expected === actual) return

    this.note(
      `pub commit ${pubSha} does not match the subtree monolith would export from ${view.lastExportedMono} today.`,
      'That is expected if `exclude`, `transform` or `rewriteMessage` changed since that export — the next',
      `\`monolith push ${subrepo.name}\` republishes with the current config. If nothing changed, the public`,
      'branch was probably rewritten.',
    )
  }

  private checkOrigins(importedPubShas: Set<string>, fetchedPubShas: Set<string>): void {
    const orphans = [...importedPubShas].filter((sha) => !fetchedPubShas.has(sha))
    if (orphans.length === 0) return

    this.log('monorepo')
    for (const sha of orphans) {
      this.problem(
        `monorepo history claims to have imported public commit ${sha} (${ORIGIN_TRAILER}), but no configured remote has it.`,
        'The public branch was probably rewritten (force-push) after that import, or the commit came from a',
        'subrepo that is no longer in your config.',
      )
    }
    this.log('')
  }
}
