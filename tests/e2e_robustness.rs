//! e2e: odd repo and config states — port of `test/e2e/robustness.test.ts` (S80–S84).
//!
//! Adapted per `docs/rust-port.md`: the config is `monosplice.toml`, so the "config that
//! throws on load" is a TOML syntax error and the field paths are TOML-ish
//! (`subrepos[0].path`), and a missing key is reported by the loader rather than by zod.

mod common;

use common::{
    clone_remote, make_repo, run_monosplice, sandbox, standard_fixture, subrepo_block, toml_str,
    write_config, Fixture, TestRepo,
};

const CONFIG: &str = "monosplice.toml";

struct Seeded {
    fx: Fixture,
    pub_repo: TestRepo,
}

fn seeded() -> Seeded {
    let fx = standard_fixture();
    let res = run_monosplice(&fx.mono.dir, &["push", "core", "--yes"]);
    assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);
    let pub_repo = TestRepo::new(&fx.pub_dir);
    Seeded { fx, pub_repo }
}

/// The path `monosplice.toml` is reported at, as it appears in an error message.
fn config_path(mono: &TestRepo) -> String {
    mono.dir.join(CONFIG).to_string_lossy().into_owned()
}

/// Rewrite the config with a single `core` entry pointing at `remote`, plus extra TOML lines.
fn rewrite_core_config(mono: &TestRepo, remote: &str, extra: &[(&str, &str)]) {
    let mut fields: Vec<(&str, String)> = vec![
        ("name", toml_str("core")),
        ("path", toml_str("core")),
        ("remote", toml_str(remote)),
    ];
    for (key, value) in extra {
        fields.push((key, (*value).to_string()));
    }
    let rendered: Vec<(&str, &str)> = fields.iter().map(|(k, v)| (*k, v.as_str())).collect();
    write_config(mono, &[&subrepo_block(&rendered)]);
}

// ---------------------------------------------------------------------------------------
// S80: running outside a monosplice-configured repo
// ---------------------------------------------------------------------------------------

/// S80: every command names the config file and `monosplice init`.
#[test]
fn s80_fails_with_a_helpful_error_naming_the_config_file_and_monosplice_init() {
    let sb = sandbox();
    let plain = make_repo(sb.path(), "plain");

    for args in [["status"], ["push"], ["pull"], ["doctor"]] {
        let res = run_monosplice(&plain.dir, &args);
        assert_ne!(
            res.exit_code, 0,
            "{} should have failed, stdout: {}",
            args[0], res.stdout
        );
        assert!(
            res.stderr.contains(CONFIG),
            "{} must name the config file, got:\n{}",
            args[0],
            res.stderr
        );
        assert!(
            res.stderr.contains("monosplice init"),
            "{} must name `monosplice init`, got:\n{}",
            args[0],
            res.stderr
        );
    }
}

/// S80: the same error outside a git repository altogether.
#[test]
fn s80_fails_the_same_way_in_a_directory_that_is_not_a_git_repo_at_all() {
    let sb = sandbox();
    let res = run_monosplice(sb.path(), &["status"]);
    assert_ne!(res.exit_code, 0, "stdout: {}", res.stdout);
    assert!(res.stderr.contains(CONFIG), "got:\n{}", res.stderr);
    assert!(
        res.stderr.contains("monosplice init"),
        "got:\n{}",
        res.stderr
    );
}

// ---------------------------------------------------------------------------------------
// S81: invalid config
// ---------------------------------------------------------------------------------------

/// S81: a subrepo path of `/` names the field and the file.
#[test]
fn s81_rejects_a_subrepo_path_of_slash_and_names_the_field_and_file() {
    let seeded = seeded();
    let mono = &seeded.fx.mono;
    write_config(
        mono,
        &[&subrepo_block(&[
            ("name", &toml_str("core")),
            ("path", &toml_str("/")),
            ("remote", &toml_str(&seeded.fx.pub_dir)),
        ])],
    );

    let res = run_monosplice(&mono.dir, &["status"]);
    assert_ne!(res.exit_code, 0, "stdout: {}", res.stdout);
    assert!(
        res.stderr.contains("subrepos[0].path"),
        "got:\n{}",
        res.stderr
    );
    assert!(
        res.stderr.contains(&config_path(mono)),
        "got:\n{}",
        res.stderr
    );
    assert!(res.stderr.contains("repo root"), "got:\n{}", res.stderr);
}

