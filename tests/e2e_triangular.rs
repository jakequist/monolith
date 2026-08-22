//! e2e: triangular mode — port of `test/e2e/triangular.test.ts`.
//!
//! The invariant under test (CLAUDE.md): **upstream decides, the fork is disposable**. Every
//! sync decision is made against `upstream` and only upstream; `remote` is the push
//! destination, and monosplice rebuilds its push branch as upstream head + replayed patches
//! on every push. Upstream is never written to — no branch, no tag.
//!
//! Per `docs/rust-port.md` the config is `monosplice.toml` and `pushBranch` is spelled
//! `push-branch`.

mod common;

use common::{
    clone_remote, make_bare_remote, make_repo, run_monosplice, sandbox, standard_fixture,
    subrepo_block, toml_str, write_config, Sandbox, TestRepo,
};

const UP_NAME: &str = "Lo Dash";
const UP_EMAIL: &str = "lodash@example.test";
const EXT_NAME: &str = "Ext Contributor";
const EXT_EMAIL: &str = "ext@example.test";

/// Three repos: upstream (someone else's), our fork, and the monorepo that vendors upstream
/// and pushes patches to the fork.
struct Tri {
    sandbox: Sandbox,
    mono: TestRepo,
    /// Bare repo standing in for the upstream project (never written to by monosplice).
    up_dir: String,
    /// Working clone used to move upstream forward, like a maintainer would.
    up: TestRepo,
    upstream: TestRepo,
    /// Bare repo standing in for our fork (the push destination).
    fork_dir: String,
    fork: TestRepo,
}

#[derive(Default)]
struct TriOpts<'a> {
    push_branch: &'a str,
    /// Overrides for the config entry, e.g. a deliberately broken URL.
    remote: &'a str,
    upstream: &'a str,
}

fn tri_fixture(opts: TriOpts) -> Tri {
    let sb = sandbox();
    let up_dir = make_bare_remote(sb.path(), "lodash");
    let fork_dir = make_bare_remote(sb.path(), "lodash-fork");

    let up = make_repo(sb.path(), "lodash-src");
    up.commit_as(
        "lodash: initial",
        &[
            ("README.md", Some("# lodash\n")),
            ("index.js", Some("module.exports = {}\n")),
        ],
        UP_NAME,
        UP_EMAIL,
    );
    up.commit_as(
        "lodash: add chunk",
        &[("chunk.js", Some("exports.chunk = 1\n"))],
        UP_NAME,
        UP_EMAIL,
    );
    up.git(&["remote", "add", "origin", &up_dir]);
    up.git(&["push", "origin", "main"]);

    let mono = make_repo(sb.path(), "mono");
    let remote = if opts.remote.is_empty() {
        fork_dir.clone()
    } else {
        opts.remote.to_string()
    };
    let upstream_url = if opts.upstream.is_empty() {
        up_dir.clone()
    } else {
        opts.upstream.to_string()
    };
    let mut fields: Vec<(&str, String)> = vec![
        ("name", toml_str("lodash")),
        ("path", toml_str("vendor/lodash")),
        ("remote", toml_str(&remote)),
        ("upstream", toml_str(&upstream_url)),
    ];
    if !opts.push_branch.is_empty() {
        fields.push(("push-branch", toml_str(opts.push_branch)));
    }
    let rendered: Vec<(&str, &str)> = fields.iter().map(|(k, v)| (*k, v.as_str())).collect();
    write_config(&mono, &[&subrepo_block(&rendered)]);
    mono.commit(
        "chore: initial monorepo",
        &[
            ("app/main.ts", Some("export const app = true\n")),
            ("private/secrets.md", Some("internal only\n")),
        ],
    );

    let upstream = TestRepo::new(&up_dir);
    let fork = TestRepo::new(&fork_dir);
    Tri {
        sandbox: sb,
        mono,
        up_dir,
        up,
        upstream,
        fork_dir,
        fork,
    }
}

/// Fixture + url-less `attach`, i.e. the monorepo now tracks upstream at its current head.
fn attached(opts: TriOpts) -> Tri {
    let fx = tri_fixture(opts);
    let res = run_monosplice(&fx.mono.dir, &["attach", "vendor/lodash"]);
    assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);
    fx
}

struct Patched {
    tri: Tri,
    fork_head: String,
    upstream_head: String,
}

/// Attached + one local patch, pushed to the fork branch.
fn patched(opts: TriOpts) -> Patched {
    let push_branch = if opts.push_branch.is_empty() {
        "main".to_string()
    } else {
        opts.push_branch.to_string()
    };
    let fx = attached(opts);
    fx.mono.write(
        "vendor/lodash/index.js",
        "module.exports = {patched: true}\n",
    );
    fx.mono
        .commit("fix(lodash): guard against a null prototype", &[]);

    let res = run_monosplice(&fx.mono.dir, &["push"]);
    assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);
    assert!(
        res.stdout.contains("exported 1 commit(s)"),
        "stdout:\n{}",
        res.stdout
    );

    let fork_head = fx
        .fork
        .git(&["rev-parse", &format!("refs/heads/{push_branch}")]);
    let upstream_head = fx.upstream.git(&["rev-parse", "refs/heads/main"]);
    Patched {
        tri: fx,
        fork_head,
        upstream_head,
    }
}

