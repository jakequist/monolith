//! e2e: the first publish of a subrepo — port of `test/e2e/firstpush.test.ts`.
//!
//! Adapted per `docs/rust-port.md`: config is `monosplice.toml`, and the S92 `scan` closure
//! becomes a shell hook run against the materialized outgoing tree. There is no TTY in tests,
//! so the confirmation path exercised here is always the non-interactive one (`--yes`, or the
//! refusal that names the exact command).

mod common;

use common::{
    make_bare_remote, make_repo, multi_fixture, run_monosplice, sandbox, standard_fixture,
    standard_fixture_extra, subrepo_block, toml_str, write_config, Sandbox, TestRepo,
};

/// TS: `scan: (files) => { for ([p, f] of files) if (f.data.includes('SECRET')) throw ... }`.
/// Same outcome from a shell hook, with the TS message as the `HookError` detail.
const SCAN_FOR_SECRET: &str = r#"scan = 'hit=$(grep -rl SECRET . 2>/dev/null | head -n 1); if [ -n "$hit" ]; then echo "possible secret in ${hit#./}" >&2; exit 1; fi'"#;

/// A monorepo whose `core/` directory has no committed files and whose remote is empty.
///
/// The [`Sandbox`] comes back first because it is the drop guard: callers must bind it for the
/// whole test or the repos vanish underneath them.
fn dead_end_fixture() -> (Sandbox, TestRepo, String) {
    let sandbox = sandbox();
    let mono = make_repo(sandbox.path(), "mono");
    let pub_dir = make_bare_remote(sandbox.path(), "core-pub");
    let block = subrepo_block(&[
        ("name", &toml_str("core")),
        ("path", &toml_str("core")),
        ("remote", &toml_str(&pub_dir)),
    ]);
    write_config(&mono, &[&block]);
    mono.commit(
        "chore: initial",
        &[("private/secrets.md", Some("internal only\n"))],
    );
    (sandbox, mono, pub_dir)
}

/// `git rev-parse --verify --quiet refs/heads/main` in a bare repo, with the TS `.catch(() => '')`
/// folded in: an unborn branch reads as the empty string.
fn main_ref(repo: &TestRepo) -> String {
    let res = repo.git_try(&["rev-parse", "--verify", "--quiet", "refs/heads/main"]);
    if res.exit_code == 0 {
        res.stdout
    } else {
        String::new()
    }
}

fn tree_paths(repo: &TestRepo, treeish: &str) -> Vec<String> {
    repo.tree_entries(treeish, None)
        .iter()
        .filter_map(|e| e.split(' ').nth(2).map(str::to_owned))
        .collect()
}

fn has(paths: &[String], needle: &str) -> bool {
    paths.iter().any(|p| p == needle)
}

/// S02: the first `push --yes` creates exactly one baseline commit whose tree equals the core
/// subtree.
#[test]
fn s02_first_push_yes_creates_one_baseline_commit() {
    let fx = standard_fixture();
    let mono = &fx.mono;

    mono.commit(
        "feat: more core",
        &[("core/src/util.ts", Some("export const n = 1\n"))],
    );
    mono.commit(
        "chore: private churn",
        &[("private/notes.md", Some("nope\n"))],
    );
    let mono_head = mono.head();

    let res = run_monosplice(&mono.dir, &["push", "core", "--yes"]);
    assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);
    assert!(
        res.stdout.to_lowercase().contains("published"),
        "stdout: {}",
        res.stdout
    );

    let pub_repo = TestRepo::new(fx.pub_dir.as_str());
    let subjects = pub_repo.subjects("HEAD");
    assert_eq!(subjects.len(), 1, "subjects: {subjects:?}");
    assert!(
        subjects[0].contains("Initial import"),
        "subject: {}",
        subjects[0]
    );

    assert_eq!(
        pub_repo.tree_sha("HEAD", None),
        mono.tree_sha(&mono_head, Some("core"))
    );

    let messages = pub_repo.messages("HEAD");
    assert!(
        messages[0].contains(&format!("Monosplice-Source: {mono_head}")),
        "message: {}",
        messages[0]
    );

    // the private tree never crosses the boundary
    let entries = pub_repo.tree_entries("HEAD", None);
    assert!(
        !entries.iter().any(|e| e.contains("private/")),
        "entries: {entries:?}"
    );
}

/// S02: the first `push --yes` also works without naming the subrepo.
#[test]
fn s02_first_push_yes_also_works_without_naming_the_subrepo() {
    let fx = standard_fixture();
    let res = run_monosplice(&fx.mono.dir, &["push", "--yes"]);
    assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);
    let subjects = TestRepo::new(fx.pub_dir.as_str()).subjects("HEAD");
    assert_eq!(subjects.len(), 1, "subjects: {subjects:?}");
}

