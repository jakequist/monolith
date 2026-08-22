//! e2e: `push --dry-run` / `pull --dry-run` — port of `test/e2e/dryrun.test.ts`.
//!
//! Adapted per `docs/rust-port.md`: config is `monosplice.toml` and the S160 `scan` closure
//! becomes a shell hook. The point of the scenario is unchanged — a dry run reports what would
//! be attempted and never runs the hook, while the real push is still gated by it.

mod common;

use common::{
    clone_remote, run_monosplice, standard_fixture, standard_fixture_extra, Fixture, TestRepo,
};

const EXT_NAME: &str = "Ext Contributor";
const EXT_EMAIL: &str = "ext@example.test";

/// TS: `scan(files) { if (files.has('boom.txt')) throw new Error('scan says no') }`.
/// The hook runs with the materialized outgoing tree as cwd, so "has the file" is `[ -e ]`,
/// and the rejection detail travels on stderr into the `HookError`.
const SCAN_REJECT_BOOM: &str =
    r#"scan = 'if [ -e boom.txt ]; then echo "scan says no" >&2; exit 1; fi'"#;

struct Seeded {
    fixture: Fixture,
    pub_repo: TestRepo,
    ext: TestRepo,
}

fn seeded_with_external() -> Seeded {
    seeded_with_external_extra("")
}

fn seeded_with_external_extra(config_extra: &str) -> Seeded {
    let fixture = standard_fixture_extra(config_extra);
    let res = run_monosplice(&fixture.mono.dir, &["push", "core", "--yes"]);
    assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);
    let ext = clone_remote(fixture.sandbox.path(), &fixture.pub_dir, "ext");
    let pub_repo = TestRepo::new(fixture.pub_dir.as_str());
    Seeded {
        fixture,
        pub_repo,
        ext,
    }
}

fn short(sha: &str) -> &str {
    &sha[..10]
}

/// Trimmed stdout lines that start with one of `prefixes`, in output order.
fn lines_starting_with(stdout: &str, prefixes: &[&str]) -> Vec<String> {
    stdout
        .lines()
        .map(str::trim)
        .filter(|l| prefixes.iter().any(|p| l.starts_with(p)))
        .map(str::to_owned)
        .collect()
}

/// S160: `push --dry-run` lists every pending commit in export order and writes nothing.
#[test]
fn s160_push_dry_run_lists_every_pending_commit_and_writes_nothing() {
    let s = seeded_with_external();
    let mono = &s.fixture.mono;
    let pub_repo = &s.pub_repo;

    let one = mono.commit("feat: one", &[("core/one.txt", Some("1\n"))]);
    let two = mono.commit("feat: two", &[("core/two.txt", Some("2\n"))]);
    mono.commit(
        "chore: website only",
        &[("website/index.html", Some("<p>hi</p>\n"))],
    );

    let mono_head = mono.head();
    let pub_head = pub_repo.head();

    let res = run_monosplice(&mono.dir, &["push", "--dry-run"]);
    assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);
    assert!(
        res.stdout
            .contains("core: 2 to push (dry run — nothing written)"),
        "stdout: {}",
        res.stdout
    );

    let shown = lines_starting_with(&res.stdout, &[short(&one), short(&two)]);
    assert_eq!(
        shown,
        vec![
            format!("{} feat: one", short(&one)),
            format!("{} feat: two", short(&two)),
        ]
    );
    // The private-only commit is not exportable, so it must not be listed.
    assert!(
        !res.stdout.contains("website only"),
        "stdout: {}",
        res.stdout
    );

    // Nothing written: not on the remote, not in the monorepo, not in the work tree.
    assert_eq!(pub_repo.head(), pub_head);
    assert_eq!(mono.head(), mono_head);
    assert_eq!(mono.git(&["status", "--porcelain"]), "");

    // And a real push still moves exactly those commits.
    let real = run_monosplice(&mono.dir, &["push"]);
    assert_eq!(real.exit_code, 0, "stderr: {}", real.stderr);
    assert_eq!(
        pub_repo.subjects("HEAD"),
        vec!["Initial import of core", "feat: one", "feat: two"]
    );
}

/// S160: `push --dry-run` prints the up-to-date line when nothing is pending.
#[test]
fn s160_push_dry_run_prints_the_up_to_date_line_when_nothing_is_pending() {
    let s = seeded_with_external();
    let mono = &s.fixture.mono;
    let pub_head = s.pub_repo.head();

    let res = run_monosplice(&mono.dir, &["push", "--dry-run"]);
    assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);
    assert!(
        res.stdout
            .contains("core: up to date (dry run — nothing written)"),
        "stdout: {}",
        res.stdout
    );
    assert_eq!(s.pub_repo.head(), pub_head);
}

