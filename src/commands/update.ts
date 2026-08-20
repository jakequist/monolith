import fs from 'node:fs'
import path from 'node:path'
import {Command, Flags} from '@oclif/core'
import {execa} from 'execa'

/** npm package name — the CLI is `monolith`, the package is not. */
const PACKAGE = 'monolith-git'
const REGISTRY_TIMEOUT_MS = 10_000

export default class Update extends Command {
  static description = 'Update monolith to the latest version published to npm'

  static flags = {
    check: Flags.boolean({
      description: 'Only report the installed and latest versions; change nothing',
      default: false,
    }),
  }

  static examples = ['<%= config.bin %> <%= command.id %>', '<%= config.bin %> <%= command.id %> --check']

  async run(): Promise<void> {
    const {flags} = await this.parse(Update)
    const current = this.config.version

    if (flags.check) {
      const latest = await this.latestVersion()
      this.log(`installed: ${current}`)
      this.log(`latest:    ${latest}`)
      this.log(latest === current ? '✓ up to date' : `Run \`monolith update\` to install ${latest}.`)
      return
    }

    // Checked before anything touches the network so a dev checkout fails fast and offline.
    if (this.runningFromSource()) {
      this.error(
        `You're running monolith from source (${this.config.root}), not from an installed package.
\`monolith update\` would replace a global npm install, which is not what is on your PATH here.
Update this checkout with git instead:
  git -C ${this.config.root} pull`,
      )
    }

    const latest = await this.latestVersion()
    if (latest === current) {
      this.log(`✓ monolith ${current} is already up to date`)
      return
    }

    this.log(`Updating monolith ${current} → ${latest}…`)
    const res = await execa('npm', ['install', '-g', `${PACKAGE}@latest`], {reject: false, all: true})
    const output = typeof res.all === 'string' ? res.all.trim() : ''
    if (output !== '') this.log(output)

    if (res.exitCode !== 0) {
      this.error(
        `npm could not install ${PACKAGE}@${latest} (exit ${res.exitCode}).
Run it yourself to see the full error (global installs often need elevated permissions):
  npm install -g ${PACKAGE}@latest`,
      )
    }
    this.log(`✓ monolith updated to ${latest}`)
  }

  /** A checkout, not an install: bin/run.js sits inside a git work tree. */
  private runningFromSource(): boolean {
    return fs.existsSync(path.join(this.config.root, '.git'))
  }

  private async latestVersion(): Promise<string> {
    const res = await execa('npm', ['view', PACKAGE, 'version'], {
      reject: false,
      timeout: REGISTRY_TIMEOUT_MS,
    })
    const version = typeof res.stdout === 'string' ? res.stdout.trim() : ''
    if (res.exitCode === 0 && version !== '') return version

    const detail = (typeof res.stderr === 'string' ? res.stderr.trim() : '') || '(no output from npm)'
    this.error(
      `Could not ask the npm registry for the latest ${PACKAGE} version.
${detail}
Check your network and npm setup, then try again — or look it up yourself with:
  npm view ${PACKAGE} version`,
    )
  }
}
