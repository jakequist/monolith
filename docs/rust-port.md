# Rust port — spec of record

monosplice is being rewritten from TypeScript/oclif to Rust (branch `rust`). The `.ts`
sources stay on disk during the port as the behavioral reference — **port behavior and
user-facing wording from them exactly** unless this document says otherwise. The
architecture invariants in CLAUDE.md ("Model B", trailers as source of truth, derived
cursors, plumbing-only export, fail loud, triangular rules) are unchanged and binding.

## Crate layout

Single binary crate, canonical layout. `.rs` files coexist with the legacy `.ts` files in
`src/` until the port lands; never edit the `.ts` files.

- `src/main.rs` — clap parsing + dispatch (flat subcommands, no topics).
- `src/config.rs` — `monosplice.toml` discovery/load/validation (port of `src/config.ts`).
- `src/report.rs` — `Reporter` semantics (port of the reporter parts of `src/lib/ops.ts`
  and `src/lib/base.ts`: collecting reporter, `SubrepoFailure { halt }`, `each_subrepo`).
- `src/ops.rs` — shared per-subrepo ops (rest of `src/lib/ops.ts`).
- `src/core/{git,trailers,paths,filter,hooks,sync_view,exporter,importer,adopt,vendor,release}.rs`
  — 1:1 ports of `src/core/*.ts` (`sync.ts` → `sync_view.rs`; hook execution is new in
  `hooks.rs`).
- `src/commands/{init,status,push,pull,sync,tag,detach,doctor,attach,update}.rs`.
- Unit tests: `#[cfg(test)]` modules in the file they test (port of `test/unit/*`).
- e2e tests: `tests/*.rs` + `tests/common/mod.rs` harness (port of `test/e2e/*`).
  Black-box: run the binary via `env!("CARGO_BIN_EXE_monosplice")`, assert on exit code,
  stdout, stderr, and git state. Never call crate internals from `tests/`.

Dependencies are fixed: clap, clap_complete, serde, serde_json, toml, globset. Do not add
more. Everything else is std. Git is always invoked via `std::process::Command` (system
git), never a library. All code is synchronous.

## Error/exit contract (matches oclif behavior tests rely on)

- `fail(msg)` / `this.error(msg)` → print to **stderr** as `Error: <msg>` (multi-line
  messages keep their newlines; no `›` gutter, no wrapping), exit code **2**.
- Places the TS passes `{exit: 1}` keep exit **1**: `doctor` with problems,
  `status --check` failure, and the collected-failures report at the end of
  `each_subrepo`.
- `warn` → stderr verbatim (no prefix beyond what the message carries). stdout stays
  pipeable exactly as in TS (e.g. `status` notes and `offline:` banner go to stderr).
- Unknown subcommand / bad flags: clap's own message + exit 2 (`clap` default for parse
  errors is 2 — keep it).

## Config: `monosplice.toml` (replaces `monosplice.config.{ts,js,...}`)

