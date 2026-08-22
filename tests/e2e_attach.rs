//! e2e: `monosplice attach` on a folder that is NOT configured yet — port of
//! `test/e2e/attach.test.ts`.
//!
//! Adapted per `docs/rust-port.md`: the config file is `monosplice.toml`, and the entry
//! `attach` writes is the `[[subrepos]]` block `src/core/vendor.rs::render_subrepo_entry`
//! renders, so every config-content assertion is spelled in TOML.

mod common;

use common::{
    clone_remote, deny_pushes, make_bare_remote, make_repo, run_monosplice, sandbox, subrepo_block,
    toml_str, write_config, Sandbox, TestRepo,
};

const UP_NAME: &str = "Up Stream";
const UP_EMAIL: &str = "up@example.test";

/// A monorepo with NO subrepos configured — `attach` is the command that writes the entry —
/// plus a bare remote that either already has its own history or is still empty.
struct Fixture {
    sandbox: Sandbox,
    mono: TestRepo,
    pub_dir: String,
    pub_repo: TestRepo,
    /// Empty string when the fixture left the remote without a branch (the TS fixture's
    /// `pubHead: null`); every use goes through [`short`], so there is nothing to unwrap.
    pub_head: String,
    pub_subjects: Vec<String>,
}

#[derive(Default)]
struct AttachOpts<'a> {
    /// Extra files committed into the monorepo's first commit (e.g. `core/README.md`).
    mono_files: &'a [(&'a str, Option<&'a str>)],
    up_files: &'a [(&'a str, Option<&'a str>)],
    /// Final upstream commit, e.g. to delete the churn files and land on a chosen tree.
    up_tail: &'a [(&'a str, Option<&'a str>)],
    /// Upstream commits to make; 0 means the default of one.
    commits: usize,
    /// Leave the bare remote without any branch at all.
    empty_remote: bool,
    /// Config entries to start from (verbatim TOML blocks).
    subrepos: &'a [&'a str],
}

fn attach_fixture(opts: AttachOpts) -> Fixture {
    let sb = sandbox();
    let mono = make_repo(sb.path(), "mono");
    write_config(&mono, opts.subrepos);

    let mut files: Vec<(&str, Option<&str>)> = vec![
        ("app/main.ts", Some("export const app = true\n")),
        ("private/secrets.md", Some("internal only\n")),
    ];
    files.extend_from_slice(opts.mono_files);
    mono.commit("chore: initial monorepo", &files);

    let pub_dir = make_bare_remote(sb.path(), "core-pub");
    if !opts.empty_remote {
        let up = make_repo(sb.path(), "upstream");
        let up_files: &[(&str, Option<&str>)] = if opts.up_files.is_empty() {
            &[("README.md", Some("# upstream core\n"))]
        } else {
            opts.up_files
        };
        up.commit_as("upstream: initial", up_files, UP_NAME, UP_EMAIL);
        for i in 1..opts.commits.max(1) {
            let file = format!("file-{i}.txt");
            let body = format!("{i}\n");
            up.commit_as(
                &format!("upstream: change {i}"),
                &[(file.as_str(), Some(body.as_str()))],
                UP_NAME,
                UP_EMAIL,
            );
        }
        if !opts.up_tail.is_empty() {
            up.commit_as("upstream: tidy up", opts.up_tail, UP_NAME, UP_EMAIL);
        }
        up.git(&["remote", "add", "origin", &pub_dir]);
        up.git(&["push", "origin", "main"]);
    }

    let pub_repo = TestRepo::new(&pub_dir);
    let (pub_head, pub_subjects) = if opts.empty_remote {
        (String::new(), Vec::new())
    } else {
        (pub_repo.head(), pub_repo.subjects("HEAD"))
    };
    Fixture {
        sandbox: sb,
        mono,
        pub_dir,
        pub_repo,
        pub_head,
        pub_subjects,
    }
}

/// The config as text — `monosplice.toml` is the file every refusal promises not to touch.
fn config_text(mono: &TestRepo) -> String {
    mono.read("monosplice.toml")
}

/// First ten characters of a sha, the way `adopt_message` abbreviates it.
fn short(sha: &str) -> String {
    sha.chars().take(10).collect()
}

/// The remote's `main`, or the empty string when it has no such branch.
fn remote_branch(pub_repo: &TestRepo) -> String {
    let res = pub_repo.git_try(&["rev-parse", "--verify", "--quiet", "refs/heads/main"]);
    if res.exit_code == 0 {
        res.stdout
    } else {
        String::new()
    }
}

/// Both halves of the entry `attach` renders for a plain (non-triangular) subrepo.
fn entry_lines(path: &str, remote: &str) -> [String; 2] {
    [
        format!("path = {}", toml_str(path)),
        format!("remote = {}", toml_str(remote)),
    ]
}

// ===========================================================================================
// S120: attach an empty folder to a remote that has history
// ===========================================================================================