/// S03: `push --yes --export-history` replays every commit touching core with messages, authors
/// and trailers preserved.
#[test]
fn s03_first_push_export_history_replays_every_commit_touching_core() {
    let fx = standard_fixture();
    let mono = &fx.mono;

    mono.commit_as(
        "feat: add util",
        &[("core/src/util.ts", Some("export const n = 1\n"))],
        "Ada Lovelace",
        "ada@example.test",
    );
    mono.commit(
        "chore: private only",
        &[("private/notes.md", Some("nope\n"))],
    );
    mono.commit(
        "fix: tweak readme",
        &[("core/README.md", Some("# core\n\nmore\n"))],
    );

    let res = run_monosplice(&mono.dir, &["push", "core", "--yes", "--export-history"]);
    assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);

    let listed = mono.git(&[
        "rev-list",
        "--reverse",
        "--topo-order",
        "HEAD",
        "--",
        "core",
    ]);
    let mono_core_shas: Vec<String> = listed.split('\n').map(str::to_owned).collect();
    let mono_subjects: Vec<String> = mono_core_shas
        .iter()
        .map(|s| mono.git(&["show", "-s", "--format=%s", s]))
        .collect();

    let pub_repo = TestRepo::new(fx.pub_dir.as_str());
    assert_eq!(pub_repo.subjects("HEAD"), mono_subjects);

    let pub_messages = pub_repo.messages("HEAD");
    assert_eq!(pub_messages.len(), mono_core_shas.len());
    for (i, sha) in mono_core_shas.iter().enumerate() {
        assert!(
            pub_messages[i].contains(&format!("Monosplice-Source: {sha}")),
            "message {i}: {}",
            pub_messages[i]
        );
    }

    let mono_authors: Vec<String> = mono_core_shas
        .iter()
        .map(|s| mono.git(&["show", "-s", "--format=%an <%ae>", s]))
        .collect();
    assert_eq!(pub_repo.authors("HEAD"), mono_authors);

    assert_eq!(
        pub_repo.tree_sha("HEAD", None),
        mono.tree_sha("HEAD", Some("core"))
    );
}

/// S03: `--export-history` is refused once the subrepo is already published.
#[test]
fn s03_export_history_refuses_once_the_subrepo_is_already_published() {
    let fx = standard_fixture();
    let mono = &fx.mono;

    let seed = run_monosplice(&mono.dir, &["push", "core", "--yes"]);
    assert_eq!(seed.exit_code, 0, "stderr: {}", seed.stderr);
    let pub_repo = TestRepo::new(fx.pub_dir.as_str());
    let before = pub_repo.head();

    mono.commit("feat: later", &[("core/later.txt", Some("l\n"))]);
    let res = run_monosplice(&mono.dir, &["push", "core", "--yes", "--export-history"]);
    assert_ne!(res.exit_code, 0, "stdout: {}", res.stdout);
    assert!(
        res.stderr.contains("--export-history"),
        "stderr: {}",
        res.stderr
    );
    assert!(
        res.stderr.to_lowercase().contains("already"),
        "stderr: {}",
        res.stderr
    );
    assert_eq!(pub_repo.head(), before);
}

/// S04: the first push omits excluded files from the baseline tree.
#[test]
fn s04_first_push_honors_exclude_patterns() {
    let fx = standard_fixture_extra(r#"exclude = ["INTERNAL.md", "src/**/*.secret.ts"]"#);
    let mono = &fx.mono;

    mono.commit(
        "feat: internal notes",
        &[
            ("core/INTERNAL.md", Some("do not publish\n")),
            ("core/src/keys.secret.ts", Some("export const k = \"x\"\n")),
            ("core/src/public.ts", Some("export const p = 1\n")),
        ],
    );

    let res = run_monosplice(&mono.dir, &["push", "core", "--yes"]);
    assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);

    let pub_repo = TestRepo::new(fx.pub_dir.as_str());
    let paths = tree_paths(&pub_repo, "HEAD");
    assert!(has(&paths, "src/public.ts"), "paths: {paths:?}");
    assert!(!has(&paths, "INTERNAL.md"), "paths: {paths:?}");
    assert!(!has(&paths, "src/keys.secret.ts"), "paths: {paths:?}");
}

/// S04: excludes are honored with `--export-history` too.
#[test]
fn s04_first_push_honors_exclude_patterns_with_export_history_too() {
    let fx = standard_fixture_extra(r#"exclude = ["INTERNAL.md"]"#);
    let mono = &fx.mono;

    mono.commit(
        "feat: internal notes",
        &[("core/INTERNAL.md", Some("do not publish\n"))],
    );
    mono.commit(
        "feat: public thing",
        &[("core/src/public.ts", Some("export const p = 1\n"))],
    );

    let res = run_monosplice(&mono.dir, &["push", "core", "--yes", "--export-history"]);
    assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);

    let pub_repo = TestRepo::new(fx.pub_dir.as_str());
    let all_entries = pub_repo.tree_entries("HEAD", None);
    assert!(
        !all_entries.iter().any(|e| e.contains("INTERNAL.md")),
        "entries: {all_entries:?}"
    );
    // the commit that only touched an excluded file produced no pub commit
    assert_eq!(
        pub_repo.subjects("HEAD"),
        vec!["chore: initial monorepo", "feat: public thing"]
    );
}

