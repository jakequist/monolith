# monosplice reference

The [README](../README.md) covers the quickstart and the core model. This is the detailed
reference for everything else: connecting repos that already exist, vendoring and the fork
workflow, the full configuration surface, conflicts, and releasing.

## Adopting an existing repo

First contact is detected, never configured. monosplice looks at two things — whether the
subrepo directory has committed content, and whether the remote branch exists — and there is
exactly one right move for each combination:

| `path/` in the monorepo | remote branch | What to run | What happens |
| --- | --- | --- | --- |
| has content | empty | `monosplice push <name>` (`--yes` in scripts) | Publishes the current tree as one `Initial import of <name>` commit. `--full-history` replays every commit that touched the directory instead. |
| empty / absent | has history | `monosplice adopt <name>` | Materializes the remote's HEAD tree at `path/` in **one** monorepo commit. `--history` replays every public commit instead, authors and messages preserved. |
| has content | has history | `monosplice adopt <name>` | Only if the two trees already match — that records the baseline as an empty commit. Otherwise monosplice lists the differing paths and stops; `--theirs` replaces `path/` with the remote tree in one commit. |
| empty / absent | empty | — | Nothing exists yet. Commit something, or point `remote` at a repo that has content. |

```sh
# a repo with 200 commits of its own history, no core/ in the monorepo yet
monosplice adopt core             # one commit: "Adopt core from …@ 9f2c1ab0e4"
monosplice adopt core --history   # …or replay all 200 into core/
```

Either way the adopt commit carries `Monosplice-Origin: <pub-sha>`, which is what makes
`status` say "in sync" immediately: the remote history is reflected by ancestry, not by
importing it commit by commit. Everything before the adopt commit stays in your monorepo
history and is never exported — the next `push` publishes only genuinely new work, parented
on the remote's existing head.

`push` and `pull` refuse to guess. Pointed at a remote whose history is unrelated to the
monorepo, both stop and tell you to run `adopt`; run `adopt` on a pair that is already
connected and it stops too.

### `attach`: the whole table in one command

`adopt` and `push` both assume the subrepo is already in your config. `monosplice attach
<folder> <git-url>` writes that entry for you and then makes the move the table above
prescribes, without you having to work out which row you are on:

```sh
monosplice attach core git@github.com:you/core.git
```

- Remote has history, `core/` is empty → one commit carrying the config entry *and* the
  remote tree, anchored with `Monosplice-Origin`. In sync immediately.
- Remote has history, `core/` has content → the same single commit when the trees match;
  otherwise monosplice lists the differing paths and stops. `--theirs` takes the remote tree.
- Remote is empty, `core/` has content → the config entry is committed on its own, then the
  first publish asks before writing to the remote. Use `--yes` in scripts (`--full-history`
  replays every commit that touched the folder). Without confirmation the config commit still
  lands and monosplice names `monosplice push <name> --yes`.
- Both empty → nothing exists yet; the config is left untouched.

`--name` defaults to the last segment of `<folder>`, `--branch` to `main`. Every refusal —
name or path already configured, nesting, a dirty tree, a pull in progress, an unreachable
URL — leaves the config byte-identical and makes no commit.

## Vendoring a third-party project

`adopt` connects a subrepo you already configured. `vendor` is the sugar for the case where
you have nothing yet: a third-party repo you want *inside* your monorepo, tracked, patchable,
and still able to take upstream updates.

```sh
monosplice vendor git@github.com:lodash/lodash.git
# ✓ vendored lodash at vendor/lodash (tracking git@github.com:lodash/lodash.git#main)
```

One command, one commit. It derives the name from the URL (`lodash`), picks
`vendor/lodash` as the path, writes the entry into your `monosplice.config.ts`, materializes
lodash's current tree at that path, and commits the config change and the tree **together**,
with a `Monosplice-Origin` trailer anchoring the pair. `--path`, `--name` and `--branch`
override the defaults.

From then on it is a normal subrepo. Patch it like any other directory in your monorepo:

```sh
git commit -am "fix(lodash): guard against a null prototype"
```

and take upstream updates whenever you like:

```sh
monosplice pull lodash    # replays new upstream commits into vendor/lodash/
```

Your patch and upstream's commits are three-way merged, so an upstream change to a different
file lands silently and your patch survives. When upstream edits the same lines you did, you
get the standard conflict flow — markers in `vendor/lodash/`, resolve, `git add`,
`monosplice pull --continue` — and your resolution is preserved.

With only `remote` set it is both the pull source and the push destination, so `monosplice push
lodash` would try to write to lodash's own repository. Almost nobody has permission to do
that. Point monosplice at a fork instead — see the next section.

## Pushing patches back upstream (fork workflow)

Set `upstream` and the subrepo becomes triangular: monosplice **pulls from upstream** and
**pushes to your fork**, which is exactly the shape a pull request wants.