/// S120: config edit and remote tree land in ONE commit, and the pair is in sync afterwards.
#[test]
fn s120_writes_config_and_the_remote_tree_in_one_commit_and_lands_in_sync() {
    let fx = attach_fixture(AttachOpts {
        commits: 20,
        ..Default::default()
    });
    let mono_before = fx.mono.subjects("HEAD").len();

    let res = run_monosplice(&fx.mono.dir, &["attach", "core", &fx.pub_dir]);
    assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);
    assert!(res.stdout.contains("core"), "stdout: {}", res.stdout);
    assert!(
        res.stdout.contains(&fx.pub_dir),
        "stdout must name the remote, got:\n{}",
        res.stdout
    );

    let subjects = fx.mono.subjects("HEAD");
    assert_eq!(subjects.len(), mono_before + 1);
    let want = format!("Adopt core from {} @ {}", fx.pub_dir, short(&fx.pub_head));
    assert_eq!(subjects.last(), Some(&want));

    let messages = fx.mono.messages("HEAD");
    let trailer = format!("Monosplice-Origin: {}", fx.pub_head);
    assert!(
        messages.last().is_some_and(|m| m.contains(&trailer)),
        "the anchor commit must carry {trailer}, got:\n{messages:?}"
    );

    // The config edit and the remote tree land in the SAME commit, and nothing else moves.
    let mut changed: Vec<String> = fx
        .mono
        .git(&["diff", "--name-only", "HEAD~1", "HEAD"])
        .split('\n')
        .map(str::to_owned)
        .collect();
    changed.sort();
    assert!(
        changed.iter().any(|p| p == "monosplice.toml"),
        "{changed:?}"
    );
    assert!(changed.iter().any(|p| p == "core/README.md"), "{changed:?}");
    assert!(
        changed
            .iter()
            .all(|p| p == "monosplice.toml" || p.starts_with("core/")),
        "only the config and core/ may move, got: {changed:?}"
    );

    assert_eq!(
        fx.mono.tree_sha("HEAD", Some("core")),
        fx.pub_repo.tree_sha("HEAD", None)
    );
    assert_eq!(fx.mono.read("core/README.md"), "# upstream core\n");
    assert!(fx.mono.git(&["status", "--porcelain"]).is_empty());

    let config = config_text(&fx.mono);
    assert!(config.contains("[[subrepos]]"), "config:\n{config}");
    for line in entry_lines("core", &fx.pub_dir) {
        assert!(
            config.contains(&line),
            "config must carry `{line}`:\n{config}"
        );
    }

    // 20 pub commits, none "to pull": reflection is ancestry-based.
    let status = run_monosplice(&fx.mono.dir, &["status"]);
    assert_eq!(status.exit_code, 0, "stderr: {}", status.stderr);
    assert!(status.stdout.contains("core: in sync"), "{}", status.stdout);
    assert!(!status.stdout.contains("to pull"), "{}", status.stdout);

    let pull = run_monosplice(&fx.mono.dir, &["pull"]);
    assert_eq!(pull.exit_code, 0, "stderr: {}", pull.stderr);
    assert!(pull.stdout.contains("up to date"), "{}", pull.stdout);

    let push = run_monosplice(&fx.mono.dir, &["push"]);
    assert_eq!(push.exit_code, 0, "stderr: {}", push.stderr);
    assert!(push.stdout.contains("up to date"), "{}", push.stdout);
    assert_eq!(fx.pub_repo.head(), fx.pub_head);
}

/// S120: a nested folder works, and the name defaults to the last segment.
#[test]
fn s120_works_at_a_nested_path_defaulting_the_name_to_the_last_segment() {
    let fx = attach_fixture(AttachOpts::default());

    let res = run_monosplice(&fx.mono.dir, &["attach", "packages/lib", &fx.pub_dir]);
    assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);
    assert!(res.stdout.contains("packages/lib"), "{}", res.stdout);

    assert_eq!(fx.mono.read("packages/lib/README.md"), "# upstream core\n");
    assert_eq!(
        fx.mono.tree_sha("HEAD", Some("packages/lib")),
        fx.pub_repo.tree_sha("HEAD", None)
    );
    let config = config_text(&fx.mono);
    assert!(
        config.contains(&format!("path = {}", toml_str("packages/lib"))),
        "config:\n{config}"
    );

    let status = run_monosplice(&fx.mono.dir, &["status"]);
    assert_eq!(status.exit_code, 0, "stderr: {}", status.stderr);
    assert!(status.stdout.contains("lib: in sync"), "{}", status.stdout);
}

/// S120: `--name` and `--branch` are written into the entry and honoured on the wire.
#[test]
fn s120_honors_name_and_branch() {
    let fx = attach_fixture(AttachOpts::default());
    let up = clone_remote(fx.sandbox.path(), &fx.pub_dir, "contributor");
    up.git(&["checkout", "-b", "release"]);
    up.commit_as(
        "upstream: release only",
        &[("release.txt", Some("r\n"))],
        UP_NAME,
        UP_EMAIL,
    );
    up.git(&["push", "origin", "release"]);

    let res = run_monosplice(
        &fx.mono.dir,
        &[
            "attach",
            "core",
            &fx.pub_dir,
            "--name",
            "kernel",
            "--branch",
            "release",
        ],
    );
    assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);
    assert!(res.stdout.contains("kernel"), "{}", res.stdout);

    assert!(fx.mono.exists("core/release.txt"));
    let config = config_text(&fx.mono);
    assert!(
        config.contains(&format!("name = {}", toml_str("kernel"))),
        "config:\n{config}"
    );
    assert!(
        config.contains(&format!("branch = {}", toml_str("release"))),
        "config:\n{config}"
    );

    let status = run_monosplice(&fx.mono.dir, &["status"]);
    assert_eq!(status.exit_code, 0, "stderr: {}", status.stderr);
    assert!(
        status.stdout.contains("kernel: in sync"),
        "{}",
        status.stdout
    );
}

// ===========================================================================================
// S121: attach a folder with content to an EMPTY remote
// ===========================================================================================

const S121_MONO_FILES: &[(&str, Option<&str>)] = &[
    ("core/README.md", Some("# core\n")),
    ("core/src/index.ts", Some("export const hello = 1\n")),
];

