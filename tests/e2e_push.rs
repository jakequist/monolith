//! e2e: `monosplice push` — port of `test/e2e/push.test.ts`.
//!
//! Adapted per `docs/rust-port.md`: config is `monosplice.toml` and the JS function hooks
//! (`rewriteMessage`, `scan`, `transform`) become shell commands run against the materialized
//! outgoing tree. Each hook below reproduces the observable outcome of the TS closure it
//! replaces, so the assertions port unchanged.

mod common;

use std::os::unix::fs::PermissionsExt as _;

use common::{
    clone_remote, run_monosplice, standard_fixture_extra, subrepo_block, toml_str, write_config,
    Fixture, TestRepo,
};

/// TS: `scan: (files) => { for ([p, f] of files) if (f.data.includes('SECRET')) throw ... }`.
///
/// Same observable outcome from a shell hook: the first file in the materialized outgoing tree
/// whose content mentions `SECRET` aborts the export, and the detail the `HookError` carries is
/// the TS message verbatim.
const SCAN_FOR_SECRET: &str = r#"scan = 'hit=$(grep -rl SECRET . 2>/dev/null | head -n 1); if [ -n "$hit" ]; then echo "possible secret in ${hit#./}" >&2; exit 1; fi'"#;

/// TS: `rewriteMessage: (message) => message.replace(/\n[\s\S]*$/, '') + ' [oss]'` — i.e. the
/// first line plus a suffix. The message arrives on stdin, the rewrite leaves on stdout.
const REWRITE_MESSAGE_OSS: &str = r#"rewrite-message = 'printf "%s [oss]" "$(head -n 1)"'"#;

/// TS: `transform: (files) => files.set('README.md', banner + previous README)`. The hook runs
/// with the materialized outgoing tree as cwd, so the same edit is a plain file rewrite.
const TRANSFORM_BANNER: &str = r#"transform = 'if [ -f README.md ]; then { printf "<!-- published by monosplice -->\n"; cat README.md; } > .banner.tmp && mv .banner.tmp README.md; fi'"#;

/// Seed the fixture and return it alongside a `TestRepo` view of the bare public remote.
fn seeded() -> (Fixture, TestRepo) {
    seeded_extra("")
}

/// [`seeded`] with extra TOML lines inside the `core` `[[subrepos]]` block.
fn seeded_extra(config_extra: &str) -> (Fixture, TestRepo) {
    let fixture = standard_fixture_extra(config_extra);
    let res = run_monosplice(&fixture.mono.dir, &["push", "core", "--yes"]);
    assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);
    let pub_repo = TestRepo::new(fixture.pub_dir.as_str());
    (fixture, pub_repo)
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

/// S10: one new mono commit touching core creates one pub commit with the same message,
/// author, subtree and a source trailer.
#[test]
fn s10_one_new_mono_commit_creates_one_pub_commit() {
    let (fx, pub_repo) = seeded();
    let mono = &fx.mono;

    let mono_sha = mono.commit_as(
        "feat: add greeter",
        &[(
            "core/src/greet.ts",
            Some("export const greet = () => \"hi\"\n"),
        )],
        "Ada Lovelace",
        "ada@example.test",
    );

    let res = run_monosplice(&mono.dir, &["push"]);
    assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);
    assert!(
        res.stdout.contains("exported 1 commit"),
        "stdout: {}",
        res.stdout
    );

    let subjects = pub_repo.subjects("HEAD");
    assert_eq!(subjects.len(), 2, "subjects: {subjects:?}");
    assert_eq!(subjects[1], "feat: add greeter");

    let authors = pub_repo.authors("HEAD");
    assert_eq!(authors[1], "Ada Lovelace <ada@example.test>");

    let messages = pub_repo.messages("HEAD");
    assert!(
        messages[1].contains(&format!("Monosplice-Source: {mono_sha}")),
        "message: {}",
        messages[1]
    );

    assert_eq!(
        pub_repo.tree_sha("HEAD", None),
        mono.tree_sha("HEAD", Some("core"))
    );
}

