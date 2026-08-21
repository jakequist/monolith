import {Command} from '@oclif/core'
import {ConfigError, loadProject, type Project, type ResolvedSubrepo} from '../config.js'
import {gitOk} from '../core/git.js'
import type {Reporter} from './ops.js'

export abstract class MonospliceCommand extends Command {
  /** Adapter so `src/lib/ops.ts` can report without depending on oclif. */
  protected reporter(): Reporter {
    return {
      log: (message) => this.log(message),
      warn: (message) => this.logToStderr(message),
      fail: (message) => this.error(message),
    }
  }

  /** Load config walking up from cwd; exits with a helpful error when absent/invalid. */
  protected async requireProject(): Promise<Project> {
    let project: Project | null
    try {
      project = await loadProject(process.cwd())
    } catch (err) {
      if (err instanceof ConfigError) this.error(err.message)
      throw err
    }
    if (!project) {
      this.error(
        'No monosplice config found. Run this inside a repo containing monosplice.config.ts, or run `monosplice init` to create one.',
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