/// S121: the config entry is committed on its own; the first publish still needs `--yes`.
#[test]
fn s121_commits_the_config_entry_alone_then_refuses_the_first_publish_without_yes() {
    let fx = attach_fixture(AttachOpts {
        empty_remote: true,
        mono_files: S121_MONO_FILES,
        ..Default::default()
    });
    let mono_before = fx.mono.subjects("HEAD").len();

    let res = run_monosplice(&fx.mono.dir, &["attach", "core", &fx.pub_dir]);
    assert_ne!(res.exit_code, 0, "stdout: {}", res.stdout);
    assert!(
        res.stderr.contains("monosplice push core --yes"),
        "the refusal must name the exact command, got:\n{}",
        res.stderr
    );

    // The config commit still landed, on its own.
    let subjects = fx.mono.subjects("HEAD");
    assert_eq!(subjects.len(), mono_before + 1);
    let want = format!("Attach core: track {} (main)", fx.pub_dir);
    assert_eq!(subjects.last(), Some(&want));
    assert_eq!(
        fx.mono.git(&["diff", "--name-only", "HEAD~1", "HEAD"]),
        "monosplice.toml"
    );
    assert!(
        config_text(&fx.mono).contains(&format!("remote = {}", toml_str(&fx.pub_dir))),
        "config:\n{}",
        config_text(&fx.mono)
    );
    assert!(fx.mono.git(&["status", "--porcelain"]).is_empty());

    // Nothing was published.
    assert!(remote_branch(&fx.pub_repo).is_empty());

    // The named command converges.
    let push = run_monosplice(&fx.mono.dir, &["push", "core", "--yes"]);
    assert_eq!(push.exit_code, 0, "stderr: {}", push.stderr);
    assert_eq!(fx.pub_repo.subjects("HEAD"), vec!["Initial import of core"]);
    assert_eq!(
        fx.pub_repo.tree_sha("HEAD", None),
        fx.mono.tree_sha("HEAD", Some("core"))
    );
    let status = run_monosplice(&fx.mono.dir, &["status"]);
    assert_eq!(status.exit_code, 0, "stderr: {}", status.stderr);
    assert!(status.stdout.contains("core: in sync"), "{}", status.stdout);
}

/// S121: `--yes` publishes the baseline in the same run.
#[test]
fn s121_yes_publishes_the_baseline_in_the_same_run() {
    let fx = attach_fixture(AttachOpts {
        empty_remote: true,
        mono_files: S121_MONO_FILES,
        ..Default::default()
    });
    let mono_before = fx.mono.subjects("HEAD").len();

    let res = run_monosplice(&fx.mono.dir, &["attach", "core", &fx.pub_dir, "--yes"]);
    assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);
    assert!(
        res.stdout.to_lowercase().contains("published"),
        "stdout:\n{}",
        res.stdout
    );

    let subjects = fx.mono.subjects("HEAD");
    assert_eq!(subjects.len(), mono_before + 1);
    let want = format!("Attach core: track {} (main)", fx.pub_dir);
    assert_eq!(subjects.last(), Some(&want));

    assert_eq!(fx.pub_repo.subjects("HEAD"), vec!["Initial import of core"]);
    assert_eq!(
        fx.pub_repo.tree_sha("HEAD", None),
        fx.mono.tree_sha("HEAD", Some("core"))
    );
    let pub_messages = fx.pub_repo.messages("HEAD");
    let trailer = format!("Monosplice-Source: {}", fx.mono.head());
    assert!(
        pub_messages.first().is_some_and(|m| m.contains(&trailer)),
        "the baseline must carry {trailer}, got:\n{pub_messages:?}"
    );
    // the private tree never crosses the boundary
    assert!(
        !fx.pub_repo
            .tree_entries("HEAD", None)
            .iter()
            .any(|e| e.contains("private/")),
        "private/ must never be published"
    );

    let status = run_monosplice(&fx.mono.dir, &["status"]);
    assert_eq!(status.exit_code, 0, "stderr: {}", status.stderr);
    assert!(status.stdout.contains("core: in sync"), "{}", status.stdout);
    let push = run_monosplice(&fx.mono.dir, &["push"]);
    assert_eq!(push.exit_code, 0, "stderr: {}", push.stderr);
    assert!(push.stdout.contains("up to date"), "{}", push.stdout);
}

/// S121: `--export-history` replays every commit that touched the folder.
#[test]
fn s121_export_history_replays_every_commit_that_touched_the_folder() {
    let fx = attach_fixture(AttachOpts {
        empty_remote: true,
        mono_files: S121_MONO_FILES,
        ..Default::default()
    });
    fx.mono.commit(
        "feat: more core",
        &[("core/src/util.ts", Some("export const n = 1\n"))],
    );
    fx.mono.commit(
        "chore: private churn",
        &[("private/notes.md", Some("nope\n"))],
    );

    let res = run_monosplice(
        &fx.mono.dir,
        &["attach", "core", &fx.pub_dir, "--yes", "--export-history"],
    );
    assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);

    assert_eq!(
        fx.pub_repo.subjects("HEAD"),
        vec!["chore: initial monorepo", "feat: more core"]
    );
    assert_eq!(
        fx.pub_repo.tree_sha("HEAD", None),
        fx.mono.tree_sha("HEAD", Some("core"))
    );
    let status = run_monosplice(&fx.mono.dir, &["status"]);
    assert_eq!(status.exit_code, 0, "stderr: {}", status.stderr);
    assert!(status.stdout.contains("core: in sync"), "{}", status.stdout);
}

// ===========================================================================================
// S122: attach a folder whose tree MATCHES the remote
// ===========================================================================================

