# monosplice reference

The [README](../README.md) covers the quickstart and the core model. This is the detailed
reference for everything else: connecting repos that already exist, vendoring and the fork
workflow, the full configuration surface, conflicts, and releasing.

## Connecting a repo that already exists

`monosplice attach` is the one command for first contact, whichever side already has
something. First contact itself is detected, never configured: monosplice looks at two things
— whether the folder has committed content, and whether the remote branch exists — and there
is exactly one right move for each combination.

```sh
monosplice attach core git@github.com:you/core.git   # folder not in your config yet
monosplice attach core                               # folder already in your config
```

With a URL, `attach` writes the `subrepos` entry for `<folder>` into your
`monosplice.config.js` first. Without one, `<folder>` must already match a configured
subrepo — by path or by name — and nothing is written to the config at all; only first
contact is made. Either way the move is the same:

| `path/` in the monorepo | remote branch | What happens |
| --- | --- | --- |
| empty / absent | has history | Materializes the remote's HEAD tree at `path/` in **one** monorepo commit (`Adopt <name> from …`, carrying `Monosplice-Origin`). `--import-history` replays every commit from the standalone repo instead, authors and messages preserved. |
| has content | has history | Only if the two trees already match — that records the baseline as an empty commit. Otherwise monosplice lists the differing paths and stops; `--theirs` replaces `path/` with the remote tree in one commit. |
| has content | empty | The first publish, confirmation-gated: a prompt at a terminal, `--yes` in scripts. Publishes the current tree as one `Initial import of <name>` commit; `--export-history` replays every monorepo commit that touched the directory instead. |
| empty / absent | empty | Nothing exists yet. Commit something, or point the URL at a repo that has content. |

```sh
# a repo with 200 commits of its own history, no core/ in the monorepo yet
monosplice attach core git@github.com:you/core.git             # one commit: "Adopt core from …@ 9f2c1ab0e4"
monosplice attach core git@github.com:you/core.git --import-history   # …or replay all 200 into core/
```

When the folder is new, the config entry and the tree land in the **same** commit — the
anchor and the entry that gives it meaning belong together. The two exceptions commit the
entry on its own first, because what follows cannot share a commit with it: `--import-history`
(each replayed commit is its own) and a first publish (which asks before writing to the
remote, and the entry must survive a "no").

Either way the anchor commit carries `Monosplice-Origin: <pub-sha>`, which is what makes
`status` say "in sync" immediately: the remote history is reflected by ancestry, not by
importing it commit by commit. Everything before it stays in your monorepo history and is
never exported — the next `push` publishes only genuinely new work, parented on the remote's
existing head.

`--name` defaults to the last segment of `<folder>`, `--branch` to `main`; on an
already-configured folder both are refused rather than silently ignored, and so is a URL that
disagrees with the configured `remote`. Every refusal — name or path already configured,
nesting, a dirty tree, a pull in progress, an unreachable URL, differing trees — leaves the
config byte-identical and makes no commit.

`push` and `pull` refuse to guess. Pointed at a remote whose history is unrelated to the
monorepo, both stop and tell you to run `attach`; run `attach` on a pair that is already
connected by trailers and it stops too.

### Can you actually push there?

Attaching proves you can *read* the remote. Writing to it needs rights nothing so far has
exercised, so after a successful attach to a remote that has history monosplice runs a
harmless `git push --dry-run` of the remote's own head back at it. If that is refused, the
attach still stands (exit 0 — the anchor commit is real and `pull` works), and monosplice
prints an advisory naming the fork setup to use instead. It never blocks, and it is skipped
where it would be meaningless: with `--fork`, or when the remote was empty and the first
publish proved write access by doing it.

## Disconnecting a subrepo

`monosplice detach <subrepo>` is the reverse of attach's config write, and *only* that:

```sh
monosplice detach core
# ✓ detached core — /repo/monosplice.config.js no longer tracks git@github.com:you/core.git
#   core/ is kept exactly as it is, and every commit stays in your monorepo history.
```

The folder stays, every commit stays, and the `Monosplice-Source`/`Monosplice-Origin` trailers
on past commits simply go inert — nothing reads them once no entry names that subrepo. The
config edit is committed on its own (`Detach <name>: stop tracking <url>`), and the output
prints the `monosplice attach <path> <url>` that connects it again later, with the URL it was
actually tracking.

It never contacts the network — there is nothing to tell the remote — and it refuses, leaving
the config byte-identical and making no commit, on an unknown subrepo, on a subrepo whose pull
is sitting unfinished, and on a dirty working tree or a dirty index (it commits the index, so
it insists on the same clean tree `attach` does).

