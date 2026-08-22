//! e2e: `monosplice detach` — port of `test/e2e/detach.test.ts` (S161).
//!
//! Adapted per `docs/rust-port.md`: the config is `monosplice.toml`, so the entry `detach`
//! removes is a `[[subrepos]]` block. The "config the remover cannot edit" case becomes a
//! config whose entries are inline tables in a `subrepos = [...]` array — valid TOML the
//! loader accepts, with no `[[subrepos]]` header the textual remover can cut.

mod common;

use common::{
    clone_remote, make_bare_remote, make_repo, multi_fixture, run_monosplice, sandbox,
    standard_fixture, subrepo_block, toml_str, write_config, Fixture,
};

const CONFIG: &str = "monosplice.toml";
const EXT_NAME: &str = "Ext Contributor";
const EXT_EMAIL: &str = "ext@example.test";

/// Fixture + a published core subrepo, so detach has real trailers to leave inert.
fn published() -> Fixture {
    let fx = standard_fixture();
    let res = run_monosplice(&fx.mono.dir, &["push", "core", "--yes"]);
    assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);
    fx
}

/// `/^<prefix>/m`: some line begins with this text.
fn starts_a_line(text: &str, prefix: &str) -> bool {
    text.lines().any(|line| line.starts_with(prefix))
}

/// `/^<line>$/m`: some line is exactly this text.
fn has_line(text: &str, line: &str) -> bool {
    text.lines().any(|l| l == line)
}

// ---------------------------------------------------------------------------------------
// S161: detach
// ---------------------------------------------------------------------------------------

/// S161: the entry goes in one commit; every file and every commit stays.
#[test]
fn s161_drops_the_entry_in_one_commit_keeping_every_file_and_every_commit() {
    let fx = published();
    let mono = &fx.mono;
    mono.commit("feat: one", &[("core/one.txt", Some("1\n"))]);
    let before = mono.subjects("HEAD");
    let tree = mono.tree_sha("HEAD", Some("core"));

    let res = run_monosplice(&mono.dir, &["detach", "core"]);
    assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);

    // The config no longer tracks it.
    assert!(
        !mono.read(CONFIG).contains(&fx.pub_dir),
        "config still names the remote:\n{}",
        mono.read(CONFIG)
    );
    let status = run_monosplice(&mono.dir, &["status"]);
    assert!(
        status.stdout.contains("no subrepos configured"),
        "got:\n{}",
        status.stdout
    );

    // Files kept, history kept.
    assert!(mono.exists("core/README.md"));
    assert!(mono.exists("core/one.txt"));
    assert_eq!(mono.tree_sha("HEAD", Some("core")), tree);
    assert_eq!(mono.subjects("HEAD")[..before.len()], before[..]);

    // Exactly one new commit, and it only touches the config file.
    let added = mono.subjects("HEAD")[before.len()..].to_vec();
    assert_eq!(
        added,
        [format!("Detach core: stop tracking {}", fx.pub_dir)]
    );
    assert_eq!(
        mono.git(&["show", "--name-only", "--format=", "HEAD"]),
        CONFIG
    );
    assert_eq!(mono.git(&["status", "--porcelain"]), "");

    // The output has to say all of that, and name the way back.
    let out = &res.stdout;
    assert!(out.to_lowercase().contains("kept"), "got:\n{out}");
    assert!(out.to_lowercase().contains("histor"), "got:\n{out}");
    assert!(
        out.contains(&format!("monosplice attach core {}", fx.pub_dir)),
        "got:\n{out}"
    );
}

/// S161: detaching one subrepo says nothing about the others.
#[test]
fn s161_leaves_the_other_subrepos_alone() {
    let mfx = multi_fixture();
    let mono = &mfx.mono;
    let push = run_monosplice(&mono.dir, &["push", "--yes"]);
    assert_eq!(push.exit_code, 0, "stderr: {}", push.stderr);

    let res = run_monosplice(&mono.dir, &["detach", "core"]);
    assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);

    let status = run_monosplice(&mono.dir, &["status"]);
    assert_eq!(status.exit_code, 0, "stderr: {}", status.stderr);
    assert!(
        !starts_a_line(&status.stdout, "core:"),
        "got:\n{}",
        status.stdout
    );
    assert!(
        has_line(&status.stdout, "lib: in sync"),
        "got:\n{}",
        status.stdout
    );
    assert!(mono.read(CONFIG).contains(&mfx.lib_pub_dir));
    assert!(!mono.read(CONFIG).contains(&mfx.core_pub_dir));
}

/// S161: detaching is a config edit, so an unreachable remote is irrelevant.
#[test]
fn s161_never_contacts_the_network() {
    let sb = sandbox();
    let mono = make_repo(sb.path(), "mono");
    let unreachable = sb.path().join("nowhere.git");
    let unreachable = unreachable.to_string_lossy().into_owned();
    write_config(
        &mono,
        &[&subrepo_block(&[
            ("path", &toml_str("core")),
            ("remote", &toml_str(&unreachable)),
        ])],
    );
    mono.commit(
        "chore: initial monorepo",
        &[("core/README.md", Some("# core\n"))],
    );

    let res = run_monosplice(&mono.dir, &["detach", "core"]);
    assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);
    assert!(
        !mono.read(CONFIG).contains(&unreachable),
        "got:\n{}",
        mono.read(CONFIG)
    );
}