/// S122: config plus the adopt baseline in one commit; the two histories share a base after.
#[test]
fn s122_records_config_plus_the_adopt_baseline_in_one_commit() {
    let fx = attach_fixture(AttachOpts {
        mono_files: &[("core/README.md", Some("# same\n"))],
        up_files: &[("README.md", Some("# same\n"))],
        commits: 3,
        up_tail: &[("file-1.txt", None), ("file-2.txt", None)],
        ..Default::default()
    });
    assert_eq!(
        fx.mono.tree_sha("HEAD", Some("core")),
        fx.pub_repo.tree_sha("HEAD", None)
    );
    let mono_before = fx.mono.subjects("HEAD").len();

    let res = run_monosplice(&fx.mono.dir, &["attach", "core", &fx.pub_dir]);
    assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);

    let subjects = fx.mono.subjects("HEAD");
    assert_eq!(subjects.len(), mono_before + 1);
    assert!(
        subjects.last().is_some_and(|s| s.contains("Adopt core")),
        "{subjects:?}"
    );
    let messages = fx.mono.messages("HEAD");
    let trailer = format!("Monosplice-Origin: {}", fx.pub_head);
    assert!(
        messages.last().is_some_and(|m| m.contains(&trailer)),
        "{messages:?}"
    );

    // Only the config moved: the tree already matched.
    assert_eq!(
        fx.mono.git(&["diff", "--name-only", "HEAD~1", "HEAD"]),
        "monosplice.toml"
    );
    assert!(fx.mono.git(&["status", "--porcelain"]).is_empty());

    let status = run_monosplice(&fx.mono.dir, &["status"]);
    assert_eq!(status.exit_code, 0, "stderr: {}", status.stderr);
    assert!(status.stdout.contains("core: in sync"), "{}", status.stdout);
    let pull = run_monosplice(&fx.mono.dir, &["pull"]);
    assert_eq!(pull.exit_code, 0, "stderr: {}", pull.stderr);
    assert!(pull.stdout.contains("up to date"), "{}", pull.stdout);
    let idle = run_monosplice(&fx.mono.dir, &["push"]);
    assert_eq!(idle.exit_code, 0, "stderr: {}", idle.stderr);
    assert!(idle.stdout.contains("up to date"), "{}", idle.stdout);

    // A later mono commit exports parented on the EXISTING pub head.
    fx.mono
        .commit("feat: after attaching", &[("core/new.txt", Some("n\n"))]);
    let push = run_monosplice(&fx.mono.dir, &["push"]);
    assert_eq!(push.exit_code, 0, "stderr: {}", push.stderr);
    assert!(push.stdout.contains("exported 1 commit"), "{}", push.stdout);
    assert_eq!(fx.pub_repo.git(&["rev-parse", "HEAD~1"]), fx.pub_head);
    assert_eq!(
        fx.pub_repo.tree_sha("HEAD", None),
        fx.mono.tree_sha("HEAD", Some("core"))
    );
}

// ===========================================================================================
// S123: attach a folder whose tree DIFFERS from the remote
// ===========================================================================================

const DIFFERING_MONO: &[(&str, Option<&str>)] = &[
    ("core/README.md", Some("# mono side\n")),
    ("core/only-mono.txt", Some("m\n")),
];
const DIFFERING_UP: &[(&str, Option<&str>)] = &[
    ("README.md", Some("# pub side\n")),
    ("only-pub.txt", Some("p\n")),
];

fn differing_fixture() -> Fixture {
    attach_fixture(AttachOpts {
        mono_files: DIFFERING_MONO,
        up_files: DIFFERING_UP,
        ..Default::default()
    })
}

/// S123: the refusal lists the differing paths and leaves the config byte-identical.
#[test]
fn s123_refuses_listing_the_differing_paths_leaving_the_config_byte_identical() {
    let fx = differing_fixture();
    let before = config_text(&fx.mono);
    let head_before = fx.mono.head();

    let res = run_monosplice(&fx.mono.dir, &["attach", "core", &fx.pub_dir]);
    assert_ne!(res.exit_code, 0, "stdout: {}", res.stdout);
    for path in ["README.md", "only-mono.txt", "only-pub.txt"] {
        assert!(
            res.stderr.contains(path),
            "the refusal must list {path}, got:\n{}",
            res.stderr
        );
    }
    assert!(res.stderr.contains("--theirs"), "stderr:\n{}", res.stderr);

    assert_eq!(config_text(&fx.mono), before);
    assert_eq!(fx.mono.head(), head_before);
    assert!(fx.mono.git(&["status", "--porcelain"]).is_empty());
    assert_eq!(fx.mono.read("core/README.md"), "# mono side\n");
    assert_eq!(fx.pub_repo.head(), fx.pub_head);
}

/// S123: `--theirs` takes the remote tree in the same single commit.
#[test]
fn s123_theirs_takes_the_remote_tree_in_the_same_single_commit() {
    let fx = differing_fixture();
    let mono_before = fx.mono.subjects("HEAD").len();

    let res = run_monosplice(&fx.mono.dir, &["attach", "core", &fx.pub_dir, "--theirs"]);
    assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);

    let subjects = fx.mono.subjects("HEAD");
    assert_eq!(subjects.len(), mono_before + 1);
    assert!(
        subjects.last().is_some_and(|s| s.contains("Adopt core")),
        "{subjects:?}"
    );
    let messages = fx.mono.messages("HEAD");
    let trailer = format!("Monosplice-Origin: {}", fx.pub_head);
    assert!(
        messages.last().is_some_and(|m| m.contains(&trailer)),
        "{messages:?}"
    );

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
            "core/README.md",
            "core/only-mono.txt",
            "core/only-pub.txt",
            "monosplice.toml",
        ]
    );

    assert_eq!(
        fx.mono.tree_sha("HEAD", Some("core")),
        fx.pub_repo.tree_sha("HEAD", None)
    );
    assert_eq!(fx.mono.read("core/README.md"), "# pub side\n");
    assert!(!fx.mono.exists("core/only-mono.txt"));
    assert!(fx.mono.git(&["status", "--porcelain"]).is_empty());
    // the pre-attach content is still in monorepo history
    assert_eq!(fx.mono.file_at("HEAD~1", "core/only-mono.txt"), "m");

    let status = run_monosplice(&fx.mono.dir, &["status"]);
    assert_eq!(status.exit_code, 0, "stderr: {}", status.stderr);
    assert!(status.stdout.contains("core: in sync"), "{}", status.stdout);
    let push = run_monosplice(&fx.mono.dir, &["push"]);
    assert_eq!(push.exit_code, 0, "stderr: {}", push.stderr);
    assert!(push.stdout.contains("up to date"), "{}", push.stdout);
    assert_eq!(fx.pub_repo.head(), fx.pub_head);
}

