//! e2e: `monosplice tag` — port of `test/e2e/tag.test.ts`.
//!
//! A tag is only meaningful if the standalone commit it lands on is the one that corresponds
//! to the current monorepo HEAD, so every refusal here is about that correspondence.

mod common;

use common::{clone_remote, run_monosplice, standard_fixture, Fixture, TestRepo};

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

/// Tag shas advertised by the bare remote, as `<sha> <ref>` lines.
fn remote_tags(mono: &TestRepo, pub_dir: &str) -> Vec<String> {
    let out = mono.git(&["ls-remote", "--tags", pub_dir]);
    if out.is_empty() {
        return Vec::new();
    }
    out.split('\n').map(|l| l.replacen('\t', " ", 1)).collect()
}

/// S70: `tag` puts the name on the standalone commit that matches mono HEAD.
#[test]
fn s70_tags_the_public_commit_matching_mono_head_and_makes_it_visible_on_the_remote() {
    let seeded = seeded();
    let mono = &seeded.fx.mono;
    mono.commit("feat: ship it", &[("core/ship.txt", Some("ready\n"))]);

    let push = run_monosplice(&mono.dir, &["push"]);
    assert_eq!(push.exit_code, 0, "stderr: {}", push.stderr);
    let pub_head = seeded.pub_repo.head();

    let res = run_monosplice(&mono.dir, &["tag", "core", "v1.0.0"]);
    assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);
    assert!(
        res.stdout.contains("✓ core: tagged v1.0.0"),
        "got:\n{}",
        res.stdout
    );
    assert!(
        res.stdout.contains(&pub_head[..10]),
        "the report must name the commit it tagged, got:\n{}",
        res.stdout
    );

    assert_eq!(
        remote_tags(mono, &seeded.fx.pub_dir),
        [format!("{pub_head} refs/tags/v1.0.0")]
    );
}

/// S70: a tag name is claimed once; the second attempt must not move it.
#[test]
fn s70_refuses_a_tag_name_that_already_exists_on_the_remote() {
    let seeded = seeded();
    let mono = &seeded.fx.mono;

    let first = run_monosplice(&mono.dir, &["tag", "core", "v1.0.0"]);
    assert_eq!(first.exit_code, 0, "stderr: {}", first.stderr);
    let pub_head = seeded.pub_repo.head();

    mono.commit("feat: more", &[("core/more.txt", Some("more\n"))]);
    let push = run_monosplice(&mono.dir, &["push"]);
    assert_eq!(push.exit_code, 0, "stderr: {}", push.stderr);

    let res = run_monosplice(&mono.dir, &["tag", "core", "v1.0.0"]);
    assert_ne!(res.exit_code, 0, "stdout: {}", res.stdout);
    assert!(res.stderr.contains("v1.0.0"), "got:\n{}", res.stderr);
    assert!(
        res.stderr.to_lowercase().contains("already exists"),
        "got:\n{}",
        res.stderr
    );

    // still pointing at the original commit
    assert_eq!(
        remote_tags(mono, &seeded.fx.pub_dir),
        [format!("{pub_head} refs/tags/v1.0.0")]
    );
}

/// S71: unexported commits mean the tag would not match mono HEAD.
#[test]
fn s71_refuses_because_the_tag_would_not_match_mono_head_and_creates_no_tag() {
    let seeded = seeded();
    let mono = &seeded.fx.mono;
    mono.commit(
        "feat: not pushed yet",
        &[("core/pending.txt", Some("pending\n"))],
    );

    let res = run_monosplice(&mono.dir, &["tag", "core", "v1.0.0"]);
    assert_ne!(res.exit_code, 0, "stdout: {}", res.stdout);
    assert!(res.stderr.contains("1 commit"), "got:\n{}", res.stderr);
    assert!(
        res.stderr.contains("monosplice push core"),
        "the refusal must name the way out, got:\n{}",
        res.stderr
    );
    assert_eq!(remote_tags(mono, &seeded.fx.pub_dir), Vec::<String>::new());
}

/// S71: unimported standalone commits are the same problem from the other side.
#[test]
fn s71_refuses_while_unimported_public_commits_exist_pointing_at_pull() {
    let seeded = seeded();
    let mono = &seeded.fx.mono;

    let ext = clone_remote(seeded.fx.sandbox.path(), &seeded.fx.pub_dir, "ext");
    ext.commit("external: drive-by", &[("EXTERNAL.md", Some("outside\n"))]);
    ext.git(&["push", "origin", "main"]);

    let res = run_monosplice(&mono.dir, &["tag", "core", "v1.0.0"]);
    assert_ne!(res.exit_code, 0, "stdout: {}", res.stdout);
    assert!(
        res.stderr.contains("monosplice pull core"),
        "the refusal must point at pull, got:\n{}",
        res.stderr
    );
    assert_eq!(remote_tags(mono, &seeded.fx.pub_dir), Vec::<String>::new());
}

/// S71: there is nothing to tag before the first publish.
#[test]
fn s71_refuses_when_the_subrepo_has_never_been_seeded() {
    let fx = standard_fixture();
    let res = run_monosplice(&fx.mono.dir, &["tag", "core", "v1.0.0"]);
    assert_ne!(res.exit_code, 0, "stdout: {}", res.stdout);
    assert!(
        res.stderr.contains("monosplice push core --yes"),
        "the refusal must name the first publish, got:\n{}",
        res.stderr
    );
}
