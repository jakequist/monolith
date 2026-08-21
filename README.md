# monolith

Keep your work in one private monorepo, and publish some of its directories as real, standalone open-source repositories. `monolith` replays commits across that boundary in both directions — your `core/` directory becomes the root of a public repo, external contributions come back into `core/` — with per-commit fidelity, configurable secret scanning and tree transforms, and no submodules, no gitlinks, and no state file to keep in sync. Your monorepo stays a completely normal git repo; the public repos stay completely normal git repos; monolith is the thing that moves commits between them.

**Status: early. v0.x.** The core sync loop (push / pull / adopt / vendor / sync / status / doctor / tag) is covered by a black-box e2e suite, but the API and output are not frozen yet, and it has not been battle-tested across many repos. Read [`docs/e2e-scenarios.md`](docs/e2e-scenarios.md) to see exactly what is proven to work.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/jakequist/monolith/main/install.sh | sh
```

The script checks for git and Node ≥ 20, then installs the latest release tarball with npm. It is a thin convenience over doing that yourself:

```sh
npm install -g https://github.com/jakequist/monolith/releases/latest/download/monolith.tgz
```

Releases are published as tarballs on [GitHub Releases](https://github.com/jakequist/monolith/releases), not to the npm registry — the URL above always points at the newest one. To pin a version, install its versioned asset instead:

```sh
npm install -g https://github.com/jakequist/monolith/releases/download/v0.1.1/monolith-0.1.1.tgz
```

Once installed, `monolith update` self-updates from GitHub Releases (`monolith update --check` just reports installed vs. latest).

Requires **Node ≥ 20** and **git ≥ 2.30**. The binary, package and tarball are all just `monolith` — GitHub Releases is the only distribution channel, so there is no npm-registry namespace to worry about. (Do not `npm install -g monolith` from the registry: that name belongs to an unrelated, long-dormant package. Always install from the release URL.)

## 60-second quickstart

```sh
cd ~/code/my-monorepo
monolith init          # writes monolith.config.ts
```

Point it at a directory and an empty public repo:

```ts
// monolith.config.ts
import {defineConfig} from 'monolith'

export default defineConfig({
  subrepos: [
    {
      name: 'core',
      path: 'core',
      remote: 'git@github.com:you/core.git',
    },
  ],
})
```

Then just push. The first push notices the remote is empty, asks once, and publishes `core/`'s
current tree as the public repo's first commit:

```sh
monolith push core
# core.git (main) is empty. Publish core's current tree as its first public commit? [y/N]
```

In a script or CI there is nobody to ask, so pass the answer explicitly — and add
`--full-history` if you want every monorepo commit that ever touched `core/` replayed instead
of one baseline commit:

```sh
monolith push core --yes
monolith push core --yes --full-history
```

If the public repo already exists and has history, don't push — see
[Adopting an existing repo](#adopting-an-existing-repo).

Then just work in the monorepo as you always have:

```sh
git commit -am "feat(core): add the greeter"
git commit -am "chore(website): copy tweaks"   # private, never exported