// ===========================================================================================
// S124: attach refusals leave the config byte-identical and make no commit
// ===========================================================================================

/// A monorepo with `core` already attached, plus a second unrelated remote to attach.
fn attached_fixture() -> (Fixture, String) {
    let fx = attach_fixture(AttachOpts::default());
    let res = run_monosplice(&fx.mono.dir, &["attach", "core", &fx.pub_dir]);
    assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);

    let other_dir = make_bare_remote(fx.sandbox.path(), "other");
    let src = make_repo(fx.sandbox.path(), "other-src");
    src.commit_as(
        "other: initial",
        &[("a.txt", Some("a\n"))],
        UP_NAME,
        UP_EMAIL,
    );
    src.git(&["remote", "add", "origin", &other_dir]);
    src.git(&["push", "origin", "main"]);
    (fx, other_dir)
}

/// S124: a name that is already configured is refused.
#[test]
fn s124_refuses_a_name_that_is_already_configured() {
    let (fx, other_dir) = attached_fixture();
    let before = config_text(&fx.mono);
    let head = fx.mono.head();

    let res = run_monosplice(
        &fx.mono.dir,
        &["attach", "other", &other_dir, "--name", "core"],
    );
    assert_ne!(res.exit_code, 0, "stdout: {}", res.stdout);
    assert!(res.stderr.contains("core"), "stderr:\n{}", res.stderr);
    assert!(
        res.stderr.to_lowercase().contains("already"),
        "stderr:\n{}",
        res.stderr
    );

    assert_eq!(config_text(&fx.mono), before);
    assert_eq!(fx.mono.head(), head);
    assert!(!fx.mono.exists("other"));
}

/// S124: a path that is already configured is refused.
#[test]
fn s124_refuses_a_path_that_is_already_configured() {
    let (fx, other_dir) = attached_fixture();
    let before = config_text(&fx.mono);
    let head = fx.mono.head();

    let res = run_monosplice(
        &fx.mono.dir,
        &["attach", "core", &other_dir, "--name", "other"],
    );
    assert_ne!(res.exit_code, 0, "stdout: {}", res.stdout);
    assert!(res.stderr.contains("core"), "stderr:\n{}", res.stderr);
    assert!(
        res.stderr.to_lowercase().contains("already"),
        "stderr:\n{}",
        res.stderr
    );

    assert_eq!(config_text(&fx.mono), before);
    assert_eq!(fx.mono.head(), head);
}

/// S124: a path nesting inside a configured subrepo is refused.
#[test]
fn s124_refuses_a_path_nesting_inside_a_configured_subrepo() {
    let (fx, other_dir) = attached_fixture();
    let before = config_text(&fx.mono);
    let head = fx.mono.head();

    let res = run_monosplice(&fx.mono.dir, &["attach", "core/inner", &other_dir]);
    assert_ne!(res.exit_code, 0, "stdout: {}", res.stdout);
    assert!(
        res.stderr.to_lowercase().contains("nest"),
        "stderr:\n{}",
        res.stderr
    );

    assert_eq!(config_text(&fx.mono), before);
    assert_eq!(fx.mono.head(), head);
}

/// S124: a dirty working tree is refused before anything is fetched or written.
#[test]
fn s124_refuses_a_dirty_working_tree_before_fetching_or_writing_anything() {
    let fx = attach_fixture(AttachOpts::default());
    fx.mono.write("app/main.ts", "export const app = \"wip\"\n");
    let before = config_text(&fx.mono);
    let head = fx.mono.head();

    let res = run_monosplice(&fx.mono.dir, &["attach", "core", &fx.pub_dir]);
    assert_ne!(res.exit_code, 0, "stdout: {}", res.stdout);
    let lower = res.stderr.to_lowercase();
    assert!(
        lower.contains("uncommitted") || lower.contains("staged"),
        "stderr:\n{}",
        res.stderr
    );

    assert_eq!(config_text(&fx.mono), before);
    assert_eq!(fx.mono.head(), head);
    assert!(!fx.mono.exists("core"));
    assert_ne!(
        fx.mono
            .git_try(&["rev-parse", "--verify", "refs/monosplice/core/remote"])
            .exit_code,
        0,
        "no tracking ref may be written by a refused attach"
    );
}

