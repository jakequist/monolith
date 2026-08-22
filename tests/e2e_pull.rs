//! e2e: `monosplice pull` — port of `test/e2e/pull.test.ts`.
//!
//! Adapted per `docs/rust-port.md`: config is `monosplice.toml`, so `exclude` is a TOML array
//! rather than a JS one. Everything else — wording fragments, sequencer path, abort semantics —
//! ports verbatim.

mod common;

use common::{
    clone_remote, run_monosplice, standard_fixture, standard_fixture_extra, Fixture, TestRepo,
};

const EXT_NAME: &str = "Ext Contributor";
const EXT_EMAIL: &str = "ext@example.test";

const SEQUENCER: &str = ".git/monosplice/pull-state.json";

/// Seed the fixture, then hand back mono, the bare pub remote and an external clone of it.
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

/// Paths of a tree-ish, in `tree_entries` order (`mode sha path` lines, third field).
fn tree_paths(repo: &TestRepo, treeish: &str) -> Vec<String> {
    repo.tree_entries(treeish, None)
        .iter()
        .filter_map(|e| e.split(' ').nth(2).map(str::to_owned))
        .collect()
}

fn has(paths: &[String], needle: &str) -> bool {
    paths.iter().any(|p| p == needle)
}

fn ext_commit(ext: &TestRepo, message: &str, files: &[(&str, Option<&str>)]) -> String {
    ext.commit_as(message, files, EXT_NAME, EXT_EMAIL)
}

/// S30: an external commit in pub is imported under `core/` with the original author and an
/// origin trailer.
#[test]
fn s30_external_commit_in_pub_is_imported_under_core() {
    let s = seeded_with_external();
    let mono = &s.fixture.mono;

    ext_commit(
        &s.ext,
        "external: add CONTRIBUTING.md",
        &[("CONTRIBUTING.md", Some("be nice\n"))],
    );
    let ext_pub_sha = s.ext.head();
    s.ext.git(&["push", "origin", "main"]);

    let mono_before = mono.subjects("HEAD").len();
    let res = run_monosplice(&mono.dir, &["pull"]);
    assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);
    assert!(
        res.stdout.contains("imported 1 commit"),
        "stdout: {}",
        res.stdout
    );

    let subjects = mono.subjects("HEAD");
    assert_eq!(subjects.len(), mono_before + 1, "subjects: {subjects:?}");
    assert_eq!(
        subjects.last().map(String::as_str),
        Some("external: add CONTRIBUTING.md")
    );

    let authors = mono.authors("HEAD");
    assert_eq!(
        authors.last().map(String::as_str),
        Some("Ext Contributor <ext@example.test>")
    );

    let messages = mono.messages("HEAD");
    assert!(
        messages
            .last()
            .is_some_and(|m| m.contains(&format!("Monosplice-Origin: {ext_pub_sha}"))),
        "messages: {messages:?}"
    );

    assert_eq!(mono.read("core/CONTRIBUTING.md"), "be nice\n");
    assert_eq!(mono.file_at("HEAD", "core/CONTRIBUTING.md"), "be nice");
    assert_eq!(
        mono.tree_sha("HEAD", Some("core")),
        s.ext.tree_sha(&ext_pub_sha, None)
    );
    // The private side of the monorepo is untouched by an import.
    assert!(mono.exists("private/secrets.md"));
}

/// S31: multiple upstream commits are imported oldest first.
#[test]
fn s31_multiple_upstream_commits_are_imported_oldest_first() {
    let s = seeded_with_external();
    let mono = &s.fixture.mono;

    ext_commit(&s.ext, "external: one", &[("one.txt", Some("1\n"))]);
    ext_commit(&s.ext, "external: two", &[("two.txt", Some("2\n"))]);
    ext_commit(&s.ext, "external: three", &[("three.txt", Some("3\n"))]);
    s.ext.git(&["push", "origin", "main"]);

    let res = run_monosplice(&mono.dir, &["pull"]);
    assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);
    assert!(
        res.stdout.contains("imported 3 commit"),
        "stdout: {}",
        res.stdout
    );

    let subjects = mono.subjects("HEAD");
    assert!(subjects.len() >= 3, "subjects: {subjects:?}");
    assert_eq!(
        subjects[subjects.len() - 3..],
        ["external: one", "external: two", "external: three"]
    );
    assert_eq!(
        mono.tree_sha("HEAD", Some("core")),
        s.ext.tree_sha("HEAD", None)
    );
}

