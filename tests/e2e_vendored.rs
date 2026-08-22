//! e2e: vendoring a third-party repo with `monosplice attach` — port of
//! `test/e2e/vendored.test.ts`.
//!
//! The situation the retired `vendor` command existed for: a monorepo with nothing configured
//! and a third-party repo that has its own history. Per `docs/rust-port.md` the config is
//! `monosplice.toml`, so the entry `attach` writes is asserted as the `[[subrepos]]` block
//! `src/core/vendor.rs::render_subrepo_entry` renders.

mod common;

use common::{
    make_bare_remote, make_repo, run_monosplice, sandbox, toml_str, write_config, Sandbox, TestRepo,
};

const UP_NAME: &str = "Lo Dash";
const UP_EMAIL: &str = "lodash@example.test";

struct Fixture {
    sandbox: Sandbox,
    mono: TestRepo,
    /// Bare "lodash.git" acting as the third-party remote.
    up_dir: String,
    up: TestRepo,
    pub_repo: TestRepo,
    pub_head: String,
}

fn vendor_fixture() -> Fixture {
    let sb = sandbox();
    let mono = make_repo(sb.path(), "mono");
    write_config(&mono, &[]);
    mono.commit(
        "chore: initial monorepo",
        &[
            ("app/main.ts", Some("export const app = true\n")),
            ("private/secrets.md", Some("internal only\n")),
        ],
    );

    let up_dir = make_bare_remote(sb.path(), "lodash");
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
    up.commit_as(
        "lodash: add map",
        &[("map.js", Some("exports.map = 1\n"))],
        UP_NAME,
        UP_EMAIL,
    );
    up.git(&["remote", "add", "origin", &up_dir]);
    up.git(&["push", "origin", "main"]);

    let pub_repo = TestRepo::new(&up_dir);
    let pub_head = pub_repo.head();
    Fixture {
        sandbox: sb,
        mono,
        up_dir,
        up,
        pub_repo,
        pub_head,
    }
}

/// Attach the fixture's remote and assert it worked, so later scenarios start from sync.
fn vendored() -> Fixture {
    let fx = vendor_fixture();
    let res = run_monosplice(&fx.mono.dir, &["attach", "vendor/lodash", &fx.up_dir]);
    assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);
    fx
}

/// The config as text — the file every refusal promises to leave byte-identical.
fn config_text(mono: &TestRepo) -> String {
    mono.read("monosplice.toml")
}

/// First ten characters of a sha, the way `adopt_message` abbreviates it.
fn short(sha: &str) -> String {
    sha.chars().take(10).collect()
}

/// A bare remote with one commit, for the collision and nesting scenarios.
fn other_remote(fx: &Fixture, name: &str) -> String {
    let dir = make_bare_remote(fx.sandbox.path(), name);
    let src = make_repo(fx.sandbox.path(), &format!("{name}-src"));
    src.commit_as(
        &format!("{name}: initial"),
        &[("a.txt", Some("a\n"))],
        UP_NAME,
        UP_EMAIL,
    );
    src.git(&["remote", "add", "origin", &dir]);
    src.git(&["push", "origin", "main"]);
    dir
}

// ===========================================================================================
// S100: attach a third-party repo into vendor/
// ===========================================================================================