/// S124: staged changes anywhere are refused.
#[test]
fn s124_refuses_staged_changes_anywhere() {
    let fx = attach_fixture(AttachOpts::default());
    fx.mono.write("private/secrets.md", "staged elsewhere\n");
    fx.mono.git(&["add", "private/secrets.md"]);
    let before = config_text(&fx.mono);
    let head = fx.mono.head();

    let res = run_monosplice(&fx.mono.dir, &["attach", "core", &fx.pub_dir]);
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

/// S124: a pull sequencer in progress blocks attach and names `pull --continue`.
#[test]
fn s124_refuses_while_a_pull_sequencer_is_in_progress() {
    // A real conflicted pull, so the sequencer on disk is the one monosplice wrote.
    let sb = sandbox();
    let mono = make_repo(sb.path(), "mono");
    let core_pub = make_bare_remote(sb.path(), "core-pub");
    write_config(
        &mono,
        &[&subrepo_block(&[
            ("name", &toml_str("core")),
            ("path", &toml_str("core")),
            ("remote", &toml_str(&core_pub)),
        ])],
    );
    mono.commit(
        "chore: initial",
        &[
            ("core/README.md", Some("# core\n")),
            ("private/secrets.md", Some("x\n")),
        ],
    );
    let published = run_monosplice(&mono.dir, &["push", "core", "--yes"]);
    assert_eq!(published.exit_code, 0, "stderr: {}", published.stderr);

    let contributor = clone_remote(sb.path(), &core_pub, "contributor");
    contributor.commit_as(
        "pub: their edit",
        &[("README.md", Some("# core\n\ntheirs\n"))],
        UP_NAME,
        UP_EMAIL,
    );
    contributor.git(&["push", "origin", "main"]);
    mono.commit(
        "mono: our edit",
        &[("core/README.md", Some("# core\n\nours\n"))],
    );

    let conflicted = run_monosplice(&mono.dir, &["pull"]);
    assert_ne!(conflicted.exit_code, 0, "stdout: {}", conflicted.stdout);

    let other_dir = make_bare_remote(sb.path(), "other");
    let src = make_repo(sb.path(), "other-src");
    src.commit_as(
        "other: initial",
        &[("a.txt", Some("a\n"))],
        UP_NAME,
        UP_EMAIL,
    );
    src.git(&["remote", "add", "origin", &other_dir]);
    src.git(&["push", "origin", "main"]);
    let before = mono.read("monosplice.toml");

    let res = run_monosplice(&mono.dir, &["attach", "docs", &other_dir]);
    assert_ne!(res.exit_code, 0, "stdout: {}", res.stdout);
    assert!(
        res.stderr.to_lowercase().contains("in progress"),
        "stderr:\n{}",
        res.stderr
    );
    assert!(
        res.stderr.contains("monosplice pull --continue"),
        "stderr:\n{}",
        res.stderr
    );

    assert_eq!(mono.read("monosplice.toml"), before);
    assert!(!mono.exists("docs"));
}

// ===========================================================================================
// S125: nothing to attach to
// ===========================================================================================

/// S125: an unreachable URL is reported cleanly and nothing is written.
#[test]
fn s125_reports_an_unreachable_url_cleanly_and_writes_nothing() {
    let fx = attach_fixture(AttachOpts::default());
    let before = config_text(&fx.mono);
    let head = fx.mono.head();
    let gone = format!("{}/gone.git", fx.sandbox.path().display());

    let res = run_monosplice(&fx.mono.dir, &["attach", "core", &gone]);
    assert_ne!(res.exit_code, 0, "stdout: {}", res.stdout);
    assert!(
        res.stderr.contains("cannot reach remote"),
        "stderr:\n{}",
        res.stderr
    );
    assert!(res.stderr.contains("gone.git"), "stderr:\n{}", res.stderr);

    assert_eq!(config_text(&fx.mono), before);
    assert_eq!(fx.mono.head(), head);
    assert!(!fx.mono.exists("core"));
}

/// S125: both sides empty gives the one shared "nothing exists yet" error.
#[test]
fn s125_gives_the_shared_nothing_exists_yet_error_when_both_sides_are_empty() {
    let fx = attach_fixture(AttachOpts {
        empty_remote: true,
        ..Default::default()
    });
    let before = config_text(&fx.mono);
    let head = fx.mono.head();

    let res = run_monosplice(&fx.mono.dir, &["attach", "core", &fx.pub_dir]);
    assert_ne!(res.exit_code, 0, "stdout: {}", res.stdout);
    assert!(
        res.stderr.to_lowercase().contains("nothing exists yet"),
        "stderr:\n{}",
        res.stderr
    );
    assert!(res.stderr.contains("core"), "stderr:\n{}", res.stderr);

    assert_eq!(config_text(&fx.mono), before);
    assert_eq!(fx.mono.head(), head);
}

// ===========================================================================================
// S126: a config shape the inserter cannot handle
// ===========================================================================================

/// The TOML analogue of the TS spread config: `subrepos` written as a *static* array. It
/// loads fine, but TOML forbids extending a statically defined array with `[[subrepos]]`, so
/// the append-then-reload bargain in `vendor.rs` fails and the entry comes back as a snippet.
const STATIC_ARRAY_CONFIG: &str = "# Monosplice configuration.\nsubrepos = []\n";

/// S126: with history on the remote the refusal prints the snippet and names the url-less attach.
#[test]
fn s126_changes_nothing_prints_the_snippet_and_names_the_url_less_attach() {
    let fx = attach_fixture(AttachOpts::default());
    fx.mono.write("monosplice.toml", STATIC_ARRAY_CONFIG);
    fx.mono
        .commit("chore: config built from a static array", &[]);
    let before = config_text(&fx.mono);
    let head = fx.mono.head();

    let res = run_monosplice(&fx.mono.dir, &["attach", "core", &fx.pub_dir]);
    assert_ne!(res.exit_code, 0, "stdout: {}", res.stdout);

    assert!(
        res.stdout.contains("[[subrepos]]"),
        "stdout:\n{}",
        res.stdout
    );
    for line in entry_lines("core", &fx.pub_dir) {
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
    assert!(
        res.stderr.contains("monosplice attach core"),
        "stderr:\n{}",
        res.stderr
    );
    assert!(
        !res.stderr.contains("monosplice adopt") && !res.stderr.contains("monosplice vendor"),
        "the retired commands must not be named, got:\n{}",
        res.stderr
    );

    assert_eq!(config_text(&fx.mono), before);
    assert_eq!(fx.mono.head(), head);
    assert!(!fx.mono.exists("core"));
    assert!(fx.mono.git(&["status", "--porcelain"]).is_empty());
}

/// S126: with an empty remote the same refusal names `push --yes`.
#[test]
fn s126_names_push_yes_when_the_remote_is_empty() {
    let fx = attach_fixture(AttachOpts {
        empty_remote: true,
        mono_files: &[("core/README.md", Some("# core\n"))],
        ..Default::default()
    });
    fx.mono.write("monosplice.toml", STATIC_ARRAY_CONFIG);
    fx.mono
        .commit("chore: config built from a static array", &[]);
    let before = config_text(&fx.mono);
    let head = fx.mono.head();

    let res = run_monosplice(&fx.mono.dir, &["attach", "core", &fx.pub_dir]);
    assert_ne!(res.exit_code, 0, "stdout: {}", res.stdout);

    assert!(
        res.stdout.contains(&format!("path = {}", toml_str("core"))),
        "stdout:\n{}",
        res.stdout
    );
    assert!(
        res.stderr.contains("monosplice push core --yes"),
        "stderr:\n{}",
        res.stderr
    );

    assert_eq!(config_text(&fx.mono), before);
    assert_eq!(fx.mono.head(), head);
    assert!(fx.mono.git(&["status", "--porcelain"]).is_empty());
}

// ===========================================================================================
// S131: attach --import-history on a new entry
// ===========================================================================================

/// S131: the config entry is committed on its own, then every public commit is replayed.
#[test]
fn s131_commits_the_config_entry_on_its_own_then_replays_every_public_commit() {
    let fx = attach_fixture(AttachOpts {
        commits: 5,
        ..Default::default()
    });
    let mono_before = fx.mono.subjects("HEAD");

    let res = run_monosplice(
        &fx.mono.dir,
        &["attach", "core", &fx.pub_dir, "--import-history"],
    );
    assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);

    let mut want = mono_before.clone();
    want.push(format!("Attach core: track {} (main)", fx.pub_dir));
    want.extend(fx.pub_subjects.iter().cloned());
    assert_eq!(fx.mono.subjects("HEAD"), want);

    // the config commit stands alone
    let n = fx.pub_subjects.len();
    let before_entry = format!("HEAD~{}", n + 1);
    let entry_commit = format!("HEAD~{n}");
    assert_eq!(
        fx.mono
            .git(&["diff", "--name-only", &before_entry, &entry_commit]),
        "monosplice.toml"
    );

    let authors = fx.mono.authors("HEAD");
    let want_author = format!("{UP_NAME} <{UP_EMAIL}>");
    let tail: Vec<&String> = authors
        .iter()
        .skip(authors.len().saturating_sub(5))
        .collect();
    assert_eq!(tail, vec![&want_author; 5]);

    let messages = fx.mono.messages("HEAD");
    let trailer = format!("Monosplice-Origin: {}", fx.pub_head);
    assert!(
        messages.last().is_some_and(|m| m.contains(&trailer)),
        "{messages:?}"
    );

    assert_eq!(
        fx.mono.tree_sha("HEAD", Some("core")),
        fx.pub_repo.tree_sha("HEAD", None)
    );
    assert!(fx.mono.git(&["status", "--porcelain"]).is_empty());
    let status = run_monosplice(&fx.mono.dir, &["status"]);
    assert_eq!(status.exit_code, 0, "stderr: {}", status.stderr);
    assert!(status.stdout.contains("core: in sync"), "{}", status.stdout);
    let push = run_monosplice(&fx.mono.dir, &["push"]);
    assert_eq!(push.exit_code, 0, "stderr: {}", push.stderr);
    assert!(push.stdout.contains("up to date"), "{}", push.stdout);
    assert_eq!(fx.pub_repo.head(), fx.pub_head);
}

/// S131: a folder that already has committed files is refused, config byte-identical.
#[test]
fn s131_refuses_when_the_folder_already_has_committed_files() {
    let fx = attach_fixture(AttachOpts {
        mono_files: &[("core/README.md", Some("# mono side\n"))],
        ..Default::default()
    });
    let before = config_text(&fx.mono);
    let head = fx.mono.head();

    let res = run_monosplice(
        &fx.mono.dir,
        &["attach", "core", &fx.pub_dir, "--import-history"],
    );
    assert_ne!(res.exit_code, 0, "stdout: {}", res.stdout);
    assert!(
        res.stderr.contains("--import-history"),
        "stderr:\n{}",
        res.stderr
    );
    assert!(
        res.stderr.contains("already has committed files"),
        "stderr:\n{}",
        res.stderr
    );

    assert_eq!(config_text(&fx.mono), before);
    assert_eq!(fx.mono.head(), head);
}

// ===========================================================================================
// S138: attach --fork refusals
// ===========================================================================================

/// S138: `--fork <url>` equal to the URL being attached is refused.
#[test]
fn s138_refuses_a_fork_url_equal_to_the_url_being_attached() {
    let fx = attach_fixture(AttachOpts::default());
    let before = config_text(&fx.mono);
    let head = fx.mono.head();

    let res = run_monosplice(
        &fx.mono.dir,
        &["attach", "core", &fx.pub_dir, "--fork", &fx.pub_dir],
    );
    assert_ne!(res.exit_code, 0, "stdout: {}", res.stdout);
    assert!(res.stderr.contains("--fork"), "stderr:\n{}", res.stderr);
    assert!(res.stderr.contains(&fx.pub_dir), "stderr:\n{}", res.stderr);

    assert_eq!(config_text(&fx.mono), before);
    assert_eq!(fx.mono.head(), head);
    assert!(!fx.mono.exists("core"));
}

/// S138: `--fork` on an already-configured folder is refused, naming the config edit.
#[test]
fn s138_refuses_fork_on_a_folder_that_is_already_configured() {
    let fx = attach_fixture(AttachOpts::default());
    let first = run_monosplice(&fx.mono.dir, &["attach", "core", &fx.pub_dir]);
    assert_eq!(first.exit_code, 0, "stderr: {}", first.stderr);
    let fork_dir = make_bare_remote(fx.sandbox.path(), "core-fork");
    let before = config_text(&fx.mono);
    let head = fx.mono.head();

    let res = run_monosplice(
        &fx.mono.dir,
        &["attach", "core", &fx.pub_dir, "--fork", &fork_dir],
    );
    assert_ne!(res.exit_code, 0, "stdout: {}", res.stdout);
    assert!(res.stderr.contains("upstream"), "stderr:\n{}", res.stderr);
    assert!(
        res.stderr.contains("monosplice.toml"),
        "stderr:\n{}",
        res.stderr
    );
    assert!(res.stderr.contains(&fork_dir), "stderr:\n{}", res.stderr);

    assert_eq!(config_text(&fx.mono), before);
    assert_eq!(fx.mono.head(), head);
}

// ===========================================================================================
// S139: write-access probe
// ===========================================================================================

/// S139: a writable remote produces no advisory at all.
#[test]
fn s139_says_nothing_when_the_remote_accepts_pushes() {
    let fx = attach_fixture(AttachOpts::default());

    let res = run_monosplice(&fx.mono.dir, &["attach", "core", &fx.pub_dir]);
    assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);
    assert!(res.stderr.is_empty(), "stderr:\n{}", res.stderr);
}

