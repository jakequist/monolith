//! e2e: `monosplice attach` on a subrepo the config ALREADY names — port of
//! `test/e2e/attach-configured.test.ts`.
//!
//! This is the half of `attach` that takes no URL: the entry exists, so there is nothing to
//! write and only first contact to make. Per `docs/rust-port.md` the config file is
//! `monosplice.toml`, so "attach must not rewrite the config" is asserted on its TOML text.

mod common;

use common::{
    make_bare_remote, make_repo, run_monosplice, sandbox, subrepo_block, toml_str, write_config,
    Sandbox, TestRepo,
};

const UP_NAME: &str = "Up Stream";
const UP_EMAIL: &str = "up@example.test";

struct Fixture {
    sandbox: Sandbox,
    mono: TestRepo,
    pub_dir: String,
    pub_repo: TestRepo,
    /// Empty string when the fixture left the remote without a branch.
    pub_head: String,
    pub_subjects: Vec<String>,
}

#[derive(Default)]
struct ConfiguredOpts<'a> {
    /// Seeds the subrepo directory; leave empty for the "directory does not exist yet" half.
    mono_core: &'a [(&'a str, Option<&'a str>)],
    up_files: &'a [(&'a str, Option<&'a str>)],
    /// Final upstream commit, e.g. to delete the churn files and land on a chosen tree.
    up_tail: &'a [(&'a str, Option<&'a str>)],
    /// Upstream commits to make; 0 means the default of one.
    commits: usize,
    /// Leave the bare remote without any branch at all.
    empty_remote: bool,
    /// Subrepo name; empty means `core`.
    name: &'a str,
    /// Subrepo path; empty means `core`.
    sub_path: &'a str,
}

/// A monorepo whose config already names the subrepo, facing a remote that has its own
/// history and no monosplice trailers.
fn configured_fixture(opts: ConfiguredOpts) -> Fixture {
    let sb = sandbox();
    let mono = make_repo(sb.path(), "mono");
    let pub_dir = make_bare_remote(sb.path(), "core-pub");
    let name = if opts.name.is_empty() {
        "core"
    } else {
        opts.name
    };
    let sub_path = if opts.sub_path.is_empty() {
        "core"
    } else {
        opts.sub_path
    };
    write_config(
        &mono,
        &[&subrepo_block(&[
            ("name", &toml_str(name)),
            ("path", &toml_str(sub_path)),
            ("remote", &toml_str(&pub_dir)),
        ])],
    );

    let mut files: Vec<(&str, Option<&str>)> =
        vec![("private/secrets.md", Some("internal only\n"))];
    files.extend_from_slice(opts.mono_core);
    mono.commit("chore: initial monorepo", &files);

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

/// The config as text — `monosplice.toml` is the file this half of `attach` may never touch.
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

// ===========================================================================================
// S130: attach a configured subrepo with no url (pub history, no mono directory)
// ===========================================================================================

/// S130: one mono commit carrying an Origin trailer, no config edit, and in sync afterwards.
#[test]
fn s130_records_one_mono_commit_with_an_origin_trailer_and_touches_no_config() {
    let fx = configured_fixture(ConfiguredOpts {
        commits: 20,
        ..Default::default()
    });
    let mono_before = fx.mono.subjects("HEAD").len();
    let before = config_text(&fx.mono);

    let res = run_monosplice(&fx.mono.dir, &["attach", "core"]);
    assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);
    assert!(
        res.stdout.to_lowercase().contains("attached"),
        "stdout:\n{}",
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
        "{messages:?}"
    );

    // The entry was already there: attach must not rewrite the config.
    assert_eq!(config_text(&fx.mono), before);
    let changed: Vec<String> = fx
        .mono
        .git(&["diff", "--name-only", "HEAD~1", "HEAD"])
        .split('\n')
        .map(str::to_owned)
        .collect();
    assert!(changed.iter().any(|p| p == "core/README.md"), "{changed:?}");
    assert!(
        changed.iter().all(|p| p.starts_with("core/")),
        "only core/ may move, got: {changed:?}"
    );

    assert_eq!(
        fx.mono.tree_sha("HEAD", Some("core")),
        fx.pub_repo.tree_sha("HEAD", None)
    );
    assert_eq!(fx.mono.read("core/README.md"), "# upstream core\n");
    assert!(fx.mono.git(&["status", "--porcelain"]).is_empty());
    assert!(fx.mono.exists("private/secrets.md"));

    // The whole point of ancestry-based reflection: 20 pub commits, none "to pull".
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

/// S130: the folder argument resolves by path or by name when the two differ.
#[test]
fn s130_resolves_the_entry_by_path_or_by_name_when_they_differ() {
    for handle in ["vendor/lodash", "lodash"] {
        let fx = configured_fixture(ConfiguredOpts {
            name: "lodash",
            sub_path: "vendor/lodash",
            ..Default::default()
        });

        let res = run_monosplice(&fx.mono.dir, &["attach", handle]);
        assert_eq!(res.exit_code, 0, "{handle}: {}", res.stderr);
        assert_eq!(
            fx.mono.tree_sha("HEAD", Some("vendor/lodash")),
            fx.pub_repo.tree_sha("HEAD", None)
        );
        let status = run_monosplice(&fx.mono.dir, &["status"]);
        assert_eq!(status.exit_code, 0, "stderr: {}", status.stderr);
        assert!(
            status.stdout.contains("lodash: in sync"),
            "{handle}: {}",
            status.stdout
        );
    }
}

// ===========================================================================================
// S131: attach --import-history
// ===========================================================================================

/// S131: every public commit is replayed with its author and message, and lands in sync.
#[test]
fn s131_replays_every_public_commit_with_authors_and_messages_preserved() {
    let fx = configured_fixture(ConfiguredOpts {
        commits: 5,
        ..Default::default()
    });
    let mono_before = fx.mono.subjects("HEAD");
    let before = config_text(&fx.mono);

    let res = run_monosplice(&fx.mono.dir, &["attach", "core", "--import-history"]);
    assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);

    let mut want = mono_before.clone();
    want.extend(fx.pub_subjects.iter().cloned());
    assert_eq!(fx.mono.subjects("HEAD"), want);

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

    assert_eq!(config_text(&fx.mono), before);
    assert_eq!(
        fx.mono.tree_sha("HEAD", Some("core")),
        fx.pub_repo.tree_sha("HEAD", None)
    );

    let status = run_monosplice(&fx.mono.dir, &["status"]);
    assert_eq!(status.exit_code, 0, "stderr: {}", status.stderr);
    assert!(status.stdout.contains("core: in sync"), "{}", status.stdout);
    let push = run_monosplice(&fx.mono.dir, &["push"]);
    assert_eq!(push.exit_code, 0, "stderr: {}", push.stderr);
    assert!(push.stdout.contains("up to date"), "{}", push.stdout);
    assert_eq!(fx.pub_repo.head(), fx.pub_head);
}