/// S81: a missing `remote` names the key and the file.
#[test]
fn s81_rejects_a_missing_remote_and_names_the_field_and_the_file() {
    let seeded = seeded();
    let mono = &seeded.fx.mono;
    write_config(
        mono,
        &[&subrepo_block(&[
            ("name", &toml_str("core")),
            ("path", &toml_str("core")),
        ])],
    );

    let res = run_monosplice(&mono.dir, &["push"]);
    assert_ne!(res.exit_code, 0, "stdout: {}", res.stdout);
    assert!(
        res.stderr.contains("missing field `remote`"),
        "got:\n{}",
        res.stderr
    );
    assert!(
        res.stderr.contains("[[subrepos]]"),
        "the error must point at the entry it read, got:\n{}",
        res.stderr
    );
    assert!(
        res.stderr.contains(&config_path(mono)),
        "got:\n{}",
        res.stderr
    );
}

/// S81: a malformed `exclude` entry is named down to its index.
#[test]
fn s81_rejects_a_malformed_exclude_entry_and_names_it() {
    let seeded = seeded();
    let mono = &seeded.fx.mono;
    let pub_dir = seeded.fx.pub_dir.clone();
    rewrite_core_config(mono, &pub_dir, &[("exclude", "[\"\"]")]);

    let res = run_monosplice(&mono.dir, &["status"]);
    assert_ne!(res.exit_code, 0, "stdout: {}", res.stdout);
    assert!(
        res.stderr.contains("subrepos[0].exclude[0]"),
        "got:\n{}",
        res.stderr
    );
}

/// S81: a config that will not parse is reported as an invalid config, naming the file.
#[test]
fn s81_reports_a_config_that_will_not_parse_naming_the_file() {
    let seeded = seeded();
    let mono = &seeded.fx.mono;
    mono.write(CONFIG, "[[subrepos]\npath = 'core' this is not valid ,,,\n");

    let res = run_monosplice(&mono.dir, &["status"]);
    assert_ne!(res.exit_code, 0, "stdout: {}", res.stdout);
    assert!(
        res.stderr.contains("Invalid config at"),
        "got:\n{}",
        res.stderr
    );
    assert!(
        res.stderr.contains("TOML parse error"),
        "got:\n{}",
        res.stderr
    );
    assert!(
        res.stderr.contains(&config_path(mono)),
        "got:\n{}",
        res.stderr
    );
}

// ---------------------------------------------------------------------------------------
// S82: unreachable remote
// ---------------------------------------------------------------------------------------

/// S82: pull, status and doctor all report it cleanly, and nothing is half-written.
#[test]
fn s82_is_reported_cleanly_by_pull_status_and_doctor_with_no_partial_state() {
    let seeded = seeded();
    let mono = &seeded.fx.mono;
    let missing = seeded.fx.sandbox.path().join("gone.git");
    let missing = missing.to_string_lossy().into_owned();
    rewrite_core_config(mono, &missing, &[]);
    let head_before = mono.head();

    for args in [["pull"], ["status"]] {
        let res = run_monosplice(&mono.dir, &args);
        assert_ne!(
            res.exit_code, 0,
            "{} should have failed, stdout: {}",
            args[0], res.stdout
        );
        assert!(
            res.stderr.contains("cannot reach remote"),
            "{} must say it cannot reach the remote, got:\n{}",
            args[0],
            res.stderr
        );
        assert!(
            res.stderr.contains("gone.git"),
            "{} must name the remote, got:\n{}",
            args[0],
            res.stderr
        );
    }

    let doctor = run_monosplice(&mono.dir, &["doctor"]);
    assert_ne!(doctor.exit_code, 0, "stdout: {}", doctor.stdout);
    assert!(
        doctor.stdout.contains("gone.git"),
        "got:\n{}",
        doctor.stdout
    );

    // Only the config edit this test made; nothing was written under the subrepo.
    assert_eq!(mono.head(), head_before);
    assert_eq!(mono.git(&["status", "--porcelain", "--", "core"]), "");
}

// ---------------------------------------------------------------------------------------
// S83: .gitignore handling
// ---------------------------------------------------------------------------------------