/// S11: commits touching only private dirs export nothing.
#[test]
fn s11_commits_touching_only_private_dirs_export_nothing() {
    let (fx, pub_repo) = seeded();
    let mono = &fx.mono;

    let before = pub_repo.head();
    mono.commit(
        "chore: website copy",
        &[("website/index.html", Some("<p>hi</p>\n"))],
    );

    let res = run_monosplice(&mono.dir, &["push"]);
    assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);
    assert!(res.stdout.contains("up to date"), "stdout: {}", res.stdout);
    assert_eq!(pub_repo.head(), before);
}

/// S12: a commit spanning core and private dirs exports only the core subtree and never ships
/// private blobs.
#[test]
fn s12_commit_spanning_core_and_private_exports_only_the_core_subtree() {
    let (fx, pub_repo) = seeded();
    let mono = &fx.mono;

    let private_content = "super private payload 4f2a\n";
    mono.commit(
        "feat: cross-cutting change",
        &[
            ("core/src/shared.ts", Some("export const shared = true\n")),
            ("private/plan.md", Some(private_content)),
        ],
    );

    let res = run_monosplice(&mono.dir, &["push"]);
    assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);

    assert_eq!(
        pub_repo.tree_sha("HEAD", None),
        mono.tree_sha("HEAD", Some("core"))
    );
    let paths = tree_paths(&pub_repo, "HEAD");
    assert!(has(&paths, "src/shared.ts"), "paths: {paths:?}");
    assert!(
        !paths.iter().any(|p| p.contains("plan.md")),
        "paths: {paths:?}"
    );

    let private_blob = mono.git_with(&["hash-object", "--stdin"], &[], Some(private_content));
    // sanity: the blob really is in the monorepo
    mono.git(&["cat-file", "-e", &private_blob]);
    let in_pub = pub_repo.git_try(&["cat-file", "-e", &private_blob]);
    assert_ne!(
        in_pub.exit_code, 0,
        "the private blob must not exist in pub (stdout: {})",
        in_pub.stdout
    );
}

/// S13: multiple pending commits export in monorepo order.
#[test]
fn s13_multiple_pending_commits_export_in_monorepo_order() {
    let (fx, pub_repo) = seeded();
    let mono = &fx.mono;

    mono.commit("feat: one", &[("core/one.txt", Some("1\n"))]);
    mono.commit("chore: private churn", &[("private/x.md", Some("x\n"))]);
    mono.commit("feat: two", &[("core/two.txt", Some("2\n"))]);
    mono.commit("feat: three", &[("core/three.txt", Some("3\n"))]);

    let res = run_monosplice(&mono.dir, &["push"]);
    assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);
    assert!(
        res.stdout.contains("exported 3 commit"),
        "stdout: {}",
        res.stdout
    );

    assert_eq!(
        pub_repo.subjects("HEAD"),
        vec![
            "Initial import of core",
            "feat: one",
            "feat: two",
            "feat: three"
        ]
    );
    assert_eq!(
        pub_repo.tree_sha("HEAD", None),
        mono.tree_sha("HEAD", Some("core"))
    );
}

/// S14: pushing twice is a no-op the second time.
#[test]
fn s14_push_twice_is_a_no_op_the_second_time() {
    let (fx, pub_repo) = seeded();
    let mono = &fx.mono;

    mono.commit("feat: one", &[("core/one.txt", Some("1\n"))]);

    let first = run_monosplice(&mono.dir, &["push"]);
    assert_eq!(first.exit_code, 0, "stderr: {}", first.stderr);
    let head = pub_repo.head();
    let count = pub_repo.subjects("HEAD").len();

    let second = run_monosplice(&mono.dir, &["push"]);
    assert_eq!(second.exit_code, 0, "stderr: {}", second.stderr);
    assert!(
        second.stdout.contains("up to date"),
        "stdout: {}",
        second.stdout
    );
    assert_eq!(pub_repo.head(), head);
    assert_eq!(pub_repo.subjects("HEAD").len(), count);
}

