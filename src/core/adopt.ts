import type {ResolvedSubrepo} from '../config.js'
import {git, gitBuffer} from './git.js'
import {ORIGIN_TRAILER, appendTrailer} from './trailers.js'

/**
 * Adopt is an *import*-side operation, so — unlike export — it is allowed to write the
 * working tree and index. It reuses the importer's patch machinery rather than plumbing
 * trees directly, so the subrepo directory ends up as a normal part of the monorepo commit.
 */

/**
 * The commit that anchors the monorepo to a public branch it did not create. The verb is the
 * only thing that varies: `adopt` connects a configured subrepo, `vendor` adds the config
 * entry too, but both record the same anchor.
 */
export function originMessage(verb: string, subrepo: ResolvedSubrepo, pubHead: string): string {
  const subject = `${verb} ${subrepo.name} from ${subrepo.remote} @ ${pubHead.slice(0, 10)}\n`
  return appendTrailer(subject, ORIGIN_TRAILER, pubHead)
}

export function adoptMessage(subrepo: ResolvedSubrepo, pubHead: string): string {
  return originMessage('Adopt', subrepo, pubHead)
}

export function vendorMessage(subrepo: ResolvedSubrepo, pubHead: string): string {
  return originMessage('Vendor', subrepo, pubHead)
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

export async function commitAdopt(
  root: string,
  subrepo: ResolvedSubrepo,
  pubHead: string,
): Promise<string> {
  return commitStaged(root, adoptMessage(subrepo, pubHead))
}