```ts
{
  path: 'vendor/lodash',
  remote: 'git@github.com:you/lodash.git',       // your fork — the push destination
  upstream: 'git@github.com:lodash/lodash.git',  // where updates come from
  branch: 'main',                                // branch tracked on upstream
  pushBranch: 'monosplice/patches',              // optional, defaults to `branch`
}
```

`monosplice vendor <upstream-url> --fork <fork-url>` writes that entry for you.

The loop:

```sh
git commit -am "fix(lodash): guard against a null prototype"   # patch it in the monorepo
monosplice push lodash    # rebuilds you/lodash's monosplice/patches = upstream main + your patches
# open the PR from that branch
monosplice pull lodash    # takes upstream updates whenever you like
```

The fork's `pushBranch` is a **derived artifact** monosplice owns: every push rebuilds it as the
current upstream head plus your patches, replayed in order, and writes it with
`--force-with-lease` so a branch somebody else moved is never clobbered silently. Exports are
sha-deterministic, so rebuilding an unchanged chain produces the identical branch and monosplice
reports "up to date" instead of pushing. Upstream itself is **never** written to — not a
branch, not a tag. (`monosplice tag` refuses on a triangular subrepo for the same reason.)

Once upstream advances, `monosplice sync` imports their commits under your patches and rebuilds
the fork branch on the new upstream head, so the PR stays applicable.

When the PR is merged, everything converges by itself:

- **Merged or rebased in:** your exported commits arrive in upstream carrying their
  `Monosplice-Source` trailers, so `pull` skips them, the anchors move forward, and `push` says
  up to date.
- **Squash-merged:** upstream gets one new commit with your tree and none of your trailers.
  `pull` imports it (usually as an empty commit — the content is already there), and because
  that import reproduces the upstream tip exactly, it becomes the newest export anchor and the
  old patch commits fall out of the scan range. `push` is up to date, with nothing
  re-published and no ping-pong.

`status` measures ahead/behind against upstream, and says `N to push (awaiting upstream merge)`
once your fork branch already carries the commits — the ball is in the maintainer's court, not
yours. `doctor` fetches both sides and reports them separately, so an unreachable fork never
looks like a broken upstream.

Two notes on the config edit. monosplice inserts the entry textually into the `subrepos: [`
array, then **reloads your config through the real loader** and checks the new entry resolves;
if the file cannot be parsed that way — because your `subrepos` is built from a spread, an
import, or a function call — it restores the original bytes byte-for-byte, makes no commit,
and prints the entry for you to paste in yourself. And `vendor` refuses to start unless the
working tree is clean and the target path is empty, because it commits the index.

## Configuration