/// Every ref a bare repo has, as `<sha> <ref>` lines — proof that nothing was written.
fn refs(repo: &TestRepo) -> Vec<String> {
    let out = repo.git(&["for-each-ref", "--format=%(objectname) %(refname)"]);
    if out.is_empty() {
        return Vec::new();
    }
    let mut lines: Vec<String> = out.split('\n').map(str::to_owned).collect();
    lines.sort();
    lines
}

fn first_parents(repo: &TestRepo, r: &str) -> Vec<String> {
    let out = repo.git(&["log", "--first-parent", "--reverse", "--format=%s", r]);
    if out.is_empty() {
        Vec::new()
    } else {
        out.split('\n').map(str::to_owned).collect()
    }
}

/// Keys of the first object inside `"subrepos":[` of a compact JSON document, sorted.
///
/// Hand-rolled: `tests/` may not reach into the crate and carries no JSON dependency, and the
/// payload here is a flat object of strings, numbers and booleans.
fn first_subrepo_keys(json: &str) -> Vec<String> {
    let Some(array) = json.find("\"subrepos\":[") else {
        return Vec::new();
    };
    let body = &json[array..];
    let Some(open) = body.find('{') else {
        return Vec::new();
    };

    let mut keys: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut pending: Option<String> = None;
    let mut in_string = false;
    let mut escaped = false;
    for c in body[open + 1..].chars() {
        if in_string {
            if escaped {
                current.push(c);
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_string = false;
                pending = Some(std::mem::take(&mut current));
            } else {
                current.push(c);
            }
            continue;
        }
        match c {
            '"' => in_string = true,
            ':' => {
                if let Some(key) = pending.take() {
                    keys.push(key);
                }
            }
            '}' => break,
            c if c.is_whitespace() => {}
            _ => pending = None,
        }
    }
    keys.sort();
    keys
}

/// The key set `status --json` publishes for a subrepo (byte-compatible with the TS).
const STATUS_JSON_KEYS: [&str; 9] = [
    "ahead",
    "behind",
    "branch",
    "inSync",
    "name",
    "path",
    "pullInProgress",
    "remote",
    "seeded",
];

// ===========================================================================================
// S110: import decisions come from upstream, never from the fork
// ===========================================================================================

/// S110: upstream commits are pulled while the fork remote is still completely empty.
#[test]
fn s110_pulls_upstream_commits_while_the_fork_remote_is_still_empty() {
    let fx = attached(TriOpts::default());

    fx.up.commit_as(
        "lodash: add map",
        &[("map.js", Some("exports.map = 1\n"))],
        UP_NAME,
        UP_EMAIL,
    );
    fx.up.commit_as(
        "lodash: add zip",
        &[("zip.js", Some("exports.zip = 1\n"))],
        UP_NAME,
        UP_EMAIL,
    );
    fx.up.git(&["push", "origin", "main"]);

    let res = run_monosplice(&fx.mono.dir, &["pull"]);
    assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);
    assert!(
        res.stdout.contains("imported 2 commit(s)"),
        "stdout:\n{}",
        res.stdout
    );

    assert_eq!(
        fx.mono.tree_sha("HEAD", Some("vendor/lodash")),
        fx.upstream.tree_sha("refs/heads/main", None)
    );
    assert!(fx.mono.exists("vendor/lodash/zip.js"));

    // The fork was never touched: no branch there, and no fork tracking ref locally.
    assert!(refs(&fx.fork).is_empty(), "{:?}", refs(&fx.fork));
    assert_ne!(
        fx.mono
            .git_try(&["rev-parse", "--verify", "refs/monosplice/lodash/fork"])
            .exit_code,
        0,
        "a pull must never create a fork tracking ref"
    );

    let again = run_monosplice(&fx.mono.dir, &["pull"]);
    assert_eq!(again.exit_code, 0, "stderr: {}", again.stderr);
    assert!(again.stdout.contains("up to date"), "{}", again.stdout);
}

