import fs from 'node:fs'
import path from 'node:path'
import {Command} from '@oclif/core'
import {findConfig} from '../config.js'
import {gitOk} from '../core/git.js'

const TEMPLATE = `/**
 * Monolith configuration.
 * Docs: https://github.com/jakequist/monolith
 */
export default {
  subrepos: [
    // {
    //   path: 'packages/my-lib',
    //   remote: 'git@github.com:me/my-lib.git',
    //   branch: 'main',
    //   exclude: [],
    // },
  ],
}
`

export default class Init extends Command {
  static description = 'Create a monolith.config.ts in the current directory'

  async run(): Promise<void> {
    const cwd = process.cwd()
    const existing = findConfig(cwd)
    if (existing) {
      this.log(`Already initialized: ${existing}`)
      return
    }
    if (!(await gitOk(cwd, ['rev-parse', '--is-inside-work-tree']))) {
      this.error('Not inside a git repository. Run `git init` first — monolith manages subdirectories of a git repo.')
    }
    const target = path.join(cwd, 'monolith.config.ts')
    fs.writeFileSync(target, TEMPLATE)
    this.log(`Created ${target}`)
    this.log('Add your subrepos to the config, then run `monolith push <name>` to publish one')
    this.log('(or `monolith adopt <name>` if the remote already has history).')
  }
}
