# monosplice

**What `git subtree` should have been.**

Keep everything in one monorepo. Splice any directory out as a real, standalone git
repository, and let commits flow both ways — `push` exports your commits, `pull` replays
outside contributions back in, one commit at a time, authors and messages preserved.

```
my-monorepo/
├── core/       ◀━━━ sync ━━━▶   github.com/you/core
├── cli/        ◀━━━ sync ━━━▶   github.com/you/cli
├── website/
├── infra/                       (everything else never leaves)
└── vendor/
    └── lodash/ ◀━━━ sync ━━━▶   github.com/lodash/lodash
```

No submodules, no gitlinks, no state file, no special clone steps for contributors. The
monorepo stays a completely normal git repo; so does every repo spliced out of it. Use it to
open-source part of a larger codebase, to vendor a third-party project you patch, or to
maintain a fork whose PR branch rebuilds itself.

**Status: early, v0.x.** The core loop (push / pull / adopt / vendor / sync / status /
doctor / tag) is covered by a black-box e2e suite, but the API and output are not frozen
yet. [`docs/e2e-scenarios.md`](docs/e2e-scenarios.md) lists exactly what is proven to work.

## Install

```sh
npm install -g monosplice
```

Requires Node ≥ 20 and git ≥ 2.30. Prefer an install script or a pinned tarball? See
[install options](docs/reference.md#install-options).

## 60-second quickstart

```sh
cd ~/code/my-monorepo
monosplice init          # writes monosplice.config.ts
```

Point it at a directory and an empty repo:

```ts
// monosplice.config.ts
import {defineConfig} from 'monosplice'

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

Push once to publish `core/`'s current tree as the standalone repo's first commit
(`--full-history` replays every commit that ever touched `core/` instead):

```sh
monosplice push core
# core.git (main) is empty. Publish core's current tree as its first public commit? [y/N]
```

Then just work in the monorepo as you always have:

```sh
git commit -am "feat(core): add the greeter"
git commit -am "chore(website): copy tweaks"   # touches nothing in core/, never exported

monosplice status   # core: 1 to push
monosplice push     # exports the core/ commit, and only that one
```

When someone lands a PR against the standalone repo:

```sh
monosplice pull     # replays it into core/, original author preserved
monosplice sync     # pull then push, in one go
```

If the standalone repo *already* has history, run `monosplice adopt` instead of pushing —
one commit connects the two, and `status` reports "in sync" immediately. See
[adopting an existing repo](docs/reference.md#adopting-an-existing-repo).

## Commands

| Command | What it does |
| --- | --- |
| `monosplice init` | Write a starter `monosplice.config.ts`. |
| `monosplice push [subrepo]` | Export new monorepo commits to the standalone repo(s). |
| `monosplice pull [subrepo]` | Import new standalone-repo commits into the monorepo. `--continue` resumes after a conflict. |
| `monosplice sync [subrepo]` | Pull, then push — converge both sides. |
| `monosplice status [--json]` | Per-subrepo "N to push, M to pull", or "in sync". |
| `monosplice adopt <subrepo>` | Connect a directory to a repo that already has history. |
| `monosplice vendor <git-url>` | Add a third-party repo as a tracked, patchable directory. `--fork` sets up the [fork workflow](docs/reference.md#pushing-patches-back-upstream-fork-workflow). |
| `monosplice doctor` | Verify the derived sync state against reality; non-zero exit on problems. |
| `monosplice tag <subrepo> <tag>` | Tag the standalone repo at the commit matching monorepo HEAD. |
| `monosplice update` | Self-update from npm. |

Full flags and edge-case behaviour: [docs/reference.md](docs/reference.md).

## How it works

**Two histories, one mapping.** The monorepo and each standalone repo have independent
histories; monosplice replays commits between them and records the correspondence in commit
trailers — exports carry `Monosplice-Source: <monorepo-sha>`, imports carry
`Monosplice-Origin: <public-sha>`. Each export is built with git plumbing (`ls-tree`,
`mktree`, `commit-tree`), preserves the original author and dates, and the remote ref is
written once, only after every commit and every hook has succeeded. Commits that touch
nothing exportable produce no commit on the other side.

**There is no state file.** Nothing on disk records "where we got to". Every run re-derives
both cursors from the trailers, and reflection is decided by *ancestry*, not by ticking off
commits one at a time — which is why a one-commit `adopt` of a 200-commit repo reports "in
sync" instead of "200 to pull". A fresh clone on a new machine can push, pull and sync
immediately: no cache to invalidate, no lockfile to conflict on. And when the picture doesn't
add up (shallow clone, rewritten history), monosplice stops and says so rather than guessing.

**Hooks run before anything leaves.** `exclude` globs filter files out of the export, and
three per-commit TypeScript hooks — `scan`, `transform`, `rewriteMessage` — inspect or
rewrite each outgoing tree; throwing aborts the whole push with nothing published. A secret
scan runs against *every* exported commit, so a key that was added and deleted still blocks
the push. See [configuration & hooks](docs/reference.md#configuration).

**Conflicts are just merges.** Imports apply with `git apply --3way`, so concurrent edits to
different lines merge silently. A real conflict leaves standard markers; you resolve,
`git add`, `monosplice pull --continue` — and your resolution is re-exported so neither side
loses it. Details: [the conflict flow](docs/reference.md#the-conflict-flow).

## Compared to the alternatives

| | git submodule | git subtree | Copybara | monosplice |
| --- | --- | --- | --- | --- |
| Files in the monorepo | pointer, not content | real files | real files | real files |
| Contributor setup | `submodule update --init`, forever | none | none | none |
| Export granularity | n/a (same repo) | squash or graft | per commit | per commit |
| Contributions back in | manual, by hand | `subtree pull` (merge noise) | yes, workflow-driven | yes, `monosplice pull` with 3-way merge |
| Secret scan / tree transform | no | no | yes (Starlark) | yes (TypeScript hooks) |
| Where the mapping lives | gitlink shas | subtree merge commit messages | labels in commit messages | commit trailers, re-derived every run |
| Runtime | git | git | Java (+ Bazel to build) | Node ≥ 20 |
| Scope | vendoring dependencies | grafting a directory in/out | large-scale, industrial-strength internal→external pipelines | one monorepo publishing a handful of directories |

Short version: submodules make the *contributor* pay for your publishing strategy.
`git subtree` moves directories but has no excludes, no transforms, no scan that can block a
push, and its history gets noisy fast. Copybara does all of this and more, and is far more
mature — it is also a Java/Bazel deployment with a Starlark config, which is a lot of
machinery if what you have is one repo and one `core/` directory. monosplice aims at that
smaller case with a config file you can read in ten seconds.

## Going deeper

- [Adopting an existing repo](docs/reference.md#adopting-an-existing-repo)
- [Vendoring a third-party project](docs/reference.md#vendoring-a-third-party-project)
- [Fork workflow — PRs back upstream](docs/reference.md#pushing-patches-back-upstream-fork-workflow)
- [Configuration & hooks](docs/reference.md#configuration)
- [The conflict flow](docs/reference.md#the-conflict-flow)
- [Install options & releasing](docs/reference.md#install-options)

## Development

```sh
pnpm install
pnpm build          # tsc → dist/
pnpm typecheck      # tsc --noEmit
pnpm test           # unit tests only (fast)
pnpm test:e2e       # build, then the black-box CLI suite
pnpm test:all       # build, then everything
```

The project is test-driven: new behaviour starts as a scenario in
[`docs/e2e-scenarios.md`](docs/e2e-scenarios.md), gets a failing black-box test in
`test/e2e/` (or a unit test in `test/unit/` for pure logic), then the implementation. E2E
tests invoke the built binary and assert on exit codes, stdout and git state; "remotes" are
local bare repos, so the suite never touches the network. Releasing is
[tag-driven](docs/reference.md#releasing).

## Roadmap

Not built yet, in rough order of usefulness:

- **Branch export** — sync branches other than the configured one, so feature branches and release branches can be published too.
- **A GitHub Action** — run `monosplice sync` (or at least `monosplice status`) in CI on a schedule.
- **Standalone binaries** — `oclif pack` tarballs so the CLI can be installed without a Node toolchain.

## License

MIT.
