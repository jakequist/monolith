import {Command} from '@oclif/core'
import {ConfigError, MultipleConfigsError, loadProject, type Project, type ResolvedSubrepo} from '../config.js'
import {gitOk} from '../core/git.js'
import {NO_SUBREPOS_CONFIGURED, SubrepoFailure, type Reporter} from './ops.js'

export abstract class MonospliceCommand extends Command {
  /** Adapter so `src/lib/ops.ts` can report without depending on oclif. */
  protected reporter(): Reporter {
    return {
      log: (message) => this.log(message),
      warn: (message) => this.logToStderr(message),
      fail: (message) => this.error(message),
    }
  }

  /**
   * A reporter whose failures are collected instead of exiting, for the commands that walk
   * several subrepos: one refusal must never silence the rest. Pair with `eachSubrepo`.
   */
  protected collectingReporter(): Reporter {
    return {
      log: (message) => this.log(message),
      warn: (message) => this.logToStderr(message),
      fail: (message, opts) => {
        throw new SubrepoFailure(message, opts?.halt ?? false)
      },
    }
  }

  /**
   * Run `body` for each subrepo, collecting per-subrepo failures and reporting them together
   * at the end with a non-zero exit. A failure marked `halt` stops the walk where it stands —
   * that is the conflict case, where a sequencer now sits on disk and only one may exist.
   */
  protected async eachSubrepo(
    subrepos: ResolvedSubrepo[],
    body: (subrepo: ResolvedSubrepo) => Promise<void>,
  ): Promise<void> {
    if (subrepos.length === 0) {
      this.log(NO_SUBREPOS_CONFIGURED)
      return
    }

    const failures: string[] = []
    for (const subrepo of subrepos) {
      try {
        await body(subrepo)
      } catch (err) {
        if (err instanceof SubrepoFailure) {
          failures.push(err.message)
          if (err.halt) break
          continue
        }
        throw err
      }
    }

    if (failures.length > 0) this.error(failures.join('\n\n'), {exit: 1})
  }

  /** Load config walking up from cwd; exits with a helpful error when absent/invalid. */
  protected async requireProject(): Promise<Project> {
    let project: Project | null
    try {
      project = await loadProject(process.cwd())
    } catch (err) {
      if (err instanceof ConfigError || err instanceof MultipleConfigsError) this.error(err.message)
      throw err
    }
    if (!project) {
      this.error(
        'No monosplice config found. Run this inside a repo containing monosplice.config.js, or run `monosplice init` to create one.',
      )
    }
    if (!(await gitOk(project.root, ['rev-parse', '--is-inside-work-tree']))) {
      this.error(`${project.root} is not a git repository.`)
    }
    return project
  }

  /** Pick subrepos by optional name argument; exits if the name is unknown. */
  protected selectSubrepos(project: Project, name?: string): ResolvedSubrepo[] {
    if (!name) return project.subrepos
    const match = project.subrepos.find((s) => s.name === name)
    if (!match) {
      this.error(
        `Unknown subrepo ${JSON.stringify(name)}. Configured subrepos: ${project.subrepos.map((s) => s.name).join(', ') || '(none)'}`,
      )
    }
    return [match]
  }
}
