import type {ResolvedSubrepo} from '../config.js'
import {fetchBranch, lsRemoteBranch, objectExists, revList, revParse, trailerValues} from './git.js'
import {ORIGIN_TRAILER, SOURCE_TRAILER} from './trailers.js'

/** Where a subrepo's public branch is mirrored inside the monorepo's object db. */
export function remoteTrackingRef(name: string): string {
  return `refs/monolith/${name}/remote`
}

export interface SyncView {
  /** Local ref mirroring the public branch. */
  trackingRef: string
  /** Public branch head, or null when the remote branch does not exist yet. */
  pubHead: string | null
  /** monorepo sha -> public sha, derived from `Monolith-Source` trailers in pub history. */
  exportedMonoToPub: Map<string, string>
  /** Public shas already imported into the monorepo, from `Monolith-Origin` trailers on HEAD. */
  importedPubShas: Set<string>
  /**
   * Newest monorepo commit that pub history claims to have exported and that still
   * exists locally. Export scans `exportBaseMono..HEAD`; null means "scan all of HEAD".
   */
  exportBaseMono: string | null
  /** Public commits that are neither our exports nor already imported (oldest first). */
  unreflectedPub: string[]
}

/**
 * Derive every sync cursor from trailers. There is no state file: this runs on each
 * invocation. `lsRemoteBranch` goes first so an unreachable remote fails with a GitError
 * carrying git's own stderr, and a missing branch is reported as "not seeded" rather than
 * as a confusing fetch failure.
 */
export async function loadSyncView(root: string, subrepo: ResolvedSubrepo): Promise<SyncView> {
  const trackingRef = remoteTrackingRef(subrepo.name)
  const pubHead = await lsRemoteBranch(root, subrepo.remote, subrepo.branch)

  const importedPubShas = new Set<string>()
  if (await revParse(root, 'HEAD')) {
    for (const values of (await trailerValues(root, ORIGIN_TRAILER, ['HEAD'])).values()) {
      for (const v of values) importedPubShas.add(v)
    }
  }

  if (pubHead === null) {
    return {
      trackingRef,
      pubHead: null,
      exportedMonoToPub: new Map(),
      importedPubShas,
      exportBaseMono: null,
      unreflectedPub: [],
    }
  }

  await fetchBranch(root, subrepo.remote, subrepo.branch, trackingRef)

  const sourceByPub = await trailerValues(root, SOURCE_TRAILER, [trackingRef])
  const exportedMonoToPub = new Map<string, string>()
  for (const [pubSha, values] of sourceByPub) {
    for (const monoSha of values) {
      if (!exportedMonoToPub.has(monoSha)) exportedMonoToPub.set(monoSha, pubSha)
    }
  }

  let exportBaseMono: string | null = null
  for (const pubSha of await revList(root, [trackingRef])) {
    const values = sourceByPub.get(pubSha)
    if (!values) continue
    for (const monoSha of values) {
      if (await objectExists(root, monoSha)) {
        exportBaseMono = monoSha
        break
      }
    }
    if (exportBaseMono) break
  }

  const unreflectedPub = (await revList(root, ['--reverse', trackingRef])).filter(
    (sha) => !sourceByPub.has(sha) && !importedPubShas.has(sha),
  )

  return {trackingRef, pubHead, exportedMonoToPub, importedPubShas, exportBaseMono, unreflectedPub}
}
