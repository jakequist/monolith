/** GitHub repo that hosts the releases the CLI installs from. */
export const RELEASE_REPO = 'jakequist/monosplice'

/**
 * Package, binary and tarball name. npm is the primary distribution channel;
 * GitHub Releases carries the same tarball for pinning and provenance.
 */
export const PACKAGE = 'monosplice'

export const RELEASES_PAGE = `https://github.com/${RELEASE_REPO}/releases`
export const LATEST_RELEASE_API = `https://api.github.com/repos/${RELEASE_REPO}/releases/latest`

/** Stable-name asset on the newest release; what the install one-liner in the README uses. */
export const LATEST_TARBALL_URL = `${RELEASES_PAGE}/latest/download/${PACKAGE}.tgz`

/** `v1.2.3` → `1.2.3`. Throws when the tag carries no version. */
export function versionFromTag(tag: string): string {
  const trimmed = tag.trim()
  const version = trimmed.startsWith('v') ? trimmed.slice(1) : trimmed
  if (version === '') throw new Error(`release tag ${JSON.stringify(tag)} does not contain a version`)
  return version
}

/**
 * Immutable, versioned asset URL — installing this guarantees you get the
 * version that was just checked, not whatever "latest" points at by then.
 */
export function releaseAssetUrl(version: string): string {
  return `${RELEASES_PAGE}/download/v${version}/${PACKAGE}-${version}.tgz`
}