/// S100: the tree and the config entry land in ONE commit, and the pair is in sync.
#[test]
fn s100_creates_the_tree_and_the_config_entry_in_one_commit_and_lands_in_sync() {
    let fx = vendor_fixture();
    let mono_before = fx.mono.subjects("HEAD").len();

    let res = run_monosplice(&fx.mono.dir, &["attach", "vendor/lodash", &fx.up_dir]);
    assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);
    assert!(
        res.stdout.contains("✓ attached lodash at vendor/lodash"),
        "stdout:\n{}",
        res.stdout
    );
    assert!(
        res.stdout.contains(&format!("{}#main", fx.up_dir)),
        "stdout:\n{}",
        res.stdout
    );
    assert!(
        res.stdout.contains("push and pull"),
        "stdout:\n{}",
        res.stdout
    );

    let subjects = fx.mono.subjects("HEAD");
    assert_eq!(subjects.len(), mono_before + 1);
    let want = format!("Adopt lodash from {} @ {}", fx.up_dir, short(&fx.pub_head));
    assert_eq!(subjects.last(), Some(&want));

    let messages = fx.mono.messages("HEAD");
    let trailer = format!("Monosplice-Origin: {}", fx.pub_head);
    assert!(
        messages.last().is_some_and(|m| m.contains(&trailer)),
        "{messages:?}"
    );

    // The config edit and the vendored tree land in the SAME commit.
    let mut changed: Vec<String> = fx
        .mono
        .git(&["diff", "--name-only", "HEAD~1", "HEAD"])
        .split('\n')
        .map(str::to_owned)
        .collect();
    changed.sort();
    assert_eq!(
        changed,
        vec![
            "monosplice.toml",
            "vendor/lodash/README.md",
            "vendor/lodash/chunk.js",
            "vendor/lodash/index.js",
            "vendor/lodash/map.js",
        ]
    );

    assert_eq!(
        fx.mono.tree_sha("HEAD", Some("vendor/lodash")),
        fx.pub_repo.tree_sha("HEAD", None)
    );
    assert_eq!(fx.mono.read("vendor/lodash/README.md"), "# lodash\n");
    assert!(fx.mono.git(&["status", "--porcelain"]).is_empty());
    let config = config_text(&fx.mono);
    assert!(config.contains("[[subrepos]]"), "config:\n{config}");
    assert!(
        config.contains(&format!("path = {}", toml_str("vendor/lodash"))),
        "config:\n{config}"
    );
    assert!(
        config.contains(&format!("remote = {}", toml_str(&fx.up_dir))),
        "config:\n{config}"
    );

    let status = run_monosplice(&fx.mono.dir, &["status"]);
    assert_eq!(status.exit_code, 0, "stderr: {}", status.stderr);
    assert!(
        status.stdout.contains("lodash: in sync"),
        "{}",
        status.stdout
    );
    assert!(!status.stdout.contains("to pull"), "{}", status.stdout);

    let pull = run_monosplice(&fx.mono.dir, &["pull"]);
    assert_eq!(pull.exit_code, 0, "stderr: {}", pull.stderr);
    assert!(pull.stdout.contains("up to date"), "{}", pull.stdout);

    let push = run_monosplice(&fx.mono.dir, &["push"]);
    assert_eq!(push.exit_code, 0, "stderr: {}", push.stderr);
    assert!(push.stdout.contains("up to date"), "{}", push.stdout);
    assert_eq!(fx.pub_repo.head(), fx.pub_head);
}

/// S100: an explicit folder, `--name` and `--branch` are all honoured.
#[test]
fn s100_honors_an_explicit_folder_name_and_branch() {
    let fx = vendor_fixture();
    fx.up.git(&["checkout", "-b", "release"]);
    fx.up.commit_as(
        "lodash: release only",
        &[("release.txt", Some("r\n"))],
        UP_NAME,
        UP_EMAIL,
    );
    fx.up.git(&["push", "origin", "release"]);

    let res = run_monosplice(
        &fx.mono.dir,
        &[
            "attach",
            "third_party/lodash-lib",
            &fx.up_dir,
            "--name",
            "ld",
            "--branch",
            "release",
        ],
    );
    assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);
    assert!(
        res.stdout
            .contains("✓ attached ld at third_party/lodash-lib"),
        "stdout:\n{}",
        res.stdout
    );
    assert!(fx.mono.exists("third_party/lodash-lib/release.txt"));

    let config = config_text(&fx.mono);
    for line in [
        format!("name = {}", toml_str("ld")),
        format!("path = {}", toml_str("third_party/lodash-lib")),
        format!("branch = {}", toml_str("release")),
    ] {
        assert!(
            config.contains(&line),
            "config must carry `{line}`:\n{config}"
        );
    }

    let status = run_monosplice(&fx.mono.dir, &["status"]);
    assert_eq!(status.exit_code, 0, "stderr: {}", status.stderr);
    assert!(status.stdout.contains("ld: in sync"), "{}", status.stdout);
}

// ===========================================================================================
// S101: upstream advances after attaching
// ===========================================================================================