/// S110: a stale fork branch is not import material — only upstream is consulted.
#[test]
fn s110_ignores_a_stale_fork_branch_when_deciding_what_to_import() {
    let p = patched(TriOpts::default());
    let fx = &p.tri;

    fx.up.commit_as(
        "lodash: add map",
        &[("map.js", Some("exports.map = 1\n"))],
        UP_NAME,
        UP_EMAIL,
    );
    fx.up.git(&["push", "origin", "main"]);

    let res = run_monosplice(&fx.mono.dir, &["pull"]);
    assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);
    // Exactly the one upstream commit — the fork's own patch commit is not import material.
    assert!(
        res.stdout.contains("imported 1 commit(s)"),
        "stdout:\n{}",
        res.stdout
    );
    assert_eq!(fx.fork.git(&["rev-parse", "refs/heads/main"]), p.fork_head);

    assert_eq!(
        fx.mono.read("vendor/lodash/index.js"),
        "module.exports = {patched: true}\n"
    );
    assert!(fx.mono.exists("vendor/lodash/map.js"));
    assert_ne!(
        fx.upstream.git(&["rev-parse", "refs/heads/main"]),
        p.fork_head
    );
}

// ===========================================================================================
// S111: push builds the fork branch on the upstream head
// ===========================================================================================

/// S111: patches are exported to the fork, parented on upstream, leaving upstream untouched.
#[test]
fn s111_exports_patches_to_the_fork_parented_on_upstream() {
    let fx = attached(TriOpts::default());
    let upstream_refs = refs(&fx.upstream);
    let upstream_head = fx.upstream.git(&["rev-parse", "refs/heads/main"]);

    fx.mono.write(
        "vendor/lodash/index.js",
        "module.exports = {patched: true}\n",
    );
    let patch_sha = fx
        .mono
        .commit("fix(lodash): guard against a null prototype", &[]);

    let res = run_monosplice(&fx.mono.dir, &["push"]);
    assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);
    assert!(
        res.stdout.contains("exported 1 commit(s)"),
        "stdout:\n{}",
        res.stdout
    );
    assert!(res.stdout.contains(&fx.fork_dir), "stdout:\n{}", res.stdout);

    // Upstream is never written to.
    assert_eq!(refs(&fx.upstream), upstream_refs);

    let fork_head = fx.fork.git(&["rev-parse", "refs/heads/main"]);
    assert_eq!(
        fx.fork.git(&["rev-parse", "refs/heads/main~1"]),
        upstream_head
    );
    assert_eq!(
        first_parents(&fx.fork, "refs/heads/main"),
        vec![
            "lodash: initial",
            "lodash: add chunk",
            "fix(lodash): guard against a null prototype",
        ]
    );
    assert!(fx
        .fork
        .git(&["log", "-1", "--format=%B", &fork_head])
        .contains(&format!("Monosplice-Source: {patch_sha}")));
    assert_eq!(
        fx.fork.tree_sha(&fork_head, None),
        fx.mono.tree_sha("HEAD", Some("vendor/lodash"))
    );

    // Nothing was pushed to upstream, and a second push is a no-op on the fork.
    let again = run_monosplice(&fx.mono.dir, &["push"]);
    assert_eq!(again.exit_code, 0, "stderr: {}", again.stderr);
    assert!(again.stdout.contains("up to date"), "{}", again.stdout);
    assert_eq!(fx.fork.git(&["rev-parse", "refs/heads/main"]), fork_head);
    assert_eq!(refs(&fx.upstream), upstream_refs);
    assert_ne!(fx.up_dir, fx.fork_dir);
}

/// S111: `push-branch` (the TS `pushBranch`) decides which fork branch is rebuilt.
#[test]
fn s111_honors_push_branch() {
    let fx = attached(TriOpts {
        push_branch: "monosplice/patches",
        ..Default::default()
    });
    fx.mono.write(
        "vendor/lodash/index.js",
        "module.exports = {patched: true}\n",
    );
    fx.mono
        .commit("fix(lodash): guard against a null prototype", &[]);

    let res = run_monosplice(&fx.mono.dir, &["push"]);
    assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);
    assert!(
        res.stdout.contains("monosplice/patches"),
        "stdout:\n{}",
        res.stdout
    );

    let names: Vec<String> = refs(&fx.fork)
        .iter()
        .filter_map(|l| l.split(' ').nth(1).map(str::to_owned))
        .collect();
    assert_eq!(names, vec!["refs/heads/monosplice/patches"]);
    assert_eq!(
        first_parents(&fx.fork, "refs/heads/monosplice/patches"),
        vec![
            "lodash: initial",
            "lodash: add chunk",
            "fix(lodash): guard against a null prototype",
        ]
    );
}

// ===========================================================================================
// S112: upstream advances while local patches exist
// ===========================================================================================