// ---------------------------------------------------------------------------------------
// S161: refusals
// ---------------------------------------------------------------------------------------

/// S161: an unknown subrepo is named back, with the configured ones listed.
#[test]
fn s161_refuses_an_unknown_subrepo() {
    let fx = published();
    let mono = &fx.mono;
    let config = mono.read(CONFIG);
    let head = mono.head();

    let res = run_monosplice(&mono.dir, &["detach", "nope"]);
    assert_ne!(res.exit_code, 0, "stdout: {}", res.stdout);
    assert!(res.stderr.contains("nope"), "got:\n{}", res.stderr);
    assert!(res.stderr.contains("core"), "got:\n{}", res.stderr);
    assert_eq!(mono.read(CONFIG), config);
    assert_eq!(mono.head(), head);
}

/// S161: detach commits, so it holds itself to the same clean-tree rule as everything else.
#[test]
fn s161_refuses_a_dirty_working_tree_and_staged_changes() {
    let fx = published();
    let mono = &fx.mono;
    let config = mono.read(CONFIG);
    let head = mono.head();

    mono.write("core/README.md", "# core\n\nedited\n");
    let dirty = run_monosplice(&mono.dir, &["detach", "core"]);
    assert_ne!(dirty.exit_code, 0, "stdout: {}", dirty.stdout);
    assert!(
        dirty.stderr.contains("uncommitted changes"),
        "got:\n{}",
        dirty.stderr
    );
    assert_eq!(mono.read(CONFIG), config);

    mono.git(&["checkout", "--", "core/README.md"]);
    mono.write("staged.txt", "x\n");
    mono.git(&["add", "staged.txt"]);
    let staged = run_monosplice(&mono.dir, &["detach", "core"]);
    assert_ne!(staged.exit_code, 0, "stdout: {}", staged.stdout);
    assert!(
        staged.stderr.contains("staged changes"),
        "got:\n{}",
        staged.stderr
    );
    assert_eq!(mono.read(CONFIG), config);
    assert_eq!(mono.head(), head);
}

/// S161: detaching mid-import would strand the sequencer.
#[test]
fn s161_refuses_while_a_pull_of_that_subrepo_is_unfinished() {
    let fx = published();
    let mono = &fx.mono;

    // Drive a conflict: both sides edit README.md.
    let ext = clone_remote(fx.sandbox.path(), &fx.pub_dir, "ext");
    ext.commit_as(
        "docs: ext wording",
        &[("README.md", Some("# core\n\next wording\n"))],
        EXT_NAME,
        EXT_EMAIL,
    );
    ext.git(&["push", "origin", "main"]);
    mono.commit(
        "docs: mono wording",
        &[("core/README.md", Some("# core\n\nmono wording\n"))],
    );
    let pull = run_monosplice(&mono.dir, &["pull"]);
    assert_ne!(pull.exit_code, 0, "stdout: {}", pull.stdout);

    let config = mono.read(CONFIG);
    let res = run_monosplice(&mono.dir, &["detach", "core"]);
    assert_ne!(res.exit_code, 0, "stdout: {}", res.stdout);
    assert!(res.stderr.contains("pull of core"), "got:\n{}", res.stderr);
    assert_eq!(mono.read(CONFIG), config);
}

/// S161: a config the remover cannot cut is restored byte-for-byte, with the fix spelled out.
#[test]
fn s161_restores_a_config_it_cannot_edit_and_says_exactly_what_to_delete() {
    let sb = sandbox();
    let mono = make_repo(sb.path(), "mono");
    let pub_dir = make_bare_remote(sb.path(), "core-pub");
    // Valid TOML the loader accepts, written as one inline array — there is no `[[subrepos]]`
    // header to cut, so the textual remover has to refuse instead of guessing.
    mono.write(
        CONFIG,
        &format!(
            "subrepos = [{{ path = \"core\", remote = {} }}]\n",
            toml_str(&pub_dir)
        ),
    );
    mono.commit(
        "chore: initial monorepo",
        &[("core/README.md", Some("# core\n"))],
    );
    let config = mono.read(CONFIG);
    let head = mono.head();

    let res = run_monosplice(&mono.dir, &["detach", "core"]);
    assert_ne!(res.exit_code, 0, "stdout: {}", res.stdout);
    assert_eq!(mono.read(CONFIG), config);
    assert_eq!(mono.head(), head);

    let out = format!("{}{}", res.stdout, res.stderr);
    assert!(out.contains("core"), "got:\n{out}");
    let lower = out.to_lowercase();
    assert!(
        lower.contains("by hand") || lower.contains("yourself") || lower.contains("delete"),
        "the refusal must say what to delete by hand, got:\n{out}"
    );
}