/// S32: pulling twice is a no-op the second time.
#[test]
fn s32_pull_twice_is_a_no_op_the_second_time() {
    let s = seeded_with_external();
    let mono = &s.fixture.mono;

    ext_commit(
        &s.ext,
        "external: drive-by",
        &[("DRIVEBY.md", Some("hi\n"))],
    );
    s.ext.git(&["push", "origin", "main"]);

    let first = run_monosplice(&mono.dir, &["pull"]);
    assert_eq!(first.exit_code, 0, "stderr: {}", first.stderr);
    let head = mono.head();

    let second = run_monosplice(&mono.dir, &["pull"]);
    assert_eq!(second.exit_code, 0, "stderr: {}", second.stderr);
    assert!(
        second.stdout.contains("up to date"),
        "stdout: {}",
        second.stdout
    );
    assert_eq!(mono.head(), head);
}

/// S33: pub commits carrying `Monosplice-Source` are skipped on pull — our own exports never
/// come back.
#[test]
fn s33_pub_commits_carrying_monosplice_source_are_skipped_on_pull() {
    let s = seeded_with_external();
    let mono = &s.fixture.mono;

    mono.commit("feat: one", &[("core/one.txt", Some("1\n"))]);
    mono.commit("feat: two", &[("core/two.txt", Some("2\n"))]);
    let push = run_monosplice(&mono.dir, &["push"]);
    assert_eq!(push.exit_code, 0, "stderr: {}", push.stderr);

    let head = mono.head();
    let res = run_monosplice(&mono.dir, &["pull"]);
    assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);
    assert!(res.stdout.contains("up to date"), "stdout: {}", res.stdout);
    assert_eq!(mono.head(), head);
}

/// S34: pull refuses before touching anything when `core/` has uncommitted changes.
#[test]
fn s34_dirty_working_tree_refuses_before_touching_anything() {
    let s = seeded_with_external();
    let mono = &s.fixture.mono;

    ext_commit(
        &s.ext,
        "external: drive-by",
        &[("DRIVEBY.md", Some("hi\n"))],
    );
    s.ext.git(&["push", "origin", "main"]);

    mono.write("core/README.md", "# core\n\nwork in progress\n");
    let head = mono.head();
    let subjects = mono.subjects("HEAD");

    let res = run_monosplice(&mono.dir, &["pull"]);
    assert_ne!(res.exit_code, 0, "stdout: {}", res.stdout);
    assert!(
        res.stderr.contains("core"),
        "the error must name the subrepo, got:\n{}",
        res.stderr
    );
    assert_eq!(mono.head(), head);
    assert_eq!(mono.subjects("HEAD"), subjects);
    assert_eq!(mono.read("core/README.md"), "# core\n\nwork in progress\n");
    assert!(!mono.exists("core/DRIVEBY.md"));
}

/// S34: pull refuses when an untracked file sits under `core/`.
#[test]
fn s34_dirty_working_tree_refuses_on_an_untracked_file_under_core() {
    let s = seeded_with_external();
    let mono = &s.fixture.mono;

    ext_commit(
        &s.ext,
        "external: drive-by",
        &[("DRIVEBY.md", Some("hi\n"))],
    );
    s.ext.git(&["push", "origin", "main"]);

    mono.write("core/scratch.tmp", "scratch\n");
    let head = mono.head();

    let res = run_monosplice(&mono.dir, &["pull"]);
    assert_ne!(res.exit_code, 0, "stdout: {}", res.stdout);
    assert_eq!(mono.head(), head);
    assert!(!mono.exists("core/DRIVEBY.md"));
}

