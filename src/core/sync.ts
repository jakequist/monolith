import type {ResolvedSubrepo} from '../config.js'
import {filteredSubtree} from './filter.js'
import {
  GitError,
  existingCommits,
  fetchBranch,
  git,
  lsRemoteBranch,
  missingObjects,
  revList,
  revParse,
  trailerValues,
} from './git.js'
import {ORIGIN_TRAILER, SOURCE_TRAILER} from './trailers.js'

/** Where a subrepo's public branch is mirrored inside the monorepo's object db. */
export function remoteTrackingRef(name: string): string {
  return `refs/monosplice/${name}/remote`
}

/** Where the fork's push branch is mirrored (triangular mode only). */
export function forkTrackingRef(name: string): string {
  return `refs/monosplice/${name}/fork`
}

/**
 * The repository every sync decision is made against. With `upstream` configured that is
 * upstream and only upstream: the fork is a derived artifact monosplice rebuilds, so consulting
 * it for imports or anchors would let our own exports masquerade as public history.
 */
export function pullSource(subrepo: ResolvedSubrepo): string {
  return subrepo.upstream ?? subrepo.remote
}

/** Is this subrepo pulled from one repository and pushed to another? */
export function isTriangular(subrepo: ResolvedSubrepo): boolean {
  return subrepo.upstream !== undefined
}

/** How much of the network a view may use. */
export interface SyncViewOptions {
  /** Skip every fetch and derive the view from the remote-tracking refs already on disk. */
  offline?: boolean
}

/**
 * Offline, and this subrepo has never been fetched. There is no honest answer — an absent
 * tracking ref is indistinguishable from a remote with no branch — so the caller reports
 * the gap instead of guessing at counts.
 */
export class NoFetchYetError extends Error {
  constructor(readonly subrepo: string) {
    super(`${subrepo}: no fetch yet — run without --offline first`)
    this.name = 'NoFetchYetError'
  }
}

/** What the fork's push branch looks like right now. Triangular mode only. */
export interface ForkState {
  /** Fork branch head, or null when the fork does not have that branch yet. */
  head: string | null
}

/**
 * Mirror the fork's push branch locally. `lsRemoteBranch` first, exactly as `loadSyncView`
 * does, so an unreachable fork raises a GitError the caller can attribute to the fork rather
 * than a fetch failure that reads like the branch is missing.
 */
export async function loadForkState(
  root: string,
  subrepo: ResolvedSubrepo,
  opts: SyncViewOptions = {},
): Promise<ForkState> {
  if (opts.offline) return {head: await revParse(root, forkTrackingRef(subrepo.name))}
  const head = await lsRemoteBranch(root, subrepo.remote, subrepo.pushBranch)
  if (head === null) return {head: null}
  await fetchBranch(root, subrepo.remote, subrepo.pushBranch, forkTrackingRef(subrepo.name))
  return {head}
}

/** Fork state for reporting: an unreachable fork is a note, not a crash. */
export async function tryLoadForkState(
  root: string,
  subrepo: ResolvedSubrepo,
  opts: SyncViewOptions = {},
): Promise<{state: ForkState | null; error: GitError | null}> {
  try {
    return {state: await loadForkState(root, subrepo, opts), error: null}
  } catch (err) {
    if (err instanceof GitError) return {state: null, error: err}
    throw err
  }
}

/** A public commit claiming to export a monorepo commit that this clone does not have. */
export interface BrokenSourceRef {
  pubSha: string
  monoSha: string
}

