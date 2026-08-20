import {execa} from 'execa'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {onTestFinished} from 'vitest'

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../bin/run.js')

/**
 * Deterministic git environment: no user/system config, fixed identities.
 * Dates are assigned per-commit by nextDate() so consecutive commits with
 * identical content still get distinct shas.
 */
export const GIT_ENV: Record<string, string> = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'Mono Author',
  GIT_AUTHOR_EMAIL: 'mono@example.test',
  GIT_COMMITTER_NAME: 'Mono Committer',
  GIT_COMMITTER_EMAIL: 'committer@example.test',
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: 'commit.gpgsign',
  GIT_CONFIG_VALUE_0: 'false',
  GIT_CONFIG_KEY_1: 'init.defaultBranch',
  GIT_CONFIG_VALUE_1: 'main',
  NO_COLOR: '1',
}

let dateCounter = 0
/** Monotonic fake timestamps (base 2026-01-01, +61s per commit). */
export function nextDate(): string {
  dateCounter += 1
  return `${1_767_225_600 + dateCounter * 61} +0000`
}

/** Temp directory removed when the current test finishes. */
export function sandbox(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'monolith-e2e-'))
  onTestFinished(() => {
    fs.rmSync(dir, {recursive: true, force: true})
  })
  return dir
}

export interface RunResult {
  stdout: string
  stderr: string
  exitCode: number
}

/** Run the built monolith CLI (black-box) in a directory. Never throws on non-zero exit. */
export async function runMonolith(cwd: string, args: string[], env: Record<string, string> = {}): Promise<RunResult> {
  const res = await execa('node', [BIN, ...args], {
    cwd,
    env: {...GIT_ENV, ...env},
    reject: false,
    all: true,
  })
  return {
    stdout: res.stdout as string,
    stderr: res.stderr as string,
    exitCode: res.exitCode ?? -1,
  }
}

export class TestRepo {
  constructor(readonly dir: string) {}

  async git(args: string[], opts: {env?: Record<string, string>; input?: string} = {}): Promise<string> {
    const res = await execa('git', args, {
      cwd: this.dir,
      env: {...GIT_ENV, ...opts.env},
      input: opts.input,
      stripFinalNewline: true,
    })
    return res.stdout as string
  }

  write(rel: string, content: string | Buffer): void {
    const abs = path.join(this.dir, rel)
    fs.mkdirSync(path.dirname(abs), {recursive: true})
    fs.writeFileSync(abs, content)
  }

  rm(rel: string): void {
    fs.rmSync(path.join(this.dir, rel), {recursive: true, force: true})
  }

  read(rel: string): string {
    return fs.readFileSync(path.join(this.dir, rel), 'utf8')
  }

  exists(rel: string): boolean {
    return fs.existsSync(path.join(this.dir, rel))
  }

  /**
   * Write files (string/Buffer content, null = delete) and commit them all.
   * Returns the new commit sha.
   */
  async commit(
    message: string,
    files: Record<string, string | Buffer | null> = {},
    opts: {authorName?: string; authorEmail?: string} = {},
  ): Promise<string> {
    for (const [rel, content] of Object.entries(files)) {
      if (content === null) this.rm(rel)
      else this.write(rel, content)
    }
    await this.git(['add', '-A'])
    const date = nextDate()
    const env: Record<string, string> = {GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date}
    if (opts.authorName) env.GIT_AUTHOR_NAME = opts.authorName
    if (opts.authorEmail) env.GIT_AUTHOR_EMAIL = opts.authorEmail
    await this.git(['commit', '--allow-empty', '-m', message], {env})
    return this.git(['rev-parse', 'HEAD'])
  }

  async head(): Promise<string> {
    return this.git(['rev-parse', 'HEAD'])
  }

  /** Subjects, oldest first. */
  async subjects(ref = 'HEAD'): Promise<string[]> {
    const out = await this.git(['log', '--reverse', '--format=%s', ref])
    return out === '' ? [] : out.split('\n')
  }