/// S34: pull refuses when changes are staged outside `core/`.
#[test]
fn s34_dirty_working_tree_refuses_when_changes_are_staged_outside_core() {
    let s = seeded_with_external();
    let mono = &s.fixture.mono;

    ext_commit(
        &s.ext,
        "external: drive-by",
        &[("DRIVEBY.md", Some("hi\n"))],
    );
    s.ext.git(&["push", "origin", "main"]);

    mono.write("private/secrets.md", "staged elsewhere\n");
    mono.git(&["add", "private/secrets.md"]);
    let head = mono.head();

    let res = run_monosplice(&mono.dir, &["pull"]);
    assert_ne!(res.exit_code, 0, "stdout: {}", res.stdout);
    assert!(
        res.stderr.to_lowercase().contains("staged"),
        "stderr: {}",
        res.stderr
    );
    assert_eq!(mono.head(), head);
    assert!(!mono.exists("core/DRIVEBY.md"));
    // the stray staged change was neither committed nor unstaged
    assert_eq!(
        mono.git(&["diff", "--cached", "--name-only"]),
        "private/secrets.md"
    );
}

/// S35: conflicting edits on both sides stop with conflict markers and complete after
/// `pull --continue`.
#[test]
fn s35_conflicting_edits_stop_and_complete_after_pull_continue() {
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
    let ext_pub_sha = s.ext.head();
    s.ext.git(&["push", "origin", "main"]);

    let conflicted = run_monosplice(&mono.dir, &["pull"]);
    assert_ne!(conflicted.exit_code, 0, "stdout: {}", conflicted.stdout);
    assert!(
        conflicted.stderr.contains("core/README.md"),
        "stderr: {}",
        conflicted.stderr
    );
    assert!(
        conflicted.stderr.contains("monosplice pull --continue"),
        "stderr: {}",
        conflicted.stderr
    );

    let with_markers = mono.read("core/README.md");
    assert!(with_markers.contains("<<<<<<<"), "{with_markers}");
    assert!(with_markers.contains("======="), "{with_markers}");
    assert!(with_markers.contains(">>>>>>>"), "{with_markers}");
    assert!(with_markers.contains("mono wording"), "{with_markers}");
    assert!(with_markers.contains("ext wording"), "{with_markers}");

    mono.write("core/README.md", "# core\n\nmono wording and ext wording\n");
    mono.git(&["add", "core/README.md"]);

    let resumed = run_monosplice(&mono.dir, &["pull", "--continue"]);
    assert_eq!(resumed.exit_code, 0, "stderr: {}", resumed.stderr);
    assert!(
        resumed.stdout.contains("imported 1 commit"),
        "stdout: {}",
        resumed.stdout
    );

    let subjects = mono.subjects("HEAD");
    assert_eq!(
        subjects.last().map(String::as_str),
        Some("docs: ext wording")
    );
    let authors = mono.authors("HEAD");
    assert_eq!(
        authors.last().map(String::as_str),
        Some("Ext Contributor <ext@example.test>")
    );
    let messages = mono.messages("HEAD");
    assert!(
        messages
            .last()
            .is_some_and(|m| m.contains(&format!("Monosplice-Origin: {ext_pub_sha}"))),
        "messages: {messages:?}"
    );
    assert_eq!(
        mono.read("core/README.md"),
        "# core\n\nmono wording and ext wording\n"
    );
    assert_eq!(mono.git(&["status", "--porcelain"]), "");

    // Round-trip fidelity: the resolution must reach pub, or the two sides diverge forever.
    let push = run_monosplice(&mono.dir, &["push"]);
    assert_eq!(push.exit_code, 0, "stderr: {}", push.stderr);
    assert_eq!(
        pub_repo.tree_sha("HEAD", None),
        mono.tree_sha("HEAD", Some("core"))
    );
    assert_eq!(
        pub_repo.file_at("HEAD", "README.md"),
        "# core\n\nmono wording and ext wording"
    );
}