/// S112: `sync` rebuilds the fork branch on the new upstream head with `--force-with-lease`.
///
/// The fork branch is a derived artifact monosplice owns: it is rebuilt, never appended to,
/// which is exactly why the old tip must stop being an ancestor of the new one.
#[test]
fn s112_sync_rebuilds_the_fork_branch_on_the_new_upstream_head() {
    let p = patched(TriOpts::default());
    let fx = &p.tri;
    let old_fork_head = p.fork_head.clone();

    fx.up.commit_as(
        "lodash: upstream tweak",
        &[("chunk.js", Some("exports.chunk = 2\n"))],
        UP_NAME,
        UP_EMAIL,
    );
    fx.up.git(&["push", "origin", "main"]);
    let new_upstream_head = fx.up.git(&["rev-parse", "HEAD"]);

    let res = run_monosplice(&fx.mono.dir, &["sync"]);
    assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);
    // The TS matched /imported 1, exported \d+/; by hand that is the prefix plus a digit.
    assert!(
        res.stdout
            .split("imported 1, exported ")
            .nth(1)
            .is_some_and(|rest| rest.starts_with(|c: char| c.is_ascii_digit())),
        "stdout:\n{}",
        res.stdout
    );

    let fork_head = fx.fork.git(&["rev-parse", "refs/heads/main"]);
    assert_ne!(fork_head, old_fork_head);

    // The old fork tip is gone from the branch: it was rebuilt, not appended to.
    assert_ne!(
        fx.fork
            .git_try(&["merge-base", "--is-ancestor", &old_fork_head, &fork_head])
            .exit_code,
        0,
        "the old fork tip must not survive the rebuild"
    );

    let chain = first_parents(&fx.fork, "refs/heads/main");
    assert_eq!(
        chain.iter().take(3).map(String::as_str).collect::<Vec<_>>(),
        vec![
            "lodash: initial",
            "lodash: add chunk",
            "lodash: upstream tweak",
        ]
    );
    assert!(
        chain
            .iter()
            .any(|s| s == "fix(lodash): guard against a null prototype"),
        "{chain:?}"
    );
    assert_eq!(
        fx.fork.git(&[
            "rev-list",
            "--count",
            &format!("{new_upstream_head}..refs/heads/main"),
        ]),
        chain.len().saturating_sub(3).to_string()
    );
    // Upstream's own commit is the base of the fork branch, and nothing was lost.
    assert!(fx
        .fork
        .git(&[
            "merge-base",
            "--is-ancestor",
            &new_upstream_head,
            &fork_head
        ])
        .is_empty());
    assert_eq!(
        fx.fork.tree_sha(&fork_head, None),
        fx.mono.tree_sha("HEAD", Some("vendor/lodash"))
    );
    assert_eq!(fx.fork.file_at(&fork_head, "chunk.js"), "exports.chunk = 2");
    assert_eq!(
        fx.fork.file_at(&fork_head, "index.js"),
        "module.exports = {patched: true}"
    );
    assert_eq!(
        fx.upstream.git(&["rev-parse", "refs/heads/main"]),
        new_upstream_head
    );

    let settle = run_monosplice(&fx.mono.dir, &["sync"]);
    assert_eq!(settle.exit_code, 0, "stderr: {}", settle.stderr);
    assert!(settle.stdout.contains("up to date"), "{}", settle.stdout);
    assert_eq!(fx.fork.git(&["rev-parse", "refs/heads/main"]), fork_head);
    assert!(!p.upstream_head.is_empty());
}

// ===========================================================================================
// S113: no upstream configured — behavior is unchanged
// ===========================================================================================

/// S113: a plain subrepo still does first push, external commit, pull and a fast-forward push.
#[test]
fn s113_first_push_external_commit_pull_and_a_plain_non_force_push_still_work() {
    let fx = standard_fixture();
    let pub_repo = TestRepo::new(&fx.pub_dir);
    // A force push would be rejected outright, so anything that passes here is fast-forward.
    pub_repo.git(&["config", "receive.denyNonFastForwards", "true"]);

    let first = run_monosplice(&fx.mono.dir, &["push", "core", "--yes"]);
    assert_eq!(first.exit_code, 0, "stderr: {}", first.stderr);
    assert!(
        first.stdout.contains(&format!(
            "✓ core: published core/ to {} (main) — one baseline commit",
            fx.pub_dir
        )),
        "stdout:\n{}",
        first.stdout
    );

    let ext = clone_remote(fx.sandbox.path(), &fx.pub_dir, "ext");
    ext.commit_as(
        "feat: external contribution",
        &[("CONTRIB.md", Some("thanks\n"))],
        EXT_NAME,
        EXT_EMAIL,
    );
    ext.git(&["push", "origin", "main"]);

    // The Rust harness keeps the trailing newline execa stripped, so exact-output assertions
    // compare against `trim_end()`.
    let pull = run_monosplice(&fx.mono.dir, &["pull"]);
    assert_eq!(pull.exit_code, 0, "stderr: {}", pull.stderr);
    assert_eq!(pull.stdout.trim_end(), "✓ core: imported 1 commit(s)");

    fx.mono.commit(
        "feat: local work",
        &[(
            "core/src/index.ts",
            Some("export const hello = () => \"hi\"\n"),
        )],
    );
    let push = run_monosplice(&fx.mono.dir, &["push"]);
    assert_eq!(push.exit_code, 0, "stderr: {}", push.stderr);
    assert_eq!(push.stdout.trim_end(), "✓ core: exported 1 commit(s)");

    let status = run_monosplice(&fx.mono.dir, &["status"]);
    assert_eq!(status.exit_code, 0, "stderr: {}", status.stderr);
    assert_eq!(status.stdout.trim_end(), "core: in sync");
    assert!(!status.stdout.contains("awaiting"), "{}", status.stdout);

    let json = run_monosplice(&fx.mono.dir, &["status", "--json"]);
    assert_eq!(json.exit_code, 0, "stderr: {}", json.stderr);
    assert_eq!(first_subrepo_keys(&json.stdout), STATUS_JSON_KEYS.to_vec());

    // No fork machinery anywhere near a plain subrepo.
    assert_ne!(
        fx.mono
            .git_try(&["rev-parse", "--verify", "refs/monosplice/core/fork"])
            .exit_code,
        0,
        "a plain subrepo has no fork ref"
    );
    assert_eq!(
        pub_repo.tree_sha("refs/heads/main", None),
        fx.mono.tree_sha("HEAD", Some("core"))
    );
}

