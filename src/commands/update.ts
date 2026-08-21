import fs from 'node:fs'
import path from 'node:path'
import {Command, Flags} from '@oclif/core'
import {execa} from 'execa'
import {
  LATEST_RELEASE_API,
  PACKAGE,
  RELEASE_REPO,
  RELEASES_PAGE,
  releaseAssetUrl,
  versionFromTag,
} from '../core/release.js'

const REQUEST_TIMEOUT_MS = 10_000

export default class Update extends Command {
  static description = 'Update monolith to the latest version published on GitHub Releases'

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

    const url = releaseAssetUrl(latest)
    this.log(`Updating monolith ${current} → ${latest}…`)
    const res = await execa('npm', ['install', '-g', url], {reject: false, all: true})
    const output = typeof res.all === 'string' ? res.all.trim() : ''
    if (output !== '') this.log(output)

    if (res.exitCode !== 0) {
      this.error(
        `npm could not install ${PACKAGE} ${latest} from GitHub Releases (exit ${res.exitCode}).
Run it yourself to see the full error (global installs often need elevated permissions):
  npm install -g ${url}`,
      )
    }
    this.log(`✓ monolith updated to ${latest}`)
  }

  /** A checkout, not an install: bin/run.js sits inside a git work tree. */
  private runningFromSource(): boolean {
    return fs.existsSync(path.join(this.config.root, '.git'))
  }

  /** Newest release tag on GitHub, as a bare version. */
  private async latestVersion(): Promise<string> {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'monolith-cli',
    }
    // Needed while the repo is private; harmless once it is public.
    const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN
    if (token) headers.Authorization = `Bearer ${token}`

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
    let res: Response
    try {
      res = await fetch(LATEST_RELEASE_API, {headers, signal: controller.signal})
    } catch (error) {
      const detail = controller.signal.aborted
        ? `GitHub did not answer within ${REQUEST_TIMEOUT_MS / 1000}s.`
        : error instanceof Error
          ? error.message
          : String(error)
      this.error(
        `Could not reach GitHub to look up the latest monolith release.
${detail}
Check your network and try again, or see the releases yourself:
  ${RELEASES_PAGE}`,
      )
    } finally {
      clearTimeout(timer)
    }

    if (res.status === 404) {
      this.error(
        `GitHub reports no published releases for ${RELEASE_REPO}, so there is nothing to update to.
Either none have been cut yet, or this machine cannot see the repository — if it is private, set GH_TOKEN to a token that can read it.
Check the release list yourself:
  ${RELEASES_PAGE}`,
      )
    }

    if (!res.ok) {
      const hint =
        res.status === 401 || res.status === 403
          ? 'Set GH_TOKEN to a GitHub token that can read the repository, then try again.'
          : 'Try again in a moment.'
      this.error(
        `GitHub answered ${res.status} ${res.statusText} when asked for the latest monolith release.
${hint}
You can always look it up yourself:
  ${RELEASES_PAGE}`,
      )
    }

    let tag: unknown
    try {
      const body = (await res.json()) as {tag_name?: unknown}
      tag = body.tag_name
    } catch {
      tag = undefined
    }

    if (typeof tag !== 'string') {
      this.error(
        `GitHub's answer for the latest monolith release had no tag name in it.
Check the release list yourself:
  ${RELEASES_PAGE}`,
      )
    }

    try {
      return versionFromTag(tag)
    } catch {
      this.error(
        `The latest monolith release is tagged "${tag}", which carries no version number.
Releases must be tagged vX.Y.Z. Check the release list yourself:
  ${RELEASES_PAGE}`,
      )
    }
  }
}
