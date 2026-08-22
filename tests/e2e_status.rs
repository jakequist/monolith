//! e2e: `monosplice status` — port of `test/e2e/status.test.ts`.
//!
//! Adapted per `docs/rust-port.md`: the config is `monosplice.toml`, and the hook that made
//! `status` report a rejected export is a `scan` **shell command** now, so the scenario greps
//! the materialized tree for a secret and exits 1 instead of throwing from JavaScript. The
//! `--json` key set (S85) is unchanged — CI pipes it into jq.

mod common;

use std::path::Path;

use serde_json::{json, Value};

use common::{
    clone_remote, run_monosplice, standard_fixture, standard_fixture_extra, subrepo_block,
    toml_str, write_config, Fixture, TestRepo,
};

const EXT_NAME: &str = "Ext Contributor";
const EXT_EMAIL: &str = "ext@example.test";

/// S85: the machine-readable contract. Any accidental rename/addition here fails the test,
/// which is the point — CI consumers pipe this into jq.
const SUBREPO_KEYS: [&str; 9] = [
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

/// A `scan` hook that refuses any outgoing tree carrying a secret, naming the file it found
/// it in — the shell port of the TS `scan: (files) => { … throw … }` fixture.
const SECRET_SCAN: &str = r#"scan = 'hit=$(grep -rl SECRET . || true); if [ -n "$hit" ]; then echo "possible secret in ${hit#./}" >&2; exit 1; fi'"#;

/// Parse a command's stdout as JSON, failing as an assertion rather than a panic.
fn parse_json(label: &str, stdout: &str) -> Value {
    let parsed = serde_json::from_str::<Value>(stdout);
    let problem = parsed.as_ref().err().map(ToString::to_string);
    assert!(
        parsed.is_ok(),
        "{label} must print JSON on stdout ({problem:?}), got:\n{stdout}"
    );
    parsed.unwrap_or(Value::Null)
}

/// Object keys, sorted — the shape assertion `Object.keys(x).sort()` made in the TS.
fn sorted_keys(value: &Value) -> Vec<String> {
    match value.as_object() {
        Some(map) => {
            let mut keys: Vec<String> = map.keys().cloned().collect();
            keys.sort();
            keys
        }
        None => Vec::new(),
    }
}

/// `expect(row).toMatchObject({...})`: the named fields, and nothing said about the rest.
fn assert_matches(row: &Value, expected: &[(&str, Value)]) {
    for (key, want) in expected {
        assert_eq!(&row[*key], want, "row.{key} — whole row: {row}");
    }
}

struct StatusOutput {
    human: String,
    notes: String,
    core: Value,
}

/// Run `status` both ways and check the JSON contract on every call site (S85).
fn status(dir: &Path) -> StatusOutput {
    let human = run_monosplice(dir, &["status"]);
    assert_eq!(human.exit_code, 0, "stderr: {}", human.stderr);

    let json = run_monosplice(dir, &["status", "--json"]);
    assert_eq!(json.exit_code, 0, "stderr: {}", json.stderr);

    let parsed = parse_json("status --json", &json.stdout);
    assert!(
        parsed.get("subrepos").and_then(Value::as_array).is_some(),
        "`subrepos` must be an array, got:\n{}",
        json.stdout
    );
    let core = parsed["subrepos"][0].clone();
    assert_eq!(
        sorted_keys(&core),
        SUBREPO_KEYS,
        "the S85 row key set is a contract, got: {core}"
    );

    // S156: the per-subrepo lines are status data (stdout); `!` annotations are diagnostics
    // (stderr).
    StatusOutput {
        human: human.stdout,
        notes: human.stderr,
        core,
    }
}

struct Seeded {
    fx: Fixture,
    ext: TestRepo,
}

fn seeded_with_external() -> Seeded {
    seeded_with_external_extra("")
}

fn seeded_with_external_extra(config_extra: &str) -> Seeded {
    let fx = standard_fixture_extra(config_extra);
    let res = run_monosplice(&fx.mono.dir, &["push", "core", "--yes"]);
    assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);
    let ext = clone_remote(fx.sandbox.path(), &fx.pub_dir, "ext");
    Seeded { fx, ext }
}

