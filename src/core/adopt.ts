import type {ResolvedSubrepo} from '../config.js'
import {git, gitBuffer} from './git.js'
import {pullSource} from './sync.js'
import {ORIGIN_TRAILER, appendTrailer} from './trailers.js'

/**
 * Adoption — connecting the monorepo to a public branch it did not create — is an *import*-
 * side operation, so unlike export it is allowed to write the working tree and index. It
 * reuses the importer's patch machinery rather than plumbing trees directly, so the subrepo
 * directory ends up as a normal part of the monorepo commit.
 */

/**
 * The commit that anchors the monorepo to a public branch it did not create. One shape for
 * every route in: a folder attach that also writes the config entry records exactly the same
 * anchor as one that only makes first contact.
 */
export function adoptMessage(subrepo: ResolvedSubrepo, pubHead: string): string {
  const subject = `Adopt ${subrepo.name} from ${pullSource(subrepo)} @ ${pubHead.slice(0, 10)}\n`
  return appendTrailer(subject, ORIGIN_TRAILER, pubHead)
}

/** Paths where two trees disagree, as the user would see them inside the subrepo. */
export async function differingPaths(root: string, fromTree: string, toTree: string): Promise<string[]> {
  const out = await git(root, ['diff-tree', '-r', '--name-only', fromTree, toTree])
  return out === '' ? [] : out.split('\n')
}

/** Stage the change from one tree to another inside the subrepo directory. */
export async function applyTreeInto(
  root: string,
  subrepo: ResolvedSubrepo,
  fromTree: string,
  toTree: string,
): Promise<void> {
  const patch = await gitBuffer(root, ['diff-tree', '--binary', '-M', '-p', fromTree, toTree])
  if (patch.length === 0) return
  await git(root, ['apply', '--index', `--directory=${subrepo.path}`], {input: patch})
}

/**
 * Commit whatever adopt staged. `--allow-empty` because the matching-trees case records the
 * baseline without changing a byte: the Origin trailer is the whole point of the commit.
 */
export async function commitStaged(root: string, message: string): Promise<string> {
  await git(root, ['commit', '--allow-empty', '--no-verify', '-m', message])
  return git(root, ['rev-parse', 'HEAD'])
}
