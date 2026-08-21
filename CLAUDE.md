# monolith

CLI (TypeScript + oclif) for managing monorepos that publish subdirectories as standalone
open-source repos, with bidirectional sync. Think "git subtree with Copybara's brain and
submodule-free ergonomics."

## Architecture (the invariants — do not violate these)

- **Model B / two-histories design.** The monorepo and each public subrepo have *independent*
  histories. Monolith replays commits across the boundary and records the correspondence.
  We never try to make the public repo a deterministic filter of monorepo history.
- **Trailers are the source of truth for the commit mapping.**
  - Exported public commits carry `Monolith-Source: <monorepo-sha>`.
  - Imported monorepo commits carry `Monolith-Origin: <public-sha>` — the marker that a pub
    commit is reflected in mono (so `pull` skips it and `push` stops refusing).
  - Import skips pub commits with `Monolith-Source` (our own exports).
  - Export does NOT skip by trailer: a pure import's tree already equals the pub tip, so the
    tree-equality no-op check drops it; a *conflicted* import (merge of mono + pub edits)
    differs from the pub tip and MUST export, or the resolution would be lost. This is what
    keeps `pub tree == filtered(mono HEAD)` structurally true after every push.
  - **Origin trailers are export anchors too.** The export scan base is the newest commit on
    the `HEAD` walk that pub already contains: a `Monolith-Source` key, *or* a
    `Monolith-Origin` commit naming an ancestor of pub head whose `filteredSubtree` equals
    that pub commit's tree. The tree check is load-bearing both ways — without it a push
    after `adopt` replays the whole pre-adoption monorepo history onto the adopted repo, and
    with a naive version a conflicted import would silently become the base and lose its
    resolution.
  - **Reflection is ancestry-based.** Unimported pub commits are
    `rev-list <pubHead> --not <each imported sha>` (fed via `--stdin`), minus our own exports.
    Every ancestor of a reflected commit is reflected; a one-commit `adopt` of a 200-commit
    repo must never read as "200 to pull".
- **Triangular mode: upstream decides, the fork is disposable.** When a subrepo configures
  `upstream`, every sync decision (fetch, anchors, unreflected, ahead/behind) is made against
  upstream and *only* upstream — the fork is never consulted for imports. `remote` is the push
  destination: monolith rebuilds its `pushBranch` as upstream head + replayed patches on every
  push and writes it with `--force-with-lease`, because that branch is a derived artifact
  monolith owns. Upstream is never written to — no branch, no tag.
- **First contact is detected, not configured.** Outbound (`pubHead` null) is a
  confirmation-gated first `push` — TTY prompt, `--yes` otherwise, plus `--full-history`.
  Inbound (pub has unrelated history) is `adopt`. Unrelated + either direction → refuse and
  name `monolith adopt`. Both empty → one shared "nothing exists yet" error. There is no
  `seed` command.
- **There is no authoritative state file.** Sync cursors are derived from trailers on every
  run (scan pub for `Monolith-Source`, mono for `Monolith-Origin`). Correctness must never
  depend on cached state; any cache added later is a pure optimization that `doctor` can
  verify. Fresh clones work with zero ceremony because of this.
- **Export never touches the working tree.** All export work uses git plumbing
  (`rev-list`, `commit-tree`, `mktree`, `cat-file`) against the object database. Import is the
  only operation allowed to modify the working tree (it's a merge the user resolves) — and
  `adopt` is an import-side op, so it may too.
- **Talk to git by shelling out** (`execa` + system `git`). No isomorphic-git, no nodegit.
- **Fail loud on surprises.** Cursor not an ancestor of HEAD (rebase/force-push), diverged
  public remote, dirty subrepo dir on pull → stop with a clear message. Never export garbage.
- **Pushing to a public remote is irreversible.** Any code path that writes to a remote must
  run configured safety hooks (secret scan, transforms, excludes) *per exported commit* first.

## Stack & commands

- pnpm, TypeScript (strict), oclif, vitest, execa. Node LTS. MIT license.
- `pnpm build` — compile. `pnpm test` — unit tests. `pnpm test:e2e` — e2e suite (black-box,
  runs the built CLI). `pnpm lint` / `pnpm typecheck`.
- Config file is `monolith.config.ts` loaded via jiti; `defineConfig()` provides types.

## TDD — non-negotiable

This project is test-driven from day one. The workflow for every change:

1. **Write the failing test first.** For command behavior, that's an e2e scenario in
   `test/e2e/` (see `docs/e2e-scenarios.md` for the backlog). For pure logic (trailer
   parsing, config validation, path filtering), a unit test in `test/unit/`.
2. Run it, watch it fail for the right reason.
3. Implement the minimum to pass. Refactor with tests green.
4. A feature without a test does not exist. A bugfix starts with a regression test.

E2E conventions:
- Tests are **black-box**: they invoke the built `monolith` binary via execa and assert on
  exit codes, stdout, and resulting git state. No importing internals into e2e tests.
- Remotes are **local bare repos** (`file://` URLs) in temp dirs. No network, ever.
- Determinism: fixed `GIT_AUTHOR_*`/`GIT_COMMITTER_*` env, `GIT_CONFIG_GLOBAL=/dev/null`,
  `GIT_CONFIG_SYSTEM=/dev/null`, fixed dates. Snapshot `git log --format=...` output freely.
- Shared harness lives in `test/e2e/harness.ts` (`makeMonorepo`, `makeBareRemote`,
  `runMonolith`, `gitLog`, ...). Grow the harness instead of duplicating setup.

## How to work in this repo (agent orchestration)

The main session acts as **manager/architect**: it owns design decisions, task breakdown,
the invariants above, and final review. Low-level implementation is delegated to **Opus
subagents** via the Agent tool (`model: "opus"`).

- Slice work into agent-sized tasks: one command, one harness feature, one scenario batch.
- Each delegated task's prompt must include: the failing test(s) to make pass (or the test
  to write first), the relevant invariants from this file, and the files in scope.
- Subagents follow TDD too — instruct them to run the tests before and after.
- The manager reviews every diff against the invariants before it lands; don't rubber-stamp.
- Parallelize independent tasks (e.g., separate scenarios) in a single message.

## Code style

- Small modules with pure functions where possible; command classes stay thin and call into
  `src/core/`. Prefer explicit types at module boundaries, inference inside.
- Error messages are written for the user at the terminal: say what happened, why monolith
  stopped, and the exact command to run next.
- No comments that narrate the diff; comment only non-obvious constraints.
