import {Args, Flags} from '@oclif/core'
import type {ResolvedSubrepo} from '../config.js'
import {MonospliceCommand} from '../lib/base.js'
import {computeExports, exportBaseRewritten, planExport} from '../core/exporter.js'
import {filteredSubtree} from '../core/filter.js'
import {git, revList} from '../core/git.js'
import {readSequencer, sequencerPath} from '../core/importer.js'
import {loadSyncView, pullSource, tryLoadForkState, type SyncView} from '../core/sync.js'
import {ORIGIN_TRAILER, SOURCE_TRAILER} from '../core/trailers.js'

/** A problem or a note: one headline, plus prose only a human needs. */
interface Finding {
  headline: string
  detail: string[]
}

/**
 * One row of the `--json` contract (S154). Same spirit as `status --json`: every key is
 * always present, nulls stand in for "does not apply here", and `problems`/`notes` carry the
 * headline of each finding — the detail lines are advice for a terminal, not data.
 */
export interface DoctorSubrepo {
  name: string
  path: string
  remote: string
  branch: string
  upstream: string | null
  pushBranch: string | null
  /** Could the pull source be reached at all? Everything below is null when it could not. */
  reachable: boolean
  seeded: boolean
  pubHead: string | null
  /** Triangular only: head of the branch monosplice rebuilds on the fork. */
  forkHead: string | null
  lastExportedMono: string | null
  lastExportedPub: string | null
  ahead: number | null
  behind: number | null
  problems: string[]
  notes: string[]
}

export interface DoctorReport {
  ok: boolean
  problems: number
  pullInProgress: {subrepo: string; statePath: string} | null
  subrepos: DoctorSubrepo[]
  /** Findings about monorepo history itself, which belong to no single subrepo. */
  monorepo: {problems: string[]}
}

/** Accumulator for one subrepo while it is being checked. */
interface Section {
  row: DoctorSubrepo
  /** Human report lines, in the order they were produced. */
  lines: string[]
  problems: Finding[]
  notes: Finding[]
}

export default class Doctor extends MonospliceCommand {
  static description = 'Report the derived sync points for every subrepo and verify they match reality'

  static args = {
    subrepo: Args.string({description: 'Only check this subrepo (defaults to all)', required: false}),
  }

