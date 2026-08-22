import {Args, Flags} from '@oclif/core'
import type {ResolvedSubrepo} from '../config.js'
import {MonospliceCommand} from '../lib/base.js'
import {buildExportChain, computeExports, planExport} from '../core/exporter.js'
import {readSequencer} from '../core/importer.js'
import {NoFetchYetError, tryLoadForkState, type SyncView, type SyncViewOptions} from '../core/sync.js'
import {NO_SUBREPOS_CONFIGURED, loadView} from '../lib/ops.js'

/**
 * One row of the `--json` contract (S85). CI pipes this into jq, so the key set is
 * stable: every key is always present, `hookError` is the single optional addition.
 */
export interface SubrepoStatus {
  name: string
  path: string
  remote: string
  branch: string
  seeded: boolean
  /** Commits `push` would create. Null when the subrepo is not seeded. */
  ahead: number | null
  /** Standalone-repo commits `pull` would import. Null when the subrepo is not seeded. */
  behind: number | null
  inSync: boolean
  pullInProgress: boolean
  /** Set when a scan/transform hook throws: `ahead` is then an upper bound. */
  hookError?: string
}

/**
 * Human-only annotations. They are deliberately not part of `SubrepoStatus`: the `--json`
 * row key set is a contract (S85), and neither triangular mode nor `--offline` may change it.
 */
interface Note {
  /** The fork branch already carries every pending commit — we are waiting on upstream. */
  awaitingUpstream: boolean
  /** Set when the fork could not be reached; the counts are still upstream-accurate. */
  unreachable?: string
  /** `--offline` and this subrepo has never been fetched, so there is nothing to measure. */
  noFetchYet?: boolean
}

export default class Status extends MonospliceCommand {
  static description = 'Show how far each subrepo is ahead of and behind its standalone remote'

  static args = {
    subrepo: Args.string({description: 'Only report this subrepo (defaults to all)', required: false}),
  }

