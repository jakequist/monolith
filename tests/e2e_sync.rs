//! e2e: `monosplice sync` — port of `test/e2e/sync.test.ts`.
//!
//! Adapted per `docs/rust-port.md`: config is `monosplice.toml`, so `exclude` is a TOML array.
//! The scenarios themselves (convergence, fixed point, interleaved rounds, `sync --continue`)
//! port unchanged.

mod common;

use common::{
    clone_remote, multi_fixture, run_monosplice, standard_fixture, standard_fixture_extra, Fixture,
    TestRepo,
};

const EXT_NAME: &str = "Ext Contributor";
const EXT_EMAIL: &str = "ext@example.test";

struct Seeded {
    fixture: Fixture,
    pub_repo: TestRepo,
    ext: TestRepo,
}

/// Seed the fixture, then hand back mono, the bare pub remote and an external clone of it.
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

/// Fast-forward the external clone to whatever monosplice just published.
fn refresh(ext: &TestRepo) {
    ext.git(&["fetch", "origin"]);
    ext.git(&["reset", "--hard", "origin/main"]);
}

fn ext_commit(ext: &TestRepo, message: &str, files: &[(&str, Option<&str>)]) -> String {
    ext.commit_as(message, files, EXT_NAME, EXT_EMAIL)
}

fn occurrences(list: &[String], value: &str) -> usize {
    list.iter().filter(|v| v.as_str() == value).count()
}

/// Paths of a tree-ish (optionally a subpath), in `tree_entries` order.
fn tree_paths(repo: &TestRepo, treeish: &str, subpath: Option<&str>) -> Vec<String> {
    repo.tree_entries(treeish, subpath)
        .iter()
        .filter_map(|e| e.split(' ').nth(2).map(str::to_owned))
        .collect()
}

fn has(paths: &[String], needle: &str) -> bool {
    paths.iter().any(|p| p == needle)
}

/// S40: `sync` converges both sides in one command from non-conflicting divergence.
#[test]
fn s40_sync_converges_both_sides_in_one_command() {
    let s = seeded_with_external();
    let mono = &s.fixture.mono;
    let pub_repo = &s.pub_repo;

    mono.commit("feat: A (mono side)", &[("core/a.txt", Some("A\n"))]);
    ext_commit(&s.ext, "external: B", &[("b.txt", Some("B\n"))]);
    let ext_sha = s.ext.head();
    s.ext.git(&["push", "origin", "main"]);

    let res = run_monosplice(&mono.dir, &["sync"]);
    assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);
    assert!(res.stdout.contains("imported 1"), "stdout: {}", res.stdout);
    assert!(
        contains_exported_count(&res.stdout),
        "stdout must report an export count, got:\n{}",
        res.stdout
    );

    // B landed in the monorepo, under core/, with its origin trailer.
    assert!(mono.exists("core/b.txt"));
    assert_eq!(mono.file_at("HEAD", "core/b.txt"), "B");
    assert!(
        mono.messages("HEAD")
            .join("\n")
            .contains(&format!("Monosplice-Origin: {ext_sha}")),
        "no origin trailer for {ext_sha}"
    );

    // A landed in pub.
    let subjects = pub_repo.subjects("HEAD");
    assert!(
        subjects.iter().any(|s| s == "feat: A (mono side)"),
        "subjects: {subjects:?}"
    );
    assert_eq!(pub_repo.file_at("HEAD", "a.txt"), "A");

    // Converged.
    assert_eq!(
        pub_repo.tree_sha("HEAD", None),
        mono.tree_sha("HEAD", Some("core"))
    );
}

/// Stand-in for the TS `/exported \d/`: an "exported" mention followed by a digit.
fn contains_exported_count(stdout: &str) -> bool {
    stdout.match_indices("exported ").any(|(at, marker)| {
        stdout[at + marker.len()..]
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_digit())
    })
}

/// S40: `sync` tells the user to publish when the public branch does not exist.
#[test]
fn s40_sync_tells_the_user_to_publish_when_the_public_branch_does_not_exist() {
    let fx = standard_fixture();
    let res = run_monosplice(&fx.mono.dir, &["sync"]);
    assert_ne!(res.exit_code, 0, "stdout: {}", res.stdout);
    assert!(
        res.stderr.contains("monosplice push core --yes"),
        "stderr: {}",
        res.stderr
    );
}

