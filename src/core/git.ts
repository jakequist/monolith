import {execa} from 'execa'

/** SHA of git's canonical empty tree object. */
export const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'

export class GitError extends Error {
  constructor(
    readonly gitArgs: string[],
    readonly exitCode: number | undefined,
    readonly stderr: string,
  ) {
    super(`git ${gitArgs.join(' ')} failed (exit ${exitCode})\n${stderr}`)
    this.name = 'GitError'
  }
}

export interface GitOptions {
  env?: Record<string, string>
  input?: string | Buffer
}

/** Run git in `cwd`, return trimmed stdout. Throws GitError on non-zero exit. */
export async function git(cwd: string, args: string[], opts: GitOptions = {}): Promise<string> {
  const res = await execa('git', args, {
    cwd,
    env: opts.env,
    input: opts.input,
    reject: false,
    stripFinalNewline: true,
  })
  if (res.exitCode !== 0) {
    throw new GitError(args, res.exitCode, typeof res.stderr === 'string' ? res.stderr : '')
  }
  return res.stdout as string
}

/** Run git and return raw stdout bytes (for blob contents). */
export async function gitBuffer(cwd: string, args: string[], opts: GitOptions = {}): Promise<Buffer> {
  const res = await execa('git', args, {
    cwd,
    env: opts.env,
    input: opts.input,
    reject: false,
    encoding: 'buffer',
    stripFinalNewline: false,
  })
  if (res.exitCode !== 0) {
    throw new GitError(args, res.exitCode, res.stderr ? Buffer.from(res.stderr).toString() : '')
  }
  return Buffer.from(res.stdout)
}

/** Run git, return true on exit 0, false on any failure. */
export async function gitOk(cwd: string, args: string[]): Promise<boolean> {
  const res = await execa('git', args, {cwd, reject: false})
  return res.exitCode === 0
}

export interface CommitMeta {
  sha: string
  authorName: string
  authorEmail: string
  /** raw format: "<unix-ts> <tz>" */
  authorDate: string
  committerName: string
  committerEmail: string
  committerDate: string
  /** Full raw message including trailers. */
  message: string
}

export async function readCommit(cwd: string, sha: string): Promise<CommitMeta> {
  const out = await git(cwd, [
    'show',
    '-s',
    '--date=raw',
    '--format=%H%x00%an%x00%ae%x00%ad%x00%cn%x00%ce%x00%cd%x00%B',
    sha,
  ])
  const parts = out.split('\0')
  if (parts.length < 8) throw new Error(`unexpected git show output for ${sha}`)
  return {
    sha: parts[0]!,
    authorName: parts[1]!,
    authorEmail: parts[2]!,
    authorDate: parts[3]!,
    committerName: parts[4]!,
    committerEmail: parts[5]!,
    committerDate: parts[6]!,
    message: parts.slice(7).join('\0'),
  }
}

/** rev-list; returns [] for empty output. Extra args like --reverse, ranges, `--`, paths. */
export async function revList(cwd: string, args: string[]): Promise<string[]> {
  const out = await git(cwd, ['rev-list', ...args])
  return out === '' ? [] : out.split('\n')
}

export async function revParse(cwd: string, ref: string): Promise<string | null> {
  try {
    return await git(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])
  } catch {
    return null
  }
}

/**
 * Which of these object ids are absent from the local object db. One batched
 * `cat-file` process regardless of input size — trailer scans can name thousands.
 */
export async function missingObjects(cwd: string, shas: readonly string[]): Promise<Set<string>> {
  const missing = new Set<string>()
  if (shas.length === 0) return missing
  const out = await git(cwd, ['cat-file', '--batch-check'], {input: shas.map((s) => `${s}\n`).join('')})
  if (out === '') return missing
  for (const line of out.split('\n')) {
    // git answers "<input> missing" for anything it cannot resolve.
    const [name, status] = line.split(' ')
    if (name && status === 'missing') missing.add(name)
  }
  return missing
}

/**
 * Which of these object ids name commits that really exist here. Same single batched
 * `cat-file` as `missingObjects`; used to sanitize trailer values before feeding them to
 * `rev-list`, where one unknown name would abort the whole query.
 */
export async function existingCommits(cwd: string, shas: readonly string[]): Promise<string[]> {
  if (shas.length === 0) return []
  const out = await git(cwd, ['cat-file', '--batch-check'], {input: shas.map((s) => `${s}\n`).join('')})
  if (out === '') return []
  const ok: string[] = []
  for (const line of out.split('\n')) {
    const [name, type] = line.split(' ')
    if (name && type === 'commit') ok.push(name)
  }
  return ok
}

export interface CommitTreeInput {
  tree: string
  parents: string[]
  message: string
  authorName: string
  authorEmail: string
  authorDate: string
  committerName: string
  committerEmail: string
  committerDate: string
}