  /** Full raw messages, oldest first, separated for easy snapshotting. */
  async messages(ref = 'HEAD'): Promise<string[]> {
    const out = await this.git(['log', '--reverse', '--format=%B%x1e', ref])
    return out
      .split('\x1e')
      .map((m) => m.replace(/^\n/, '').trimEnd())
      .filter((m) => m !== '')
  }

  /** `<authorName> <authorEmail>` oldest first. */
  async authors(ref = 'HEAD'): Promise<string[]> {
    const out = await this.git(['log', '--reverse', '--format=%an <%ae>', ref])
    return out === '' ? [] : out.split('\n')
  }

  /** Sorted `mode<space>path` listing of a tree-ish (optionally a subpath). */
  async treeEntries(treeish: string, subpath?: string): Promise<string[]> {
    const target = subpath ? `${treeish}:${subpath}` : treeish
    const out = await this.git(['ls-tree', '-r', '--format=%(objectmode) %(objectname) %(path)', target])
    return out === '' ? [] : out.split('\n').sort()
  }

  /** Tree object sha for a treeish (optionally a subdirectory of it). */
  async treeSha(treeish: string, subpath?: string): Promise<string> {
    return this.git(['rev-parse', subpath ? `${treeish}:${subpath}` : `${treeish}^{tree}`])
  }

  /** Blob content at a revision. */
  async fileAt(treeish: string, rel: string): Promise<string> {
    return this.git(['show', `${treeish}:${rel}`])
  }
}

/** Init a normal (non-bare) repo with main branch. */
export async function makeRepo(root: string, name: string): Promise<TestRepo> {
  const dir = path.join(root, name)
  fs.mkdirSync(dir, {recursive: true})
  const repo = new TestRepo(dir)
  await repo.git(['init', '-b', 'main'])
  return repo
}

/** Bare repo usable as a local "public remote". Returns its path (valid as a git URL). */
export async function makeBareRemote(root: string, name: string): Promise<string> {
  const dir = path.join(root, `${name}.git`)
  fs.mkdirSync(dir, {recursive: true})
  await execa('git', ['init', '--bare', '-b', 'main', dir], {env: GIT_ENV})
  return dir
}

/** Clone a remote (e.g. to act as an external contributor) and return a TestRepo. */
export async function cloneRemote(root: string, remoteDir: string, name: string): Promise<TestRepo> {
  const dir = path.join(root, name)
  await execa('git', ['clone', remoteDir, dir], {env: GIT_ENV})
  return new TestRepo(dir)
}

/**
 * Write monolith.config.ts. `subrepos` entries are emitted verbatim when given
 * as strings (to allow function-valued hooks), or JSON-serialized objects.
 */
export function writeConfig(repo: TestRepo, subrepos: Array<Record<string, unknown> | string>): void {
  const entries = subrepos
    .map((s) => (typeof s === 'string' ? s : JSON.stringify(s, null, 2)))
    .join(',\n')
  repo.write('monolith.config.ts', `export default {\n  subrepos: [\n${entries}\n  ],\n}\n`)
}

/**
 * Standard fixture: a monorepo with a `core/` subrepo dir, private dirs, and a
 * bare public remote wired into the config.
 */
export async function standardFixture(opts: {configExtra?: string} = {}): Promise<{
  root: string
  mono: TestRepo
  pubDir: string
}> {
  const root = sandbox()
  const mono = await makeRepo(root, 'mono')
  const pubDir = await makeBareRemote(root, 'core-pub')
  const extra = opts.configExtra ?? ''
  writeConfig(mono, [
    `    { name: 'core', path: 'core', remote: ${JSON.stringify(pubDir)}${extra ? `, ${extra}` : ''} }`,
  ])
  await mono.commit('chore: initial monorepo', {
    'core/README.md': '# core\n',
    'core/src/index.ts': 'export const hello = () => "hello"\n',
    'private/secrets.md': 'internal only\n',
  })
  return {root, mono, pubDir}
}
