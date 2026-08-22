//! e2e: `monosplice doctor` — port of `test/e2e/doctor.test.ts`.
//!
//! The theme is Model B: there is no state file, so every cursor `doctor` reports is derived
//! from trailers and has to match reality. Adapted per `docs/rust-port.md` only where the
//! config file is named (`monosplice.toml`).

mod common;

use std::path::Path;

use common::{clone_remote, run_monosplice, standard_fixture, Fixture, TestRepo};

const CONFIG: &str = "monosplice.toml";
const EXT_NAME: &str = "Ext Contributor";
const EXT_EMAIL: &str = "ext@example.test";

struct Seeded {
    fx: Fixture,
    pub_repo: TestRepo,
    ext: TestRepo,
}

fn seeded_with_external() -> Seeded {
    let fx = standard_fixture();
    let res = run_monosplice(&fx.mono.dir, &["push", "core", "--yes"]);
    assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);
    let ext = clone_remote(fx.sandbox.path(), &fx.pub_dir, "ext");
    let pub_repo = TestRepo::new(&fx.pub_dir);
    Seeded { fx, pub_repo, ext }
}

/// Run a command that must succeed, carrying its stderr into the failure message.
fn run_ok(dir: &Path, args: &[&str]) {
    let res = run_monosplice(dir, args);
    assert_eq!(
        res.exit_code,
        0,
        "`monosplice {}` failed: {}",
        args.join(" "),
        res.stderr
    );
}

/// Every tracked-or-untracked file in the work tree, ignoring `.git`.
fn work_tree_files(dir: &Path, prefix: &str, out: &mut Vec<String>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if name == ".git" {
            continue;
        }
        let rel = if prefix.is_empty() {
            name
        } else {
            format!("{prefix}/{name}")
        };
        let path = entry.path();
        if path.is_dir() {
            work_tree_files(&path, &rel, out);
        } else {
            out.push(rel);
        }
    }
}

/// S51: cursors derive from trailers, not from state on disk.
#[test]
fn s51_reports_the_derived_sync_points_and_passes_after_several_push_pull_cycles() {
    let seeded = seeded_with_external();
    let mono = &seeded.fx.mono;
    let ext = &seeded.ext;

    mono.commit("feat: one", &[("core/one.txt", Some("1\n"))]);
    run_ok(&mono.dir, &["push"]);

    ext.git(&["fetch", "origin"]);
    ext.git(&["reset", "--hard", "origin/main"]);
    ext.commit_as(
        "external: two",
        &[("two.txt", Some("2\n"))],
        EXT_NAME,
        EXT_EMAIL,
    );
    ext.git(&["push", "origin", "main"]);
    run_ok(&mono.dir, &["pull"]);

    mono.commit("feat: three", &[("core/three.txt", Some("3\n"))]);
    run_ok(&mono.dir, &["push"]);

    let mono_head = mono.head();
    let pub_head = seeded.pub_repo.head();

    let doc = run_monosplice(&mono.dir, &["doctor"]);
    assert_eq!(doc.exit_code, 0, "{}\n{}", doc.stdout, doc.stderr);
    assert!(
        doc.stdout.contains("all checks passed"),
        "got:\n{}",
        doc.stdout
    );
    assert!(doc.stdout.contains("core"), "got:\n{}", doc.stdout);
    // the derived sync points, and they match reality
    assert!(doc.stdout.contains(&pub_head), "got:\n{}", doc.stdout);
    assert!(doc.stdout.contains(&mono_head), "got:\n{}", doc.stdout);
    assert!(doc.stdout.contains("to push: 0"), "got:\n{}", doc.stdout);
    assert!(doc.stdout.contains("to pull: 0"), "got:\n{}", doc.stdout);

    // no state file, by design
    let mut files = Vec::new();
    work_tree_files(&mono.dir, "", &mut files);
    assert!(
        !files.iter().any(|f| f == ".monosplice"),
        "files: {files:?}"
    );
    assert!(
        !files.iter().any(|f| f.starts_with(".monosplice/")),
        "files: {files:?}"
    );
    assert!(
        !files
            .iter()
            .any(|f| f.rsplit('/').next() == Some("state.json")),
        "files: {files:?}"
    );
    assert!(!mono.exists(".monosplice"), "files: {files:?}");
}