/// S15: commits that only touch excluded files are skipped, and the excluded files are never
/// exported.
#[test]
fn s15_excluded_files_on_push_are_skipped_and_never_exported() {
    let (fx, pub_repo) = seeded_extra(r#"exclude = ["INTERNAL.md"]"#);
    let mono = &fx.mono;

    let before = pub_repo.head();

    mono.commit(
        "chore: internal notes",
        &[("core/INTERNAL.md", Some("v1\n"))],
    );
    let only_excluded = run_monosplice(&mono.dir, &["push"]);
    assert_eq!(
        only_excluded.exit_code, 0,
        "stderr: {}",
        only_excluded.stderr
    );
    assert!(
        only_excluded.stdout.contains("up to date"),
        "stdout: {}",
        only_excluded.stdout
    );
    assert_eq!(pub_repo.head(), before);

    mono.commit(
        "chore: update internal notes",
        &[("core/INTERNAL.md", Some("v2\n"))],
    );
    let still_excluded = run_monosplice(&mono.dir, &["push"]);
    assert_eq!(
        still_excluded.exit_code, 0,
        "stderr: {}",
        still_excluded.stderr
    );
    assert_eq!(pub_repo.head(), before);

    mono.commit(
        "feat: real change",
        &[
            ("core/INTERNAL.md", Some("v3\n")),
            ("core/real.txt", Some("real\n")),
        ],
    );
    let mixed = run_monosplice(&mono.dir, &["push"]);
    assert_eq!(mixed.exit_code, 0, "stderr: {}", mixed.stderr);
    assert!(
        mixed.stdout.contains("exported 1 commit"),
        "stdout: {}",
        mixed.stdout
    );
    assert_eq!(
        pub_repo.subjects("HEAD"),
        vec!["Initial import of core", "feat: real change"]
    );
    let paths = tree_paths(&pub_repo, "HEAD");
    assert!(has(&paths, "real.txt"), "paths: {paths:?}");
    assert!(!has(&paths, "INTERNAL.md"), "paths: {paths:?}");
}

/// S16: the `rewrite-message` hook applies to exported commit messages (trailers are still
/// appended afterwards).
#[test]
fn s16_rewrite_message_hook_applies_to_exported_commit_messages() {
    let (fx, pub_repo) = seeded_extra(REWRITE_MESSAGE_OSS);
    let mono = &fx.mono;

    mono.commit("feat: hooked", &[("core/hooked.txt", Some("yes\n"))]);

    let res = run_monosplice(&mono.dir, &["push"]);
    assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);

    let subjects = pub_repo.subjects("HEAD");
    assert_eq!(
        subjects.last().map(String::as_str),
        Some("feat: hooked [oss]"),
        "subjects: {subjects:?}"
    );
    let messages = pub_repo.messages("HEAD");
    assert!(
        messages
            .last()
            .is_some_and(|m| m.contains("Monosplice-Source: ")),
        "messages: {messages:?}"
    );
}

/// S17: a pure import is a tree-no-op on push, so it produces no ping-pong duplicates in pub.
#[test]
fn s17_pure_imports_are_tree_no_ops_on_push() {
    let (fx, pub_repo) = seeded();
    let mono = &fx.mono;

    let ext = clone_remote(fx.sandbox.path(), &fx.pub_dir, "ext");
    ext.commit(
        "external: add EXTERNAL.md",
        &[("EXTERNAL.md", Some("from outside\n"))],
    );
    ext.git(&["push", "origin", "main"]);

    let pull = run_monosplice(&mono.dir, &["pull"]);
    assert_eq!(pull.exit_code, 0, "stderr: {}", pull.stderr);
    let pub_head_after_import = pub_repo.head();

    let res = run_monosplice(&mono.dir, &["push"]);
    assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);
    assert!(res.stdout.contains("up to date"), "stdout: {}", res.stdout);

    // The import reproduced the pub tip's tree, so it exports as nothing at all.
    assert_eq!(pub_repo.head(), pub_head_after_import);
    assert_eq!(
        pub_repo.subjects("HEAD"),
        vec!["Initial import of core", "external: add EXTERNAL.md"]
    );
    assert_eq!(
        pub_repo.tree_sha("HEAD", None),
        mono.tree_sha("HEAD", Some("core"))
    );

    // Later local work still exports normally, exactly once.
    mono.commit("feat: local work", &[("core/local.txt", Some("local\n"))]);
    let second = run_monosplice(&mono.dir, &["push"]);
    assert_eq!(second.exit_code, 0, "stderr: {}", second.stderr);
    assert!(
        second.stdout.contains("exported 1 commit"),
        "stdout: {}",
        second.stdout
    );
    assert_eq!(
        pub_repo.subjects("HEAD"),
        vec![
            "Initial import of core",
            "external: add EXTERNAL.md",
            "feat: local work"
        ]
    );
}