/// S40: `sync` refuses to start while a pull is mid-conflict.
#[test]
fn s40_sync_refuses_to_start_while_a_pull_is_mid_conflict() {
    let s = seeded_with_external();
    let mono = &s.fixture.mono;

    mono.commit(
        "docs: mono wording",
        &[("core/README.md", Some("# core\n\nmono wording\n"))],
    );
    ext_commit(
        &s.ext,
        "docs: ext wording",
        &[("README.md", Some("# core\n\next wording\n"))],
    );
    s.ext.git(&["push", "origin", "main"]);

    let conflicted = run_monosplice(&mono.dir, &["sync"]);
    assert_ne!(conflicted.exit_code, 0, "stdout: {}", conflicted.stdout);
    assert!(
        conflicted.stderr.contains("core/README.md"),
        "stderr: {}",
        conflicted.stderr
    );
    assert!(
        conflicted.stderr.contains("--continue"),
        "stderr: {}",
        conflicted.stderr
    );

    let restart = run_monosplice(&mono.dir, &["sync"]);
    assert_ne!(restart.exit_code, 0, "stdout: {}", restart.stdout);
    assert!(
        restart.stderr.contains("--continue"),
        "stderr: {}",
        restart.stderr
    );
}

/// S40: `sync` pushes nothing when the import conflicts.
#[test]
fn s40_sync_pushes_nothing_when_the_import_conflicts() {
    let s = seeded_with_external();
    let mono = &s.fixture.mono;
    let pub_repo = &s.pub_repo;

    mono.commit(
        "docs: mono wording",
        &[("core/README.md", Some("# core\n\nmono wording\n"))],
    );
    ext_commit(
        &s.ext,
        "docs: ext wording",
        &[("README.md", Some("# core\n\next wording\n"))],
    );
    s.ext.git(&["push", "origin", "main"]);
    let pub_head = pub_repo.head();

    let res = run_monosplice(&mono.dir, &["sync"]);
    assert_ne!(res.exit_code, 0, "stdout: {}", res.stdout);
    assert_eq!(pub_repo.head(), pub_head);
}

/// S40: `sync` reports "up to date" when neither side moved.
#[test]
fn s40_sync_reports_up_to_date_when_neither_side_moved() {
    let s = seeded_with_external();
    let res = run_monosplice(&s.fixture.mono.dir, &["sync"]);
    assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);
    assert!(res.stdout.contains("up to date"), "stdout: {}", res.stdout);
}

/// S41: round-trip fidelity with excludes leaves pub byte-identical to the non-excluded part
/// of `core/`.
#[test]
fn s41_round_trip_fidelity_with_excludes() {
    let s = seeded_with_external_extra(r#"exclude = ["INTERNAL.md", "docs/private/**"]"#);
    let mono = &s.fixture.mono;
    let pub_repo = &s.pub_repo;

    mono.commit(
        "feat: mixed public and private",
        &[
            ("core/INTERNAL.md", Some("never publish\n")),
            ("core/keep.txt", Some("keep me\n")),
            ("core/docs/private/notes.md", Some("private notes\n")),
            ("core/docs/public.md", Some("# public docs\n")),
            ("private/plan.md", Some("monorepo only\n")),
        ],
    );
    ext_commit(
        &s.ext,
        "external: add ext.txt",
        &[("ext.txt", Some("from outside\n"))],
    );
    s.ext.git(&["push", "origin", "main"]);

    let res = run_monosplice(&mono.dir, &["sync"]);
    assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);

    let is_excluded = |p: &str| p == "INTERNAL.md" || p.starts_with("docs/private/");
    let mono_paths = tree_paths(mono, "HEAD", Some("core"));
    let pub_paths = tree_paths(pub_repo, "HEAD", None);

    assert!(has(&mono_paths, "INTERNAL.md"), "mono: {mono_paths:?}");
    assert!(
        has(&mono_paths, "docs/private/notes.md"),
        "mono: {mono_paths:?}"
    );

    let mut pub_sorted = pub_paths.clone();
    pub_sorted.sort();
    let mut expected: Vec<String> = mono_paths
        .iter()
        .filter(|p| !is_excluded(p))
        .cloned()
        .collect();
    expected.sort();
    assert_eq!(pub_sorted, expected);

    for p in &pub_paths {
        assert_eq!(
            pub_repo.file_at("HEAD", p),
            mono.file_at("HEAD", &format!("core/{p}")),
            "content mismatch for {p}"
        );
    }
    assert!(!has(&pub_paths, "INTERNAL.md"), "pub: {pub_paths:?}");
    assert!(
        !pub_paths.iter().any(|p| p.starts_with("docs/private/")),
        "pub: {pub_paths:?}"
    );
    assert!(
        !pub_paths.iter().any(|p| p.contains("plan.md")),
        "pub: {pub_paths:?}"
    );
}

