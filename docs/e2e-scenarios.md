# E2E scenario backlog

Living TDD backlog. Each scenario becomes a black-box test in `test/e2e/` that drives the
built CLI against throwaway git repos (local bare repos as "public" remotes). Check items
off as their tests land. IDs are stable — reference them in commits and test names.

Conventions: **mono** = the private monorepo, **pub** = the public bare remote for a
subrepo, `core/` = the configured subrepo path.

## Init & seeding

- [ ] S01 `init` scaffolds `monolith.config.ts`; running it again is a safe no-op.
- [ ] S02 `seed` (default squash): mono with mixed history → pub gets exactly one "Initial import" commit whose tree equals `core/` subtree; cursor recorded.
- [ ] S03 `seed --full-history`: every mono commit touching `core/` is replayed into pub in order with messages/authors preserved and `Monolith-Source` trailers.
- [ ] S04 `seed` honors `exclude` patterns — excluded files absent from pub tree even though present in mono history.
- [ ] S05 `seed` against a non-empty pub → refuses with guidance (suggest pull/adopt), exit ≠ 0.
- [ ] S06 `seed` when `core/` has no committed files yet → clear error, nothing pushed.

## Push (export)

- [ ] S10 One new mono commit touching `core/` → `push` creates one pub commit: same message, same author, tree = subtree, trailer appended.
- [ ] S11 Commits touching only private dirs (`website/`) are not exported.
- [ ] S12 A commit spanning `core/` + private dirs exports with only the `core/` subtree (private paths never in pub objects).
- [ ] S13 Multiple pending commits export in order; pub log order matches mono order.
- [ ] S14 `push` twice → second run is a no-op ("up to date"), zero new pub commits, exit 0.
- [ ] S15 Modifying an excluded file exports nothing; if the commit *only* touched excluded files, no empty pub commit is created (commit skipped).
- [ ] S16 `rewriteMessage` hook in config is applied to exported commit messages.
- [ ] S17 Imported commits (carrying `Monolith-Origin`) are skipped on push — no ping-pong duplicates in pub.
- [ ] S18 Binary files, file deletions, and renames replay correctly (tree equality after each commit).
- [ ] S19 Executable bit and symlinks are preserved in exported trees.
- [ ] S20 Pub has an unimported external commit → `push` refuses, tells user to `monolith pull` first; pub untouched.
- [ ] S21 Secret-scan hook rejects a commit → push aborts *before* any ref update on pub; error names the offending commit/file.
- [ ] S22 `transform` hook mutates the exported tree (e.g., swaps README) without affecting mono.

## Pull (import)

- [ ] S30 External commit in pub → `pull` creates a mono commit placing the tree under `core/`, original author preserved, `Monolith-Origin` trailer added.
- [ ] S31 Multiple upstream commits import in order.
- [ ] S32 `pull` twice → second run is a no-op.
- [ ] S33 Pub commits carrying `Monolith-Source` (our own exports) are skipped on pull.
- [ ] S34 Uncommitted local changes under `core/` → `pull` refuses before touching anything.
- [ ] S35 Conflicting edits (same file changed in mono and pub) → conflict markers in mono working tree, clear instructions, and after manual resolution `sync` completes cleanly.
- [ ] S36 External commit adds a file matching an `exclude` pattern → defined behavior (import + warn), covered by test so the decision is locked in.

## Sync & convergence

- [ ] S40 `sync` = pull then push; from divergence with non-conflicting changes, one command converges both repos.
- [ ] S41 Round-trip fidelity: after any sync, pub HEAD tree is byte-identical to mono `core/` subtree (minus excludes).
- [ ] S42 Stability: push → pull → push → pull produces zero new commits after the first cycle (fixed point reached).
- [ ] S43 Interleaved history (mono and pub alternate commits over several rounds) converges with every commit present exactly once on each side.

## Status, state & doctor

- [ ] S50 `status` reports per-subrepo ahead/behind counts (N unexported, M unimported) and "in sync" when clean.
- [ ] S51 No state file exists by design — after arbitrary push/pull cycles, deleting nothing is possible; instead verify all cursors derive from trailers: `doctor` reports the derived sync points and they match reality.
- [ ] S52 Broken mapping (pub trailer referencing a mono sha that doesn't exist locally) → `doctor` detects and reports it clearly.
- [ ] S53 Fresh clone of mono in a new directory ("second machine") → `status`/`push`/`pull` work immediately with no state to restore.
- [ ] S54 Mono main was rebased/force-pushed (cursor no longer an ancestor of HEAD) → loud error naming the problem; nothing exported.

## Multi-subrepo

- [ ] S60 Two subrepos with separate pub remotes → `push` exports each to its own remote only.
- [ ] S61 `push core` (named) touches only that subrepo's remote and cursor.
- [ ] S62 One mono commit touching both subrepos exports to both pubs, each with only its own subtree.

## Tags

- [ ] S70 `monolith tag core v1.0.0` resolves the current mapping and tags the corresponding pub commit; tag visible on pub.
- [ ] S71 Tagging when unexported commits exist → warn/refuse (tag would not match mono HEAD).

## Robustness & UX

- [ ] S80 Running any command outside a monolith-configured repo → helpful error, exit ≠ 0.
- [ ] S81 Invalid config (bad path, missing remote, malformed exclude) → validation errors name the field and file.
- [ ] S82 Subrepo `remote` unreachable → clean error surfaced with the git detail, no partial state written.
- [ ] S83 A `.gitignore` inside `core/` is exported like any other file; mono root ignores do not leak into pub.
- [ ] S84 Unicode filenames and messages survive round-trip export/import.
- [ ] S85 `--json` output for `status` is stable and machine-parseable (locks the contract for CI use).