/// S18: binary files, renames and deletions replay with exact tree fidelity.
#[test]
fn s18_binary_files_renames_and_deletions_replay_with_exact_tree_fidelity() {
    let (fx, pub_repo) = seeded();
    let mono = &fx.mono;

    let binary: [u8; 9] = [0x00, 0xff, 0xfe, 0x01, 0x80, 0x7f, 0x00, 0xc3, 0x28];
    mono.write_bytes("core/assets/logo.bin", &binary);
    mono.commit("feat: add binary asset", &[]);
    let mut res = run_monosplice(&mono.dir, &["push"]);
    assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);
    assert_eq!(
        pub_repo.tree_sha("HEAD", None),
        mono.tree_sha("HEAD", Some("core"))
    );

    mono.git(&["mv", "core/README.md", "core/DOCS.md"]);
    mono.commit("refactor: rename readme", &[]);
    res = run_monosplice(&mono.dir, &["push"]);
    assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);
    assert_eq!(
        pub_repo.tree_sha("HEAD", None),
        mono.tree_sha("HEAD", Some("core"))
    );

    mono.commit("chore: drop index", &[("core/src/index.ts", None)]);
    res = run_monosplice(&mono.dir, &["push"]);
    assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);
    assert_eq!(
        pub_repo.tree_sha("HEAD", None),
        mono.tree_sha("HEAD", Some("core"))
    );

    let paths = tree_paths(&pub_repo, "HEAD");
    assert!(has(&paths, "DOCS.md"), "paths: {paths:?}");
    assert!(has(&paths, "assets/logo.bin"), "paths: {paths:?}");
    assert!(!has(&paths, "src/index.ts"), "paths: {paths:?}");
}

/// S19: the executable bit and symlinks are preserved in exported trees.
#[test]
fn s19_executable_bit_and_symlinks_are_preserved() {
    let (fx, pub_repo) = seeded();
    let mono = &fx.mono;

    mono.write("core/bin/tool.sh", "#!/bin/sh\necho hi\n");
    let tool = mono.dir.join("core/bin/tool.sh");
    std::fs::set_permissions(&tool, std::fs::Permissions::from_mode(0o755))
        .unwrap_or_else(|e| panic!("chmod {}: {e}", tool.display()));
    std::os::unix::fs::symlink("bin/tool.sh", mono.dir.join("core/tool-link"))
        .unwrap_or_else(|e| panic!("symlink core/tool-link: {e}"));
    mono.commit("feat: tool and link", &[]);

    let res = run_monosplice(&mono.dir, &["push"]);
    assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);

    let entries = pub_repo.tree_entries("HEAD", None);
    assert!(
        entries
            .iter()
            .any(|e| e.starts_with("100755 ") && e.ends_with("bin/tool.sh")),
        "entries: {entries:?}"
    );
    assert!(
        entries
            .iter()
            .any(|e| e.starts_with("120000 ") && e.ends_with("tool-link")),
        "entries: {entries:?}"
    );
    assert_eq!(
        pub_repo.tree_sha("HEAD", None),
        mono.tree_sha("HEAD", Some("core"))
    );
}