/// S05: pushing against a pub with unrelated history refuses, points at `monosplice attach`, and
/// leaves the remote untouched.
#[test]
fn s05_push_against_a_pub_with_unrelated_history_refuses() {
    let fx = standard_fixture();
    let mono = &fx.mono;

    let ext = make_repo(fx.sandbox.path(), "ext");
    ext.commit("external: hello", &[("HELLO.md", Some("hi\n"))]);
    ext.git(&["remote", "add", "origin", &fx.pub_dir]);
    ext.git(&["push", "origin", "main"]);

    let pub_repo = TestRepo::new(fx.pub_dir.as_str());
    let before = pub_repo.head();

    let cases: [&[&str]; 2] = [&["push"], &["push", "core", "--yes"]];
    for args in cases {
        let res = run_monosplice(&mono.dir, args);
        assert_ne!(
            res.exit_code,
            0,
            "`{}` should have failed, stdout: {}",
            args.join(" "),
            res.stdout
        );
        assert!(
            res.stderr.contains("monosplice attach core"),
            "`{}` stderr: {}",
            args.join(" "),
            res.stderr
        );
        assert_eq!(pub_repo.head(), before);
        assert_eq!(pub_repo.subjects("HEAD"), vec!["external: hello"]);
    }
}

/// S06: a first push when the subrepo path has no committed files errors clearly and pushes
/// nothing.
#[test]
fn s06_first_push_with_no_committed_files_errors_clearly() {
    let (_sb, mono, pub_dir) = dead_end_fixture();

    let res = run_monosplice(&mono.dir, &["push", "core", "--yes"]);
    assert_ne!(res.exit_code, 0, "stdout: {}", res.stdout);
    assert!(
        res.stderr.contains("core"),
        "the error must name the subrepo, got:\n{}",
        res.stderr
    );
    let lowered = res.stderr.to_lowercase();
    assert!(
        lowered.contains("no committed files")
            || lowered.contains("nothing to publish")
            || lowered.contains("nothing exists yet"),
        "stderr: {}",
        res.stderr
    );

    let pub_repo = TestRepo::new(pub_dir.as_str());
    assert_eq!(main_ref(&pub_repo), "");
}

/// S90: a non-interactive first push without `--yes` refuses with the exact command, keeps the
/// remote empty, and still pushes the others.
#[test]
fn s90_non_interactive_first_push_without_yes_refuses_but_pushes_the_others() {
    let fx = multi_fixture();
    let mono = &fx.mono;

    // core is already published; lib is not.
    let seed = run_monosplice(&mono.dir, &["push", "core", "--yes"]);
    assert_eq!(seed.exit_code, 0, "stderr: {}", seed.stderr);
    mono.commit(
        "feat: both",
        &[
            ("core/new.txt", Some("c\n")),
            ("packages/lib/new.txt", Some("l\n")),
        ],
    );

    let res = run_monosplice(&mono.dir, &["push"]);
    assert_ne!(res.exit_code, 0, "stdout: {}", res.stdout);
    assert!(
        res.stderr.contains("monosplice push lib --yes"),
        "stderr: {}",
        res.stderr
    );
    assert!(
        res.stderr.to_lowercase().contains("first"),
        "stderr: {}",
        res.stderr
    );

    // the refusal did not abort the run: core still exported
    assert!(
        res.stdout.contains("core: exported 1 commit"),
        "stdout: {}",
        res.stdout
    );
    assert_eq!(
        fx.core_pub.subjects("HEAD"),
        vec!["Initial import of core", "feat: both"]
    );
    assert!(!fx.core_pub_dir.is_empty());

    // lib's remote is still empty
    assert_eq!(main_ref(&fx.lib_pub), "");
}

/// S90: a single unpublished subrepo is refused too.
#[test]
fn s90_refuses_a_single_unpublished_subrepo_too() {
    let fx = standard_fixture();
    let res = run_monosplice(&fx.mono.dir, &["push"]);
    assert_ne!(res.exit_code, 0, "stdout: {}", res.stdout);
    assert!(
        res.stderr.contains("monosplice push core --yes"),
        "stderr: {}",
        res.stderr
    );
    let pub_repo = TestRepo::new(fx.pub_dir.as_str());
    assert_eq!(main_ref(&pub_repo), "");
}