/// S50 / S85: status across the lifecycle.
#[test]
fn s50_reports_ahead_behind_at_every_stage_and_keeps_the_json_contract_stable() {
    let seeded = seeded_with_external();
    let mono = &seeded.fx.mono;
    let ext = &seeded.ext;

    // 1. Fresh seed → in sync.
    let mut s = status(&mono.dir);
    assert!(s.human.contains("core: in sync"), "got:\n{}", s.human);
    assert_matches(
        &s.core,
        &[
            ("name", json!("core")),
            ("path", json!("core")),
            ("remote", json!(seeded.fx.pub_dir)),
            ("branch", json!("main")),
            ("seeded", json!(true)),
            ("ahead", json!(0)),
            ("behind", json!(0)),
            ("inSync", json!(true)),
            ("pullInProgress", json!(false)),
        ],
    );

    // 2. Two local commits → 2 to push.
    mono.commit("feat: one", &[("core/one.txt", Some("1\n"))]);
    mono.commit("feat: two", &[("core/two.txt", Some("2\n"))]);
    s = status(&mono.dir);
    assert!(s.human.contains("core: 2 to push"), "got:\n{}", s.human);
    assert!(!s.human.contains("to pull"), "got:\n{}", s.human);
    assert_matches(
        &s.core,
        &[
            ("ahead", json!(2)),
            ("behind", json!(0)),
            ("inSync", json!(false)),
        ],
    );

    // 3. One external commit → also 1 to pull.
    ext.commit_as(
        "external: drive-by",
        &[("ext.txt", Some("x\n"))],
        EXT_NAME,
        EXT_EMAIL,
    );
    ext.git(&["push", "origin", "main"]);
    s = status(&mono.dir);
    assert!(
        s.human.contains("core: 2 to push, 1 to pull"),
        "got:\n{}",
        s.human
    );
    assert_matches(
        &s.core,
        &[
            ("ahead", json!(2)),
            ("behind", json!(1)),
            ("inSync", json!(false)),
        ],
    );

    // 4. After sync → in sync again.
    let sync = run_monosplice(&mono.dir, &["sync"]);
    assert_eq!(sync.exit_code, 0, "stderr: {}", sync.stderr);
    s = status(&mono.dir);
    assert!(s.human.contains("core: in sync"), "got:\n{}", s.human);
    assert_matches(
        &s.core,
        &[
            ("ahead", json!(0)),
            ("behind", json!(0)),
            ("inSync", json!(true)),
        ],
    );

    // 5. Accuracy: a pure import is a tree no-op on export, so it is NOT "to push".
    ext.git(&["fetch", "origin"]);
    ext.git(&["reset", "--hard", "origin/main"]);
    ext.commit_as(
        "external: second",
        &[("ext2.txt", Some("y\n"))],
        EXT_NAME,
        EXT_EMAIL,
    );
    ext.git(&["push", "origin", "main"]);
    s = status(&mono.dir);
    assert!(s.human.contains("core: 1 to pull"), "got:\n{}", s.human);
    assert_matches(&s.core, &[("ahead", json!(0)), ("behind", json!(1))]);

    let pull = run_monosplice(&mono.dir, &["pull"]);
    assert_eq!(pull.exit_code, 0, "stderr: {}", pull.stderr);
    s = status(&mono.dir);
    assert_matches(
        &s.core,
        &[
            ("ahead", json!(0)),
            ("behind", json!(0)),
            ("inSync", json!(true)),
        ],
    );
    assert!(s.human.contains("core: in sync"), "got:\n{}", s.human);

    let push = run_monosplice(&mono.dir, &["push"]);
    assert_eq!(push.exit_code, 0, "stderr: {}", push.stderr);
    assert!(push.stdout.contains("up to date"), "got:\n{}", push.stdout);
}

/// S50: an unseeded subrepo is reported, not treated as a failure.
#[test]
fn s50_reports_an_unseeded_subrepo_without_failing() {
    let fx = standard_fixture();
    let s = status(&fx.mono.dir);

    assert!(
        s.human.contains("core: not published yet"),
        "got:\n{}",
        s.human
    );
    assert!(
        s.human.contains("monosplice push core --yes"),
        "the report must name the way out, got:\n{}",
        s.human
    );
    assert_matches(
        &s.core,
        &[
            ("name", json!("core")),
            ("remote", json!(fx.pub_dir)),
            ("seeded", json!(false)),
            ("ahead", Value::Null),
            ("behind", Value::Null),
            ("inSync", json!(false)),
            ("pullInProgress", json!(false)),
        ],
    );
}

/// S50: an unreachable remote is an error, not a silent zero.
#[test]
fn s50_errors_when_the_remote_is_unreachable() {
    let seeded = seeded_with_external();
    let mono = &seeded.fx.mono;
    let missing = seeded.fx.sandbox.path().join("nope.git");
    let missing = missing.to_string_lossy().into_owned();
    write_config(
        mono,
        &[&subrepo_block(&[
            ("name", &toml_str("core")),
            ("path", &toml_str("core")),
            ("remote", &toml_str(&missing)),
        ])],
    );

    let res = run_monosplice(&mono.dir, &["status"]);
    assert_ne!(res.exit_code, 0, "stdout: {}", res.stdout);
    assert!(
        res.stderr.contains("nope.git"),
        "the error must name the remote it could not reach, got:\n{}",
        res.stderr
    );
}