Discovery walks up from cwd looking for `monosplice.toml`; the directory containing it is
the project root. If a directory contains a legacy `monosplice.config.{ts,mts,js,mjs,cjs}`
and **no** `monosplice.toml`, stop and error with migration guidance (name the legacy file
found, say monosplice is now configured by `monosplice.toml`, and point at
`docs/reference.md`'s migration section). If a directory has both, the TOML wins silently
(the legacy file is presumed mid-migration). `MultipleConfigsError` disappears (one
filename now).

Format (kebab-case keys, `deny_unknown_fields` so typos are caught):

```toml
[[subrepos]]
name = "core"              # optional; default = last segment of path
path = "core"              # required; normalized/validated exactly like normalizeSubrepoPath
remote = "git@..."         # required; with upstream set, this is the fork (push target)
upstream = "git@..."       # optional; triangular mode
branch = "main"            # optional; default "main"
push-branch = "patches"    # optional; requires upstream; default = branch
exclude = ["**/*.secret"]  # optional; globset globs, dotfiles matched (picomatch dot:true parity)
rewrite-message = "cmd"    # optional shell hook, see below
transform = "cmd"          # optional shell hook
scan = "cmd"               # optional shell hook
```

Validation ports 1:1 from `resolveConfig`: path normalization errors, `push-branch`
requires `upstream` (same wording, with the key spelled `push-branch`), `upstream == remote`
refusal, duplicate names/paths, path nesting refusal. Error rendering mirrors
`ConfigError`: `Invalid config at <path>:\n  <field> — <detail>` with TOML-ish field paths
(`subrepos[2].path`).

`init` writes a commented `monosplice.toml` template (same guidance the JS template gives,
minus the TypeScript notes).

## Hooks are shell commands now (the one capability change)

The TS config carried JS functions (`rewriteMessage`, `transform`, `scan`). A Rust binary
cannot execute those, so hooks are shell commands, run via `sh -c <cmd>` from the project
root, per exported commit, with env:

- `MONOSPLICE_SUBREPO` — subrepo name
- `MONOSPLICE_MONO_SHA` — monorepo commit being exported
- `MONOSPLICE_MESSAGE_FILE` — path to a temp file holding the original (pre-rewrite)
  full commit message

Contracts:

- `rewrite-message`: original message on **stdin**, rewritten message expected on
  **stdout**. Non-zero exit → `HookError`. Trailers are appended after it runs (as today).
- `transform` and `scan`: monosplice materializes the outgoing (post-exclude) tree into a
  temp dir — blob contents with exec bit per git mode, symlinks as symlinks, gitlink
  entries NOT materialized (passed through untouched, exactly like the TS FileMap path) —
  and runs the hook with that dir as cwd.
  - `scan` runs first: non-zero exit → `HookError` carrying the hook's stderr (trimmed) as
    detail; the export run aborts before anything is pushed (same all-or-nothing rule).
  - `transform` may add/modify/delete files in the dir; on exit 0 the dir is re-hashed
    (mode from the filesystem: 100755 iff exec bit, symlinks → 120000, else 100644) and
    that tree is what exports. Non-zero exit → `HookError`.
- `HookError` message format matches TS: `<hook> hook rejected <subrepo> commit <sha>: <detail>`.
- Hooks only run when configured; the no-hook path must stay pure object-db (`ls-tree
  -d`/`mktree`), no temp dirs.
- Determinism stays the hook author's responsibility (documented, as today).

`filteredSubtree`'s exclude-only path keeps using in-memory tree filtering (globset over
`ls-tree -r` entries + `mktree`), no materialization.

## JSON contracts (byte-compatible with TS)

`status --json` and `doctor --json` keep the **exact** key sets and camelCase spellings
(`pullInProgress`, `inSync`, `hookError`, `pushBranch`, `lastExportedMono`, ...) — CI pipes
these into jq. Same for optional-key behavior (`hookError` only when set; `offline: true`
only under `--offline`). Serialize with serde field renames; write compact JSON
(`serde_json::to_string`, not pretty) exactly as `JSON.stringify` did.

The pull sequencer file stays `.git/monosplice/pull-state.json` with the same camelCase
schema (`subrepo`, `path`, `current{sha,message,authorName,authorEmail,authorDate}`,
`remaining`, `startHead`, `created`), pretty-printed with 2-space indent + trailing
newline (a TS-written sequencer must load, and doctor prints its path).

## Command surface

Same ten commands, flat: `init`, `status`, `push`, `pull`, `sync`, `tag`, `attach`,
`detach`, `doctor`, `update`, plus new `completion <shell>` (clap_complete; bash/zsh/fish)
replacing oclif autocomplete. Flags, args, defaults, prompts (`[y/N]` TTY first-publish
confirmation; refusal wording when not a TTY), dry-run wording, and all user-facing
messages port verbatim — except messages that name `monosplice.config.ts`/`.js`, which now
name `monosplice.toml`, and hook names `rewriteMessage`/`transform`/`scan` in prose become
`rewrite-message`/`transform`/`scan`.

