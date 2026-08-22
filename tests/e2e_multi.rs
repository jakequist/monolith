//! e2e: several subrepos in one monorepo — port of `test/e2e/multi.test.ts`.
//!
//! Adapted per `docs/rust-port.md` only in the config format; the scenarios (separate remotes,
//! named push, one commit touching both subrepos) port verbatim, including the blob-absence
//! checks that are the real proof that nothing leaks across the boundary.

mod common;

use common::{clone_remote, multi_fixture, run_monosplice, MultiFixture, TestRepo};

/// Seed both subrepos of the multi fixture.
fn seeded_pair() -> MultiFixture {
    let fixture = multi_fixture();
    for name in ["core", "lib"] {
        let res = run_monosplice(&fixture.mono.dir, &["push", name, "--yes"]);
        assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);
    }
    fixture
}

/// Assert a blob with exactly this content is absent from `repo`'s object db.
///
/// This is the load-bearing check: a subrepo's remote must never so much as *contain* another
/// subrepo's (or the monorepo's private) objects, reachable or not.
fn assert_blob_absent(repo: &TestRepo, mono: &TestRepo, content: &str) {
    let blob = mono.git_with(&["hash-object", "--stdin"], &[], Some(content));
    // sanity: the monorepo really does have it
    mono.git(&["cat-file", "-e", &blob]);
    let found = repo.git_try(&["cat-file", "-e", &blob]);
    assert_ne!(
        found.exit_code,
        0,
        "blob {blob} for {content:?} must not exist in {}",
        repo.dir.display()
    );
}

/// Sorted paths of a tree-ish.
fn sorted_tree_paths(repo: &TestRepo, treeish: &str) -> Vec<String> {
    let mut paths: Vec<String> = repo
        .tree_entries(treeish, None)
        .iter()
        .filter_map(|e| e.split(' ').nth(2).map(str::to_owned))
        .collect();
    paths.sort();
    paths
}

/// S60: two subrepos with separate remotes export each to its own remote only.
#[test]
fn s60_two_subrepos_with_separate_remotes_export_to_their_own_remote_only() {
    let fx = seeded_pair();
    let mono = &fx.mono;

    let core_content = "export const greet = () => \"hi from core\"\n";
    let lib_content = "export const helper = () => \"hi from lib\"\n";
    mono.commit(
        "feat(core): add greeter",
        &[("core/src/greet.ts", Some(core_content))],
    );
    mono.commit(
        "feat(lib): add helper",
        &[("packages/lib/src/helper.ts", Some(lib_content))],
    );

    let res = run_monosplice(&mono.dir, &["push"]);
    assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);
    assert!(
        res.stdout.contains("core: exported 1 commit"),
        "stdout: {}",
        res.stdout
    );
    assert!(
        res.stdout.contains("lib: exported 1 commit"),
        "stdout: {}",
        res.stdout
    );

    assert_eq!(
        fx.core_pub.subjects("HEAD"),
        vec!["Initial import of core", "feat(core): add greeter"]
    );
    assert_eq!(
        fx.lib_pub.subjects("HEAD"),
        vec!["Initial import of lib", "feat(lib): add helper"]
    );

    assert_eq!(
        fx.core_pub.tree_sha("HEAD", None),
        mono.tree_sha("HEAD", Some("core"))
    );
    assert_eq!(
        fx.lib_pub.tree_sha("HEAD", None),
        mono.tree_sha("HEAD", Some("packages/lib"))
    );

    // The nested path must not leak into the public tree: pub sees `src/helper.ts`,
    // never `packages/lib/src/helper.ts`.
    assert_eq!(
        sorted_tree_paths(&fx.lib_pub, "HEAD"),
        vec!["README.md", "src/helper.ts", "src/lib.ts"]
    );

    assert_blob_absent(&fx.core_pub, mono, lib_content);
    assert_blob_absent(&fx.lib_pub, mono, core_content);
    assert_blob_absent(&fx.lib_pub, mono, "internal only\n");
}

/// S60: external commits are imported back into the nested subrepo path.
#[test]
fn s60_imports_external_commits_back_into_the_nested_subrepo_path() {
    let fx = seeded_pair();
    let mono = &fx.mono;

    let ext = clone_remote(fx.sandbox.path(), &fx.lib_pub_dir, "lib-ext");
    ext.commit(
        "external: document the lib",
        &[("docs/usage.md", Some("usage\n"))],
    );
    ext.git(&["push", "origin", "main"]);
    let ext_sha = ext.head();

    let res = run_monosplice(&mono.dir, &["pull"]);
    assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);
    assert!(
        res.stdout.contains("lib: imported 1 commit"),
        "stdout: {}",
        res.stdout
    );

    assert_eq!(mono.read("packages/lib/docs/usage.md"), "usage\n");
    assert_eq!(mono.file_at("HEAD", "packages/lib/docs/usage.md"), "usage");
    let messages = mono.messages("HEAD");
    assert!(
        messages
            .last()
            .is_some_and(|m| m.contains(&format!("Monosplice-Origin: {ext_sha}"))),
        "messages: {messages:?}"
    );

    // The import must not have created a `docs/` directory at the monorepo root.
    assert!(!mono.exists("docs/usage.md"));

    let after = run_monosplice(&mono.dir, &["push"]);
    assert_eq!(after.exit_code, 0, "stderr: {}", after.stderr);
    assert!(
        after.stdout.contains("lib: up to date"),
        "stdout: {}",
        after.stdout
    );
}