/// S20: an unimported external commit in pub makes push refuse and tell the user to pull first.
#[test]
fn s20_unimported_external_commit_in_pub_refuses_the_push() {
    let (fx, pub_repo) = seeded();
    let mono = &fx.mono;

    let ext = clone_remote(fx.sandbox.path(), &fx.pub_dir, "ext");
    ext.commit(
        "external: drive-by fix",
        &[("EXTERNAL.md", Some("from outside\n"))],
    );
    ext.git(&["push", "origin", "main"]);
    let pub_head_before = pub_repo.head();

    mono.commit("feat: local work", &[("core/local.txt", Some("local\n"))]);

    let res = run_monosplice(&mono.dir, &["push"]);
    assert_ne!(res.exit_code, 0, "stdout: {}", res.stdout);
    assert!(
        res.stderr.to_lowercase().contains("pull"),
        "the error must send the user to pull, got:\n{}",
        res.stderr
    );
    assert!(
        res.stderr.contains('1'),
        "the error must count the unimported commit, got:\n{}",
        res.stderr
    );
    assert_eq!(pub_repo.head(), pub_head_before);
    assert_eq!(
        pub_repo.subjects("HEAD"),
        vec!["Initial import of core", "external: drive-by fix"]
    );
}

/// S21: a `scan` hook rejection aborts before any ref update on pub and names the offending
/// commit and file.
#[test]
fn s21_scan_hook_rejects_a_commit_and_nothing_is_pushed() {
    let (fx, pub_repo) = seeded_extra(SCAN_FOR_SECRET);
    let mono = &fx.mono;

    let before = pub_repo.head();

    mono.commit("feat: safe change", &[("core/safe.txt", Some("fine\n"))]);
    let leak = mono.commit(
        "feat: oops",
        &[(
            "core/config.ts",
            Some("export const token = \"SECRET-abc\"\n"),
        )],
    );
    mono.commit(
        "feat: after the leak",
        &[("core/after.txt", Some("later\n"))],
    );

    let res = run_monosplice(&mono.dir, &["push"]);
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

    // nothing partial: not even the safe commit preceding the leak was pushed
    assert_eq!(pub_repo.head(), before);
    assert_eq!(pub_repo.subjects("HEAD"), vec!["Initial import of core"]);
}

/// S22: the `transform` hook mutates the exported tree without affecting the monorepo.
#[test]
fn s22_transform_hook_mutates_the_exported_tree_only() {
    let (fx, pub_repo) = seeded_extra(TRANSFORM_BANNER);
    let mono = &fx.mono;

    mono.commit(
        "docs: update readme",
        &[("core/README.md", Some("# core\n\ninternal wording\n"))],
    );

    let res = run_monosplice(&mono.dir, &["push"]);
    assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);
    assert!(
        res.stdout.contains("exported 1 commit"),
        "stdout: {}",
        res.stdout
    );

    assert_eq!(
        pub_repo.file_at("HEAD", "README.md"),
        "<!-- published by monosplice -->\n# core\n\ninternal wording"
    );
    assert_eq!(mono.read("core/README.md"), "# core\n\ninternal wording\n");
    assert_eq!(
        mono.file_at("HEAD", "core/README.md"),
        "# core\n\ninternal wording"
    );
    assert_ne!(
        pub_repo.tree_sha("HEAD", None),
        mono.tree_sha("HEAD", Some("core"))
    );
}

/// S82: an unreachable remote surfaces the git error cleanly.
#[test]
fn s82_unreachable_remote_surfaces_the_git_error_cleanly() {
    let (fx, _pub_repo) = seeded();
    let mono = &fx.mono;

    let nope = fx.sandbox.path().join("nope.git");
    let block = subrepo_block(&[
        ("name", &toml_str("core")),
        ("path", &toml_str("core")),
        ("remote", &toml_str(&nope.to_string_lossy())),
    ]);
    write_config(mono, &[&block]);

    let res = run_monosplice(&mono.dir, &["push"]);
    assert_ne!(res.exit_code, 0, "stdout: {}", res.stdout);
    assert!(
        res.stderr.contains("nope.git"),
        "the error must name the remote, got:\n{}",
        res.stderr
    );
}