/// S131: a folder that already has committed files is refused, changing nothing.
#[test]
fn s131_refuses_when_the_folder_already_has_committed_files() {
    let fx = configured_fixture(ConfiguredOpts {
        mono_core: &[("core/README.md", Some("# mono side\n"))],
        ..Default::default()
    });
    let head = fx.mono.head();

    let res = run_monosplice(&fx.mono.dir, &["attach", "core", "--import-history"]);
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
    assert!(
        res.stderr.contains("monosplice attach core"),
        "stderr:\n{}",
        res.stderr
    );
    assert_eq!(fx.mono.head(), head);
    assert!(fx.mono.git(&["status", "--porcelain"]).is_empty());
}

/// S131: a remote with no branch has nothing to replay.
#[test]
fn s131_refuses_when_the_remote_has_no_branch_to_replay() {
    let fx = configured_fixture(ConfiguredOpts {
        empty_remote: true,
        mono_core: &[("core/README.md", Some("# core\n"))],
        ..Default::default()
    });
    let head = fx.mono.head();

    let res = run_monosplice(&fx.mono.dir, &["attach", "core", "--import-history"]);
    assert_ne!(res.exit_code, 0, "stdout: {}", res.stdout);
    assert!(
        res.stderr.contains("--import-history"),
        "stderr:\n{}",
        res.stderr
    );
    assert_eq!(fx.mono.head(), head);
}

// ===========================================================================================
// S132: attach a configured subrepo whose folder has content
// ===========================================================================================