/// S61: a named push touches only that subrepo, leaving the other behind until it is pushed too.
#[test]
fn s61_named_push_touches_only_that_subrepo() {
    let fx = seeded_pair();
    let mono = &fx.mono;
    let lib_head_before = fx.lib_pub.head();

    mono.commit("feat(core): core work", &[("core/a.txt", Some("a\n"))]);
    mono.commit(
        "feat(lib): lib work",
        &[("packages/lib/b.txt", Some("b\n"))],
    );

    let first = run_monosplice(&mono.dir, &["push", "core"]);
    assert_eq!(first.exit_code, 0, "stderr: {}", first.stderr);
    assert!(
        first.stdout.contains("core: exported 1 commit"),
        "stdout: {}",
        first.stdout
    );
    assert!(
        !first.stdout.contains("lib:"),
        "a named push must stay silent about the others, got:\n{}",
        first.stdout
    );

    assert_eq!(
        fx.core_pub.subjects("HEAD"),
        vec!["Initial import of core", "feat(core): core work"]
    );
    assert_eq!(fx.lib_pub.head(), lib_head_before);
    assert_eq!(fx.lib_pub.subjects("HEAD"), vec!["Initial import of lib"]);

    let status = run_monosplice(&mono.dir, &["status", "--json"]);
    assert_eq!(status.exit_code, 0, "stderr: {}", status.stderr);
    assert_eq!(
        subrepo_number(&status.stdout, "core", "ahead"),
        Some(0),
        "status --json: {}",
        status.stdout
    );
    assert_eq!(
        subrepo_number(&status.stdout, "lib", "ahead"),
        Some(1),
        "status --json: {}",
        status.stdout
    );

    let second = run_monosplice(&mono.dir, &["push", "lib"]);
    assert_eq!(second.exit_code, 0, "stderr: {}", second.stderr);
    assert!(
        second.stdout.contains("lib: exported 1 commit"),
        "stdout: {}",
        second.stdout
    );
    assert_eq!(
        fx.lib_pub.subjects("HEAD"),
        vec!["Initial import of lib", "feat(lib): lib work"]
    );
    assert_eq!(
        fx.lib_pub.tree_sha("HEAD", None),
        mono.tree_sha("HEAD", Some("packages/lib"))
    );
}

/// Read `<key>` as a number out of the compact `status --json` object whose `"name"` is `name`.
///
/// Hand-rolled rather than pulled in as a dependency: the JSON contract is flat rows of scalars
/// (`docs/rust-port.md`), so brace matching around the `"name"` hit is enough.
fn subrepo_number(json: &str, name: &str, key: &str) -> Option<i64> {
    let marker = format!("\"name\":\"{name}\"");
    let hit = json.find(&marker)?;

    let bytes = json.as_bytes();
    let mut start = hit;
    let mut depth = 0i32;
    loop {
        match bytes[start] {
            b'}' => depth += 1,
            b'{' if depth == 0 => break,
            b'{' => depth -= 1,
            _ => {}
        }
        start = start.checked_sub(1)?;
    }

    let mut end = hit;
    depth = 0;
    while end < bytes.len() {
        match bytes[end] {
            b'{' => depth += 1,
            b'}' if depth == 0 => break,
            b'}' => depth -= 1,
            _ => {}
        }
        end += 1;
    }

    let row = json.get(start..end)?;
    let at = row.find(&format!("\"{key}\":"))? + key.len() + 3;
    let digits: String = row[at..]
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '-')
        .collect();
    digits.parse().ok()
}

/// S62: one commit touching both subrepos exports one commit to each pub, each carrying only
/// its own subtree.
#[test]
fn s62_one_commit_touching_both_subrepos_exports_one_commit_to_each_pub() {
    let fx = seeded_pair();
    let mono = &fx.mono;

    let mono_sha = mono.commit(
        "feat: cross-cutting rename",
        &[
            ("core/version.txt", Some("2.0.0\n")),
            ("packages/lib/version.txt", Some("2.0.0\n")),
            ("private/notes.md", Some("do not publish 91af\n")),
        ],
    );

    let res = run_monosplice(&mono.dir, &["push"]);
    assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);
    assert!(
        res.stdout.contains("core: exported 1 commit"),
        "stdout: {}",
        res.stdout
    );
    assert!(
        res.stdout.contains("lib: exported 1 commit"),
        "stdout: {}",
        res.stdout
    );

    assert_eq!(
        fx.core_pub.subjects("HEAD"),
        vec!["Initial import of core", "feat: cross-cutting rename"]
    );
    assert_eq!(
        fx.lib_pub.subjects("HEAD"),
        vec!["Initial import of lib", "feat: cross-cutting rename"]
    );

    // Same mono commit is the source on both sides.
    for pub_repo in [&fx.core_pub, &fx.lib_pub] {
        let messages = pub_repo.messages("HEAD");
        assert!(
            messages
                .last()
                .is_some_and(|m| m.contains(&format!("Monosplice-Source: {mono_sha}"))),
            "messages: {messages:?}"
        );
    }

    assert_eq!(
        fx.core_pub.tree_sha("HEAD", None),
        mono.tree_sha("HEAD", Some("core"))
    );
    assert_eq!(
        fx.lib_pub.tree_sha("HEAD", None),
        mono.tree_sha("HEAD", Some("packages/lib"))
    );

    assert_eq!(
        sorted_tree_paths(&fx.core_pub, "HEAD"),
        vec!["README.md", "src/index.ts", "version.txt"]
    );
    assert_eq!(
        sorted_tree_paths(&fx.lib_pub, "HEAD"),
        vec!["README.md", "src/lib.ts", "version.txt"]
    );

    assert_blob_absent(&fx.core_pub, mono, "do not publish 91af\n");
    assert_blob_absent(&fx.lib_pub, mono, "do not publish 91af\n");
    assert_blob_absent(&fx.core_pub, mono, "export const lib = true\n");
    assert_blob_absent(&fx.lib_pub, mono, "export const hello = () => \"hello\"\n");
}