/// S35: `--continue` refuses while unmerged paths remain, and a fresh `pull` refuses
/// mid-conflict.
#[test]
fn s35_refuses_to_continue_with_unmerged_paths_and_refuses_a_fresh_pull() {
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

    let conflicted = run_monosplice(&mono.dir, &["pull"]);
    assert_ne!(conflicted.exit_code, 0, "stdout: {}", conflicted.stdout);

    let early = run_monosplice(&mono.dir, &["pull", "--continue"]);
    assert_ne!(early.exit_code, 0, "stdout: {}", early.stdout);
    assert!(
        early.stderr.contains("core/README.md"),
        "stderr: {}",
        early.stderr
    );

    let restart = run_monosplice(&mono.dir, &["pull"]);
    assert_ne!(restart.exit_code, 0, "stdout: {}", restart.stdout);
    assert!(
        restart.stderr.contains("--continue"),
        "stderr: {}",
        restart.stderr
    );
}

/// S35: `--continue` with no pull in progress is an error.
#[test]
fn s35_errors_when_continue_is_used_with_no_pull_in_progress() {
    let s = seeded_with_external();
    let res = run_monosplice(&s.fixture.mono.dir, &["pull", "--continue"]);
    assert_ne!(res.exit_code, 0, "stdout: {}", res.stdout);
    assert!(
        res.stderr.to_lowercase().contains("no pull"),
        "stderr: {}",
        res.stderr
    );
}

/// S36: an imported file matching an exclude pattern is imported, but the user is warned that
/// the next push will delete it from pub.
#[test]
fn s36_imported_file_matching_an_exclude_pattern_warns_about_the_next_push() {
    let s = seeded_with_external_extra(r#"exclude = ["INTERNAL.md"]"#);
    let mono = &s.fixture.mono;
    let pub_repo = &s.pub_repo;

    ext_commit(
        &s.ext,
        "external: add notes",
        &[
            ("INTERNAL.md", Some("external notes\n")),
            ("PUBLIC.md", Some("public notes\n")),
        ],
    );
    s.ext.git(&["push", "origin", "main"]);

    let res = run_monosplice(&mono.dir, &["pull"]);
    assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);
    assert!(
        res.stdout.contains("imported 1 commit"),
        "stdout: {}",
        res.stdout
    );
    assert!(res.stderr.contains("INTERNAL.md"), "stderr: {}", res.stderr);
    assert!(
        res.stderr.to_lowercase().contains("exclude"),
        "stderr: {}",
        res.stderr
    );
    assert!(
        !res.stderr.contains("PUBLIC.md"),
        "only the excluded path is worth warning about, got:\n{}",
        res.stderr
    );

    assert!(mono.exists("core/INTERNAL.md"));
    assert_eq!(mono.file_at("HEAD", "core/INTERNAL.md"), "external notes");

    // Documented consequence: the exclude wins, so pushing removes it from pub.
    let push = run_monosplice(&mono.dir, &["push"]);
    assert_eq!(push.exit_code, 0, "stderr: {}", push.stderr);
    let paths = tree_paths(pub_repo, "HEAD");
    assert!(!has(&paths, "INTERNAL.md"), "paths: {paths:?}");
    assert!(has(&paths, "PUBLIC.md"), "paths: {paths:?}");
    // The file survives in mono, so pub is filtered(core/) here rather than core/ itself.
    assert!(mono.exists("core/INTERNAL.md"));
    assert_eq!(pub_repo.file_at("HEAD", "PUBLIC.md"), "public notes");
}