/// S132: matching trees record an empty baseline commit and share history afterwards.
#[test]
fn s132_records_an_empty_baseline_commit_when_the_trees_match() {
    let fx = configured_fixture(ConfiguredOpts {
        mono_core: &[("core/README.md", Some("# same\n"))],
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

    let res = run_monosplice(&fx.mono.dir, &["attach", "core"]);
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
    assert!(fx
        .mono
        .git(&["diff", "--name-only", "HEAD~1", "HEAD"])
        .is_empty());

    let status = run_monosplice(&fx.mono.dir, &["status"]);
    assert_eq!(status.exit_code, 0, "stderr: {}", status.stderr);
    assert!(status.stdout.contains("core: in sync"), "{}", status.stdout);
    let pull = run_monosplice(&fx.mono.dir, &["pull"]);
    assert_eq!(pull.exit_code, 0, "stderr: {}", pull.stderr);
    assert!(pull.stdout.contains("up to date"), "{}", pull.stdout);
    let idle = run_monosplice(&fx.mono.dir, &["push"]);
    assert_eq!(idle.exit_code, 0, "stderr: {}", idle.stderr);
    assert!(idle.stdout.contains("up to date"), "{}", idle.stdout);

    // A new mono commit exports parented on the EXISTING pub head.
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

const DIFFERING_MONO: &[(&str, Option<&str>)] = &[
    ("core/README.md", Some("# mono side\n")),
    ("core/only-mono.txt", Some("m\n")),
];
const DIFFERING_UP: &[(&str, Option<&str>)] = &[
    ("README.md", Some("# pub side\n")),
    ("only-pub.txt", Some("p\n")),
];

fn differing_fixture() -> Fixture {
    configured_fixture(ConfiguredOpts {
        mono_core: DIFFERING_MONO,
        up_files: DIFFERING_UP,
        ..Default::default()
    })
}

/// S132: differing trees are refused with every differing path listed.
#[test]
fn s132_refuses_listing_the_differing_paths_when_the_trees_differ() {
    let fx = differing_fixture();
    let head_before = fx.mono.head();

    let res = run_monosplice(&fx.mono.dir, &["attach", "core"]);
    assert_ne!(res.exit_code, 0, "stdout: {}", res.stdout);
    for path in ["README.md", "only-mono.txt", "only-pub.txt"] {
        assert!(
            res.stderr.contains(path),
            "the refusal must list {path}, got:\n{}",
            res.stderr
        );
    }
    assert!(res.stderr.contains("--theirs"), "stderr:\n{}", res.stderr);

    assert_eq!(fx.mono.head(), head_before);
    assert!(fx.mono.git(&["status", "--porcelain"]).is_empty());
    assert_eq!(fx.mono.read("core/README.md"), "# mono side\n");
    assert_eq!(fx.pub_repo.head(), fx.pub_head);
}

/// S132: `--theirs` replaces the mono directory in one commit and lands in sync.
#[test]
fn s132_theirs_replaces_the_mono_directory_in_one_commit() {
    let fx = differing_fixture();
    let mono_before = fx.mono.subjects("HEAD").len();

    let res = run_monosplice(&fx.mono.dir, &["attach", "core", "--theirs"]);
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
// S133: attach a configured subrepo whose remote is empty
// ===========================================================================================

const S133_MONO_CORE: &[(&str, Option<&str>)] = &[
    ("core/README.md", Some("# core\n")),
    ("core/src/index.ts", Some("export const hello = 1\n")),
];

/// S133: the first publish is refused without `--yes`, and nothing is published.
#[test]
fn s133_refuses_the_first_publish_without_yes_naming_the_exact_command() {
    let fx = configured_fixture(ConfiguredOpts {
        empty_remote: true,
        mono_core: S133_MONO_CORE,
        ..Default::default()
    });
    let head = fx.mono.head();

    let res = run_monosplice(&fx.mono.dir, &["attach", "core"]);
    assert_ne!(res.exit_code, 0, "stdout: {}", res.stdout);
    assert!(
        res.stderr.contains("monosplice push core --yes"),
        "stderr:\n{}",
        res.stderr
    );
    assert_eq!(fx.mono.head(), head);
    assert!(remote_branch(&fx.pub_repo).is_empty());
}

/// S133: `--yes` publishes the baseline; `--export-history` replays instead.
#[test]
fn s133_yes_publishes_the_baseline_and_export_history_replays() {
    let fx = configured_fixture(ConfiguredOpts {
        empty_remote: true,
        mono_core: S133_MONO_CORE,
        ..Default::default()
    });

    let res = run_monosplice(&fx.mono.dir, &["attach", "core", "--yes"]);
    assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);
    assert!(
        res.stdout.to_lowercase().contains("published"),
        "stdout:\n{}",
        res.stdout
    );
    assert_eq!(fx.pub_repo.subjects("HEAD"), vec!["Initial import of core"]);
    assert_eq!(
        fx.pub_repo.tree_sha("HEAD", None),
        fx.mono.tree_sha("HEAD", Some("core"))
    );
    let status = run_monosplice(&fx.mono.dir, &["status"]);
    assert_eq!(status.exit_code, 0, "stderr: {}", status.stderr);
    assert!(status.stdout.contains("core: in sync"), "{}", status.stdout);

    let other = configured_fixture(ConfiguredOpts {
        empty_remote: true,
        mono_core: S133_MONO_CORE,
        ..Default::default()
    });
    other.mono.commit(
        "feat: more core",
        &[("core/src/util.ts", Some("export const n = 1\n"))],
    );
    let full = run_monosplice(
        &other.mono.dir,
        &["attach", "core", "--yes", "--export-history"],
    );
    assert_eq!(full.exit_code, 0, "stderr: {}", full.stderr);
    assert_eq!(
        other.pub_repo.subjects("HEAD"),
        vec!["chore: initial monorepo", "feat: more core"]
    );
}

/// S133: both sides empty gives the one shared "nothing exists yet" error.
#[test]
fn s133_gives_the_shared_nothing_exists_yet_error_when_both_sides_are_empty() {
    let fx = configured_fixture(ConfiguredOpts {
        empty_remote: true,
        ..Default::default()
    });
    let head = fx.mono.head();

    let res = run_monosplice(&fx.mono.dir, &["attach", "core"]);
    assert_ne!(res.exit_code, 0, "stdout: {}", res.stdout);
    assert!(
        res.stderr.to_lowercase().contains("nothing exists yet"),
        "stderr:\n{}",
        res.stderr
    );
    assert!(
        !res.stderr.contains("monosplice adopt") && !res.stderr.contains("monosplice vendor"),
        "the retired commands must not be named, got:\n{}",
        res.stderr
    );
    assert_eq!(fx.mono.head(), head);
}

// ===========================================================================================
// S134: attach an already-related subrepo
// ===========================================================================================

/// S134: two repos already linked by trailers have nothing left to attach.
#[test]
fn s134_refuses_when_the_two_repos_are_already_connected_by_trailers() {
    let fx = configured_fixture(ConfiguredOpts::default());
    let first = run_monosplice(&fx.mono.dir, &["attach", "core"]);
    assert_eq!(first.exit_code, 0, "stderr: {}", first.stderr);
    let head_before = fx.mono.head();
    let pub_head_before = fx.pub_repo.head();

    let again = run_monosplice(&fx.mono.dir, &["attach", "core"]);
    assert_ne!(again.exit_code, 0, "stdout: {}", again.stdout);
    assert!(
        again.stderr.to_lowercase().contains("already"),
        "stderr:\n{}",
        again.stderr
    );
    assert!(
        again.stderr.contains("monosplice pull")
            || again.stderr.contains("monosplice push")
            || again.stderr.contains("monosplice sync"),
        "the refusal must name what to run instead, got:\n{}",
        again.stderr
    );
    assert_eq!(fx.mono.head(), head_before);
    assert_eq!(fx.pub_repo.head(), pub_head_before);
}

/// S134: the same refusal after a subrepo was published by `push --yes`.
#[test]
fn s134_refuses_on_a_subrepo_published_by_push_yes() {
    let fx = configured_fixture(ConfiguredOpts {
        empty_remote: true,
        mono_core: &[("core/README.md", Some("# core\n"))],
        ..Default::default()
    });
    let published = run_monosplice(&fx.mono.dir, &["push", "core", "--yes"]);
    assert_eq!(published.exit_code, 0, "stderr: {}", published.stderr);

    let res = run_monosplice(&fx.mono.dir, &["attach", "core"]);
    assert_ne!(res.exit_code, 0, "stdout: {}", res.stdout);
    assert!(
        res.stderr.to_lowercase().contains("already"),
        "stderr:\n{}",
        res.stderr
    );
}

// ===========================================================================================
// S135: attach preconditions on a configured subrepo
// ===========================================================================================

/// S135: a dirty subrepo directory is refused before anything is fetched or written.
#[test]
fn s135_refuses_a_dirty_subrepo_directory_before_fetching_or_writing() {
    let fx = configured_fixture(ConfiguredOpts {
        mono_core: &[("core/README.md", Some("# mono side\n"))],
        ..Default::default()
    });
    fx.mono.write("core/README.md", "# work in progress\n");
    let head_before = fx.mono.head();

    let res = run_monosplice(&fx.mono.dir, &["attach", "core"]);
    assert_ne!(res.exit_code, 0, "stdout: {}", res.stdout);
    assert!(res.stderr.contains("core"), "stderr:\n{}", res.stderr);
    assert!(
        res.stderr.to_lowercase().contains("uncommitted"),
        "stderr:\n{}",
        res.stderr
    );
    assert!(
        res.stderr.contains("monosplice attach core"),
        "stderr:\n{}",
        res.stderr
    );
    assert_eq!(fx.mono.head(), head_before);
    assert_eq!(fx.mono.read("core/README.md"), "# work in progress\n");
    assert_ne!(
        fx.mono
            .git_try(&["rev-parse", "--verify", "refs/monosplice/core/remote"])
            .exit_code,
        0,
        "no tracking ref may be written by a refused attach"
    );
}

/// S135: staged changes anywhere are refused before anything is fetched or written.
#[test]
fn s135_refuses_staged_changes_anywhere_before_fetching_or_writing() {
    let fx = configured_fixture(ConfiguredOpts::default());
    fx.mono.write("private/secrets.md", "staged elsewhere\n");
    fx.mono.git(&["add", "private/secrets.md"]);
    let head_before = fx.mono.head();

    let res = run_monosplice(&fx.mono.dir, &["attach", "core"]);
    assert_ne!(res.exit_code, 0, "stdout: {}", res.stdout);
    assert!(
        res.stderr.to_lowercase().contains("staged"),
        "stderr:\n{}",
        res.stderr
    );
    assert_eq!(fx.mono.head(), head_before);
    assert_eq!(
        fx.mono.git(&["diff", "--cached", "--name-only"]),
        "private/secrets.md"
    );
    assert_ne!(
        fx.mono
            .git_try(&["rev-parse", "--verify", "refs/monosplice/core/remote"])
            .exit_code,
        0,
        "no tracking ref may be written by a refused attach"
    );
}

/// S135: an unreachable configured remote is reported in the standard style.
#[test]
fn s135_reports_an_unreachable_remote_in_the_standard_style() {
    let sb = sandbox();
    let mono = make_repo(sb.path(), "mono");
    let missing = format!("{}/gone.git", sb.path().display());
    write_config(
        &mono,
        &[&subrepo_block(&[
            ("name", &toml_str("core")),
            ("path", &toml_str("core")),
            ("remote", &toml_str(&missing)),
        ])],
    );
    mono.commit("chore: initial", &[("core/README.md", Some("# core\n"))]);

    let res = run_monosplice(&mono.dir, &["attach", "core"]);
    assert_ne!(res.exit_code, 0, "stdout: {}", res.stdout);
    assert!(
        res.stderr.contains("cannot reach remote"),
        "stderr:\n{}",
        res.stderr
    );
    assert!(res.stderr.contains("gone.git"), "stderr:\n{}", res.stderr);
}

// ===========================================================================================
// S136: attach a configured folder with the url spelled out
// ===========================================================================================

/// S136: spelling out the configured remote is fine.
#[test]
fn s136_proceeds_when_the_url_equals_the_configured_remote() {
    let fx = configured_fixture(ConfiguredOpts::default());

    let res = run_monosplice(&fx.mono.dir, &["attach", "core", &fx.pub_dir]);
    assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);
    assert_eq!(
        fx.mono.tree_sha("HEAD", Some("core")),
        fx.pub_repo.tree_sha("HEAD", None)
    );
    let status = run_monosplice(&fx.mono.dir, &["status"]);
    assert_eq!(status.exit_code, 0, "stderr: {}", status.stderr);
    assert!(status.stdout.contains("core: in sync"), "{}", status.stdout);
}

/// S136: a different url is refused, naming the configured remote and the config file.
#[test]
fn s136_refuses_a_different_url_naming_the_configured_remote_and_the_config_file() {
    let fx = configured_fixture(ConfiguredOpts::default());
    let before = config_text(&fx.mono);
    let head = fx.mono.head();
    let elsewhere = format!("{}/somewhere-else.git", fx.sandbox.path().display());

    let res = run_monosplice(&fx.mono.dir, &["attach", "core", &elsewhere]);
    assert_ne!(res.exit_code, 0, "stdout: {}", res.stdout);
    assert!(res.stderr.contains(&fx.pub_dir), "stderr:\n{}", res.stderr);
    assert!(
        res.stderr.contains("somewhere-else.git"),
        "stderr:\n{}",
        res.stderr
    );
    assert!(
        res.stderr.contains("monosplice.toml"),
        "stderr:\n{}",
        res.stderr
    );

    assert_eq!(config_text(&fx.mono), before);
    assert_eq!(fx.mono.head(), head);
    assert!(!fx.mono.exists("core"));
}

/// S136: for a triangular entry the upstream url is the one that may be spelled out.
#[test]
fn s136_accepts_the_upstream_url_of_a_triangular_entry_and_refuses_the_fork_url() {
    let fx = configured_fixture(ConfiguredOpts::default());
    let fork_dir = make_bare_remote(fx.sandbox.path(), "core-fork");
    write_config(
        &fx.mono,
        &[&subrepo_block(&[
            ("name", &toml_str("core")),
            ("path", &toml_str("core")),
            ("remote", &toml_str(&fork_dir)),
            ("upstream", &toml_str(&fx.pub_dir)),
        ])],
    );
    fx.mono.commit("chore: point core at a fork", &[]);

    let wrong = run_monosplice(&fx.mono.dir, &["attach", "core", &fork_dir]);
    assert_ne!(wrong.exit_code, 0, "stdout: {}", wrong.stdout);
    assert!(
        wrong.stderr.contains(&fx.pub_dir),
        "the refusal must name the pull source, got:\n{}",
        wrong.stderr
    );

    let res = run_monosplice(&fx.mono.dir, &["attach", "core", &fx.pub_dir]);
    assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);
    assert_eq!(
        fx.mono.tree_sha("HEAD", Some("core")),
        fx.pub_repo.tree_sha("HEAD", None)
    );
}

// ===========================================================================================
// S137: attach with no url and no matching entry
// ===========================================================================================

/// S137: without a url and without an entry there is nothing to create the entry from.
#[test]
fn s137_explains_that_a_url_is_needed_to_create_the_entry_and_changes_nothing() {
    let fx = configured_fixture(ConfiguredOpts::default());
    let before = config_text(&fx.mono);
    let head = fx.mono.head();

    let res = run_monosplice(&fx.mono.dir, &["attach", "packages/lib"]);
    assert_ne!(res.exit_code, 0, "stdout: {}", res.stdout);
    assert!(
        res.stderr.contains("packages/lib"),
        "stderr:\n{}",
        res.stderr
    );
    assert!(
        res.stderr
            .contains("monosplice attach packages/lib <git-url>"),
        "stderr:\n{}",
        res.stderr
    );
    assert!(res.stderr.contains("core"), "stderr:\n{}", res.stderr);

    assert_eq!(config_text(&fx.mono), before);
    assert_eq!(fx.mono.head(), head);
    assert!(!fx.mono.exists("packages/lib"));
}

// ===========================================================================================
// S97: pull against an unrelated pub
// ===========================================================================================

/// S97: `pull` refuses and points at `attach`, importing nothing.
#[test]
fn s97_pull_refuses_and_points_at_attach_importing_nothing() {
    let fx = configured_fixture(ConfiguredOpts {
        mono_core: &[("core/README.md", Some("# mono side\n"))],
        ..Default::default()
    });
    let head_before = fx.mono.head();

    let res = run_monosplice(&fx.mono.dir, &["pull"]);
    assert_ne!(res.exit_code, 0, "stdout: {}", res.stdout);
    assert!(
        res.stderr.contains("monosplice attach core"),
        "stderr:\n{}",
        res.stderr
    );
    assert_eq!(fx.mono.head(), head_before);
    assert!(fx.mono.git(&["status", "--porcelain"]).is_empty());
    assert_eq!(fx.mono.read("core/README.md"), "# mono side\n");
    assert!(!fx.pub_head.is_empty());
}

/// S97: the same refusal when the subrepo directory does not exist yet.
#[test]
fn s97_pull_refuses_the_same_way_when_the_subrepo_directory_does_not_exist_yet() {
    let fx = configured_fixture(ConfiguredOpts::default());
    let head_before = fx.mono.head();

    let res = run_monosplice(&fx.mono.dir, &["pull"]);
    assert_ne!(res.exit_code, 0, "stdout: {}", res.stdout);
    assert!(
        res.stderr.contains("monosplice attach core"),
        "stderr:\n{}",
        res.stderr
    );
    assert_eq!(fx.mono.head(), head_before);
    assert!(!fx.mono.exists("core"));
}

// ===========================================================================================
// S98: push after attach never re-exports pre-attach mono history
// ===========================================================================================

/// The shared body of S98: after `attach`, the first push must add nothing to the pub log,
/// and only genuinely new work may ever appear there. A push that anchored only on pub
/// `Monosplice-Source` trailers would replay the pre-attach commits that touched the path.
fn assert_push_never_replays_pre_attach_history(fx: &Fixture, attach_args: &[&str]) {
    let attach = run_monosplice(&fx.mono.dir, attach_args);
    assert_eq!(attach.exit_code, 0, "stderr: {}", attach.stderr);

    let first_push = run_monosplice(&fx.mono.dir, &["push"]);
    assert_eq!(first_push.exit_code, 0, "stderr: {}", first_push.stderr);
    assert!(
        first_push.stdout.contains("up to date"),
        "{}",
        first_push.stdout
    );
    assert_eq!(fx.pub_repo.subjects("HEAD"), fx.pub_subjects);
    assert_eq!(fx.pub_repo.head(), fx.pub_head);

    fx.mono
        .commit("feat: genuinely new", &[("core/new.txt", Some("n\n"))]);
    let second = run_monosplice(&fx.mono.dir, &["push"]);
    assert_eq!(second.exit_code, 0, "stderr: {}", second.stderr);
    assert!(
        second.stdout.contains("exported 1 commit"),
        "{}",
        second.stdout
    );

    let mut want = fx.pub_subjects.clone();
    want.push("feat: genuinely new".to_string());
    assert_eq!(fx.pub_repo.subjects("HEAD"), want);
    assert_eq!(
        fx.pub_repo.tree_sha("HEAD", None),
        fx.mono.tree_sha("HEAD", Some("core"))
    );
}

/// S98: the snapshot shape (S130) — the directory existed once and was removed, so HEAD has
/// no `core/` tree at attach time.
#[test]
fn s98_keeps_the_pub_log_to_its_own_commits_snapshot() {
    let fx = configured_fixture(ConfiguredOpts {
        commits: 4,
        mono_core: &[("core/legacy.txt", Some("gone later\n"))],
        ..Default::default()
    });
    fx.mono
        .commit("mono: extend legacy", &[("core/legacy-2.txt", Some("b\n"))]);
    fx.mono.commit(
        "mono: drop the directory",
        &[("core/legacy.txt", None), ("core/legacy-2.txt", None)],
    );

    assert_push_never_replays_pre_attach_history(&fx, &["attach", "core"]);
}

/// S98: the matching-trees shape (S132).
#[test]
fn s98_keeps_the_pub_log_to_its_own_commits_matching_trees() {
    let fx = configured_fixture(ConfiguredOpts {
        commits: 4,
        mono_core: &[("core/README.md", Some("# draft\n"))],
        up_files: &[("README.md", Some("# same\n"))],
        up_tail: &[
            ("file-1.txt", None),
            ("file-2.txt", None),
            ("file-3.txt", None),
        ],
        ..Default::default()
    });
    fx.mono.commit(
        "mono: rework the draft",
        &[("core/README.md", Some("# same\n"))],
    );

    assert_push_never_replays_pre_attach_history(&fx, &["attach", "core"]);
}

/// S98: the `--theirs` shape (S132).
#[test]
fn s98_keeps_the_pub_log_to_its_own_commits_theirs() {
    let fx = configured_fixture(ConfiguredOpts {
        commits: 4,
        mono_core: &[("core/README.md", Some("# mono side\n"))],
        up_files: &[("README.md", Some("# pub side\n"))],
        ..Default::default()
    });
    fx.mono.commit(
        "mono: private history one",
        &[("core/legacy-a.txt", Some("a\n"))],
    );
    fx.mono.commit(
        "mono: private history two",
        &[("core/legacy-b.txt", Some("b\n"))],
    );

    assert_push_never_replays_pre_attach_history(&fx, &["attach", "core", "--theirs"]);
}