// ===========================================================================================
// S114: unreachable upstream vs unreachable fork
// ===========================================================================================

/// S114: an unreachable upstream is blamed on the upstream URL, never on the fork.
#[test]
fn s114_blames_the_upstream_url_when_upstream_is_unreachable() {
    let fx = attached(TriOpts::default());
    let missing = format!("{}/nope-upstream.git", fx.sandbox.path().display());
    write_config(
        &fx.mono,
        &[&subrepo_block(&[
            ("name", &toml_str("lodash")),
            ("path", &toml_str("vendor/lodash")),
            ("remote", &toml_str(&fx.fork_dir)),
            ("upstream", &toml_str(&missing)),
        ])],
    );

    for args in [["status"], ["pull"], ["push"], ["doctor"]] {
        let res = run_monosplice(&fx.mono.dir, &args);
        let out = format!("{}\n{}", res.stdout, res.stderr);
        assert_ne!(res.exit_code, 0, "{}: {out}", args[0]);
        assert!(out.contains("cannot reach upstream"), "{}: {out}", args[0]);
        assert!(out.contains(&missing), "{}: {out}", args[0]);
        assert!(!out.contains("fork remote"), "{}: {out}", args[0]);
    }
}

/// S114: an unreachable fork is blamed on the fork URL, and never breaks `pull`.
#[test]
fn s114_blames_the_fork_url_when_only_the_fork_is_unreachable() {
    let fx = attached(TriOpts::default());
    let missing = format!("{}/nope-fork.git", fx.sandbox.path().display());
    write_config(
        &fx.mono,
        &[&subrepo_block(&[
            ("name", &toml_str("lodash")),
            ("path", &toml_str("vendor/lodash")),
            ("remote", &toml_str(&missing)),
            ("upstream", &toml_str(&fx.up_dir)),
        ])],
    );

    // Pull only ever talks to upstream, so an unreachable fork cannot break it.
    fx.up.commit_as(
        "lodash: add map",
        &[("map.js", Some("exports.map = 1\n"))],
        UP_NAME,
        UP_EMAIL,
    );
    fx.up.git(&["push", "origin", "main"]);
    let pull = run_monosplice(&fx.mono.dir, &["pull"]);
    assert_eq!(pull.exit_code, 0, "stderr: {}", pull.stderr);
    assert!(
        pull.stdout.contains("imported 1 commit(s)"),
        "stdout:\n{}",
        pull.stdout
    );

    fx.mono.write(
        "vendor/lodash/index.js",
        "module.exports = {patched: true}\n",
    );
    fx.mono
        .commit("fix(lodash): guard against a null prototype", &[]);

    let push = run_monosplice(&fx.mono.dir, &["push"]);
    let push_out = format!("{}\n{}", push.stdout, push.stderr);
    assert_ne!(push.exit_code, 0, "stdout: {}", push.stdout);
    assert!(push_out.contains("fork"), "{push_out}");
    assert!(push_out.contains(&missing), "{push_out}");
    assert!(!push_out.contains("cannot reach upstream"), "{push_out}");

    let doctor = run_monosplice(&fx.mono.dir, &["doctor"]);
    let doctor_out = format!("{}\n{}", doctor.stdout, doctor.stderr);
    assert_ne!(doctor.exit_code, 0, "stdout: {}", doctor.stdout);
    assert!(
        doctor_out.contains("cannot reach fork remote"),
        "{doctor_out}"
    );
    assert!(doctor_out.contains(&missing), "{doctor_out}");
    assert!(
        !doctor_out.contains("cannot reach upstream"),
        "{doctor_out}"
    );

    // status still answers, measured against upstream, and says which side it could not see.
    let status = run_monosplice(&fx.mono.dir, &["status"]);
    assert_eq!(status.exit_code, 0, "stderr: {}", status.stderr);
    assert!(status.stdout.contains("1 to push"), "{}", status.stdout);
    // The counts are status data (stdout); "I could not see the fork" is a diagnostic (stderr).
    assert!(
        !status.stdout.contains("cannot reach fork"),
        "{}",
        status.stdout
    );
    assert!(
        status.stderr.contains("cannot reach fork"),
        "{}",
        status.stderr
    );
}

