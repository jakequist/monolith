import type {ResolvedSubrepo} from '../config.js'
import {EMPTY_TREE, commitTree, git, pushRef, readCommit, revList} from './git.js'
import {filteredSubtree} from './filter.js'
import type {SyncView} from './sync.js'
import {SOURCE_TRAILER, appendTrailer} from './trailers.js'

export interface ExportCandidate {
  monoSha: string
}

export interface ExportedCommit {
  monoSha: string
  pubSha: string
}

export interface ExportResult {
  exported: ExportedCommit[]
  /** Public head after the run (unchanged when nothing was exported). */
  newHead: string | null
}

export interface ExportOptions {
  candidates: ExportCandidate[]
}

/**
 * Monorepo commits eligible for export: everything touching the subrepo path since the
 * derived base, minus commits already exported.
 *
 * Imported commits (`Monolith-Origin`) are deliberately NOT filtered here. A pure import
 * reproduces the public tip's tree, so `runExport`'s tree-equality check drops it; a
 * *conflicted* import carries the user's merge resolution and must be exported, or
 * `pub tree == filtered(mono HEAD)` would stop holding.
 */
export async function planExport(
  root: string,
  subrepo: ResolvedSubrepo,
  view: SyncView,
): Promise<{candidates: ExportCandidate[]}> {
  const range = view.exportBaseMono ? `${view.exportBaseMono}..HEAD` : 'HEAD'
  const shas = await revList(root, ['--reverse', '--topo-order', range, '--', subrepo.path])
  return {
    candidates: shas.filter((sha) => !view.exportedMonoToPub.has(sha)).map((monoSha) => ({monoSha})),
  }
}

/**
 * Replay candidates onto the public branch. Every commit (and therefore every scan hook)
 * is built first; the remote is written exactly once, at the end. A hook that throws must
 * never leave a partially published branch behind.
 */
export async function runExport(
  root: string,
  subrepo: ResolvedSubrepo,
  view: SyncView,
  opts: ExportOptions,
): Promise<ExportResult> {
  let tip = view.pubHead
  let tipTree = tip === null ? EMPTY_TREE : await git(root, ['rev-parse', `${tip}^{tree}`])
  const exported: ExportedCommit[] = []

  for (const candidate of opts.candidates) {
    const tree = await filteredSubtree(root, candidate.monoSha, subrepo)
    // No subrepo content at this commit, or nothing publishable changed (e.g. only
    // excluded files) — an empty pub commit would be noise.
    if (tree === null || tree === tipTree) continue

    const meta = await readCommit(root, candidate.monoSha)
    let message = meta.message
    if (subrepo.rewriteMessage) {
      message = subrepo.rewriteMessage(message, {
        subrepo: subrepo.name,
        monoSha: meta.sha,
        message: meta.message,
      })
    }
    message = appendTrailer(message, SOURCE_TRAILER, meta.sha)

    const pubSha = await commitTree(root, {
      tree,
      parents: tip === null ? [] : [tip],
      message,
      authorName: meta.authorName,
      authorEmail: meta.authorEmail,
      authorDate: meta.authorDate,
      committerName: meta.committerName,
      committerEmail: meta.committerEmail,
      committerDate: meta.committerDate,
    })

    exported.push({monoSha: meta.sha, pubSha})
    tip = pubSha
    tipTree = tree
  }

  if (exported.length === 0 || tip === null) return {exported: [], newHead: view.pubHead}

  await pushRef(root, subrepo.remote, tip, `refs/heads/${subrepo.branch}`)
  await git(root, ['update-ref', view.trackingRef, tip])
  return {exported, newHead: tip}
}
