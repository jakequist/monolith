import readline from 'node:readline/promises'
import {Args, Flags} from '@oclif/core'
import type {ResolvedSubrepo} from '../config.js'
import {MonolithCommand} from '../lib/base.js'
import {SubrepoFailure, exportSubrepo, firstPublish, loadView, type Reporter} from '../lib/ops.js'

interface PushFlags {
  yes: boolean
  'full-history': boolean
}

export default class Push extends MonolithCommand {
  static description = 'Export new monorepo commits to the public subrepo remotes'

  static args = {
    subrepo: Args.string({description: 'Only push this subrepo (defaults to all)', required: false}),
  }

  static flags = {
    yes: Flags.boolean({
      char: 'y',
      description: 'Answer the first-publish confirmation with yes (required in scripts and CI)',
      default: false,
    }),
    'full-history': Flags.boolean({
      description: 'First publish only: replay every commit touching the subrepo instead of one baseline commit',
      default: false,
    }),
  }

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> core',
    '<%= config.bin %> <%= command.id %> core --yes',
    '<%= config.bin %> <%= command.id %> core --yes --full-history',
  ]

  async run(): Promise<void> {
    const {args, flags} = await this.parse(Push)
    const project = await this.requireProject()

    // One subrepo refusing (typically: never published, no --yes) must not silence the
    // others, so failures are collected and reported together at the end.
    const reporter: Reporter = {
      log: (message) => this.log(message),
      warn: (message) => this.logToStderr(message),
      fail: (message) => {
        throw new SubrepoFailure(message)
      },
    }

    const failures: string[] = []
    for (const subrepo of this.selectSubrepos(project, args.subrepo)) {
      try {
        await this.pushOne(project.root, subrepo, reporter, flags)
      } catch (err) {
        if (err instanceof SubrepoFailure) {
          failures.push(err.message)
          continue
        }
        throw err
      }
    }

    if (failures.length > 0) this.error(failures.join('\n\n'), {exit: 1})
  }

  private async pushOne(
    root: string,
    subrepo: ResolvedSubrepo,
    r: Reporter,
    flags: PushFlags,
  ): Promise<void> {
    const view = await loadView(root, subrepo, r)

    if (view.pubHead === null) {
      const result = await firstPublish(root, subrepo, r, {
        fullHistory: flags['full-history'],
        confirm: () => this.confirmFirstPublish(subrepo, flags.yes, r),
      })
      const how = result.fullHistory ? `replayed ${result.commits} commit(s)` : 'one baseline commit'
      this.log(`✓ ${subrepo.name}: published ${subrepo.path}/ to ${subrepo.remote} (${subrepo.branch}) — ${how}`)
      return
    }

    if (flags['full-history']) {
      r.fail(
        `${subrepo.name}: --full-history only applies to the first publish, and ${subrepo.remote} already has a ${subrepo.branch} branch (${view.pubHead.slice(0, 10)}).
Nothing was pushed. Run \`monolith push ${subrepo.name}\` to export new commits.`,
      )
    }

    const exported = await exportSubrepo(root, subrepo, r, view)
    if (exported === 0) this.log(`✓ ${subrepo.name}: up to date`)
    else this.log(`✓ ${subrepo.name}: exported ${exported} commit(s)`)
  }

  /**
   * Publishing to a public remote is irreversible, so the very first push asks. At a
   * terminal that is a prompt; anywhere else it is a refusal naming the exact command,
   * because a CI job must never publish a repository by accident.
   */
  private async confirmFirstPublish(subrepo: ResolvedSubrepo, yes: boolean, r: Reporter): Promise<void> {
    if (yes) return

    if (process.stdin.isTTY && process.stdout.isTTY) {
      const rl = readline.createInterface({input: process.stdin, output: process.stdout})
      let answer: string
      try {
        answer = await rl.question(
          `${subrepo.remote} (${subrepo.branch}) is empty. Publish ${subrepo.name}'s current tree as its first public commit? [y/N] `,
        )
      } finally {
        rl.close()
      }
      if (/^y(es)?$/i.test(answer.trim())) return
      r.fail(`${subrepo.name}: cancelled — nothing was pushed to ${subrepo.remote}.`)
    }

    r.fail(
      `${subrepo.name}: ${subrepo.remote} has no ${subrepo.branch} branch — this would be the first publish of ${subrepo.path}/.
Nothing was pushed. Publishing to a public remote cannot be undone, so monolith asks first; there is no terminal here to ask at. Run:
  monolith push ${subrepo.name} --yes
Add --full-history to replay every monorepo commit that touched ${subrepo.path}/ instead of publishing one baseline commit.`,
    )
  }
}