/// S101: new upstream commits import per-commit with their authors preserved.
#[test]
fn s101_imports_the_new_commits_per_commit_with_authors_preserved() {
    let fx = vendored();

    fx.up.commit_as(
        "lodash: fix chunk",
        &[("chunk.js", Some("exports.chunk = 2\n"))],
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

    let before = fx.mono.subjects("HEAD").len();
    let res = run_monosplice(&fx.mono.dir, &["pull"]);
    assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);
    assert!(
        res.stdout.contains("imported 2 commit"),
        "stdout:\n{}",
        res.stdout
    );

    let subjects = fx.mono.subjects("HEAD");
    assert_eq!(subjects.len(), before + 2);
    let tail: Vec<&String> = subjects
        .iter()
        .skip(subjects.len().saturating_sub(2))
        .collect();
    assert_eq!(tail, vec!["lodash: fix chunk", "lodash: add zip"]);

    let authors = fx.mono.authors("HEAD");
    let want_author = format!("{UP_NAME} <{UP_EMAIL}>");
    let author_tail: Vec<&String> = authors
        .iter()
        .skip(authors.len().saturating_sub(2))
        .collect();
    assert_eq!(author_tail, vec![&want_author; 2]);

    assert_eq!(
        fx.mono.read("vendor/lodash/chunk.js"),
        "exports.chunk = 2\n"
    );
    assert_eq!(fx.mono.read("vendor/lodash/zip.js"), "exports.zip = 1\n");
    let status = run_monosplice(&fx.mono.dir, &["status"]);
    assert_eq!(status.exit_code, 0, "stderr: {}", status.stderr);
    assert!(
        status.stdout.contains("lodash: in sync"),
        "{}",
        status.stdout
    );
}

// ===========================================================================================
// S102: local patch plus a non-conflicting upstream change
// ===========================================================================================

/// S102: a non-conflicting upstream change three-way merges and leaves the patch to push.
#[test]
fn s102_three_way_merges_cleanly_and_leaves_the_local_patch_to_push() {
    let fx = vendored();

    fx.mono.commit(
        "patch: local tweak to index",
        &[(
            "vendor/lodash/index.js",
            Some("module.exports = {patched: true}\n"),
        )],
    );
    fx.up.commit_as(
        "lodash: touch map",
        &[("map.js", Some("exports.map = 2\n"))],
        UP_NAME,
        UP_EMAIL,
    );
    fx.up.git(&["push", "origin", "main"]);

    let res = run_monosplice(&fx.mono.dir, &["pull"]);
    assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);
    assert!(
        res.stdout.contains("imported 1 commit"),
        "stdout:\n{}",
        res.stdout
    );

    assert_eq!(
        fx.mono.read("vendor/lodash/index.js"),
        "module.exports = {patched: true}\n"
    );
    assert_eq!(fx.mono.read("vendor/lodash/map.js"), "exports.map = 2\n");
    assert!(fx.mono.git(&["status", "--porcelain"]).is_empty());

    // Nothing left to pull, and the local patch is pending. The count is 2, not 1, for the
    // reason S43 already locks in: both sides moved, so the import sits on top of the local
    // patch and its tree differs from the public tip — it must be re-exported or the public
    // repo would never see the patch merged with upstream's change.
    let status = run_monosplice(&fx.mono.dir, &["status"]);
    assert_eq!(status.exit_code, 0, "stderr: {}", status.stderr);
    assert!(
        status.stdout.contains("lodash: 2 to push"),
        "{}",
        status.stdout
    );
    assert!(!status.stdout.contains("to pull"), "{}", status.stdout);

    let push = run_monosplice(&fx.mono.dir, &["push"]);
    assert_eq!(push.exit_code, 0, "stderr: {}", push.stderr);
    assert_eq!(
        fx.pub_repo.tree_sha("HEAD", None),
        fx.mono.tree_sha("HEAD", Some("vendor/lodash"))
    );
}

// ===========================================================================================
// S103: local patch conflicting with an upstream edit
// ===========================================================================================