/** Create a commit object directly in the object db. Never touches the working tree. */
export async function commitTree(cwd: string, input: CommitTreeInput): Promise<string> {
  const args = ['commit-tree', input.tree]
  for (const p of input.parents) args.push('-p', p)
  return git(cwd, args, {
    input: input.message,
    env: {
      GIT_AUTHOR_NAME: input.authorName,
      GIT_AUTHOR_EMAIL: input.authorEmail,
      GIT_AUTHOR_DATE: input.authorDate,
      GIT_COMMITTER_NAME: input.committerName,
      GIT_COMMITTER_EMAIL: input.committerEmail,
      GIT_COMMITTER_DATE: input.committerDate,
    },
  })
}

export interface TreeEntry {
  mode: string
  type: 'blob' | 'commit' | 'tree'
  sha: string
  /** Path relative to the listed tree root. */
  path: string
}

/** Recursive listing of a tree-ish: blobs, symlinks (mode 120000) and submodule entries. */
export async function lsTreeRecursive(cwd: string, treeish: string): Promise<TreeEntry[]> {
  const out = await git(cwd, ['ls-tree', '-r', '-z', treeish])
  if (out === '') return []
  return out
    .split('\0')
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf('\t')
      const [mode, type, sha] = line.slice(0, tab).split(' ')
      return {mode: mode!, type: type! as TreeEntry['type'], sha: sha!, path: line.slice(tab + 1)}
    })
}

/**
 * Build a (possibly nested) tree object from flat entries and return its sha.
 * Entries' paths are relative to the tree being built.
 */
export async function buildTree(cwd: string, entries: TreeEntry[]): Promise<string> {
  const here: TreeEntry[] = []
  const subdirs = new Map<string, TreeEntry[]>()
  for (const e of entries) {
    const slash = e.path.indexOf('/')
    if (slash === -1) {
      here.push(e)
    } else {
      const dir = e.path.slice(0, slash)
      const rest = e.path.slice(slash + 1)
      if (!subdirs.has(dir)) subdirs.set(dir, [])
      subdirs.get(dir)!.push({...e, path: rest})
    }
  }
  const lines: string[] = here.map((e) => `${e.mode} ${e.type} ${e.sha}\t${e.path}`)
  for (const [dir, children] of subdirs) {
    const sub = await buildTree(cwd, children)
    lines.push(`040000 tree ${sub}\t${dir}`)
  }
  return git(cwd, ['mktree', '-z'], {input: lines.map((l) => `${l}\0`).join('')})
}

/** Write blob content into the object db, return sha. */
export async function hashObject(cwd: string, data: Buffer): Promise<string> {
  return git(cwd, ['hash-object', '-w', '--stdin'], {input: data})
}

/** Read a blob's raw content. */
export async function readBlob(cwd: string, sha: string): Promise<Buffer> {
  return gitBuffer(cwd, ['cat-file', 'blob', sha])
}

/**
 * Map of commit sha -> trailer values for every commit in the given rev range
 * that has at least one value for the trailer key. `revArgs` example: ['HEAD'] or ['A..B'].
 */
export async function trailerValues(
  cwd: string,
  key: string,
  revArgs: string[],
): Promise<Map<string, string[]>> {
  const out = await git(cwd, [
    'log',
    `--format=%H%x00%(trailers:key=${key},valueonly,separator=%x00)`,
    ...revArgs,
  ])
  const map = new Map<string, string[]>()
  if (out === '') return map
  for (const line of out.split('\n')) {
    const [sha, ...values] = line.split('\0')
    const vals = values.map((v) => v.trim()).filter(Boolean)
    if (sha && vals.length > 0) map.set(sha, vals)
  }
  return map
}

/**
 * Resolve a branch head on a remote. Returns the sha, null if the branch (or an
 * empty repo) has no such ref, and throws GitError if the remote is unreachable.
 */
export async function lsRemoteBranch(cwd: string, remote: string, branch: string): Promise<string | null> {
  const out = await git(cwd, ['ls-remote', remote, `refs/heads/${branch}`])
  if (out === '') return null
  return out.split('\t')[0]!
}

/** Fetch a remote branch into a local tracking ref; returns the fetched head sha. */
export async function fetchBranch(
  cwd: string,
  remote: string,
  branch: string,
  localRef: string,
): Promise<string> {
  await git(cwd, ['fetch', '--no-tags', remote, `+refs/heads/${branch}:${localRef}`])
  return git(cwd, ['rev-parse', localRef])
}

/** Push a local sha to a remote ref (fast-forward only — no force). */
export async function pushRef(cwd: string, remote: string, sha: string, dstRef: string): Promise<void> {
  await git(cwd, ['push', remote, `${sha}:${dstRef}`])
}
