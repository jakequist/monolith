import {Args, Flags} from '@oclif/core'
import type {ResolvedSubrepo} from '../config.js'
import {MonolithCommand} from '../lib/base.js'
import {computeExports, planExport} from '../core/exporter.js'
import {readSequencer} from '../core/importer.js'
import {loadView} from '../lib/ops.js'

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
  /** Public commits `pull` would import. Null when the subrepo is not seeded. */
  behind: number | null
  inSync: boolean
  pullInProgress: boolean
  /** Set when a scan/transform hook throws: `ahead` is then an upper bound. */
  hookError?: string
}

export default class Status extends MonolithCommand {
  static description = 'Show how far each subrepo is ahead of and behind its public remote'

  static args = {
    subrepo: Args.string({description: 'Only report this subrepo (defaults to all)', required: false}),
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
    const {args, flags} = await this.parse(Status)
    const project = await this.requireProject()
    const state = await readSequencer(project.root)

    const rows: SubrepoStatus[] = []
    for (const subrepo of this.selectSubrepos(project, args.subrepo)) {
      rows.push(await this.inspect(project.root, subrepo, state?.subrepo === subrepo.name))
    }

    if (flags.json) {
      this.log(JSON.stringify({subrepos: rows}))
      return
    }
    for (const row of rows) this.describe(row)
  }

  private async inspect(
    root: string,
    subrepo: ResolvedSubrepo,
    pullInProgress: boolean,
  ): Promise<SubrepoStatus> {
    const base = {
      name: subrepo.name,
      path: subrepo.path,
      remote: subrepo.remote,
      branch: subrepo.branch,
      pullInProgress,
    }

    const view = await loadView(root, subrepo, this.reporter())
    if (view.pubHead === null) {
      return {...base, seeded: false, ahead: null, behind: null, inSync: false}
    }

    const {candidates} = await planExport(root, subrepo, view)
    // Candidates over-report: tree-equality drops pure imports and excluded-only commits.
    // A throwing hook is a push-time failure, not a reason for status to blow up.
    let ahead = candidates.length
    let hookError: string | undefined
    try {
      ahead = (await computeExports(root, subrepo, view, candidates)).length
    } catch (err) {
      hookError = (err as Error).message
    }

    const behind = view.unreflectedPub.length
    return {
      ...base,
      seeded: true,
      ahead,
      behind,
      inSync: ahead === 0 && behind === 0,
      ...(hookError === undefined ? {} : {hookError}),
    }
  }

  private describe(row: SubrepoStatus): void {
    if (!row.seeded) {
      this.log(`${row.name}: not published yet (run \`monolith push ${row.name} --yes\`)`)
    } else if (row.inSync) {
      this.log(`${row.name}: in sync`)
    } else {
      const parts: string[] = []
      if (row.ahead) parts.push(`${row.ahead} to push`)
      if (row.behind) parts.push(`${row.behind} to pull`)
      this.log(`${row.name}: ${parts.join(', ')}`)
    }

    if (row.pullInProgress) {
      this.log(`  ! a pull of ${row.name} is unfinished — resolve the conflict, \`git add\` the files,`)
      this.log('    then run `monolith pull --continue`')
    }
    if (row.hookError) {
      this.log(`  ! ${row.hookError}`)
      this.log(`    \`monolith push ${row.name}\` would fail with this; the count above is an upper bound.`)
    }
  }
}