/// S139: a read-only remote still attaches; the advisory names the `--fork` re-run.
#[test]
fn s139_still_attaches_but_warns_when_the_remote_refuses_pushes() {
    let fx = attach_fixture(AttachOpts::default());
    deny_pushes(&fx.pub_dir);
    let mono_before = fx.mono.subjects("HEAD").len();

    let res = run_monosplice(&fx.mono.dir, &["attach", "core", &fx.pub_dir]);
    // Advisory only: the attach itself succeeded.
    assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);
    assert!(
        res.stderr.to_lowercase().contains("warning"),
        "stderr:\n{}",
        res.stderr
    );
    assert!(
        res.stderr
            .lines()
            .any(|l| l.contains("monosplice attach core") && l.contains("--fork")),
        "the advisory must name the --fork re-run, got:\n{}",
        res.stderr
    );
    assert!(
        res.stderr.contains("monosplice push core"),
        "stderr:\n{}",
        res.stderr
    );

    assert_eq!(fx.mono.subjects("HEAD").len(), mono_before + 1);
    assert_eq!(
        fx.mono.tree_sha("HEAD", Some("core")),
        fx.pub_repo.tree_sha("HEAD", None)
    );
    let messages = fx.mono.messages("HEAD");
    let trailer = format!("Monosplice-Origin: {}", fx.pub_head);
    assert!(
        messages.last().is_some_and(|m| m.contains(&trailer)),
        "{messages:?}"
    );
    let status = run_monosplice(&fx.mono.dir, &["status"]);
    assert_eq!(status.exit_code, 0, "stderr: {}", status.stderr);
    assert!(status.stdout.contains("core: in sync"), "{}", status.stdout);
}