/// S42: sync reaches a fixed point — push/pull/push/pull change nothing.
#[test]
fn s42_stability_reaches_a_fixed_point() {
    let s = seeded_with_external();
    let mono = &s.fixture.mono;
    let pub_repo = &s.pub_repo;

    mono.commit("feat: A (mono side)", &[("core/a.txt", Some("A\n"))]);
    ext_commit(&s.ext, "external: B", &[("b.txt", Some("B\n"))]);
    s.ext.git(&["push", "origin", "main"]);

    let sync = run_monosplice(&mono.dir, &["sync"]);
    assert_eq!(sync.exit_code, 0, "stderr: {}", sync.stderr);

    let mono_head = mono.head();
    let pub_head = pub_repo.head();

    for cmd in ["push", "pull", "push", "pull"] {
        let res = run_monosplice(&mono.dir, &[cmd]);
        assert_eq!(res.exit_code, 0, "{cmd}: {}", res.stderr);
        assert!(res.stdout.contains("up to date"), "{cmd}: {}", res.stdout);
    }

    assert_eq!(mono.head(), mono_head);
    assert_eq!(pub_repo.head(), pub_head);

    let again = run_monosplice(&mono.dir, &["sync"]);
    assert_eq!(again.exit_code, 0, "stderr: {}", again.stderr);
    assert!(
        again.stdout.contains("up to date"),
        "stdout: {}",
        again.stdout
    );
    assert_eq!(mono.head(), mono_head);
    assert_eq!(pub_repo.head(), pub_head);
}

/// S43: interleaved history over several rounds converges with every commit present on both
/// sides.
#[test]
fn s43_interleaved_history_over_several_rounds_converges() {
    let s = seeded_with_external();
    let mono = &s.fixture.mono;
    let pub_repo = &s.pub_repo;

    // Round 1: monorepo only.
    mono.commit("r1: mono only", &[("core/m1.txt", Some("1\n"))]);
    let mut res = run_monosplice(&mono.dir, &["sync"]);
    assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);

    // Round 2: public only.
    refresh(&s.ext);
    ext_commit(&s.ext, "r2: ext only", &[("e2.txt", Some("2\n"))]);
    s.ext.git(&["push", "origin", "main"]);
    res = run_monosplice(&mono.dir, &["sync"]);
    assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);

    // Round 3: both sides, non-conflicting.
    mono.commit("r3: mono side", &[("core/m3.txt", Some("3\n"))]);
    refresh(&s.ext);
    ext_commit(&s.ext, "r3: ext side", &[("e3.txt", Some("3\n"))]);
    s.ext.git(&["push", "origin", "main"]);
    res = run_monosplice(&mono.dir, &["sync"]);
    assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);

    let mono_subjects = mono.subjects("HEAD");
    let pub_subjects = pub_repo.subjects("HEAD");

    for subject in [
        "r1: mono only",
        "r2: ext only",
        "r3: mono side",
        "r3: ext side",
    ] {
        assert_eq!(
            occurrences(&mono_subjects, subject),
            1,
            "mono: {subject} in {mono_subjects:?}"
        );
        assert!(
            pub_subjects.iter().any(|s| s == subject),
            "pub: {subject} in {pub_subjects:?}"
        );
    }
    for subject in ["r1: mono only", "r2: ext only", "r3: mono side"] {
        assert_eq!(
            occurrences(&pub_subjects, subject),
            1,
            "pub: {subject} in {pub_subjects:?}"
        );
    }
    // Locked-in consequence of the two-histories model: in a round where BOTH sides moved,
    // the import commit sits on top of the local commit, so its tree differs from the pub
    // tip and it must be re-exported (same rule that preserves conflict resolutions).
    assert_eq!(
        occurrences(&pub_subjects, "r3: ext side"),
        2,
        "pub: {pub_subjects:?}"
    );

    assert_eq!(
        pub_repo.tree_sha("HEAD", None),
        mono.tree_sha("HEAD", Some("core"))
    );
    for f in ["m1.txt", "e2.txt", "m3.txt", "e3.txt"] {
        assert!(mono.exists(&format!("core/{f}")), "missing core/{f}");
        assert_eq!(
            pub_repo.file_at("HEAD", f),
            mono.file_at("HEAD", &format!("core/{f}")),
            "content mismatch for {f}"
        );
    }

    let mono_head = mono.head();
    let pub_head = pub_repo.head();
    let settle = run_monosplice(&mono.dir, &["sync"]);
    assert_eq!(settle.exit_code, 0, "stderr: {}", settle.stderr);
    assert!(
        settle.stdout.contains("up to date"),
        "stdout: {}",
        settle.stdout
    );
    assert_eq!(mono.head(), mono_head);
    assert_eq!(pub_repo.head(), pub_head);
}