The removal is textual, then verified: monosplice deletes the entry from the `subrepos: [`
array, reloads the config through the real loader, and checks that the named subrepo is gone
*and* that every other one still resolves exactly as it did. If the file cannot be edited that
way — a computed array, an entry whose `path` is not a literal — the original bytes go back
byte-for-byte, no commit is made, and monosplice tells you which entry to delete by hand.

## Vendoring a third-party project

The same command covers a third-party repo you want *inside* your monorepo — tracked,
patchable, and still able to take upstream updates. The `vendor/` prefix is pure convention:

```sh
monosplice attach vendor/lodash git@github.com:lodash/lodash.git
# ✓ attached lodash at vendor/lodash (tracking git@github.com:lodash/lodash.git#main)
```

One command, one commit: the entry goes into your `monosplice.config.js`, lodash's current
tree is materialized at `vendor/lodash/`, and both are committed **together** with a
`Monosplice-Origin` trailer anchoring the pair. The subrepo name defaults to the last path
segment (`lodash`); `--name` and `--branch` override the defaults.

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

`monosplice attach vendor/lodash <upstream-url> --fork <fork-url>` writes that entry for you,
then attaches against **upstream** — the tree, the anchor and every later sync decision come
from there, and the fork is only ever written to by `push`. `--fork` must differ from the URL
you are attaching, and it only applies to a folder that is not configured yet: on an existing
entry monosplice tells you to add `upstream` to the config instead of guessing which of the
two remotes you meant to keep.

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
and prints the entry for you to paste in yourself, naming the `monosplice attach <folder>`
that finishes the job once you have. And `attach` refuses to start unless the working tree is
clean, because it commits the index.

## Configuration