/// S103: conflict markers land under `vendor/<name>/`, and `--continue` + push converge.
#[test]
fn s103_leaves_conflict_markers_and_converges_after_continue_and_push() {
    let fx = vendored();

    fx.mono.commit(
        "patch: local README line",
        &[("vendor/lodash/README.md", Some("# lodash\n\nlocal patch\n"))],
    );
    fx.up.commit_as(
        "lodash: upstream README line",
        &[("README.md", Some("# lodash\n\nupstream edit\n"))],
        UP_NAME,
        UP_EMAIL,
    );
    let up_sha = fx.up.head();
    fx.up.git(&["push", "origin", "main"]);

    let conflicted = run_monosplice(&fx.mono.dir, &["pull"]);
    assert_ne!(conflicted.exit_code, 0, "stdout: {}", conflicted.stdout);
    assert!(
        conflicted.stderr.contains("vendor/lodash/README.md"),
        "stderr:\n{}",
        conflicted.stderr
    );
    assert!(
        conflicted.stderr.contains("monosplice pull --continue"),
        "stderr:\n{}",
        conflicted.stderr
    );

    let markers = fx.mono.read("vendor/lodash/README.md");
    assert!(markers.contains("<<<<<<<"), "{markers}");
    assert!(markers.contains("local patch"), "{markers}");
    assert!(markers.contains("upstream edit"), "{markers}");

    fx.mono.write(
        "vendor/lodash/README.md",
        "# lodash\n\nlocal patch and upstream edit\n",
    );
    fx.mono.git(&["add", "vendor/lodash/README.md"]);

    let resumed = run_monosplice(&fx.mono.dir, &["pull", "--continue"]);
    assert_eq!(resumed.exit_code, 0, "stderr: {}", resumed.stderr);
    assert!(
        resumed.stdout.contains("imported 1 commit"),
        "stdout:\n{}",
        resumed.stdout
    );
    let messages = fx.mono.messages("HEAD");
    let trailer = format!("Monosplice-Origin: {up_sha}");
    assert!(
        messages.last().is_some_and(|m| m.contains(&trailer)),
        "{messages:?}"
    );

    let push = run_monosplice(&fx.mono.dir, &["push"]);
    assert_eq!(push.exit_code, 0, "stderr: {}", push.stderr);
    assert_eq!(
        fx.pub_repo.tree_sha("HEAD", None),
        fx.mono.tree_sha("HEAD", Some("vendor/lodash"))
    );
    assert_eq!(
        fx.pub_repo.file_at("HEAD", "README.md"),
        "# lodash\n\nlocal patch and upstream edit"
    );
}

// ===========================================================================================
// S104: attaching the same repo twice
// ===========================================================================================

/// S104: a second attach is refused on the name/path collision, config byte-identical.
#[test]
fn s104_refuses_on_the_name_or_path_collision_leaving_the_config_byte_identical() {
    let fx = vendored();
    let before = config_text(&fx.mono);
    let log_before = fx.mono.subjects("HEAD");

    // Same folder, same url: the entry now exists, so this is first contact — and the two
    // are already connected by trailers.
    let again = run_monosplice(&fx.mono.dir, &["attach", "vendor/lodash", &fx.up_dir]);
    assert_ne!(again.exit_code, 0, "stdout: {}", again.stdout);
    assert!(
        again.stderr.to_lowercase().contains("already"),
        "stderr:\n{}",
        again.stderr
    );

    // A different folder under the same name is a plain slot collision.
    let other = other_remote(&fx, "other");
    let collide = run_monosplice(
        &fx.mono.dir,
        &["attach", "vendor/other", &other, "--name", "lodash"],
    );
    assert_ne!(collide.exit_code, 0, "stdout: {}", collide.stdout);
    assert!(
        collide.stderr.contains("lodash"),
        "stderr:\n{}",
        collide.stderr
    );
    assert!(
        collide.stderr.to_lowercase().contains("already"),
        "stderr:\n{}",
        collide.stderr
    );

    assert_eq!(config_text(&fx.mono), before);
    assert_eq!(fx.mono.subjects("HEAD"), log_before);
    assert!(fx.mono.git(&["status", "--porcelain"]).is_empty());
}