/// One clean import followed by a conflicting one, so `--abort` has both a committed import to
/// rewind and a half-applied merge to clean up. Returns the pre-pull head.
fn conflict_after_one_import() -> (Seeded, String) {
    let s = seeded_with_external();
    let mono = &s.fixture.mono;

    mono.commit(
        "docs: mono wording",
        &[("core/README.md", Some("# core\n\nmono wording\n"))],
    );
    ext_commit(
        &s.ext,
        "external: unrelated",
        &[("unrelated.txt", Some("u\n"))],
    );
    ext_commit(
        &s.ext,
        "docs: ext wording",
        &[("README.md", Some("# core\n\next wording\n"))],
    );
    s.ext.git(&["push", "origin", "main"]);

    let start_head = mono.head();
    let conflicted = run_monosplice(&mono.dir, &["pull"]);
    assert_ne!(conflicted.exit_code, 0, "stdout: {}", conflicted.stdout);
    assert!(mono.exists(SEQUENCER), "the sequencer file must exist");
    // the clean one landed, the conflicting one did not
    assert_eq!(
        mono.subjects("HEAD").last().map(String::as_str),
        Some("external: unrelated")
    );
    (s, start_head)
}

/// S150: `pull --abort` rewinds this run's imports and restores the pre-pull state.
#[test]
fn s150_pull_abort_rewinds_this_runs_imports() {
    let (s, start_head) = conflict_after_one_import();
    let mono = &s.fixture.mono;

    let res = run_monosplice(&mono.dir, &["pull", "--abort"]);
    assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);
    assert!(
        res.stdout.to_lowercase().contains("aborted"),
        "stdout: {}",
        res.stdout
    );

    assert_eq!(mono.head(), start_head);
    assert_eq!(mono.git(&["status", "--porcelain"]), "");
    assert_eq!(mono.read("core/README.md"), "# core\n\nmono wording\n");
    assert!(!mono.exists("core/unrelated.txt"));
    assert!(!mono.exists(SEQUENCER));
    assert_eq!(
        mono.subjects("HEAD").last().map(String::as_str),
        Some("docs: mono wording")
    );

    // Aborting left no pull in progress, so the whole thing can be attempted again.
    let again = run_monosplice(&mono.dir, &["pull"]);
    assert_ne!(again.exit_code, 0, "stdout: {}", again.stdout);
    assert!(
        again.stderr.contains("core/README.md"),
        "stderr: {}",
        again.stderr
    );
    assert!(
        again.stderr.contains("--continue"),
        "stderr: {}",
        again.stderr
    );
}

/// S150: `pull --abort` never touches anything outside the subrepo path.
#[test]
fn s150_pull_abort_never_touches_anything_outside_the_subrepo_path() {
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

    // Unstaged work outside core/ is allowed while pulling, so abort must preserve it.
    mono.write("private/secrets.md", "work in progress\n");
    mono.write("private/scratch.tmp", "scratch\n");

    let conflicted = run_monosplice(&mono.dir, &["pull"]);
    assert_ne!(conflicted.exit_code, 0, "stdout: {}", conflicted.stdout);

    let res = run_monosplice(&mono.dir, &["pull", "--abort"]);
    assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);
    assert_eq!(mono.read("private/secrets.md"), "work in progress\n");
    assert_eq!(mono.read("private/scratch.tmp"), "scratch\n");
    assert_eq!(mono.read("core/README.md"), "# core\n\nmono wording\n");
    assert_eq!(
        mono.git(&["status", "--porcelain"]),
        " M private/secrets.md\n?? private/scratch.tmp"
    );
}