/// S139: an empty remote is never probed — the first publish proves write access itself.
#[test]
fn s139_does_not_probe_when_the_remote_is_empty() {
    let fx = attach_fixture(AttachOpts {
        empty_remote: true,
        mono_files: &[("core/README.md", Some("# core\n"))],
        ..Default::default()
    });
    deny_pushes(&fx.pub_dir);

    // The real push fails, so the exit code is not asserted here: only that the failure is a
    // push error and never the read-only advisory.
    let res = run_monosplice(&fx.mono.dir, &["attach", "core", &fx.pub_dir, "--yes"]);
    assert!(
        !res.stderr.to_lowercase().contains("warning"),
        "stderr:\n{}",
        res.stderr
    );
}

// ===========================================================================================
// S140: adopt and vendor are gone
// ===========================================================================================

/// S140: `monosplice adopt` is not a command (clap's own usage error, exit 2).
#[test]
fn s140_monosplice_adopt_is_an_unknown_command() {
    let fx = attach_fixture(AttachOpts::default());
    let res = run_monosplice(&fx.mono.dir, &["adopt"]);
    assert_eq!(res.exit_code, 2, "stdout: {}", res.stdout);
    let out = format!("{}\n{}", res.stdout, res.stderr);
    assert!(
        out.contains("unrecognized subcommand") && out.contains("adopt"),
        "output:\n{out}"
    );
}

/// S140: `monosplice vendor` is not a command either.
#[test]
fn s140_monosplice_vendor_is_an_unknown_command() {
    let fx = attach_fixture(AttachOpts::default());
    let res = run_monosplice(&fx.mono.dir, &["vendor"]);
    assert_eq!(res.exit_code, 2, "stdout: {}", res.stdout);
    let out = format!("{}\n{}", res.stdout, res.stderr);
    assert!(
        out.contains("unrecognized subcommand") && out.contains("vendor"),
        "output:\n{out}"
    );
}

/// S140: no help text anywhere in the CLI names either retired command.
///
/// The TS version grepped the built `dist/` bundle; the black-box equivalent is the help the
/// binary itself prints, which is the only place those strings could reach a user.
#[test]
fn s140_no_user_facing_string_in_the_cli_names_either_command() {
    let sb = sandbox();
    let commands = [
        "init",
        "status",
        "push",
        "pull",
        "sync",
        "tag",
        "attach",
        "detach",
        "doctor",
        "update",
        "completion",
    ];

    let mut offenders: Vec<String> = Vec::new();
    let mut scan = |label: &str, text: &str| {
        for line in text.lines() {
            if line.contains("monosplice adopt") || line.contains("monosplice vendor") {
                offenders.push(format!("{label}: {}", line.trim()));
            }
        }
    };

    let root = run_monosplice(sb.path(), &["--help"]);
    assert_eq!(root.exit_code, 0, "stderr: {}", root.stderr);
    scan("--help", &root.stdout);

    for command in commands {
        let res = run_monosplice(sb.path(), &[command, "--help"]);
        assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);
        scan(command, &res.stdout);
    }

    assert!(offenders.is_empty(), "{offenders:?}");
}

// ===========================================================================================
// attach --help
// ===========================================================================================

/// `attach --help` documents the whole flag surface.
#[test]
fn attach_help_documents_the_flags() {
    let fx = attach_fixture(AttachOpts::default());
    let res = run_monosplice(&fx.mono.dir, &["attach", "--help"]);
    assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);
    for flag in [
        "--name",
        "--branch",
        "--theirs",
        "--export-history",
        "--import-history",
        "--fork",
    ] {
        assert!(
            res.stdout.contains(flag),
            "`attach --help` must document {flag}, got:\n{}",
            res.stdout
        );
    }
}