`monosplice.config.js` sits at the root of your monorepo — that is what `monosplice init` writes. TypeScript configs (`monosplice.config.ts`) work too, as do `.mts`, `.mjs` and `.cjs`; the file is loaded with [jiti](https://github.com/unjs/jiti), so TypeScript and ESM work with no build step whatever your project's own module system is. Exactly **one** of them may exist in a directory: two and every command stops and tells you to delete one, rather than silently acting on the file you were not editing.

The scaffold is plain ESM with a JSDoc annotation, so editors complete the fields with no TypeScript involved:

```js
/** @type {import('monosplice').MonospliceConfig} */
export default {
  subrepos: [
    {path: 'core', remote: 'git@github.com:you/core.git'},
  ],
}
```

In TypeScript, `defineConfig()` does the same job:

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
| `path` | `string` | yes | Directory inside the monorepo, relative to the config file. `packages/lib` is fine, and a leading `./` is normalized away. Cannot be the repo root, cannot contain `.`/`..` segments, and two subrepos may not nest inside one another. |
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
 ›   To abandon the import instead, restoring the monorepo to its pre-pull state:
 ›     monosplice pull --abort
```

Each incoming commit is applied with `git apply --3way --index`, so non-conflicting concurrent edits merge silently. On a real conflict, monosplice leaves standard conflict markers in your working tree and writes a sequencer file under `.git/monosplice/` — a transient record of which commit we were on, what is left, where the run started and what it has committed so far, exactly like `.git/rebase-merge`. It is never committed and never part of your project.

You resolve, `git add`, and run `monosplice pull --continue`. The import lands as a monorepo commit carrying `Monosplice-Origin`, and the remaining commits replay on top. A conflict stops the whole run even with several subrepos configured, because only one sequencer can exist at a time.

A conflict during `monosplice sync` names `monosplice sync --continue` instead, and that is the one to run: it finishes the interrupted import exactly as `pull --continue` does and then runs the push phase the interrupted run never reached — for **every** subrepo, since one that is already converged simply reports "up to date". `monosplice pull --abort` still abandons the import whichever command started it; there is one sequencer, and throwing it away is the same act either way.

### Aborting

`monosplice pull --abort` throws the interrupted import away. It restores the subrepo directory and the index to the tree they had before the pull started, deletes the sequencer, and rewinds the commits this pull run had already imported — but only when the sequencer can *prove* they are its own: it recorded the pre-pull HEAD and the sha of every commit it created, and it rewinds only if the commits between the two are exactly that list and nothing else. If you committed something yourself after the conflict, that proof fails, so abort undoes only the conflicted step, keeps the rest, and prints the pre-pull sha so you can decide for yourself.

Nothing outside the subrepo directory is ever touched — unstaged edits and untracked files elsewhere in the monorepo survive an abort untouched, which a plain `git reset --hard` would not manage. Untracked files *under* the subrepo path do not: `pull` refuses to start unless that directory is pristine, so anything untracked there was created by the import being abandoned.

Aborting with no pull in progress is an error, and so is combining `--abort` with `--continue`.

Then comes the subtle part, and it is deliberate: your resolution is **re-exported** on the next push. A pure import reproduces the remote tip's tree exactly, so the tree-equality check drops it and nothing is published (no ping-pong). But a *conflicted* import is a genuine merge of monorepo and external edits — its tree differs from the remote tip — so it must go out, or the standalone repo would silently lose your resolution. That is the rule that keeps "the exported tree equals the filtered monorepo tree" true after every push.

## Previewing a run, and working offline

`--dry-run` on `push` and `pull` prints exactly what would move and writes nothing — no remote
ref, no monorepo commit, no working-tree or index change:

```console
$ monosplice push --dry-run
core: 2 to push (dry run — nothing written)
  4a91c2f0b1 feat(core): add the greeter
  9f2c1ab0e4 fix(core): guard the empty case
```

Nothing pending prints the up-to-date line, and either way the exit code is 0. The plan comes
from the same candidate scan `push` and `status` share, so it is not a separate code path that
can drift.

One deliberate gap: **`scan` and `transform` hooks do not run on a dry run.** They are the gate
on writing to a remote, and a dry run does not write — so the list is what would be *attempted*,
and a commit a hook would reject still appears in it. The real push is still gated: a throwing
hook aborts it with nothing published. `pull --dry-run` likewise skips the clean-working-tree
check a real pull insists on, since that check exists to protect a write.

`monosplice status --offline` skips fetching entirely and measures against the remote-tracking
refs the last run left under `refs/monosplice/`. It says so once per run on stderr
(`offline: using last-fetched state`), so stdout stays pipeable, and it combines with `--json`
(which gains a top-level `offline: true`; the per-subrepo key set is unchanged) and `--check`.
A subrepo that has never been fetched is reported as `no fetch yet — run without --offline
first` rather than guessed at: with no tracking ref, "never fetched" and "the remote has no
branch" are the same picture from here.

## Exit codes and machine-readable output

Every command exits **0** on success (including "already converged, nothing to do") and **1** on any error or `--check` failure; `status` without `--check` is always 0 because reporting a difference is not an error, while `doctor` exits non-zero whenever it found a problem.

`status --check` is the CI form: same human report, but exit 1 unless every subrepo is fully in sync — nothing to push, nothing to pull, no unreachable remote. `status --json` and `doctor --json` print one stable object on stdout and nothing else; diagnostics and warnings always go to stderr, so either can be piped straight into `jq`.

```sh
monosplice status --check              # 0 = converged, 1 = drift
monosplice status --json | jq '.subrepos[] | select(.inSync | not) | .name'
monosplice doctor --json | jq '.problems'
```

With several subrepos configured, one failing subrepo never silences the others: `push`, `pull` and `sync` report every failure together at the end and exit 1. The one exception is an import conflict, which writes the sequencer and therefore stops the run where it stands.

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

### Shell completion

`monosplice autocomplete` (oclif's autocomplete plugin) prints the one-time setup for your shell:

```sh
monosplice autocomplete bash   # or: zsh
```

## Releasing

Releases are cut by pushing a tag; nothing is published by hand.

```sh
# 1. bump "version" in package.json to X.Y.Z
git commit -am "release: vX.Y.Z"
git tag vX.Y.Z && git push origin main vX.Y.Z
```

`.github/workflows/release.yml` then refuses the tag if it disagrees with `package.json`, runs `pnpm test:all`, packs the tarball, creates the GitHub release with both assets (`monosplice-X.Y.Z.tgz` immutable, `monosplice.tgz` stable), and publishes the same tarball to npm via [trusted publishing](https://docs.npmjs.com/trusted-publishers) — OIDC, no token secret; the one-time setup is registering `release.yml` as a trusted publisher in the package settings on npmjs.com. `.github/workflows/ci.yml` runs `pnpm typecheck` and `pnpm test:all` on every push to `main` and every pull request.

[`e2e-scenarios.md`](e2e-scenarios.md) is the living backlog. Every scenario has a stable ID (`S10`, `S42`, …) that its test name references, and items are checked off as their tests land. New behaviour starts as a new scenario there.
