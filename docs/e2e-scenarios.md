# E2E scenario backlog

Living TDD backlog. Each scenario becomes a black-box test in `test/e2e/` that drives the
built CLI against throwaway git repos (local bare repos as "public" remotes). Check items
off as their tests land. IDs are stable — reference them in commits and test names.

Conventions: **mono** = the private monorepo, **pub** = the public bare remote for a
subrepo, `core/` = the configured subrepo path.

## Init & seeding

- [x] S01 `init` scaffolds `monolith.config.ts`; running it again is a safe no-op.
- [x] S02 `seed` (default squash): mono with mixed history → pub gets exactly one "Initial import" commit whose tree equals `core/` subtree; cursor recorded.
- [x] S03 `seed --full-history`: every mono commit touching `core/` is replayed into pub in order with messages/authors preserved and `Monolith-Source` trailers.
- [x] S04 `seed` honors `exclude` patterns — excluded files absent from pub tree even though present in mono history.
- [x] S05 `seed` against a non-empty pub → refuses with guidance (suggest pull/adopt), exit ≠ 0.
- [x] S06 `seed` when `core/` has no committed files yet → clear error, nothing pushed.

## Push (export)

- [x] S10 One new mono commit touching `core/` → `push` creates one pub commit: same message, same author, tree = subtree, trailer appended.
- [x] S11 Commits touching only private dirs (`website/`) are not exported.
- [x] S12 A commit spanning `core/` + private dirs exports with only the `core/` subtree (private paths never in pub objects).
- [x] S13 Multiple pending commits export in order; pub log order matches mono order.
- [x] S14 `push` twice → second run is a no-op ("up to date"), zero new pub commits, exit 0.
- [x] S15 Modifying an excluded file exports nothing; if the commit *only* touched excluded files, no empty pub commit is created (commit skipped).
- [x] S16 `rewriteMessage` hook in config is applied to exported commit messages.
- [x] S17 Pure imports are tree-no-ops on push (dropped by the tree-equality check, not by trailer) — no ping-pong duplicates in pub.
- [x] S18 Binary files, file deletions, and renames replay correctly (tree equality after each commit).
- [x] S19 Executable bit and symlinks are preserved in exported trees.
- [x] S20 Pub has an unimported external commit → `push` refuses, tells user to `monolith pull` first; pub untouched.
- [x] S21 Secret-scan hook rejects a commit → push aborts *before* any ref update on pub; error names the offending commit/file.
- [x] S22 `transform` hook mutates the exported tree (e.g., swaps README) without affecting mono.

## Pull (import)

- [x] S30 External commit in pub → `pull` creates a mono commit placing the tree under `core/`, original author preserved, `Monolith-Origin` trailer added.
- [x] S31 Multiple upstream commits import in order.
- [x] S32 `pull` twice → second run is a no-op.
- [x] S33 Pub commits carrying `Monolith-Source` (our own exports) are skipped on pull.
- [x] S34 Uncommitted local changes under `core/` (or anything staged anywhere) → `pull` refuses before touching anything.
- [x] S35 Conflicting edits (same file changed in mono and pub) → conflict markers in mono working tree, clear instructions, and after `git add` + `monolith pull --continue` the import lands and the resolution round-trips back to pub on the next push.
- [x] S36 External commit adds a file matching an `exclude` pattern → defined behavior (import + warn that the next push deletes it from pub), covered by test so the decision is locked in.

## Sync & convergence

- [x] S40 `sync` = pull then push; from divergence with non-conflicting changes, one command converges both repos.
- [x] S41 Round-trip fidelity: after any sync, pub HEAD tree is byte-identical to mono `core/` subtree (minus excludes).
- [x] S42 Stability: push → pull → push → pull produces zero new commits after the first cycle (fixed point reached).
- [x] S43 Interleaved history (mono and pub alternate commits over several rounds) converges with every commit present exactly once on each side. Known exception, locked in by the test: in a round where *both* sides moved, the import sits on top of the local commit, so its resolution is re-exported and that subject appears twice in pub (same rule that preserves conflict resolutions).

## Status, state & doctor

- [x] S50 `status` reports per-subrepo ahead/behind counts (N unexported, M unimported) and "in sync" when clean.
- [x] S51 No state file exists by design — after arbitrary push/pull cycles, deleting nothing is possible; instead verify all cursors derive from trailers: `doctor` reports the derived sync points and they match reality.
- [x] S52 Broken mapping (pub trailer referencing a mono sha that doesn't exist locally) → `doctor` detects and reports it clearly.
- [x] S53 Fresh clone of mono in a new directory ("second machine") → `status`/`push`/`pull` work immediately with no state to restore.
- [x] S54 Mono main was rebased/force-pushed (cursor no longer an ancestor of HEAD) → loud error naming the problem; nothing exported.

## Multi-subrepo

- [x] S60 Two subrepos with separate pub remotes → `push` exports each to its own remote only.
- [x] S61 `push core` (named) touches only that subrepo's remote and cursor.
- [x] S62 One mono commit touching both subrepos exports to both pubs, each with only its own subtree.

## Tags

- [x] S70 `monolith tag core v1.0.0` resolves the current mapping and tags the corresponding pub commit; tag visible on pub.
- [x] S71 Tagging when unexported commits exist → warn/refuse (tag would not match mono HEAD).

## Robustness & UX

- [x] S80 Running any command outside a monolith-configured repo → helpful error, exit ≠ 0.
- [x] S81 Invalid config (bad path, missing remote, malformed exclude) → validation errors name the field and file.
- [x] S82 Subrepo `remote` unreachable → clean error surfaced with the git detail, no partial state written.
- [x] S83 A `.gitignore` inside `core/` is exported like any other file; mono root ignores do not leak into pub.
- [x] S84 Unicode filenames and messages survive round-trip export/import.
- [x] S85 `--json` output for `status` is stable and machine-parseable (locks the contract for CI use).