/// S52: broken commit mapping.
#[test]
fn s52_is_detected_by_doctor_and_blocks_push_instead_of_exporting_garbage() {
    let seeded = seeded_with_external();
    let mono = &seeded.fx.mono;
    let ghost = "ab".repeat(20);

    seeded.ext.commit_as(
        &format!("external: forged mapping\n\nMonosplice-Source: {ghost}"),
        &[("forged.txt", Some("from nowhere\n"))],
        EXT_NAME,
        EXT_EMAIL,
    );
    let forged_pub_sha = seeded.ext.head();
    seeded.ext.git(&["push", "origin", "main"]);
    let pub_head_before = seeded.pub_repo.head();
    let pub_subjects_before = seeded.pub_repo.subjects("HEAD");

    let doc = run_monosplice(&mono.dir, &["doctor"]);
    assert_eq!(doc.exit_code, 1, "stderr: {}", doc.stderr);
    assert!(doc.stdout.contains(&ghost), "got:\n{}", doc.stdout);
    assert!(doc.stdout.contains(&forged_pub_sha), "got:\n{}", doc.stdout);
    assert!(
        doc.stdout.contains("Monosplice-Source"),
        "got:\n{}",
        doc.stdout
    );
    assert!(
        doc.stdout.to_lowercase().contains("does not exist"),
        "got:\n{}",
        doc.stdout
    );

    // A pending local commit must NOT be exported on top of a mapping we cannot trust.
    mono.commit("feat: local work", &[("core/local.txt", Some("local\n"))]);
    let push = run_monosplice(&mono.dir, &["push"]);
    assert_ne!(push.exit_code, 0, "stdout: {}", push.stdout);
    assert!(push.stderr.contains(&ghost), "got:\n{}", push.stderr);
    assert!(push.stderr.contains("doctor"), "got:\n{}", push.stderr);
    assert_eq!(seeded.pub_repo.head(), pub_head_before);
    assert_eq!(seeded.pub_repo.subjects("HEAD"), pub_subjects_before);
    // the external content was neither reverted nor duplicated
    assert_eq!(
        seeded.pub_repo.file_at("HEAD", "forged.txt"),
        "from nowhere"
    );
}

/// S53: a fresh clone on a second machine works immediately with no state to restore.
#[test]
fn s53_works_immediately_with_no_state_to_restore() {
    let seeded = seeded_with_external();
    let mono = &seeded.fx.mono;
    let root = seeded.fx.sandbox.path();

    // The config is committed, which is what makes a fresh clone self-sufficient.
    assert!(
        mono.file_at("HEAD", CONFIG).contains("subrepos"),
        "the config must be committed"
    );

    mono.commit("feat: first machine", &[("core/first.txt", Some("1\n"))]);
    run_ok(&mono.dir, &["push"]);

    seeded.ext.git(&["fetch", "origin"]);
    seeded.ext.git(&["reset", "--hard", "origin/main"]);
    seeded.ext.commit_as(
        "external: before the clone",
        &[("before.txt", Some("b\n"))],
        EXT_NAME,
        EXT_EMAIL,
    );
    seeded.ext.git(&["push", "origin", "main"]);
    run_ok(&mono.dir, &["pull"]);
    run_ok(&mono.dir, &["push"]);

    // "Second machine": a plain clone of the monorepo, no monosplice state carried over.
    let mono2 = clone_remote(root, &mono.dir.to_string_lossy(), "mono2");
    assert!(!mono2.exists(".monosplice"));

    let st = run_monosplice(&mono2.dir, &["status"]);
    assert_eq!(st.exit_code, 0, "stderr: {}", st.stderr);
    assert!(st.stdout.contains("core: in sync"), "got:\n{}", st.stdout);

    let doc = run_monosplice(&mono2.dir, &["doctor"]);
    assert_eq!(doc.exit_code, 0, "{}\n{}", doc.stdout, doc.stderr);

    // A full round from the fresh clone.
    let ext2 = clone_remote(root, &seeded.fx.pub_dir, "ext2");
    ext2.commit_as(
        "external: after the clone",
        &[("after.txt", Some("a\n"))],
        EXT_NAME,
        EXT_EMAIL,
    );
    ext2.git(&["push", "origin", "main"]);

    let pull = run_monosplice(&mono2.dir, &["pull"]);
    assert_eq!(pull.exit_code, 0, "stderr: {}", pull.stderr);
    assert!(pull.stdout.contains("imported 1"), "got:\n{}", pull.stdout);

    mono2.commit("feat: second machine", &[("core/second.txt", Some("2\n"))]);
    let push = run_monosplice(&mono2.dir, &["push"]);
    assert_eq!(push.exit_code, 0, "stderr: {}", push.stderr);
    assert!(push.stdout.contains("exported"), "got:\n{}", push.stdout);

    assert_eq!(
        seeded.pub_repo.tree_sha("HEAD", None),
        mono2.tree_sha("HEAD", Some("core"))
    );
    assert!(seeded
        .pub_repo
        .subjects("HEAD")
        .iter()
        .any(|s| s == "feat: second machine"));
}