`monosplice.config.ts` sits at the root of your monorepo (`.mts`, `.js` and `.mjs` also work). It is loaded with [jiti](https://github.com/unjs/jiti), so TypeScript and ESM work with no build step.

```ts
import {defineConfig} from 'monosplice'

export default defineConfig({
  subrepos: [
    {
      name: 'core',                                 // optional, defaults to the last path segment
      path: 'core',                                 // directory in the monorepo; nested paths are fine
      remote: 'git@github.com:you/core.git',        // any git URL
      branch: 'main',                               // optional, default "main"
      exclude: ['INTERNAL.md', '**/*.internal.ts'], // optional globs, relative to the subrepo dir
    },
  ],
})
```

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `path` | `string` | yes | Directory inside the monorepo, relative to the config file. `packages/lib` is fine. Cannot be the repo root, cannot contain `.`/`..`, and two subrepos may not nest inside one another. |
| `remote` | `string` | yes | Git URL of the standalone repository. With `upstream` set, this is your fork: the push destination, and the only repo monosplice writes to. |
| `upstream` | `string` | no | Git URL to pull from when it differs from the one you push to (fork workflow). Every sync decision — imports, anchors, ahead/behind — is made against it. Must differ from `remote`. |
| `name` | `string` | no | The handle you type (`monosplice push core`). Defaults to the last segment of `path`. Must be unique. |
| `branch` | `string` | no | Branch synced on both sides. Default `main`. With `upstream` set, the branch tracked on upstream. |
| `pushBranch` | `string` | no | Branch monosplice rebuilds on your fork. Defaults to `branch`. Requires `upstream`. |
| `exclude` | `string[]` | no | [picomatch](https://github.com/micromatch/picomatch) globs, relative to the subrepo directory, matched against every file before export. Dotfiles are matched. |
| `rewriteMessage` | function | no | Rewrite outgoing commit messages. |
| `transform` | function | no | Mutate the outgoing tree. |
| `scan` | function | no | Inspect the outgoing tree and throw to block the push. |

### Hooks

All three hooks run **per exported commit**, against the tree that commit would publish, *before* anything is written to the remote. Throwing from any of them aborts the whole push with nothing published.

```ts
interface ExportContext {
  subrepo: string   // name from config
  monoSha: string   // the monorepo commit being exported
  message: string   // its original, pre-rewrite message
}

// Keyed by path relative to the subrepo root ("src/index.ts", not "core/src/index.ts").
type FileMap = Map<string, {mode: string; data: Buffer}>

rewriteMessage?: (message: string, ctx: ExportContext) => string
transform?:      (files: FileMap, ctx: ExportContext) => FileMap | void | Promise<FileMap | void>
scan?:           (files: FileMap, ctx: ExportContext) => void | Promise<void>
```

`rewriteMessage` runs before the `Monosplice-Source` trailer is appended, so you cannot accidentally strip it. `transform` may mutate `files` in place or return a replacement map — deleting a key removes the file from the exported tree, without touching your monorepo. Only the object database is written; your working tree and index are never touched by an export.

A realistic secret scan, which is the reason the hook exists at all:

```ts
const SECRETS: Array<[string, RegExp]> = [
  ['AWS access key id', /\bAKIA[0-9A-Z]{16}\b/],
  ['private key block', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['Slack token', /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/],
  ['internal hostname', /\b[a-z0-9-]+\.corp\.example\.internal\b/],
]

export default defineConfig({
  subrepos: [
    {
      path: 'core',
      remote: 'git@github.com:you/core.git',
      exclude: ['**/*.internal.ts', 'fixtures/prod-dump.sql'],
      scan(files, ctx) {
        for (const [file, {data}] of files) {
          if (data.includes(0)) continue // skip binaries
          const text = data.toString('utf8')
          for (const [label, pattern] of SECRETS) {
            if (pattern.test(text)) {
              throw new Error(`${label} in ${file} (monorepo commit ${ctx.monoSha.slice(0, 10)})`)
            }
          }
        }
      },
    },
  ],
})
```

Because the scan runs against every commit being exported — not just the final tree — a secret that was added and later deleted still blocks the push, which is the correct behaviour: publishing that history would publish the secret.

## The conflict flow

Imports are the only operation that touches your working tree, because a conflicting import is a merge only you can resolve.

```console
$ monosplice pull
 ›   Error: core: importing 4a91c2f0b1 conflicts with local changes.
 ›   Conflicted files:
 ›     core/src/index.ts
 ›   Edit each file to resolve the markers, `git add` it, then run:
 ›     monosplice pull --continue
 ›   To abort instead, delete /path/to/repo/.git/monosplice/pull-state.json.
```

Each incoming commit is applied with `git apply --3way --index`, so non-conflicting concurrent edits merge silently. On a real conflict, monosplice leaves standard conflict markers in your working tree and writes a sequencer file under `.git/monosplice/` — a transient record of "which commit we were on and what is left", exactly like `.git/rebase-merge`. It is never committed and never part of your project.

You resolve, `git add`, and run `monosplice pull --continue`. The import lands as a monorepo commit carrying `Monosplice-Origin`, and the remaining commits replay on top.

Then comes the subtle part, and it is deliberate: your resolution is **re-exported** on the next push. A pure import reproduces the remote tip's tree exactly, so the tree-equality check drops it and nothing is published (no ping-pong). But a *conflicted* import is a genuine merge of monorepo and external edits — its tree differs from the remote tip — so it must go out, or the standalone repo would silently lose your resolution. That is the rule that keeps "the exported tree equals the filtered monorepo tree" true after every push.

## Install options

Beyond `npm install -g monosplice`:

An install script that checks prerequisites (git, Node ≥ 20) first:

```sh
curl -fsSL https://raw.githubusercontent.com/jakequist/monosplice/main/install.sh | sh
```

Every release is also attached as a tarball to [GitHub Releases](https://github.com/jakequist/monosplice/releases), useful for pinning an exact artifact:

```sh
npm install -g https://github.com/jakequist/monosplice/releases/download/v0.3.1/monosplice-0.3.1.tgz
```

Once installed, `monosplice update` self-updates from npm (`monosplice update --check` just reports installed vs. latest).

## Releasing

Releases are cut by pushing a tag; nothing is published by hand.

```sh
# 1. bump "version" in package.json to X.Y.Z
git commit -am "release: vX.Y.Z"
git tag vX.Y.Z && git push origin main vX.Y.Z
```

`.github/workflows/release.yml` then refuses the tag if it disagrees with `package.json`, runs `pnpm test:all`, packs the tarball, creates the GitHub release with both assets (`monosplice-X.Y.Z.tgz` immutable, `monosplice.tgz` stable), and publishes the same tarball to npm via [trusted publishing](https://docs.npmjs.com/trusted-publishers) — OIDC, no token secret; the one-time setup is registering `release.yml` as a trusted publisher in the package settings on npmjs.com. `.github/workflows/ci.yml` runs `pnpm typecheck` and `pnpm test:all` on every push to `main` and every pull request.

[`e2e-scenarios.md`](e2e-scenarios.md) is the living backlog. Every scenario has a stable ID (`S10`, `S42`, …) that its test name references, and items are checked off as their tests land. New behaviour starts as a new scenario there.
