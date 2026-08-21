import type {ResolvedSubrepo} from '../config.js'
import {
  EMPTY_TREE,
  type CommitMeta,
  commitTree,
  git,
  gitOk,
  pushRef,
  pushRefWithLease,
  readCommit,
  revList,
} from './git.js'
import {filteredSubtree} from './filter.js'
import {
  forkTrackingRef,
  loadForkState,
  remoteTrackingRef,
  unpublishedView,
  type SyncView,
} from './sync.js'
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
  /**
   * Did this run write to a remote? False in triangular mode when the fork branch already
   * carries exactly these commits — the export is built, byte-identical, and simply waiting
   * for upstream to merge it.
   */
  pushed: boolean
}

export interface ExportOptions {
  candidates: ExportCandidate[]
}

/**
 * Monorepo commits eligible for export: everything touching the subrepo path since the
 * derived base, minus commits already exported.
 *
 * Imported commits (`Monosplice-Origin`) are deliberately NOT filtered here. A pure import
 * reproduces the public tip's tree, so `runExport`'s tree-equality check drops it; a
 * *conflicted* import carries the user's merge resolution and must be exported, or
 * `pub tree == filtered(mono HEAD)` would stop holding.
 */
export async function planExport(
  root: string,
  subrepo: ResolvedSubrepo,
  view: SyncView,
): Promise<{candidates: ExportCandidate[]}> {
  const range = view.exportBase ? `${view.exportBase}..HEAD` : 'HEAD'
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
 * Turn planned exports into commit objects on top of `base`, without touching any remote.
 *
 * Every input is fixed — tree, message, author *and* committer are copied from the monorepo
 * commit — so replaying the same plan on the same base always yields the same shas. That
 * determinism is what lets triangular mode recognise a fork branch it built earlier instead
 * of force-pushing an identical chain on every run.
 */
export async function buildExportChain(
  root: string,
  planned: PlannedExport[],
  base: string | null,
): Promise<{exported: ExportedCommit[]; tip: string | null}> {
  let tip = base
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
  return {exported, tip}
}

/**
 * Replay candidates onto the public branch. Every commit (and therefore every scan hook)
 * is resolved first; the remote is written exactly once, at the end. A hook that throws must
 * never leave a partially published branch behind.
 *
 * In triangular mode the chain is parented on the UPSTREAM head and lands on the fork's
 * `pushBranch`: a linear, PR-ready branch that monosplice owns and rebuilds. Upstream is never
 * written to, and the upstream tracking ref is never moved to something upstream does not have.
 */
export async function runExport(
  root: string,
  subrepo: ResolvedSubrepo,
  view: SyncView,
  opts: ExportOptions,
): Promise<ExportResult> {
  const planned = await computeExports(root, subrepo, view, opts.candidates)
  const {exported, tip} = await buildExportChain(root, planned, view.pubHead)

  if (exported.length === 0 || tip === null) return {exported: [], newHead: view.pubHead, pushed: false}

  if (subrepo.upstream !== undefined) {
    const fork = await loadForkState(root, subrepo)
    if (fork.head === tip) return {exported, newHead: tip, pushed: false}
    if (fork.head === null) await pushRef(root, subrepo.remote, tip, `refs/heads/${subrepo.pushBranch}`)
    else await pushRefWithLease(root, subrepo.remote, tip, `refs/heads/${subrepo.pushBranch}`, fork.head)
    await git(root, ['update-ref', forkTrackingRef(subrepo.name), tip])
    return {exported, newHead: tip, pushed: true}
  }

  await pushRef(root, subrepo.remote, tip, `refs/heads/${subrepo.branch}`)
  await git(root, ['update-ref', view.trackingRef, tip])
  return {exported, newHead: tip, pushed: true}
}

/**
 * Has monorepo history been rewritten under the last exported commit? Export appends to pub
 * assuming everything after the scan base is new; if the commit pub says it last exported is
 * no longer reachable from HEAD, the monorepo was rebased underneath the mapping. This has to
 * consult `lastExportedMono` rather than `exportBase`: a rewritten-away commit is exactly the
 * one the HEAD walk cannot see.
 */
export async function exportBaseRewritten(root: string, view: SyncView): Promise<boolean> {
  if (!view.lastExportedMono) return false
  return !(await gitOk(root, ['merge-base', '--is-ancestor', view.lastExportedMono, 'HEAD']))
}

/**
 * The first public commit: the subrepo's current tree as one parentless commit. Returns null
 * when there is nothing publishable left after excludes and hooks. Object-db only, like every
 * other export path — the working tree is never touched.
 */
export async function publishBaseline(
  root: string,
  subrepo: ResolvedSubrepo,
  monoHead: string,
): Promise<string | null> {
  const tree = await filteredSubtree(root, monoHead, subrepo)
  if (tree === null || tree === EMPTY_TREE) return null

  const meta = await readCommit(root, monoHead)
  const pubSha = await commitTree(root, {
    tree,
    parents: [],
    message: appendTrailer(`Initial import of ${subrepo.name}\n`, SOURCE_TRAILER, meta.sha),
    authorName: meta.committerName,
    authorEmail: meta.committerEmail,
    authorDate: meta.committerDate,
    committerName: meta.committerName,
    committerEmail: meta.committerEmail,
    committerDate: meta.committerDate,
  })

  await pushRef(root, subrepo.remote, pubSha, `refs/heads/${subrepo.branch}`)
  await git(root, ['update-ref', remoteTrackingRef(subrepo.name), pubSha])
  return pubSha
}

/**
 * First publish that replays every monorepo commit touching the path instead of squashing.
 * Goes through `runExport`, so scan hooks run per replayed commit and a throwing one aborts
 * before the single ref update — nothing partial ever reaches the remote.
 */
export async function publishFullHistory(
  root: string,
  subrepo: ResolvedSubrepo,
  monoHead: string,
): Promise<ExportResult> {
  const shas = await revList(root, ['--reverse', '--topo-order', monoHead, '--', subrepo.path])
  return runExport(root, subrepo, unpublishedView(subrepo.name), {
    candidates: shas.map((monoSha) => ({monoSha})),
  })
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
The commit mapping is broken, so monosplice cannot tell what is already published and will not export on top of it. Nothing was pushed to ${subrepo.remote}.
Run \`monosplice doctor\` to see the full picture.`
  }

  if (await exportBaseRewritten(root, view)) {
    return `${subrepo.name}: the last exported monorepo commit ${view.lastExportedMono} is no longer an ancestor of HEAD.
Monorepo history was rewritten (rebase, amend or force-push) underneath it, so monosplice cannot tell which commits are new. Nothing was pushed to ${subrepo.remote}.
Run \`monosplice doctor\` for details, then restore that commit (\`git reflog\`) before pushing again.`
  }

  return null
}