// ===========================================================================================
// S138: attach --fork
// ===========================================================================================

/// S138: `--fork` writes upstream + fork into the config, pulls upstream, pushes to the fork.
#[test]
fn s138_writes_upstream_and_fork_into_the_config_and_pulls_upstream() {
    let sb = sandbox();
    let up_dir = make_bare_remote(sb.path(), "lodash");
    let fork_dir = make_bare_remote(sb.path(), "lodash-fork");
    let up = make_repo(sb.path(), "lodash-src");
    up.commit_as(
        "lodash: initial",
        &[
            ("README.md", Some("# lodash\n")),
            ("index.js", Some("module.exports = {}\n")),
        ],
        UP_NAME,
        UP_EMAIL,
    );
    up.commit_as(
        "lodash: add chunk",
        &[("chunk.js", Some("exports.chunk = 1\n"))],
        UP_NAME,
        UP_EMAIL,
    );
    up.git(&["remote", "add", "origin", &up_dir]);
    up.git(&["push", "origin", "main"]);

    let mono = make_repo(sb.path(), "mono");
    write_config(&mono, &[]);
    mono.commit(
        "chore: initial monorepo",
        &[("app/main.ts", Some("export const app = true\n"))],
    );

    let upstream = TestRepo::new(&up_dir);
    let fork = TestRepo::new(&fork_dir);
    let upstream_refs = refs(&upstream);

    let res = run_monosplice(
        &mono.dir,
        &["attach", "vendor/lodash", &up_dir, "--fork", &fork_dir],
    );
    assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);
    assert!(
        res.stdout.contains("✓ attached lodash at vendor/lodash"),
        "stdout:\n{}",
        res.stdout
    );
    assert!(res.stdout.contains(&up_dir), "stdout:\n{}", res.stdout);
    assert!(res.stdout.contains(&fork_dir), "stdout:\n{}", res.stdout);
    // The fork is never probed for write access: a triangular subrepo says outright that
    // the fork is the push destination.
    assert!(res.stderr.is_empty(), "stderr:\n{}", res.stderr);

    let config = mono.read("monosplice.toml");
    assert!(
        config.contains(&format!("remote = {}", toml_str(&fork_dir))),
        "config:\n{config}"
    );
    assert!(
        config.contains(&format!("upstream = {}", toml_str(&up_dir))),
        "config:\n{config}"
    );
    // `push-branch` equals `branch`, so `render_subrepo_entry` leaves it out.
    assert!(!config.contains("push-branch"), "config:\n{config}");

    // The vendored tree came from upstream, and the anchor commit names upstream.
    assert_eq!(
        mono.tree_sha("HEAD", Some("vendor/lodash")),
        upstream.tree_sha("refs/heads/main", None)
    );
    let messages = mono.messages("HEAD");
    let upstream_head = upstream.git(&["rev-parse", "refs/heads/main"]);
    let trailer = format!("Monosplice-Origin: {upstream_head}");
    assert!(
        messages.last().is_some_and(|m| m.contains(&trailer)),
        "{messages:?}"
    );
    assert!(
        messages.last().is_some_and(|m| m.contains(&up_dir)),
        "{messages:?}"
    );

    let status = run_monosplice(&mono.dir, &["status"]);
    assert_eq!(status.exit_code, 0, "stderr: {}", status.stderr);
    assert!(
        status.stdout.contains("lodash: in sync"),
        "{}",
        status.stdout
    );
    let pull = run_monosplice(&mono.dir, &["pull"]);
    assert_eq!(pull.exit_code, 0, "stderr: {}", pull.stderr);
    assert!(pull.stdout.contains("up to date"), "{}", pull.stdout);
    assert!(refs(&fork).is_empty(), "{:?}", refs(&fork));

    mono.write(
        "vendor/lodash/index.js",
        "module.exports = {patched: true}\n",
    );
    mono.commit("fix(lodash): guard against a null prototype", &[]);
    let push = run_monosplice(&mono.dir, &["push"]);
    assert_eq!(push.exit_code, 0, "stderr: {}", push.stderr);
    assert!(
        push.stdout.contains("exported 1 commit(s)"),
        "stdout:\n{}",
        push.stdout
    );
    assert_eq!(refs(&upstream), upstream_refs);
    assert_eq!(
        fork.tree_sha("refs/heads/main", None),
        mono.tree_sha("HEAD", Some("vendor/lodash"))
    );
}