`attach`/`detach` config editing (`vendor.rs`): same append-then-verify /
remove-then-verify bargain as the TS, but on TOML — append a rendered `[[subrepos]]` block
(fields omitted when they equal loader defaults, same as `renderSubrepoEntry`) at the end
of the file (with a separating blank line), reload through the real loader, and revert +
`pasteItYourself` on any mismatch. Removal textually cuts the matching `[[subrepos]]`
block (from its header line to the next `[[`-header or EOF), refuses when zero or several
match or when an entry's name/path can't be read from plain TOML, verifies by reload,
reverts on mismatch. Rendered entry style:

```toml
[[subrepos]]
path = "vendor/lodash"
remote = "git@github.com:lodash/lodash.git"
```

`update`: npm is no longer the mechanism. `update --check` asks the GitHub Releases API
(`release.rs` consts port over; latest via `https://api.github.com/repos/jakequist/monosplice/releases/latest`,
`tag_name` → version, `versionFromTag` semantics + unit test) using `curl -fsSL` with a
10s timeout; compare against `env!("CARGO_PKG_VERSION")`. `update` (no flag): refuse when
running from a source checkout (a `.git` directory next to the binary's ancestor manifest —
port the spirit: detect `CARGO_MANIFEST_DIR`-style dev builds by checking for a `.git`
sibling of the executable's grandparent, or the executable living under a `target/` dir),
otherwise download the release asset for the current target triple
(`monosplice-<version>-<target>.tar.gz`, single `monosplice` binary inside), unpack to a
temp file via `tar`, and atomically rename over `std::env::current_exe()`; on permission
failure, name the exact `curl | sh` reinstall command. No curl on PATH → error pointing at
the releases page. (e2e for update stays minimal, like the TS one: `--check` against an
unreachable registry errors helpfully.)

## e2e harness parity (`tests/common/mod.rs`)

Port `test/e2e/harness.ts` 1:1: `GIT_ENV` (same fixed identities/dates map), `next_date()`
(same base timestamp, +61s, process-global atomic counter), `sandbox()` (tempdir under
std::env::temp_dir, removed on drop via a guard struct), `TestRepo` (git/write/rm/read/
exists/commit/head/subjects/messages/authors/tree_entries/tree_sha/file_at),
`run_monosplice(cwd, args, env)` → `RunResult { stdout, stderr, exit_code }` (never
panics on non-zero), `make_repo`, `make_bare_remote`, `deny_pushes` (same
receive.maxInputSize poisoning trick), `clone_remote`, `write_config` (writes
`monosplice.toml` now; entries given as TOML block strings or built from fields),
`standard_fixture`, `multi_fixture`. Run the binary directly (`CARGO_BIN_EXE_monosplice`),
env = GIT_ENV ∪ overrides.

Scenario IDs (`S10`, ...) stay in test names/comments so `docs/e2e-scenarios.md` keeps
meaning. Tests that exercised JS function hooks port to shell hooks asserting the same
outcomes (e.g. a `scan` that greps for a secret and exits 1; a `transform` that rewrites a
file). Tests asserting config-file contents (`attach` writes an entry, S165 init) assert
the TOML equivalents.

## Style

- Small modules, pure functions where possible; command modules stay thin over `core`.
- Error messages are written for the user at the terminal: what happened, why monosplice
  stopped, exact next command. Port them verbatim.
- Comments only for non-obvious constraints (the TS files' load-bearing comments are worth
  carrying over where the constraint still holds).
- No `unwrap()` on paths that user input can reach; bubble `Result` into the reporter.
- rustfmt defaults; clippy clean (`cargo clippy -- -D warnings` should pass).