/// S91: `push --yes` reports the baseline distinctly, is idempotent, and exports later commits
/// per-commit.
#[test]
fn s91_push_yes_baseline_then_normal_exports() {
    let fx = standard_fixture();
    let mono = &fx.mono;
    let pub_repo = TestRepo::new(fx.pub_dir.as_str());

    let first = run_monosplice(&mono.dir, &["push", "--yes"]);
    assert_eq!(first.exit_code, 0, "stderr: {}", first.stderr);
    assert!(
        first.stdout.to_lowercase().contains("published"),
        "stdout: {}",
        first.stdout
    );
    assert!(
        !first.stdout.to_lowercase().contains("exported"),
        "the baseline is a publish, not an export, got:\n{}",
        first.stdout
    );
    assert_eq!(pub_repo.subjects("HEAD"), vec!["Initial import of core"]);

    let again = run_monosplice(&mono.dir, &["push"]);
    assert_eq!(again.exit_code, 0, "stderr: {}", again.stderr);
    assert!(
        again.stdout.contains("up to date"),
        "stdout: {}",
        again.stdout
    );
    assert_eq!(pub_repo.subjects("HEAD"), vec!["Initial import of core"]);

    mono.commit("feat: one", &[("core/one.txt", Some("1\n"))]);
    mono.commit("feat: two", &[("core/two.txt", Some("2\n"))]);
    let later = run_monosplice(&mono.dir, &["push"]);
    assert_eq!(later.exit_code, 0, "stderr: {}", later.stderr);
    assert!(
        later.stdout.contains("exported 2 commit"),
        "stdout: {}",
        later.stdout
    );
    assert_eq!(
        pub_repo.subjects("HEAD"),
        vec!["Initial import of core", "feat: one", "feat: two"]
    );
    assert_eq!(
        pub_repo.tree_sha("HEAD", None),
        mono.tree_sha("HEAD", Some("core"))
    );

    let status = run_monosplice(&mono.dir, &["status"]);
    assert!(
        status.stdout.contains("core: in sync"),
        "stdout: {}",
        status.stdout
    );
}

/// S92: `push --yes --export-history` runs scan hooks per replayed commit and aborts with
/// nothing pushed when one rejects a historical commit.
#[test]
fn s92_export_history_runs_scan_hooks_per_replayed_commit() {
    let fx = standard_fixture_extra(SCAN_FOR_SECRET);
    let mono = &fx.mono;

    mono.commit("feat: safe", &[("core/safe.txt", Some("fine\n"))]);
    // a secret that was committed and later removed: only --export-history sees it
    let leak = mono.commit(
        "feat: oops",
        &[(
            "core/config.ts",
            Some("export const token = \"SECRET-abc\"\n"),
        )],
    );
    mono.commit("fix: remove the secret", &[("core/config.ts", None)]);

    let res = run_monosplice(&mono.dir, &["push", "core", "--yes", "--export-history"]);
    assert_ne!(res.exit_code, 0, "stdout: {}", res.stdout);
    assert!(
        res.stderr.contains("possible secret in config.ts"),
        "stderr: {}",
        res.stderr
    );
    assert!(
        res.stderr.contains(&leak),
        "the error must name the offending commit {leak}, got:\n{}",
        res.stderr
    );

    let pub_repo = TestRepo::new(fx.pub_dir.as_str());
    assert_eq!(main_ref(&pub_repo), "");

    // the baseline (current tree, secret already gone) still publishes fine
    let baseline = run_monosplice(&mono.dir, &["push", "core", "--yes"]);
    assert_eq!(baseline.exit_code, 0, "stderr: {}", baseline.stderr);
    assert_eq!(pub_repo.subjects("HEAD"), vec!["Initial import of core"]);
}

/// S99: an empty subrepo dir and an empty remote give the same "nothing exists yet" error from
/// every command.
#[test]
fn s99_empty_subrepo_dir_and_empty_remote_give_one_shared_error() {
    // `_sb` is the drop guard: it has to outlive every run below.
    let (_sb, mono, _pub_dir) = dead_end_fixture();

    let cases: [&[&str]; 5] = [
        &["push", "core", "--yes"],
        &["push"],
        &["pull"],
        &["sync"],
        &["attach", "core"],
    ];
    for args in cases {
        let res = run_monosplice(&mono.dir, args);
        assert_ne!(
            res.exit_code,
            0,
            "`{}` should have failed, stdout: {}",
            args.join(" "),
            res.stdout
        );
        assert!(
            res.stderr.to_lowercase().contains("nothing exists yet"),
            "`{}` stderr: {}",
            args.join(" "),
            res.stderr
        );
        assert!(
            res.stderr.contains("core"),
            "`{}` stderr: {}",
            args.join(" "),
            res.stderr
        );
    }
}