/// S138: a subrepo with an upstream cannot be tagged — the fork branch is not a release.
#[test]
fn s138_refuses_to_tag_a_subrepo_that_has_an_upstream() {
    let p = patched(TriOpts::default());
    let res = run_monosplice(&p.tri.mono.dir, &["tag", "lodash", "v1.0.0"]);
    assert_ne!(res.exit_code, 0, "stdout: {}", res.stdout);
    let out = format!("{}\n{}", res.stdout, res.stderr);
    assert!(out.contains("upstream"), "{out}");
    assert!(out.contains(&p.tri.fork_dir), "{out}");
}

// ===========================================================================================
// S116: the PR is merged upstream as a fast-forward
// ===========================================================================================

/// S116: once upstream fast-forwards onto our patches, everything is a fixed point.
#[test]
fn s116_pull_is_a_no_op_push_reports_up_to_date_and_the_fixed_point_holds() {
    let p = patched(TriOpts::default());
    let fx = &p.tri;

    // The maintainer merges our fork branch: the exported commits land in upstream verbatim.
    fx.up.git(&["fetch", &fx.fork_dir, "main"]);
    fx.up.git(&["merge", "--ff-only", "FETCH_HEAD"]);
    fx.up.git(&["push", "origin", "main"]);
    assert_eq!(
        fx.upstream.git(&["rev-parse", "refs/heads/main"]),
        p.fork_head
    );

    let pull = run_monosplice(&fx.mono.dir, &["pull"]);
    assert_eq!(pull.exit_code, 0, "stderr: {}", pull.stderr);
    assert!(pull.stdout.contains("up to date"), "{}", pull.stdout);

    let push = run_monosplice(&fx.mono.dir, &["push"]);
    assert_eq!(push.exit_code, 0, "stderr: {}", push.stderr);
    assert!(push.stdout.contains("up to date"), "{}", push.stdout);

    let status = run_monosplice(&fx.mono.dir, &["status"]);
    assert_eq!(status.exit_code, 0, "stderr: {}", status.stderr);
    assert!(
        status.stdout.contains("lodash: in sync"),
        "{}",
        status.stdout
    );

    let sync = run_monosplice(&fx.mono.dir, &["sync"]);
    assert_eq!(sync.exit_code, 0, "stderr: {}", sync.stderr);
    assert!(sync.stdout.contains("up to date"), "{}", sync.stdout);

    assert_eq!(
        fx.upstream.git(&["rev-parse", "refs/heads/main"]),
        p.fork_head
    );
    assert_eq!(fx.fork.git(&["rev-parse", "refs/heads/main"]), p.fork_head);
    assert_eq!(
        fx.mono.tree_sha("HEAD", Some("vendor/lodash")),
        fx.upstream.tree_sha("refs/heads/main", None)
    );
}

// ===========================================================================================
// S117: the PR is squash-merged upstream
// ===========================================================================================

/// S117: a squash merge is imported once, and both sides then stay put.
#[test]
fn s117_imports_the_squash_commit_and_then_stays_up_to_date_on_both_sides() {
    let p = patched(TriOpts::default());
    let fx = &p.tri;
    let mono_commits_before = fx.mono.subjects("HEAD").len();

    // A squash merge: one brand-new upstream commit with our tree and none of our trailers.
    fx.up.git(&["fetch", &fx.fork_dir, "main"]);
    let tree = fx.up.git(&["rev-parse", "FETCH_HEAD^{tree}"]);
    let squash = fx.up.git(&[
        "commit-tree",
        &tree,
        "-p",
        "HEAD",
        "-m",
        "Guard against a null prototype (#42)",
    ]);
    fx.up.git(&["reset", "--hard", &squash]);
    fx.up.git(&["push", "origin", "main"]);
    let upstream_head = fx.upstream.git(&["rev-parse", "refs/heads/main"]);
    assert!(!fx
        .up
        .git(&["log", "-1", "--format=%B", "HEAD"])
        .contains("Monosplice-"));

    let pull = run_monosplice(&fx.mono.dir, &["pull"]);
    assert_eq!(pull.exit_code, 0, "stderr: {}", pull.stderr);
    assert!(
        pull.stdout.contains("imported 1 commit(s)"),
        "stdout:\n{}",
        pull.stdout
    );
    assert_eq!(fx.mono.subjects("HEAD").len(), mono_commits_before + 1);
    let messages = fx.mono.messages("HEAD");
    let trailer = format!("Monosplice-Origin: {upstream_head}");
    assert!(
        messages.last().is_some_and(|m| m.contains(&trailer)),
        "{messages:?}"
    );
    assert_eq!(
        fx.mono.tree_sha("HEAD", Some("vendor/lodash")),
        fx.upstream.tree_sha("refs/heads/main", None)
    );

    let push = run_monosplice(&fx.mono.dir, &["push"]);
    assert_eq!(push.exit_code, 0, "stderr: {}", push.stderr);
    assert!(push.stdout.contains("up to date"), "{}", push.stdout);

    // Neither remote moved, and the whole thing is a fixed point.
    assert_eq!(
        fx.upstream.git(&["rev-parse", "refs/heads/main"]),
        upstream_head
    );
    assert_eq!(fx.fork.git(&["rev-parse", "refs/heads/main"]), p.fork_head);

    let sync = run_monosplice(&fx.mono.dir, &["sync"]);
    assert_eq!(sync.exit_code, 0, "stderr: {}", sync.stderr);
    assert!(sync.stdout.contains("up to date"), "{}", sync.stdout);
    assert_eq!(
        fx.upstream.git(&["rev-parse", "refs/heads/main"]),
        upstream_head
    );
    assert_eq!(fx.fork.git(&["rev-parse", "refs/heads/main"]), p.fork_head);

    let status = run_monosplice(&fx.mono.dir, &["status"]);
    assert_eq!(status.exit_code, 0, "stderr: {}", status.stderr);
    assert!(
        status.stdout.contains("lodash: in sync"),
        "{}",
        status.stdout
    );
}