/// S164: `sync --continue` finishes the interrupted pull and then pushes every subrepo.
#[test]
fn s164_sync_continue_finishes_the_pull_then_pushes_every_subrepo() {
    let fx = multi_fixture();
    let mono = &fx.mono;
    let seed = run_monosplice(&mono.dir, &["push", "--yes"]);
    assert_eq!(seed.exit_code, 0, "stderr: {}", seed.stderr);

    // core conflicts; lib has work waiting on both sides that the halted run never reached.
    let core_ext = clone_remote(fx.sandbox.path(), &fx.core_pub_dir, "core-ext");
    ext_commit(
        &core_ext,
        "docs: ext wording",
        &[("README.md", Some("# core\n\next wording\n"))],
    );
    core_ext.git(&["push", "origin", "main"]);
    let lib_ext = clone_remote(fx.sandbox.path(), &fx.lib_pub_dir, "lib-ext");
    ext_commit(
        &lib_ext,
        "external: lib drive-by",
        &[("drive.txt", Some("d\n"))],
    );
    lib_ext.git(&["push", "origin", "main"]);

    mono.commit(
        "docs: mono wording",
        &[("core/README.md", Some("# core\n\nmono wording\n"))],
    );
    mono.commit("feat: lib work", &[("packages/lib/new.txt", Some("n\n"))]);

    let conflicted = run_monosplice(&mono.dir, &["sync"]);
    assert_ne!(conflicted.exit_code, 0, "stdout: {}", conflicted.stdout);
    assert!(
        conflicted.stderr.contains("monosplice sync --continue"),
        "stderr: {}",
        conflicted.stderr
    );
    assert!(
        conflicted.stderr.contains("monosplice pull --abort"),
        "stderr: {}",
        conflicted.stderr
    );
    assert!(
        !conflicted.stderr.contains("monosplice pull --continue"),
        "a sync must resume through sync, got:\n{}",
        conflicted.stderr
    );

    mono.write("core/README.md", "# core\n\nmerged wording\n");
    mono.git(&["add", "core/README.md"]);

    let res = run_monosplice(&mono.dir, &["sync", "--continue"]);
    assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);

    // The resolution reached the standalone repo, and lib converged in the same run.
    assert_eq!(
        fx.core_pub.file_at("HEAD", "README.md"),
        "# core\n\nmerged wording"
    );
    let lib_subjects = fx.lib_pub.subjects("HEAD");
    assert!(
        lib_subjects.iter().any(|s| s == "feat: lib work"),
        "lib subjects: {lib_subjects:?}"
    );
    let mono_subjects = mono.subjects("HEAD");
    assert!(
        mono_subjects.iter().any(|s| s == "external: lib drive-by"),
        "mono subjects: {mono_subjects:?}"
    );

    let check = run_monosplice(&mono.dir, &["status", "--check"]);
    assert_eq!(check.exit_code, 0, "stderr: {}", check.stderr);
}

/// S164: `sync --continue` refuses with pull's wording when no pull is in progress.
#[test]
fn s164_sync_continue_refuses_with_pulls_wording_when_no_pull_is_in_progress() {
    let s = seeded_with_external();
    let mono = &s.fixture.mono;

    let sync = run_monosplice(&mono.dir, &["sync", "--continue"]);
    let pull = run_monosplice(&mono.dir, &["pull", "--continue"]);
    assert_ne!(sync.exit_code, 0, "stdout: {}", sync.stdout);
    assert_ne!(pull.exit_code, 0, "stdout: {}", pull.stdout);
    assert_eq!(sync.stderr, pull.stderr);
}