/// S160: `push --dry-run` does not run scan hooks — it reports what would be attempted.
#[test]
fn s160_push_dry_run_does_not_run_scan_hooks() {
    let s = seeded_with_external_extra(SCAN_REJECT_BOOM);
    let mono = &s.fixture.mono;
    let pub_repo = &s.pub_repo;

    mono.commit("feat: boom", &[("core/boom.txt", Some("x\n"))]);
    let pub_head = pub_repo.head();

    let dry = run_monosplice(&mono.dir, &["push", "--dry-run"]);
    assert_eq!(dry.exit_code, 0, "stderr: {}", dry.stderr);
    assert!(
        dry.stdout
            .contains("core: 1 to push (dry run — nothing written)"),
        "stdout: {}",
        dry.stdout
    );
    assert!(
        !format!("{}{}", dry.stdout, dry.stderr).contains("scan says no"),
        "the hook must not run on a dry run, got:\n{}\n{}",
        dry.stdout,
        dry.stderr
    );

    // The real push is still gated by the hook.
    let real = run_monosplice(&mono.dir, &["push"]);
    assert_ne!(real.exit_code, 0, "stdout: {}", real.stdout);
    assert!(
        real.stderr.contains("scan says no"),
        "stderr: {}",
        real.stderr
    );
    assert_eq!(pub_repo.head(), pub_head);
}

/// S160: `push --help` says that hooks still gate the real push.
#[test]
fn s160_push_help_says_hooks_still_gate_the_real_push() {
    let fx = standard_fixture();
    let res = run_monosplice(&fx.mono.dir, &["push", "--help"]);
    assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);
    assert!(res.stdout.contains("--dry-run"), "stdout: {}", res.stdout);
    assert!(
        res.stdout.to_lowercase().contains("hook"),
        "stdout: {}",
        res.stdout
    );
}

/// S160: `push --dry-run` reports an unpublished subrepo as the first publish it would make.
#[test]
fn s160_push_dry_run_reports_an_unpublished_subrepo_as_a_first_publish() {
    let fx = standard_fixture();
    let pub_repo = TestRepo::new(fx.pub_dir.as_str());

    let res = run_monosplice(&fx.mono.dir, &["push", "--dry-run"]);
    assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);
    assert!(
        res.stdout.contains("dry run — nothing written"),
        "stdout: {}",
        res.stdout
    );
    assert!(
        res.stdout.to_lowercase().contains("first"),
        "stdout: {}",
        res.stdout
    );
    assert_eq!(pub_repo.git(&["for-each-ref", "refs/heads"]), "");
}

/// S160: `pull --dry-run` lists every incoming commit in import order and writes nothing.
#[test]
fn s160_pull_dry_run_lists_every_incoming_commit_and_writes_nothing() {
    let s = seeded_with_external();
    let mono = &s.fixture.mono;

    let one = s.ext.commit_as(
        "external: one",
        &[("e1.txt", Some("1\n"))],
        EXT_NAME,
        EXT_EMAIL,
    );
    let two = s.ext.commit_as(
        "external: two",
        &[("e2.txt", Some("2\n"))],
        EXT_NAME,
        EXT_EMAIL,
    );
    s.ext.git(&["push", "origin", "main"]);

    let mono_head = mono.head();

    let res = run_monosplice(&mono.dir, &["pull", "--dry-run"]);
    assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);
    assert!(
        res.stdout
            .contains("core: 2 to pull (dry run — nothing written)"),
        "stdout: {}",
        res.stdout
    );

    let shown = lines_starting_with(&res.stdout, &[short(&one), short(&two)]);
    assert_eq!(
        shown,
        vec![
            format!("{} external: one", short(&one)),
            format!("{} external: two", short(&two)),
        ]
    );

    assert_eq!(mono.head(), mono_head);
    assert_eq!(mono.git(&["status", "--porcelain"]), "");
    assert!(!mono.exists("core/e1.txt"));

    let real = run_monosplice(&mono.dir, &["pull"]);
    assert_eq!(real.exit_code, 0, "stderr: {}", real.stderr);
    let subjects = mono.subjects("HEAD");
    assert!(subjects.len() >= 2, "subjects: {subjects:?}");
    assert_eq!(
        subjects[subjects.len() - 2..],
        ["external: one", "external: two"]
    );
}

/// S160: `pull --dry-run` prints the up-to-date line when nothing is incoming.
#[test]
fn s160_pull_dry_run_prints_the_up_to_date_line_when_nothing_is_incoming() {
    let s = seeded_with_external();
    let res = run_monosplice(&s.fixture.mono.dir, &["pull", "--dry-run"]);
    assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);
    assert!(
        res.stdout
            .contains("core: up to date (dry run — nothing written)"),
        "stdout: {}",
        res.stdout
    );
}

/// S160: `pull --dry-run` refuses to combine with `--continue` or `--abort`.
#[test]
fn s160_pull_dry_run_refuses_to_combine_with_continue_or_abort() {
    let s = seeded_with_external();
    let mono = &s.fixture.mono;

    for flag in ["--continue", "--abort"] {
        let res = run_monosplice(&mono.dir, &["pull", "--dry-run", flag]);
        assert_ne!(res.exit_code, 0, "{flag}: {}", res.stdout);
        assert!(res.stderr.contains("--dry-run"), "{flag}: {}", res.stderr);
    }
}