// ===========================================================================================
// S118: status and doctor with an upstream
// ===========================================================================================

/// S118: ahead/behind are measured against upstream, and both remotes are reported.
#[test]
fn s118_measures_ahead_behind_against_upstream_and_reports_both_remotes() {
    let fx = attached(TriOpts::default());

    fx.mono.write(
        "vendor/lodash/index.js",
        "module.exports = {patched: true}\n",
    );
    fx.mono
        .commit("fix(lodash): guard against a null prototype", &[]);

    // Before the fork has them: a plain "to push".
    let status = run_monosplice(&fx.mono.dir, &["status"]);
    assert_eq!(status.exit_code, 0, "stderr: {}", status.stderr);
    assert!(
        status.stdout.contains("lodash: 1 to push"),
        "{}",
        status.stdout
    );
    assert!(!status.stdout.contains("awaiting"), "{}", status.stdout);

    let json = run_monosplice(&fx.mono.dir, &["status", "--json"]);
    assert_eq!(json.exit_code, 0, "stderr: {}", json.stderr);
    assert_eq!(first_subrepo_keys(&json.stdout), STATUS_JSON_KEYS.to_vec());
    for fragment in [
        "\"ahead\":1".to_string(),
        "\"behind\":0".to_string(),
        format!("\"remote\":\"{}\"", fx.fork_dir),
    ] {
        assert!(
            json.stdout.contains(&fragment),
            "status --json must carry {fragment}, got:\n{}",
            json.stdout
        );
    }

    let push = run_monosplice(&fx.mono.dir, &["push"]);
    assert_eq!(push.exit_code, 0, "stderr: {}", push.stderr);

    // Once the fork carries them, the count is waiting on the maintainer, not on us.
    let status = run_monosplice(&fx.mono.dir, &["status"]);
    assert_eq!(status.exit_code, 0, "stderr: {}", status.stderr);
    assert!(
        status
            .stdout
            .contains("1 to push (awaiting upstream merge)"),
        "{}",
        status.stdout
    );

    fx.up.commit_as(
        "lodash: add map",
        &[("map.js", Some("exports.map = 1\n"))],
        UP_NAME,
        UP_EMAIL,
    );
    fx.up.git(&["push", "origin", "main"]);

    // Upstream moved, so the fork branch no longer matches what push would build: the note
    // drops and the honest report is "pull first, then I will rebuild your branch".
    let status = run_monosplice(&fx.mono.dir, &["status"]);
    assert_eq!(status.exit_code, 0, "stderr: {}", status.stderr);
    assert!(
        status.stdout.contains("lodash: 1 to push, 1 to pull"),
        "{}",
        status.stdout
    );
    assert!(!status.stdout.contains("awaiting"), "{}", status.stdout);

    let json = run_monosplice(&fx.mono.dir, &["status", "--json"]);
    assert_eq!(json.exit_code, 0, "stderr: {}", json.stderr);
    for fragment in ["\"ahead\":1", "\"behind\":1", "\"inSync\":false"] {
        assert!(
            json.stdout.contains(fragment),
            "status --json must carry {fragment}, got:\n{}",
            json.stdout
        );
    }

    let doctor = run_monosplice(&fx.mono.dir, &["doctor"]);
    assert_eq!(doctor.exit_code, 0, "stderr: {}", doctor.stderr);
    for fragment in [
        "upstream:",
        fx.up_dir.as_str(),
        fx.fork_dir.as_str(),
        "fork head:",
        "to push: 1, to pull: 1",
        "✓ all checks passed",
    ] {
        assert!(
            doctor.stdout.contains(fragment),
            "doctor must report {fragment}, got:\n{}",
            doctor.stdout
        );
    }
}