/// S104: a path that resolves to the configured entry is the repoint refusal.
#[test]
fn s104_refuses_when_only_the_path_collides() {
    let fx = vendored();
    let other = other_remote(&fx, "other");
    let before = config_text(&fx.mono);

    // The path resolves to the configured `lodash` entry, so this is the repoint refusal.
    let res = run_monosplice(&fx.mono.dir, &["attach", "vendor/lodash", &other]);
    assert_ne!(res.exit_code, 0, "stdout: {}", res.stdout);
    assert!(
        res.stderr.contains("vendor/lodash"),
        "stderr:\n{}",
        res.stderr
    );
    assert_eq!(config_text(&fx.mono), before);
}

// ===========================================================================================
// S105: attach preconditions on a new entry
// ===========================================================================================

/// S105: a dirty working tree is refused before anything is fetched or written.
#[test]
fn s105_refuses_a_dirty_working_tree_before_fetching_or_writing_anything() {
    let fx = vendor_fixture();
    fx.mono.write("app/main.ts", "export const app = \"wip\"\n");
    let before = config_text(&fx.mono);
    let head = fx.mono.head();

    let res = run_monosplice(&fx.mono.dir, &["attach", "vendor/lodash", &fx.up_dir]);
    assert_ne!(res.exit_code, 0, "stdout: {}", res.stdout);
    let lower = res.stderr.to_lowercase();
    assert!(
        lower.contains("uncommitted") || lower.contains("staged"),
        "stderr:\n{}",
        res.stderr
    );

    assert_eq!(config_text(&fx.mono), before);
    assert_eq!(fx.mono.head(), head);
    assert!(!fx.mono.exists("vendor"));
    assert_ne!(
        fx.mono
            .git_try(&["rev-parse", "--verify", "refs/monosplice/lodash/remote"])
            .exit_code,
        0,
        "no tracking ref may be written by a refused attach"
    );
}

/// S105: staged changes anywhere are refused.
#[test]
fn s105_refuses_staged_changes_anywhere() {
    let fx = vendor_fixture();
    fx.mono.write("private/secrets.md", "staged elsewhere\n");
    fx.mono.git(&["add", "private/secrets.md"]);
    let before = config_text(&fx.mono);
    let head = fx.mono.head();

    let res = run_monosplice(&fx.mono.dir, &["attach", "vendor/lodash", &fx.up_dir]);
    assert_ne!(res.exit_code, 0, "stdout: {}", res.stdout);
    let lower = res.stderr.to_lowercase();
    assert!(
        lower.contains("staged") || lower.contains("uncommitted"),
        "stderr:\n{}",
        res.stderr
    );
    assert_eq!(config_text(&fx.mono), before);
    assert_eq!(fx.mono.head(), head);
    assert_eq!(
        fx.mono.git(&["diff", "--cached", "--name-only"]),
        "private/secrets.md"
    );
}

/// S105: an untracked directory already sitting at the target path is refused.
#[test]
fn s105_refuses_an_untracked_directory_sitting_at_the_target_path() {
    let fx = vendor_fixture();
    fx.mono
        .write("vendor/lodash/leftover.txt", "from a previous attempt\n");
    let before = config_text(&fx.mono);
    let head = fx.mono.head();

    let res = run_monosplice(&fx.mono.dir, &["attach", "vendor/lodash", &fx.up_dir]);
    assert_ne!(res.exit_code, 0, "stdout: {}", res.stdout);
    assert!(
        res.stderr.contains("vendor/lodash"),
        "stderr:\n{}",
        res.stderr
    );
    assert!(res.stderr.contains("exists"), "stderr:\n{}", res.stderr);

    assert_eq!(config_text(&fx.mono), before);
    assert_eq!(fx.mono.head(), head);
    assert_eq!(
        fx.mono.read("vendor/lodash/leftover.txt"),
        "from a previous attempt\n"
    );
    assert_ne!(
        fx.mono
            .git_try(&["rev-parse", "--verify", "refs/monosplice/lodash/remote"])
            .exit_code,
        0,
        "no tracking ref may be written by a refused attach"
    );
}