  static flags = {
    json: Flags.boolean({description: 'Print machine-readable JSON and nothing else', default: false}),
  }

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> core',
    '<%= config.bin %> <%= command.id %> --json',
  ]

  async run(): Promise<void> {
    const {args, flags} = await this.parse(Doctor)
    const project = await this.requireProject()
    const root = project.root

    const state = await readSequencer(root)
    const pullInProgress = state === null ? null : {subrepo: state.subrepo, statePath: await sequencerPath(root)}

    const subrepos = this.selectSubrepos(project, args.subrepo)
    const sections: Section[] = []
    const fetchedPubShas = new Set<string>()
    let importedPubShas = new Set<string>()

    for (const subrepo of subrepos) {
      const {section, view} = await this.checkSubrepo(root, subrepo)
      sections.push(section)
      if (view) {
        for (const sha of await revList(root, [view.trackingRef])) fetchedPubShas.add(sha)
        importedPubShas = view.importedPubShas
      }
    }

    // Only meaningful with every subrepo in view: a Monosplice-Origin trailer in monorepo
    // history may belong to any of the configured remotes.
    const orphans = args.subrepo ? [] : this.checkOrigins(importedPubShas, fetchedPubShas)

    const problems =
      (pullInProgress === null ? 0 : 1) +
      sections.reduce((n, s) => n + s.problems.length, 0) +
      orphans.length

    const report: DoctorReport = {
      ok: problems === 0,
      problems,
      pullInProgress,
      subrepos: sections.map((s) => s.row),
      monorepo: {problems: orphans.map((f) => f.headline)},
    }

    if (flags.json) this.log(JSON.stringify(report))
    else this.render(report, sections, orphans)

    if (problems === 0) return
    this.error(`${problems} problem(s) found — see the report above.`, {exit: 1})
  }

  // ---------------------------------------------------------------------------------------
  // Human rendering. Everything above builds the model; this is the only place that prints.
  // ---------------------------------------------------------------------------------------

  private render(report: DoctorReport, sections: Section[], orphans: Finding[]): void {
    const {pullInProgress} = report
    if (pullInProgress) {
      this.log(`✗ an unfinished pull of ${pullInProgress.subrepo} is recorded in ${pullInProgress.statePath}`)
      this.log('  Resolve the conflict, `git add` the files, then run `monosplice pull --continue`.')
      this.log('  To abandon that import instead, run `monosplice pull --abort`.')
      this.log('')
    }
    for (const section of sections) {
      for (const line of section.lines) this.log(line)
      this.log('')
    }
    if (orphans.length > 0) {
      this.log('monorepo')
      for (const finding of orphans) this.renderFinding('✗', finding, (line) => this.log(line))
      this.log('')
    }
    if (report.ok) this.log('✓ all checks passed')
  }

  private renderFinding(mark: string, finding: Finding, emit: (line: string) => void): void {
    emit(`  ${mark} ${finding.headline}`)
    for (const line of finding.detail) emit(`    ${line}`)
  }

  // ---------------------------------------------------------------------------------------
  // Checks. Each one appends to the section's model; `lines` is built alongside so the human
  // report keeps the interleaved order it always had.
  // ---------------------------------------------------------------------------------------

  private problem(section: Section, headline: string, ...detail: string[]): void {
    const finding = {headline, detail}
    section.problems.push(finding)
    section.row.problems.push(headline)
    this.renderFinding('✗', finding, (line) => section.lines.push(line))
  }

  private note(section: Section, headline: string, ...detail: string[]): void {
    const finding = {headline, detail}
    section.notes.push(finding)
    section.row.notes.push(headline)
    this.renderFinding('!', finding, (line) => section.lines.push(line))
  }

  private async checkSubrepo(
    root: string,
    subrepo: ResolvedSubrepo,
  ): Promise<{section: Section; view: SyncView | null}> {
    const triangular = subrepo.upstream !== undefined
    const section: Section = {
      row: {
        name: subrepo.name,
        path: subrepo.path,
        remote: subrepo.remote,
        branch: subrepo.branch,
        upstream: subrepo.upstream ?? null,
        pushBranch: triangular ? subrepo.pushBranch : null,
        reachable: true,
        seeded: false,
        pubHead: null,
        forkHead: null,
        lastExportedMono: null,
        lastExportedPub: null,
        ahead: null,
        behind: null,
        problems: [],
        notes: [],
      },
      lines: [],
      problems: [],
      notes: [],
    }

    section.lines.push(subrepo.name, `  path:          ${subrepo.path}/`)
    if (triangular) {
      section.lines.push(`  upstream:      ${subrepo.upstream} (${subrepo.branch})`)
      section.lines.push(`  fork:          ${subrepo.remote} (${subrepo.pushBranch})`)
    } else {
      section.lines.push(`  remote:        ${subrepo.remote} (${subrepo.branch})`)
    }

    let view: SyncView
    try {
      view = await loadSyncView(root, subrepo)
    } catch (err) {
      section.row.reachable = false
      this.problem(
        section,
        `cannot reach ${triangular ? 'upstream ' : ''}${pullSource(subrepo)}`,
        ...(err as Error).message.split('\n'),
        'Fix the URL in your config or your network/credentials, then run `monosplice doctor` again.',
      )
      return {section, view: null}
    }

    if (view.pubHead === null) {
      this.problem(
        section,
        `not published yet — ${pullSource(subrepo)} has no ${subrepo.branch} branch.`,
        triangular
          ? `Fix \`upstream\` or \`branch\` in your config: monosplice builds the fork branch on the upstream head.`
          : `Run \`monosplice push ${subrepo.name} --yes\` to publish it for the first time.`,
      )
      return {section, view: null}
    }

    section.row.seeded = true
    section.row.pubHead = view.pubHead
    section.lines.push(`  ${triangular ? 'upstream head:' : 'pub head:     '} ${view.pubHead}`)
    if (triangular) await this.reportFork(section, root, subrepo)

    section.row.lastExportedMono = view.lastExportedMono
    if (view.lastExportedMono) {
      const pub = view.exportedMonoToPub.get(view.lastExportedMono) ?? null
      section.row.lastExportedPub = pub
      section.lines.push(`  last exported: mono ${view.lastExportedMono}`)
      section.lines.push(`                 pub  ${pub ?? '(unknown)'}`)
    } else {
      section.lines.push('  last exported: (nothing yet)')
    }

    await this.reportCounts(section, root, subrepo, view)

    for (const broken of view.brokenSourceRefs) {
      this.problem(
        section,
        `standalone commit ${broken.pubSha} carries ${SOURCE_TRAILER}: ${broken.monoSha}, but that monorepo commit does not exist in this clone.`,
        'Usually the monorepo clone is missing history (a shallow or partial clone), or `remote` points',
        'at a repository that was published from a different monorepo.',
        'Run `git fetch --unshallow` (or fix `remote` in your config); monosplice refuses to export until',
        'the mapping resolves, so nothing can be published on top of a history it cannot see.',
      )
    }

    if (await exportBaseRewritten(root, view)) {
      this.problem(
        section,
        `the last exported monorepo commit ${view.lastExportedMono} is no longer an ancestor of HEAD.`,
        'Monorepo history was rewritten (rebase, amend or force-push) underneath it, so the export range',
        'is meaningless and `monosplice push` will refuse.',
        'Restore that commit (see `git reflog`) or re-point the branch at history that contains it.',
      )
    }

    await this.verifyMapping(section, root, subrepo, view)
    return {section, view}
  }

  /**
   * The fork is reported separately from upstream and never conflated with it: an unreachable
   * fork blocks `push` and nothing else, so it must not read like the sync source is broken.
   */
  private async reportFork(section: Section, root: string, subrepo: ResolvedSubrepo): Promise<void> {
    const {state, error} = await tryLoadForkState(root, subrepo)
    if (error) {
      this.problem(
        section,
        `cannot reach fork remote ${subrepo.remote}`,
        ...error.message.split('\n'),
        `Pulling still works — it only talks to ${subrepo.upstream} — but \`monosplice push ${subrepo.name}\` will fail.`,
        'Fix `remote` in your config or your network/credentials, then run `monosplice doctor` again.',
      )
      return
    }
    if (!state?.head) {
      section.lines.push(`  fork head:     (no ${subrepo.pushBranch} branch yet)`)
      return
    }
    section.row.forkHead = state.head
    section.lines.push(`  fork head:     ${state.head}`)
  }

  private async reportCounts(
    section: Section,
    root: string,
    subrepo: ResolvedSubrepo,
    view: SyncView,
  ): Promise<void> {
    const {candidates} = await planExport(root, subrepo, view)
    let ahead = candidates.length
    let hookError: string | undefined
    try {
      ahead = (await computeExports(root, subrepo, view, candidates)).length
    } catch (err) {
      hookError = (err as Error).message
    }
    section.row.ahead = ahead
    section.row.behind = view.unreflectedPub.length
    section.lines.push(`  to push: ${ahead}, to pull: ${view.unreflectedPub.length}`)
    if (hookError) {
      this.problem(
        section,
        `a configured hook rejects a pending commit: ${hookError}`,
        `\`monosplice push ${subrepo.name}\` will fail until that commit is fixed or the hook is changed.`,
      )
    }
  }

  /** The cursor claims a standalone commit X exported mono commit Y; check the trees agree. */
  private async verifyMapping(
    section: Section,
    root: string,
    subrepo: ResolvedSubrepo,
    view: SyncView,
  ): Promise<void> {
    if (!view.lastExportedMono) return
    const pubSha = view.exportedMonoToPub.get(view.lastExportedMono)
    if (!pubSha) return

    const [expected, actual] = await Promise.all([
      filteredSubtree(root, view.lastExportedMono, subrepo).catch(() => null),
      git(root, ['rev-parse', `${pubSha}^{tree}`]).catch(() => null),
    ])
    if (expected === null || actual === null || expected === actual) return

    this.note(
      section,
      `commit ${pubSha} does not match the subtree monosplice would export from ${view.lastExportedMono} today.`,
      'That is expected if `exclude`, `transform` or `rewriteMessage` changed since that export — the next',
      `\`monosplice push ${subrepo.name}\` republishes with the current config. If nothing changed, the`,
      'standalone branch was probably rewritten.',
    )
  }

  private checkOrigins(importedPubShas: Set<string>, fetchedPubShas: Set<string>): Finding[] {
    return [...importedPubShas]
      .filter((sha) => !fetchedPubShas.has(sha))
      .map((sha) => ({
        headline: `monorepo history claims to have imported commit ${sha} (${ORIGIN_TRAILER}), but no configured remote has it.`,
        detail: [
          'The standalone branch was probably rewritten (force-push) after that import, or the commit came',
          'from a subrepo that is no longer in your config.',
        ],
      }))
  }
}