/// S85: `--json` prints one object and nothing else.
#[test]
fn s85_prints_only_json_on_stdout_so_it_pipes_into_jq() {
    let seeded = seeded_with_external();
    let res = run_monosplice(&seeded.fx.mono.dir, &["status", "--json"]);
    assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);

    let trimmed = res.stdout.trim();
    assert!(trimmed.starts_with('{'), "got:\n{}", res.stdout);
    assert!(trimmed.ends_with('}'), "got:\n{}", res.stdout);
    for human_only in ["✓", "in sync", "to push"] {
        assert!(
            !res.stdout.contains(human_only),
            "`{human_only}` is human output and may not be on the JSON stdout, got:\n{}",
            res.stdout
        );
    }
    parse_json("status --json", &res.stdout);
}

/// S50: a half-finished import is impossible to miss.
#[test]
fn s50_flags_a_mid_conflict_pull_prominently() {
    let seeded = seeded_with_external();
    let mono = &seeded.fx.mono;

    mono.commit(
        "docs: mono wording",
        &[("core/README.md", Some("# core\n\nmono wording\n"))],
    );
    seeded.ext.commit_as(
        "docs: ext wording",
        &[("README.md", Some("# core\n\next wording\n"))],
        EXT_NAME,
        EXT_EMAIL,
    );
    seeded.ext.git(&["push", "origin", "main"]);

    let conflicted = run_monosplice(&mono.dir, &["pull"]);
    assert_ne!(conflicted.exit_code, 0, "stdout: {}", conflicted.stdout);

    let s = status(&mono.dir);
    assert!(
        s.notes.to_lowercase().contains("pull"),
        "the diagnostic must mention the pull, got:\n{}",
        s.notes
    );
    assert!(
        s.notes.contains("--continue"),
        "the diagnostic must name `--continue`, got:\n{}",
        s.notes
    );
    assert!(
        !s.human.contains("--continue"),
        "stdout stays pipeable, got:\n{}",
        s.human
    );
    assert_matches(&s.core, &[("pullInProgress", json!(true))]);
}

/// S50/S85: a `scan` hook that would reject the pending export is reported, not fatal.
#[test]
fn s50_does_not_crash_when_a_scan_hook_would_reject_the_pending_commits() {
    let seeded = seeded_with_external_extra(SECRET_SCAN);
    let mono = &seeded.fx.mono;
    mono.commit(
        "feat: oops",
        &[(
            "core/config.ts",
            Some("export const token = \"SECRET-abc\"\n"),
        )],
    );

    let human = run_monosplice(&mono.dir, &["status"]);
    assert_eq!(human.exit_code, 0, "stderr: {}", human.stderr);
    assert!(human.stdout.contains("1 to push"), "got:\n{}", human.stdout);
    assert!(
        human.stderr.contains("scan hook rejected"),
        "the diagnostic must name the hook that refused, got:\n{}",
        human.stderr
    );
    assert!(
        human.stderr.contains("possible secret in config.ts"),
        "the diagnostic must carry the hook's own detail, got:\n{}",
        human.stderr
    );

    let json = run_monosplice(&mono.dir, &["status", "--json"]);
    assert_eq!(json.exit_code, 0, "stderr: {}", json.stderr);
    let parsed = parse_json("status --json", &json.stdout);
    let core = &parsed["subrepos"][0];
    assert_eq!(core["ahead"], json!(1), "whole row: {core}");
    let hook_error = core["hookError"].as_str().unwrap_or_default();
    assert!(
        hook_error.contains("scan hook rejected"),
        "hookError must carry the HookError message, got: {core}"
    );
    assert!(
        hook_error.contains("possible secret in config.ts"),
        "hookError must carry the hook's detail, got: {core}"
    );
    // hookError is the only optional key.
    let mut expected: Vec<&str> = SUBREPO_KEYS.to_vec();
    expected.push("hookError");
    expected.sort_unstable();
    assert_eq!(sorted_keys(core), expected, "whole row: {core}");

    // and push really would fail, which is what the warning promised
    let push = run_monosplice(&mono.dir, &["push"]);
    assert_ne!(push.exit_code, 0, "stdout: {}", push.stdout);
}

/// S50: `status <name>` narrows the report; an unknown name is an error.
#[test]
fn s50_accepts_a_subrepo_name_argument() {
    let seeded = seeded_with_external();
    let res = run_monosplice(&seeded.fx.mono.dir, &["status", "core"]);
    assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);
    assert!(res.stdout.contains("core: in sync"), "got:\n{}", res.stdout);

    let unknown = run_monosplice(&seeded.fx.mono.dir, &["status", "nope"]);
    assert_ne!(unknown.exit_code, 0, "stdout: {}", unknown.stdout);
}