/// S83: the subrepo's own `.gitignore` is exported; the monorepo root's never is.
#[test]
fn s83_exports_the_subrepo_gitignore_and_ignored_but_tracked_files_never_the_root_one() {
    let seeded = seeded();
    let mono = &seeded.fx.mono;

    mono.commit(
        "chore: ignore rules",
        &[
            (".gitignore", Some("*.log\nnode_modules/\n")),
            ("core/.gitignore", Some("dist/\n*.tmp\n")),
        ],
    );

    // Ignored by the ROOT rule, but tracked on purpose — it must still be published.
    mono.write("core/debug.log", "captured output\n");
    mono.git(&["add", "-f", "core/debug.log"]);
    mono.commit("chore: keep a sample log", &[]);

    let res = run_monosplice(&mono.dir, &["push"]);
    assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);

    let mut paths: Vec<String> = seeded
        .pub_repo
        .tree_entries("HEAD", None)
        .iter()
        .filter_map(|e| e.split(' ').nth(2).map(str::to_owned))
        .collect();
    paths.sort();
    assert!(paths.iter().any(|p| p == ".gitignore"), "paths: {paths:?}");
    assert!(paths.iter().any(|p| p == "debug.log"), "paths: {paths:?}");

    // The pub `.gitignore` is core's, not the monorepo root's.
    assert_eq!(
        seeded.pub_repo.file_at("HEAD", ".gitignore"),
        "dist/\n*.tmp"
    );
    assert_eq!(
        seeded.pub_repo.tree_sha("HEAD", None),
        mono.tree_sha("HEAD", Some("core"))
    );
}

// ---------------------------------------------------------------------------------------
// S84: unicode round-trip
// ---------------------------------------------------------------------------------------

const UNICODE_FILE: &str = "ünïcødé-文件.md";
const UNICODE_CONTENT: &str = "# Ünïcødé 文件\n\nrésumé — naïve — 世界 🌍\n";

/// S84: unicode filenames, contents and messages survive the export.
#[test]
fn s84_exports_unicode_filenames_contents_and_messages_intact() {
    let seeded = seeded();
    let mono = &seeded.fx.mono;
    mono.commit(
        "feat: 追加 émoji 🎉 support",
        &[(&format!("core/{UNICODE_FILE}"), Some(UNICODE_CONTENT))],
    );

    let res = run_monosplice(&mono.dir, &["push"]);
    assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);

    assert_eq!(
        seeded.pub_repo.tree_sha("HEAD", None),
        mono.tree_sha("HEAD", Some("core"))
    );
    assert_eq!(
        seeded.pub_repo.file_at("HEAD", UNICODE_FILE),
        UNICODE_CONTENT.trim_end()
    );

    let subjects = seeded.pub_repo.subjects("HEAD");
    assert_eq!(
        subjects.last().map(String::as_str),
        Some("feat: 追加 émoji 🎉 support")
    );
}

/// S84: and the same on the way in, with a byte-identical round trip back out.
#[test]
fn s84_imports_unicode_filenames_contents_and_messages_intact() {
    let seeded = seeded();
    let mono = &seeded.fx.mono;
    let ext_file = "døcs/naïve-テスト.txt";
    let ext_content = "contribución externa — 貢献 ✨\n";

    let ext = clone_remote(seeded.fx.sandbox.path(), &seeded.fx.pub_dir, "ext");
    ext.commit("外部: añadir 🚀 docs", &[(ext_file, Some(ext_content))]);
    ext.git(&["push", "origin", "main"]);
    let ext_sha = ext.head();

    let res = run_monosplice(&mono.dir, &["pull"]);
    assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);
    assert!(
        res.stdout.contains("imported 1 commit"),
        "got:\n{}",
        res.stdout
    );

    assert_eq!(mono.read(&format!("core/{ext_file}")), ext_content);
    let subjects = mono.subjects("HEAD");
    assert_eq!(
        subjects.last().map(String::as_str),
        Some("外部: añadir 🚀 docs")
    );
    let messages = mono.messages("HEAD");
    assert!(
        messages
            .last()
            .is_some_and(|m| m.contains(&format!("Monosplice-Origin: {ext_sha}"))),
        "messages: {messages:?}"
    );

    // …and the round trip back out is a no-op, byte for byte.
    let back = run_monosplice(&mono.dir, &["push"]);
    assert_eq!(back.exit_code, 0, "stderr: {}", back.stderr);
    assert!(back.stdout.contains("up to date"), "got:\n{}", back.stdout);
    assert_eq!(
        seeded.pub_repo.tree_sha("HEAD", None),
        mono.tree_sha("HEAD", Some("core"))
    );
}
