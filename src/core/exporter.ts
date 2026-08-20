import type {ResolvedSubrepo} from '../config.js'
import {EMPTY_TREE, type CommitMeta, commitTree, git, gitOk, pushRef, readCommit, revList} from './git.js'
import {filteredSubtree} from './filter.js'
import type {SyncView} from './sync.js'
import {ORIGIN_TRAILER, SOURCE_TRAILER, appendTrailer, getTrailer} from './trailers.js'

export interface ExportCandidate {
  monoSha: string
}

/** A monorepo commit that really would become a public commit, fully resolved but uncommitted. */
export interface PlannedExport {
  monoSha: string
  /** Filtered subtree sha (excludes and hooks already applied). */
  tree: string
  /** Final public commit message, trailer included. */
  message: string
  meta: CommitMeta
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
 * Is this commit a *pure* import — one whose publishable subtree is byte-identical to the
 * public commit it was replayed from, which the public branch therefore already contains?
 *
 * Still not a trailer test: the trailer only says where to look, tree equality decides. A
 * conflicted import carries the user's resolution, differs from its origin, and must be
 * exported. Comparing against the origin rather than the current pub tip matters once the
 * tip has moved on — otherwise a long-settled import becomes a candidate again and
 * republishes an old state on top of newer public work.
 */
async function alreadyPublished(
  root: string,
  message: string,
  tree: string,
  pubHead: string,
): Promise<boolean> {
  const origin = getTrailer(message, ORIGIN_TRAILER)
  if (!origin) return false
  if (!(await gitOk(root, ['merge-base', '--is-ancestor', origin, pubHead]))) return false
  const originTree = await git(root, ['rev-parse', `${origin}^{tree}`]).catch(() => null)
  return originTree === tree
}

/**
 * Resolve what the candidates would publish — filtered trees, hooks, rewritten messages,
 * tree-equality skips — without creating a single object or touching a remote. `runExport`
 * builds on this; `status`/`doctor` use it to answer "how many commits would push create?"
 * accurately, which a raw candidate count cannot do.
 */
export async function computeExports(
  root: string,
  subrepo: ResolvedSubrepo,
  view: SyncView,
  candidates: ExportCandidate[],
): Promise<PlannedExport[]> {
  let tipTree = view.pubHead === null ? EMPTY_TREE : await git(root, ['rev-parse', `${view.pubHead}^{tree}`])
  const planned: PlannedExport[] = []

  for (const candidate of candidates) {
    const tree = await filteredSubtree(root, candidate.monoSha, subrepo)
    // No subrepo content at this commit, or nothing publishable changed (e.g. only
    // excluded files) — an empty pub commit would be noise.
    if (tree === null || tree === tipTree) continue

    const meta = await readCommit(root, candidate.monoSha)
    if (view.pubHead !== null && (await alreadyPublished(root, meta.message, tree, view.pubHead))) continue

    let message = meta.message
    if (subrepo.rewriteMessage) {
      message = subrepo.rewriteMessage(message, {
        subrepo: subrepo.name,
        monoSha: meta.sha,
        message: meta.message,
      })
    }
    message = appendTrailer(message, SOURCE_TRAILER, meta.sha)

    planned.push({monoSha: meta.sha, tree, message, meta})
    tipTree = tree
  }

  return planned
}

/**
 * Replay candidates onto the public branch. Every commit (and therefore every scan hook)
 * is resolved first; the remote is written exactly once, at the end. A hook that throws must
 * never leave a partially published branch behind.
 */
export async function runExport(
  root: string,
  subrepo: ResolvedSubrepo,
  view: SyncView,
  opts: ExportOptions,
): Promise<ExportResult> {
  const planned = await computeExports(root, subrepo, view, opts.candidates)

  let tip = view.pubHead
  const exported: ExportedCommit[] = []
  for (const p of planned) {
    const pubSha = await commitTree(root, {
      tree: p.tree,
      parents: tip === null ? [] : [tip],
      message: p.message,
      authorName: p.meta.authorName,
      authorEmail: p.meta.authorEmail,
      authorDate: p.meta.authorDate,
      committerName: p.meta.committerName,
      committerEmail: p.meta.committerEmail,
      committerDate: p.meta.committerDate,
    })
    exported.push({monoSha: p.monoSha, pubSha})
    tip = pubSha
  }

  if (exported.length === 0 || tip === null) return {exported: [], newHead: view.pubHead}

  await pushRef(root, subrepo.remote, tip, `refs/heads/${subrepo.branch}`)
  await git(root, ['update-ref', view.trackingRef, tip])
  return {exported, newHead: tip}
}

/**
 * Has monorepo history been rewritten under the last exported commit? Export appends to
 * pub assuming `exportBaseMono..HEAD` is the set of new commits; if the base is no longer
 * reachable from HEAD that range is meaningless.
 */
export async function exportBaseRewritten(root: string, view: SyncView): Promise<boolean> {
  if (!view.exportBaseMono) return false
  return !(await gitOk(root, ['merge-base', '--is-ancestor', view.exportBaseMono, 'HEAD']))
}

/** Why export must not run, or null when the derived mapping is trustworthy. */
export async function checkExportPreconditions(
  root: string,
  subrepo: ResolvedSubrepo,
  view: SyncView,
): Promise<string | null> {
  const broken = view.brokenSourceRefs[0]
  if (broken) {
    return `${subrepo.name}: public commit ${broken.pubSha} carries ${SOURCE_TRAILER}: ${broken.monoSha}, but that monorepo commit does not exist in this clone.
The commit mapping is broken, so monolith cannot tell what is already published and will not export on top of it. Nothing was pushed to ${subrepo.remote}.
Run \`monolith doctor\` to see the full picture.`
  }

  if (await exportBaseRewritten(root, view)) {
    return `${subrepo.name}: the last exported monorepo commit ${view.exportBaseMono} is no longer an ancestor of HEAD.
Monorepo history was rewritten (rebase, amend or force-push) underneath it, so monolith cannot tell which commits are new. Nothing was pushed to ${subrepo.remote}.
Run \`monolith doctor\` for details, then restore that commit (\`git reflog\`) before pushing again.`
  }

  return null
}
