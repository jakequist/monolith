import fs from 'node:fs'
import path from 'node:path'
import {Command} from '@oclif/core'
import {MultipleConfigsError, findConfig} from '../config.js'
import {gitOk} from '../core/git.js'

/**
 * Plain ESM in a `.js` file. jiti compiles the config from *your* repo, which may have no
 * package.json at all or a CommonJS one, and it reads `export default` in every case — so the
 * scaffold does not have to guess your module system. The JSDoc `@type` gives editors the
 * same completion `defineConfig()` gives a TypeScript config, with no TypeScript in sight.
 */
const TEMPLATE = `/**
 * Monosplice configuration.
 * Docs: https://github.com/jakequist/monosplice
 *
 * @type {import('monosplice').MonospliceConfig}
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

const CONFIG_FILE = 'monosplice.config.js'

export default class Init extends Command {
  static description = 'Create a monosplice.config.js in the current directory'

  async run(): Promise<void> {
    const cwd = process.cwd()
    let existing: string | null
    try {
      existing = findConfig(cwd)
    } catch (err) {
      if (err instanceof MultipleConfigsError) this.error(err.message)
      throw err
    }
    if (existing) {
      this.log(`Already initialized: ${existing}`)
      return
    }
    if (!(await gitOk(cwd, ['rev-parse', '--is-inside-work-tree']))) {
      this.error('Not inside a git repository. Run `git init` first — monosplice manages subdirectories of a git repo.')
    }
    const target = path.join(cwd, CONFIG_FILE)
    fs.writeFileSync(target, TEMPLATE)
    this.log(`Created ${target}`)
    this.log('Add your subrepos to the config, then run `monosplice push <name>` to publish one')
    this.log('(or skip the hand-editing: `monosplice attach <folder> <git-url>` writes the entry and')
    this.log('makes first contact for you, whichever side already has content).')
    this.log('Prefer TypeScript? Rename it to monosplice.config.ts and use `defineConfig()` from monosplice.')
  }
}