monolith status   # core: 1 to push
monolith push     # exports the core/ commit, and only that one
```

When someone opens a PR against the public repo and it lands:

```sh
monolith pull     # replays it into core/, with the original author preserved
monolith sync     # pull then push, in one go
monolith tag core v1.0.0
```

## Adopting an existing repo

First contact is detected, never configured. monolith looks at two things — whether the
subrepo directory has committed content, and whether the remote branch exists — and there is
exactly one right move for each combination:

| `path/` in the monorepo | remote branch | What to run | What happens |
| --- | --- | --- | --- |
| has content | empty | `monolith push <name>` (`--yes` in scripts) | Publishes the current tree as one `Initial import of <name>` commit. `--full-history` replays every commit that touched the directory instead. |
| empty / absent | has history | `monolith adopt <name>` | Materializes the remote's HEAD tree at `path/` in **one** monorepo commit. `--history` replays every public commit instead, authors and messages preserved. |
| has content | has history | `monolith adopt <name>` | Only if the two trees already match — that records the baseline as an empty commit. Otherwise monolith lists the differing paths and stops; `--theirs` replaces `path/` with the public tree in one commit. |
| empty / absent | empty | — | Nothing exists yet. Commit something, or point `remote` at a repo that has content. |

```sh
# a public repo with 200 commits of its own history, no core/ in the monorepo yet
monolith adopt core             # one commit: "Adopt core from …@ 9f2c1ab0e4"
monolith adopt core --history   # …or replay all 200 into core/
```

Either way the adopt commit carries `Monolith-Origin: <pub-sha>`, which is what makes
`status` say "in sync" immediately: the public history is reflected by ancestry, not by
importing it commit by commit. Everything before the adopt commit stays in your monorepo
history and is never exported — the next `push` publishes only genuinely new work, parented
on the public repo's existing head.

`push` and `pull` refuse to guess. Pointed at a remote whose history is unrelated to the
monorepo, both stop and tell you to run `adopt`; run `adopt` on a pair that is already
connected and it stops too.

## Vendoring a third-party project

`adopt` connects a subrepo you already configured. `vendor` is the sugar for the case where
you have nothing yet: a third-party repo you want *inside* your monorepo, tracked, patchable,
and still able to take upstream updates.

```sh
monolith vendor git@github.com:lodash/lodash.git
# ✓ vendored lodash at vendor/lodash (tracking git@github.com:lodash/lodash.git#main)
```

One command, one commit. It derives the name from the URL (`lodash`), picks
`vendor/lodash` as the path, writes the entry into your `monolith.config.ts`, materializes
lodash's current tree at that path, and commits the config change and the tree **together**,
with a `Monolith-Origin` trailer anchoring the pair. `--path`, `--name` and `--branch`
override the defaults.

From then on it is a normal subrepo. Patch it like any other directory in your monorepo:

```sh
git commit -am "fix(lodash): guard against a null prototype"
```

and take upstream updates whenever you like:

```sh
monolith pull lodash    # replays new upstream commits into vendor/lodash/
```

Your patch and upstream's commits are three-way merged, so an upstream change to a different
file lands silently and your patch survives. When upstream edits the same lines you did, you
get the standard conflict flow — markers in `vendor/lodash/`, resolve, `git add`,
`monolith pull --continue` — and your resolution is preserved.

**Pushing patches back upstream is not solved yet, and monolith does not pretend otherwise.**
`remote` is currently both the pull source and the push destination, so a `monolith push
lodash` after a local patch will try to write to lodash's own repository. Almost nobody has
permission to do that, and the push fails loudly with git's own rejection before anything is
recorded — a safe failure, but a failure. Until then, either don't push vendored subrepos, or
point `remote` at your own fork and pull manually from upstream. The proper fix is a
triangular setup — an `upstream` to pull from and a fork as `remote` to push PR branches to —
tracked as the next phase in [`docs/e2e-scenarios.md`](docs/e2e-scenarios.md) (S110–S118).

Two notes on the config edit. monolith inserts the entry textually into the `subrepos: [`
array, then **reloads your config through the real loader** and checks the new entry resolves;
if the file cannot be parsed that way — because your `subrepos` is built from a spread, an
import, or a function call — it restores the original bytes byte-for-byte, makes no commit,
and prints the entry for you to paste in yourself. And `vendor` refuses to start unless the
working tree is clean and the target path is empty, because it commits the index.

## Configuration

`monolith.config.ts` sits at the root of your monorepo (`.mts`, `.js` and `.mjs` also work). It is loaded with [jiti](https://github.com/unjs/jiti), so TypeScript and ESM work with no build step.

```ts
import {defineConfig} from 'monolith'

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
| `remote` | `string` | yes | Git URL of the public repository. |
| `name` | `string` | no | The handle you type (`monolith push core`). Defaults to the last segment of `path`. Must be unique. |
| `branch` | `string` | no | Branch synced on both sides. Default `main`. |
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

`rewriteMessage` runs before the `Monolith-Source` trailer is appended, so you cannot accidentally strip it. `transform` may mutate `files` in place or return a replacement map — deleting a key removes the file from the public tree, without touching your monorepo. Only the object database is written; your working tree and index are never touched by an export.

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

## Commands

| Command | What it does |
| --- | --- |
| `monolith init` | Write a starter `monolith.config.ts` in the current directory. Running it again is a no-op. |
| `monolith adopt <subrepo> [--history] [--theirs]` | Connect a subrepo to a public remote that already has history. Default records the remote's HEAD tree in one commit; `--history` replays every public commit; `--theirs` resolves the "both sides have content and disagree" case in favour of the remote. Refuses if the two are already connected. |
| `monolith vendor <git-url> [--path <p>] [--name <n>] [--branch <b>]` | Add a third-party repo as a tracked subrepo. Writes the config entry and materializes the remote's tree at `vendor/<name>/` in one commit. Refuses (changing nothing) on a name/path collision, a dirty working tree, an occupied target path, an unreachable remote, or a config it cannot safely edit — in which case it prints the entry to paste yourself. |
| `monolith push [subrepo] [--yes] [--full-history]` | Export new monorepo commits to the public remote(s). Defaults to every configured subrepo. On a subrepo's **first** push it asks before publishing — `--yes` answers that (required when there is no terminal), and `--full-history` replays every commit that touched the directory instead of publishing one baseline commit. One subrepo refusing does not stop the others; the run exits non-zero at the end. |
| `monolith pull [subrepo] [--continue]` | Import new public commits into the monorepo. `--continue` finishes an import that stopped on a conflict, after you resolved it and ran `git add`. |
| `monolith sync [subrepo]` | Pull, then push — converge both sides in one command. |
| `monolith status [subrepo] [--json]` | Per-subrepo "N to push, M to pull", or "in sync". `--json` prints a stable machine-readable object for CI. |
| `monolith doctor [subrepo]` | Print the derived sync points and verify they match reality: broken commit mappings, rewritten history, unfinished pulls, unreachable remotes. Exits non-zero when it finds a problem. |
| `monolith tag <subrepo> <tag>` | Create a lightweight tag on the public remote pointing at the commit that corresponds to monorepo HEAD. Refuses when anything is unpushed or unpulled (the tag would lie), or when the tag already exists. |
| `monolith update [--check]` | Reinstall the CLI from the newest GitHub release, or just report installed vs. latest. |

## How it works

### Two histories, one mapping

The monorepo and each public repo have **independent histories**. monolith does not try to make the public repo a deterministic filter of monorepo history — that is what makes bidirectional sync and merge-resolution preservation possible. Instead it replays commits and records the correspondence in commit trailers:

- Every commit monolith **exports** carries `Monolith-Source: <monorepo-sha>` in the public repo.
- Every commit monolith **imports** carries `Monolith-Origin: <public-sha>` in the monorepo.

A push replays each pending monorepo commit one at a time: it builds the filtered subtree with git plumbing (`ls-tree`, `mktree`, `hash-object`, `commit-tree`), preserves the original author and dates, appends the trailer, and only after every commit — and every hook — has succeeded does it write the remote ref, once. Commits that touch nothing publishable (only private directories, only excluded files) produce no public commit at all.

### There is no state file

Nothing on disk records "where we got to". On every run, monolith re-derives both cursors from trailers: it walks monorepo `HEAD` for the newest commit the public branch already contains (one it exported, or one that imported public work and reproduces it exactly), and subtracts the public commits already reflected in the monorepo. Everything else follows from those two sets.

Reflection is decided by **ancestry**, not by ticking off commits one at a time: if a monorepo commit reflects public commit X, then everything X is built on is reflected too. That is what lets a one-commit `adopt` of a 200-commit public repo report "in sync" instead of "200 to pull".

The practical consequence: a fresh clone of your monorepo on a new machine can `push`, `pull` and `sync` immediately, with zero setup and nothing to restore. There is no cache to invalidate and no lockfile to conflict on. (`doctor` exists to verify the derived picture against the actual trees, which is only possible because the derivation is the source of truth.)

It also means monolith fails loudly rather than guessing. If the public branch names a monorepo commit that is not in your clone (shallow clone, wrong remote, rewritten history), export stops and tells you so rather than publishing on top of a history it cannot see.

### The conflict flow

Imports are the only operation that touches your working tree, because a conflicting import is a merge only you can resolve.

```console
$ monolith pull
 ›   Error: core: importing 4a91c2f0b1 conflicts with local changes.
 ›   Conflicted files:
 ›     core/src/index.ts
 ›   Edit each file to resolve the markers, `git add` it, then run:
 ›     monolith pull --continue
 ›   To abort instead, delete /path/to/repo/.git/monolith/pull-state.json.
```

Each public commit is applied with `git apply --3way --index`, so non-conflicting concurrent edits merge silently. On a real conflict, monolith leaves standard conflict markers in your working tree and writes a sequencer file under `.git/monolith/` — a transient record of "which commit we were on and what is left", exactly like `.git/rebase-merge`. It is never committed and never part of your project.

You resolve, `git add`, and run `monolith pull --continue`. The import lands as a monorepo commit carrying `Monolith-Origin`, and the remaining commits replay on top.

Then comes the subtle part, and it is deliberate: your resolution is **re-exported** on the next push. A pure import reproduces the public tip's tree exactly, so the tree-equality check drops it and nothing is published (no ping-pong). But a *conflicted* import is a genuine merge of monorepo and public edits — its tree differs from the public tip — so it must go out, or the public repo would silently lose your resolution. That is the rule that keeps "the public tree equals the filtered monorepo tree" true after every push.

## Compared to the alternatives

| | git submodule | git subtree | Copybara | monolith |
| --- | --- | --- | --- | --- |
| Files in the monorepo | pointer, not content | real files | real files | real files |
| Contributor setup | `submodule update --init`, forever | none | none | none |
| Export granularity | n/a (same repo) | squash or graft | per commit | per commit |
| Contributions back in | manual, by hand | `subtree pull` (merge noise) | yes, workflow-driven | yes, `monolith pull` with 3-way merge |
| Secret scan / tree transform | no | no | yes (Starlark) | yes (TypeScript hooks) |
| Where the mapping lives | gitlink shas | subtree merge commit messages | labels in commit messages | commit trailers, re-derived every run |
| Runtime | git | git | Java (+ Bazel to build) | Node ≥ 20 |
| Scope | vendoring dependencies | grafting a directory in/out | large-scale, industrial-strength internal→external pipelines | one monorepo publishing a handful of directories |

Short version: submodules make the *contributor* pay for your publishing strategy. `git subtree` moves directories but has no notion of excludes, transforms, or a scan that can block a push, and its history gets noisy fast. Copybara does all of this and more, and is far more mature — it is also a Java/Bazel deployment with a Starlark config, which is a lot of machinery if what you have is one repo and one `core/` directory. monolith aims at that smaller case with a config file you can read in ten seconds.

## Development

```sh
pnpm install
pnpm build          # tsc → dist/
pnpm typecheck      # tsc --noEmit
pnpm test           # unit tests only (fast)
pnpm test:e2e       # build, then the black-box CLI suite
pnpm test:all       # build, then everything
```

This project is test-driven, and the workflow is not optional:

1. **Write the failing test first.** Command behaviour gets a black-box scenario in `test/e2e/`; pure logic (trailer parsing, config validation, path filtering) gets a unit test in `test/unit/`.
2. Run it and watch it fail for the right reason.
3. Implement the minimum to make it pass, then refactor with the suite green.

E2E tests invoke the built binary with `execa` and assert on exit codes, stdout and resulting git state — no importing internals. "Remotes" are local bare repositories in temp directories, so the suite never touches the network. Git identities, dates and config are pinned in `test/e2e/harness.ts`, so shas and logs are reproducible; grow the harness rather than duplicating setup.

### Releasing

Releases are cut by pushing a tag; nothing is published by hand.

```sh
# 1. bump "version" in package.json to X.Y.Z
git commit -am "release: vX.Y.Z"
git tag vX.Y.Z && git push origin main vX.Y.Z
```

`.github/workflows/release.yml` then refuses the tag if it disagrees with `package.json`, runs `pnpm test:all`, packs the tarball, and creates the GitHub release with both assets: `monolith-X.Y.Z.tgz` (immutable, what `monolith update` installs) and `monolith.tgz` (the stable name behind the `/releases/latest/download/` install URL). `.github/workflows/ci.yml` runs `pnpm typecheck` and `pnpm test:all` on every push to `main` and every pull request.

[`docs/e2e-scenarios.md`](docs/e2e-scenarios.md) is the living backlog. Every scenario has a stable ID (`S10`, `S42`, …) that its test name references, and items are checked off as their tests land. New behaviour starts as a new scenario there.

## Roadmap

Not built yet, in rough order of usefulness:

- **Branch export** — sync branches other than the configured one, so feature branches and release branches can be published too.
- **A GitHub Action** — run `monolith sync` (or at least `monolith status`) in CI on a schedule.
- **Standalone binaries** — `oclif pack` tarballs so the CLI can be installed without a Node toolchain.
- **npm registry publish** — a registry convenience alongside the release tarballs would need a scoped name (`@jakequist/monolith`), since bare `monolith` is taken on the registry.

## License

MIT.