/// S105: a path that nests inside an existing subrepo is refused.
#[test]
fn s105_refuses_a_path_that_nests_inside_an_existing_subrepo() {
    let fx = vendored();
    let other = other_remote(&fx, "nested");
    let before = config_text(&fx.mono);

    let res = run_monosplice(&fx.mono.dir, &["attach", "vendor/lodash/inner", &other]);
    assert_ne!(res.exit_code, 0, "stdout: {}", res.stdout);
    assert!(
        res.stderr.to_lowercase().contains("nest"),
        "stderr:\n{}",
        res.stderr
    );
    assert_eq!(config_text(&fx.mono), before);
}

// ===========================================================================================
// S106: unreachable remote or missing branch
// ===========================================================================================

/// S106: an unreachable URL is reported cleanly and changes nothing.
#[test]
fn s106_reports_an_unreachable_url_cleanly_and_changes_nothing() {
    let fx = vendor_fixture();
    let before = config_text(&fx.mono);
    let head = fx.mono.head();
    let gone = format!("{}/gone.git", fx.sandbox.path().display());

    let res = run_monosplice(&fx.mono.dir, &["attach", "vendor/lodash", &gone]);
    assert_ne!(res.exit_code, 0, "stdout: {}", res.stdout);
    assert!(
        res.stderr.contains("cannot reach remote"),
        "stderr:\n{}",
        res.stderr
    );
    assert!(res.stderr.contains("gone.git"), "stderr:\n{}", res.stderr);

    assert_eq!(config_text(&fx.mono), before);
    assert_eq!(fx.mono.head(), head);
    assert!(!fx.mono.exists("vendor"));
}

/// S106: a branch the remote does not have is named, and nothing changes.
#[test]
fn s106_names_the_missing_branch_and_changes_nothing() {
    let fx = vendor_fixture();
    let before = config_text(&fx.mono);
    let head = fx.mono.head();

    let res = run_monosplice(
        &fx.mono.dir,
        &["attach", "vendor/lodash", &fx.up_dir, "--branch", "nope"],
    );
    assert_ne!(res.exit_code, 0, "stdout: {}", res.stdout);
    assert!(res.stderr.contains("nope"), "stderr:\n{}", res.stderr);
    assert!(res.stderr.contains(&fx.up_dir), "stderr:\n{}", res.stderr);

    assert_eq!(config_text(&fx.mono), before);
    assert_eq!(fx.mono.head(), head);
    assert!(!fx.mono.exists("vendor"));
}

// ===========================================================================================
// S107: a config shape the inserter cannot handle
// ===========================================================================================

/// The TOML analogue of the TS spread config: `subrepos` written as a *static* array. It
/// loads fine, but TOML forbids extending a statically defined array with `[[subrepos]]`, so
/// the append-then-reload bargain in `vendor.rs` fails and the entry comes back as a snippet.
const STATIC_ARRAY_CONFIG: &str = "# Monosplice configuration.\nsubrepos = []\n";

/// S107: nothing changes, and the entry is printed on stdout ready to paste.
#[test]
fn s107_changes_nothing_and_prints_a_paste_able_snippet_on_stdout() {
    let fx = vendor_fixture();
    fx.mono.write("monosplice.toml", STATIC_ARRAY_CONFIG);
    fx.mono
        .commit("chore: config built from a static array", &[]);
    let before = config_text(&fx.mono);
    let head = fx.mono.head();

    let res = run_monosplice(&fx.mono.dir, &["attach", "vendor/lodash", &fx.up_dir]);
    assert_ne!(res.exit_code, 0, "stdout: {}", res.stdout);

    assert!(
        res.stdout.contains("[[subrepos]]"),
        "stdout:\n{}",
        res.stdout
    );
    for line in [
        format!("path = {}", toml_str("vendor/lodash")),
        format!("remote = {}", toml_str(&fx.up_dir)),
    ] {
        assert!(
            res.stdout.contains(&line),
            "the snippet must carry `{line}`, got:\n{}",
            res.stdout
        );
    }
    assert!(
        res.stdout.contains("monosplice.toml"),
        "stdout:\n{}",
        res.stdout
    );

    assert_eq!(config_text(&fx.mono), before);
    assert_eq!(fx.mono.head(), head);
    assert!(!fx.mono.exists("vendor"));
    assert!(fx.mono.git(&["status", "--porcelain"]).is_empty());
}