  static flags = {
    json: Flags.boolean({description: 'Print machine-readable JSON and nothing else', default: false}),
    check: Flags.boolean({
      description: 'Exit 1 unless every subrepo is fully in sync (for CI); the report itself is unchanged',
      default: false,
    }),
    offline: Flags.boolean({
      description:
        'Fetch nothing: measure against the remote-tracking refs the last run left behind. A subrepo that has never been fetched is reported as such rather than guessed at.',
      default: false,
    }),
  }

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> core',
    '<%= config.bin %> <%= command.id %> --json',
    '<%= config.bin %> <%= command.id %> --check',
    '<%= config.bin %> <%= command.id %> --offline',
  ]

  async run(): Promise<void> {
    const {args, flags} = await this.parse(Status)
    const project = await this.requireProject()
    const state = await readSequencer(project.root)

    // Once per run, on stderr: the counts below are as fresh as the last fetch and no fresher,
    // and stdout stays pipeable (S156).
    if (flags.offline) this.logToStderr('offline: using last-fetched state')

    const selected = this.selectSubrepos(project, args.subrepo)
    const rows: SubrepoStatus[] = []
    const notes = new Map<string, Note>()
    for (const subrepo of selected) {
      const {row, note} = await this.inspect(project.root, subrepo, state?.subrepo === subrepo.name, {
        offline: flags.offline,
      })
      rows.push(row)
      if (note) notes.set(row.name, note)
    }

    if (flags.json) this.log(JSON.stringify({...(flags.offline ? {offline: true} : {}), subrepos: rows}))
    else if (selected.length === 0) this.log(NO_SUBREPOS_CONFIGURED)
    else for (const row of rows) this.describe(row, notes.get(row.name))

    if (flags.check) this.check(rows, notes)
  }

  /**
   * The `--check` contract: exit 1 unless everything is converged and every remote answered.
   * The report above is untouched — a machine reads the exit code, a human reads the lines.
   */
  private check(rows: SubrepoStatus[], notes: Map<string, Note>): void {
    const unreachable = [...notes].filter(([, n]) => n.unreachable).map(([name]) => name)
    const failing = [...new Set([...rows.filter((r) => !r.inSync).map((r) => r.name), ...unreachable])]
    if (failing.length === 0) return
    this.error(
      `--check: ${failing.join(', ')} ${failing.length === 1 ? 'is' : 'are'} not fully in sync.\nRun \`monosplice sync\` to converge, or \`monosplice status\` for the details.`,
      {exit: 1},
    )
  }

  private async inspect(
    root: string,
    subrepo: ResolvedSubrepo,
    pullInProgress: boolean,
    opts: SyncViewOptions,
  ): Promise<{row: SubrepoStatus; note?: Note}> {
    const base = {
      name: subrepo.name,
      path: subrepo.path,
      remote: subrepo.remote,
      branch: subrepo.branch,
      pullInProgress,
    }
    const unmeasured = {...base, seeded: false, ahead: null, behind: null, inSync: false}

    let view: SyncView
    try {
      view = await loadView(root, subrepo, this.reporter(), opts)
    } catch (err) {
      // Offline with no tracking ref: "never fetched" and "no branch on the remote" look the
      // same from here, so report the gap instead of picking one.
      if (err instanceof NoFetchYetError) {
        return {row: unmeasured, note: {awaitingUpstream: false, noFetchYet: true}}
      }
      throw err
    }
    if (view.pubHead === null) return {row: unmeasured}

    const {candidates} = await planExport(root, subrepo, view)
    // Candidates over-report: tree-equality drops pure imports and excluded-only commits.
    // A throwing hook is a push-time failure, not a reason for status to blow up.
    let ahead = candidates.length
    let hookError: string | undefined
    let note: Note | undefined
    try {
      const planned = await computeExports(root, subrepo, view, candidates)
      ahead = planned.length
      if (subrepo.upstream !== undefined) note = await this.inspectFork(root, subrepo, view.pubHead, planned, opts)
    } catch (err) {
      hookError = (err as Error).message
    }

    const behind = view.unreflectedPub.length
    return {
      row: {
        ...base,
        seeded: true,
        ahead,
        behind,
        inSync: ahead === 0 && behind === 0,
        ...(hookError === undefined ? {} : {hookError}),
      },
      ...(note === undefined ? {} : {note}),
    }
  }

  /**
   * Has the fork branch already been built from exactly these commits? Exports are
   * sha-deterministic, so rebuilding the chain locally and comparing tips answers that
   * exactly — and tells the user their patches are waiting on a maintainer, not on them.
   */
  private async inspectFork(
    root: string,
    subrepo: ResolvedSubrepo,
    pubHead: string,
    planned: Awaited<ReturnType<typeof computeExports>>,
    opts: SyncViewOptions,
  ): Promise<Note> {
    const {state, error} = await tryLoadForkState(root, subrepo, opts)
    if (error) return {awaitingUpstream: false, unreachable: error.stderr.trim() || error.message}
    if (planned.length === 0 || !state?.head) return {awaitingUpstream: false}
    const {tip} = await buildExportChain(root, planned, pubHead)
    return {awaitingUpstream: tip === state.head}
  }

  private describe(row: SubrepoStatus, note?: Note): void {
    if (note?.noFetchYet) {
      this.log(`${row.name}: no fetch yet — run without --offline first`)
    } else if (!row.seeded) {
      this.log(`${row.name}: not published yet (run \`monosplice push ${row.name} --yes\`)`)
    } else if (row.inSync) {
      this.log(`${row.name}: in sync`)
    } else {
      const parts: string[] = []
      if (row.ahead) {
        parts.push(`${row.ahead} to push${note?.awaitingUpstream ? ' (awaiting upstream merge)' : ''}`)
      }
      if (row.behind) parts.push(`${row.behind} to pull`)
      this.log(`${row.name}: ${parts.join(', ')}`)
    }

    // The counts are the report; everything below is a diagnostic, so it goes to stderr and
    // leaves stdout pipeable (S156).
    if (note?.unreachable) {
      this.logToStderr(`  ! cannot reach fork ${row.remote} — the counts above are measured against upstream.`)
      for (const line of note.unreachable.split('\n')) this.logToStderr(`    ${line}`)
    }
    if (row.pullInProgress) {
      this.logToStderr(`  ! a pull of ${row.name} is unfinished — resolve the conflict, \`git add\` the files,`)
      this.logToStderr('    then run `monosplice pull --continue`, or `monosplice pull --abort` to throw it away')
    }
    if (row.hookError) {
      this.logToStderr(`  ! ${row.hookError}`)
      this.logToStderr(`    \`monosplice push ${row.name}\` would fail with this; the count above is an upper bound.`)
    }
  }
}