export interface SyncView {
  /** Local ref mirroring the public branch. */
  trackingRef: string
  /** Public branch head, or null when the remote branch does not exist yet. */
  pubHead: string | null
  /** monorepo sha -> public sha, derived from `Monosplice-Source` trailers in pub history. */
  exportedMonoToPub: Map<string, string>
  /** Public shas already imported into the monorepo, from `Monosplice-Origin` trailers on HEAD. */
  importedPubShas: Set<string>
  /**
   * Where the export scan starts: the newest commit on the HEAD walk that is either already
   * exported (`Monosplice-Source` names it) or anchors the monorepo to the public branch
   * (`Monosplice-Origin` naming pub head or one of its ancestors). Export scans
   * `exportBase..HEAD`; null means "scan all of HEAD" (nothing published yet).
   */
  exportBase: string | null
  /**
   * Newest monorepo commit that pub history claims to have exported and that still exists
   * locally. Not the scan base — its job is rewrite detection: a commit that was rebased away
   * lives on in the reflog but is absent from the HEAD walk, so `exportBase` cannot see it.
   */
  lastExportedMono: string | null
  /** Public commits that are neither our exports nor already reflected (oldest first). */
  unreflectedPub: string[]
  /**
   * `Monosplice-Source` trailers in pub history naming monorepo commits that are not in
   * this clone. The mapping cannot be trusted while any exist, so export refuses.
   */
  brokenSourceRefs: BrokenSourceRef[]
  /**
   * Do the two repos know about each other at all? False means first contact: the public
   * branch has history, but nothing on either side references the other, so the only safe
   * move is `monosplice attach`.
   */
  related: boolean
}

/** The view of a subrepo whose public branch does not exist yet. */
export function unpublishedView(name: string): SyncView {
  return {
    trackingRef: remoteTrackingRef(name),
    pubHead: null,
    exportedMonoToPub: new Map(),
    importedPubShas: new Set(),
    exportBase: null,
    lastExportedMono: null,
    unreflectedPub: [],
    brokenSourceRefs: [],
    related: false,
  }
}

/**
 * Does this monorepo commit reproduce, exactly, the public commit it claims to reflect?
 * An attach anchor commit and a clean import do; a *conflicted* import and an import of a file the
 * config excludes do not — they carry work the public branch has never seen, so they cannot
 * be an export boundary. Hooks are allowed to throw here: an unusable filter simply means
 * "not an anchor", and `push` reports the hook failure on its own terms.
 */
async function reflectsExactly(
  root: string,
  subrepo: ResolvedSubrepo,
  monoSha: string,
  pubSha: string,
): Promise<boolean> {
  const monoTree = await filteredSubtree(root, monoSha, subrepo).catch(() => null)
  if (monoTree === null) return false
  return monoTree === (await git(root, ['rev-parse', `${pubSha}^{tree}`]).catch(() => null))
}

/**
 * Walk monorepo history from HEAD and stop at the first commit whose publishable subtree the
 * public branch already contains. Two ways to qualify: pub says it exported this commit
 * (`Monosplice-Source`), or the commit imported public work and reproduces it exactly
 * (`Monosplice-Origin`) — the second is what stops a `push` right after an `attach` from
 * replaying the monorepo's entire pre-attach history onto the newly connected repo.
 *
 * One `rev-list` for the walk, then O(1) lookups: both trailer maps are already in hand and
 * `pubAncestors` is the pub-side walk this function's caller needed anyway, so an Origin
 * candidate costs a set probe rather than a `merge-base` process.
 */
async function findExportAnchor(
  root: string,
  subrepo: ResolvedSubrepo,
  exportedMonoToPub: Map<string, string>,
  originByMono: Map<string, string[]>,
  pubAncestors: Set<string>,
): Promise<{exportBase: string | null; related: boolean}> {
  if (exportedMonoToPub.size === 0 && originByMono.size === 0) {
    return {exportBase: null, related: false}
  }

  let related = exportedMonoToPub.size > 0
  for (const monoSha of await revList(root, ['HEAD'])) {
    if (exportedMonoToPub.has(monoSha)) return {exportBase: monoSha, related: true}
    for (const pubSha of originByMono.get(monoSha) ?? []) {
      if (!pubAncestors.has(pubSha)) continue
      related = true
      if (await reflectsExactly(root, subrepo, monoSha, pubSha)) return {exportBase: monoSha, related: true}
    }
  }
  return {exportBase: null, related}
}

