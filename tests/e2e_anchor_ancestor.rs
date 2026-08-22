//! e2e regression: an attach anchor that does NOT touch the subrepo path must still bound the
//! export. The anchor commit records `Monosplice-Origin` on `monosplice.toml` alone, so a
//! commit *before* it (whose tree is already the remote head) is an ancestor of the sync point
//! and is reflected by ancestry — it must never be re-exported, even when a `scan` hook makes
//! the anchor's tree impossible to re-materialize.
//!
//! Without the fix the scan hook defeats anchor detection, `export_base` collapses to "scan all
//! of HEAD", and the path walk runs back past the anchor to the pre-attach commit.

mod common;

use common::{
    make_bare_remote, make_repo, run_monosplice, sandbox, subrepo_block, toml_str, write_config,
    TestRepo,
};

const UP_NAME: &str = "Up Stream";
const UP_EMAIL: &str = "up@example.test";

/// The published content carries a legacy marker the local `scan` later rejects. The subrepo
/// tree at the pre-attach commit — and at the attach anchor — is byte-identical to this.
const PUB_README: &str = "# core\n";
const PUB_LEGACY: &str = "API_KEY=leaked-marker-xyz\n";

fn core_block(remote: &str) -> String {
    subrepo_block(&[
        ("name", &toml_str("core")),
        ("path", &toml_str("core")),
        ("remote", &toml_str(remote)),
    ])
}

/// The same block plus a `scan` hook that rejects any tree still carrying the legacy marker.
fn core_block_with_scan(remote: &str) -> String {
    let mut block = core_block(remote);
    block.push_str(
        "scan = 'if grep -rq leaked-marker-xyz .; then echo \"legacy secret in tree\" >&2; exit 1; fi'\n",
    );
    block
}

#[test]
fn a_pre_attach_commit_is_never_re_exported_even_when_a_scan_hook_hides_the_anchor() {
    let sb = sandbox();

    // A standalone repo with its own history, pushed to the bare "public" remote.
    let pub_dir = make_bare_remote(sb.path(), "core-pub");
    let up = make_repo(sb.path(), "upstream");
    up.commit_as(
        "upstream: initial",
        &[
            ("README.md", Some(PUB_README)),
            ("legacy.env", Some(PUB_LEGACY)),
        ],
        UP_NAME,
        UP_EMAIL,
    );
    up.git(&["remote", "add", "origin", &pub_dir]);
    up.git(&["push", "origin", "main"]);
    let pub_repo = TestRepo::new(&pub_dir);
    let pub_head = pub_repo.head();

    // The monorepo: an empty config, then a commit (A) whose core/ tree exactly matches the
    // remote head tree. `attach` will record its anchor on monosplice.toml alone.
    let mono = make_repo(sb.path(), "mono");
    write_config(&mono, &[]);
    mono.commit(
        "chore: initial monorepo",
        &[("app/main.ts", Some("export const app = true\n"))],
    );
    let a = mono.commit(
        "add core matching remote",
        &[
            ("core/README.md", Some(PUB_README)),
            ("core/legacy.env", Some(PUB_LEGACY)),
        ],
    );
    assert_eq!(
        mono.tree_sha("HEAD", Some("core")),
        pub_repo.tree_sha("HEAD", None),
        "the pre-attach tree must match the remote head tree"
    );

    // Attach: trees match, so the anchor is one commit touching only monosplice.toml.
    let res = run_monosplice(&mono.dir, &["attach", "core", &pub_dir]);
    assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);
    assert_eq!(
        mono.git(&["diff", "--name-only", "HEAD~1", "HEAD"]),
        "monosplice.toml",
        "the anchor must not touch the subrepo path"
    );
    let status = run_monosplice(&mono.dir, &["status"]);
    assert!(
        status.stdout.contains("core: in sync"),
        "right after attach: {}",
        status.stdout
    );

    // Now a `scan` hook is added that rejects the legacy marker still living in the published
    // tree, then the marker is scrubbed from the monorepo, then unrelated new work lands.
    write_config(&mono, &[&core_block_with_scan(&pub_dir)]);
    mono.commit("chore: enable secret scan", &[]);
    let scrub = mono.commit(
        "scrub: drop the legacy marker",
        &[("core/legacy.env", None)],
    );
    let brand_new = mono.commit(
        "feat: brand new file",
        &[("core/new.ts", Some("export const n = 1\n"))],
    );

    // The two commits that touch core AFTER the anchor are the only pending work; the
    // pre-attach commit A is an ancestor of the anchor and must not appear.
    let dry = run_monosplice(&mono.dir, &["push", "--dry-run"]);
    assert_eq!(dry.exit_code, 0, "stderr: {}", dry.stderr);
    assert!(
        dry.stdout
            .contains("core: 2 to push (dry run — nothing written)"),
        "expected exactly the two post-anchor commits, got:\n{}",
        dry.stdout
    );
    assert!(
        dry.stdout.contains(&scrub[..10]) && dry.stdout.contains(&brand_new[..10]),
        "the post-anchor commits must be listed:\n{}",
        dry.stdout
    );
    assert!(
        !dry.stdout.contains(&a[..10]) && !dry.stdout.contains("add core matching remote"),
        "the pre-attach commit A must NOT be listed:\n{}",
        dry.stdout
    );

    // A real push exports exactly those two, parented on the existing remote head — commit A is
    // never replayed (its scan-failing tree would have aborted the push).
    let push = run_monosplice(&mono.dir, &["push"]);
    assert_eq!(push.exit_code, 0, "stderr: {}", push.stderr);
    assert!(
        !push.stderr.contains("scan hook rejected"),
        "commit A must never reach the scan: {}",
        push.stderr
    );
    assert!(push.stdout.contains("exported 2 commit"), "{}", push.stdout);
    assert_eq!(
        pub_repo.git(&["rev-parse", "HEAD~2"]),
        pub_head,
        "the remote must advance by exactly two commits from its original head"
    );
    let subjects = pub_repo.subjects("HEAD");
    assert_eq!(
        subjects[subjects.len() - 2..],
        ["scrub: drop the legacy marker", "feat: brand new file"]
    );
}
