import type {ExportContext, FileMap, ResolvedSubrepo} from '../config.js'
import {buildTree, git, hashObject, lsTreeRecursive, readBlob, readCommit, type TreeEntry} from './git.js'
import {makeExcluder} from './paths.js'

/** A configured hook rejected (scan) or failed while processing one monorepo commit. */
export class HookError extends Error {
  constructor(
    readonly hook: 'scan' | 'transform',
    readonly monoSha: string,
    readonly subrepo: string,
    readonly detail: string,
  ) {
    super(`${hook} hook rejected ${subrepo} commit ${monoSha}: ${detail}`)
    this.name = 'HookError'
  }
}

/**
 * Tree sha of `subrepo.path` at `monoCommit` after excludes and transform hooks,
 * or null when the path does not exist at that commit. Object-db only — the
 * working tree and index are never touched.
 */
export async function filteredSubtree(
  root: string,
  monoCommit: string,
  subrepo: ResolvedSubrepo,
): Promise<string | null> {
  const treeish = `${monoCommit}:${subrepo.path}`
  const hasHooks = Boolean(subrepo.transform || subrepo.scan)

  if (subrepo.exclude.length === 0 && !hasHooks) {
    // `-d` keeps this a tree lookup: a missing path (or a path that is a file) yields
    // empty output rather than something we would splice into a commit as a tree.
    const out = await git(root, [
      'ls-tree',
      '-d',
      '--format=%(objectname)',
      monoCommit,
      '--',
      subrepo.path,
    ]).catch(() => '')
    return out === '' ? null : out
  }

  let entries: TreeEntry[]
  try {
    entries = await lsTreeRecursive(root, treeish)
  } catch {
    return null
  }

  const excluded = makeExcluder(subrepo.exclude)
  const kept = entries.filter((e) => !excluded(e.path))
  if (!hasHooks) return buildTree(root, kept)

  const meta = await readCommit(root, monoCommit)
  const ctx: ExportContext = {subrepo: subrepo.name, monoSha: meta.sha, message: meta.message}

  const files: FileMap = new Map()
  // Gitlinks have no blob content; carry them through untouched.
  const passthrough: TreeEntry[] = []
  for (const e of kept) {
    if (e.type === 'blob') files.set(e.path, {mode: e.mode, data: await readBlob(root, e.sha)})
    else passthrough.push(e)
  }

  if (subrepo.scan) {
    try {
      await subrepo.scan(files, ctx)
    } catch (err) {
      throw new HookError('scan', meta.sha, subrepo.name, (err as Error).message)
    }
  }

  let out = files
  if (subrepo.transform) {
    try {
      const replaced = await subrepo.transform(files, ctx)
      if (replaced) out = replaced
    } catch (err) {
      throw new HookError('transform', meta.sha, subrepo.name, (err as Error).message)
    }
  }

  const rebuilt: TreeEntry[] = [...passthrough]
  for (const [relPath, entry] of out) {
    rebuilt.push({mode: entry.mode, type: 'blob', sha: await hashObject(root, entry.data), path: relPath})
  }
  return buildTree(root, rebuilt)
}