/// S150: `pull --abort` keeps commits it cannot prove are its own, and says so.
#[test]
fn s150_pull_abort_keeps_commits_it_cannot_prove_are_its_own() {
    let (s, start_head) = conflict_after_one_import();
    let mono = &s.fixture.mono;
    let after_import = mono.head();

    // The user resolves and commits by hand: monorepo history moved underneath the sequencer.
    mono.write("core/README.md", "# core\n\nhand resolved\n");
    mono.git(&["add", "core/README.md"]);
    mono.commit("chore: resolved by hand", &[]);
    let hand_head = mono.head();

    let res = run_monosplice(&mono.dir, &["pull", "--abort"]);
    assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);
    assert!(
        res.stdout.to_lowercase().contains("aborted"),
        "stdout: {}",
        res.stdout
    );
    assert!(
        res.stdout.to_lowercase().contains("kept"),
        "stdout: {}",
        res.stdout
    );
    assert!(
        res.stdout.contains(&start_head[..10]),
        "the report must name the pre-pull head, got:\n{}",
        res.stdout
    );

    assert_eq!(mono.head(), hand_head);
    assert_eq!(mono.git(&["rev-parse", "HEAD~1"]), after_import);
    assert!(!mono.exists(SEQUENCER));
    assert_eq!(mono.git(&["status", "--porcelain"]), "");
}

/// S150: `--abort` refuses when no pull is in progress, and refuses to combine with
/// `--continue`.
#[test]
fn s150_pull_abort_refuses_without_a_pull_and_refuses_with_continue() {
    let s = seeded_with_external();
    let mono = &s.fixture.mono;

    let none = run_monosplice(&mono.dir, &["pull", "--abort"]);
    assert_ne!(none.exit_code, 0, "stdout: {}", none.stdout);
    assert!(
        none.stderr
            .to_lowercase()
            .contains("no pull is in progress"),
        "stderr: {}",
        none.stderr
    );

    let both = run_monosplice(&mono.dir, &["pull", "--abort", "--continue"]);
    assert_ne!(both.exit_code, 0, "stdout: {}", both.stdout);
    assert!(both.stderr.contains("--abort"), "stderr: {}", both.stderr);
    assert!(
        both.stderr.contains("--continue"),
        "stderr: {}",
        both.stderr
    );
}

/// S150: `pull --abort` is the abort route every conflict message names — never "go delete
/// pull-state.json".
#[test]
fn s150_pull_abort_is_the_abort_route_every_conflict_message_names() {
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

    let conflicted = run_monosplice(&mono.dir, &["pull"]);
    assert!(
        conflicted.stderr.contains("monosplice pull --abort"),
        "stderr: {}",
        conflicted.stderr
    );
    assert!(
        !mentions_deleting_pull_state(&conflicted.stderr),
        "stderr: {}",
        conflicted.stderr
    );

    let restart = run_monosplice(&mono.dir, &["pull"]);
    assert!(
        restart.stderr.contains("monosplice pull --abort"),
        "stderr: {}",
        restart.stderr
    );
    assert!(
        !mentions_deleting_pull_state(&restart.stderr),
        "stderr: {}",
        restart.stderr
    );

    let doc = run_monosplice(&mono.dir, &["doctor"]);
    assert!(
        doc.stdout.contains("monosplice pull --abort"),
        "stdout: {}",
        doc.stdout
    );
    assert!(
        !doc.stdout.contains("delete the file"),
        "stdout: {}",
        doc.stdout
    );
}

/// Hand-rolled stand-in for the TS `/delete .*pull-state\.json/`: true when some line tells the
/// user to delete the sequencer by hand.
fn mentions_deleting_pull_state(text: &str) -> bool {
    text.lines().any(|line| match line.find("delete") {
        Some(at) => line[at..].contains("pull-state.json"),
        None => false,
    })
}

/// `pull` against an unseeded remote tells the user to publish first.
#[test]
fn pull_tells_the_user_to_publish_when_the_public_branch_does_not_exist() {
    let fx = standard_fixture();
    let res = run_monosplice(&fx.mono.dir, &["pull"]);
    assert_ne!(res.exit_code, 0, "stdout: {}", res.stdout);
    assert!(
        res.stderr.contains("monosplice push core --yes"),
        "stderr: {}",
        res.stderr
    );
}