/// S54: rewritten monorepo history.
#[test]
fn s54_refuses_to_push_and_doctor_names_the_problem() {
    let seeded = seeded_with_external();
    let mono = &seeded.fx.mono;

    mono.commit("feat: exported", &[("core/x.txt", Some("x\n"))]);
    let first = run_monosplice(&mono.dir, &["push"]);
    assert_eq!(first.exit_code, 0, "stderr: {}", first.stderr);
    let exported_mono_sha = mono.head();
    let pub_head = seeded.pub_repo.head();
    let pub_subjects = seeded.pub_repo.subjects("HEAD");

    // rebase/amend/force-push equivalent: drop the exported commit, put a different one back
    mono.git(&["reset", "--hard", "HEAD~1"]);
    mono.commit("feat: rewritten", &[("core/y.txt", Some("y\n"))]);

    let push = run_monosplice(&mono.dir, &["push"]);
    assert_ne!(push.exit_code, 0, "stdout: {}", push.stdout);
    assert!(
        push.stderr.contains(&exported_mono_sha),
        "got:\n{}",
        push.stderr
    );
    assert!(
        push.stderr.to_lowercase().contains("rewritten"),
        "got:\n{}",
        push.stderr
    );
    assert!(push.stderr.contains("doctor"), "got:\n{}", push.stderr);
    assert_eq!(seeded.pub_repo.head(), pub_head);
    assert_eq!(seeded.pub_repo.subjects("HEAD"), pub_subjects);

    let doc = run_monosplice(&mono.dir, &["doctor"]);
    assert_eq!(doc.exit_code, 1, "stderr: {}", doc.stderr);
    assert!(
        doc.stdout.contains(&exported_mono_sha),
        "got:\n{}",
        doc.stdout
    );
    let lower = doc.stdout.to_lowercase();
    assert!(
        lower.contains("rewritten") || lower.contains("ancestor"),
        "got:\n{}",
        doc.stdout
    );
}

/// doctor housekeeping: an unfinished pull is a problem, with the way out named.
#[test]
fn doctor_flags_an_unfinished_pull() {
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

    let doc = run_monosplice(&mono.dir, &["doctor"]);
    assert_eq!(doc.exit_code, 1, "stderr: {}", doc.stderr);
    assert!(
        doc.stdout.to_lowercase().contains("pull"),
        "got:\n{}",
        doc.stdout
    );
    assert!(doc.stdout.contains("--continue"), "got:\n{}", doc.stdout);
}

/// doctor housekeeping: a subrepo that was never seeded is a problem, not a crash.
#[test]
fn doctor_flags_a_subrepo_that_was_never_seeded() {
    let fx = standard_fixture();
    let doc = run_monosplice(&fx.mono.dir, &["doctor"]);
    assert_eq!(doc.exit_code, 1, "stderr: {}", doc.stderr);
    assert!(
        doc.stdout.contains("not published yet"),
        "got:\n{}",
        doc.stdout
    );
    assert!(
        doc.stdout.contains("monosplice push core --yes"),
        "got:\n{}",
        doc.stdout
    );
}