/**
 * Public commits the monorepo has not seen. Ancestry, not per-commit bookkeeping: a shallow
 * a snapshot `attach` records only the pub head as imported, and every ancestor of a reflected commit is
 * reflected by construction. Our own exports drop out by trailer.
 */
async function findUnreflectedPub(
  root: string,
  trackingRef: string,
  importedPubShas: Set<string>,
  sourceByPub: Map<string, string[]>,
): Promise<string[]> {
  // A forged or force-pushed-away Origin value would abort the whole rev-list, so only
  // values that resolve to a commit here are allowed to negate anything.
  const reflected = await existingCommits(root, [...importedPubShas])
  const args = ['rev-list', '--reverse', trackingRef]
  let out: string
  if (reflected.length === 0) {
    out = await git(root, args)
  } else {
    // --stdin instead of argv: pub histories can carry thousands of reflected commits.
    out = await git(root, [...args, '--stdin'], {input: reflected.map((sha) => `^${sha}\n`).join('')})
  }
  return out === '' ? [] : out.split('\n').filter((sha) => !sourceByPub.has(sha))
}

/**
 * Derive every sync cursor from trailers. There is no state file: this runs on each
 * invocation. `lsRemoteBranch` goes first so an unreachable remote fails with a GitError
 * carrying git's own stderr, and a missing branch is reported as "not published yet" rather
 * than as a confusing fetch failure.
 */
export async function loadSyncView(
  root: string,
  subrepo: ResolvedSubrepo,
  opts: SyncViewOptions = {},
): Promise<SyncView> {
  const trackingRef = remoteTrackingRef(subrepo.name)
  const source = pullSource(subrepo)
  const pubHead = opts.offline
    ? await revParse(root, trackingRef)
    : await lsRemoteBranch(root, source, subrepo.branch)

  const originByMono = (await revParse(root, 'HEAD'))
    ? await trailerValues(root, ORIGIN_TRAILER, ['HEAD'])
    : new Map<string, string[]>()
  const importedPubShas = new Set<string>()
  for (const values of originByMono.values()) {
    for (const v of values) importedPubShas.add(v)
  }

  if (pubHead === null) {
    if (opts.offline) throw new NoFetchYetError(subrepo.name)
    return {...unpublishedView(subrepo.name), importedPubShas}
  }

  if (!opts.offline) await fetchBranch(root, source, subrepo.branch, trackingRef)

  const sourceByPub = await trailerValues(root, SOURCE_TRAILER, [trackingRef])
  const exportedMonoToPub = new Map<string, string>()
  for (const [pubSha, values] of sourceByPub) {
    for (const monoSha of values) {
      if (!exportedMonoToPub.has(monoSha)) exportedMonoToPub.set(monoSha, pubSha)
    }
  }

  const missing = await missingObjects(root, [...exportedMonoToPub.keys()])
  const brokenSourceRefs: BrokenSourceRef[] = []

  const pubAncestors = new Set<string>()
  let lastExportedMono: string | null = null
  for (const pubSha of await revList(root, [trackingRef])) {
    pubAncestors.add(pubSha)
    const values = sourceByPub.get(pubSha)
    if (!values) continue
    for (const monoSha of values) {
      if (missing.has(monoSha)) brokenSourceRefs.push({pubSha, monoSha})
      else if (lastExportedMono === null) lastExportedMono = monoSha
    }
  }

  const {exportBase, related} = await findExportAnchor(
    root,
    subrepo,
    exportedMonoToPub,
    originByMono,
    pubAncestors,
  )

  return {
    trackingRef,
    pubHead,
    exportedMonoToPub,
    importedPubShas,
    exportBase,
    lastExportedMono,
    unreflectedPub: await findUnreflectedPub(root, trackingRef, importedPubShas, sourceByPub),
    brokenSourceRefs,
    related,
  }
}
