//! e2e: `monosplice update` — port of `test/e2e/update.test.ts`.
//!
//! Both scenarios run against surface that is already ported: the refusal fires offline,
//! before any release lookup, and the command list is clap's own.

mod common;

use common::{run_monosplice, sandbox};

/// Commands the top-level help must advertise, each starting a line of its own.
const ADVERTISED: [&str; 9] = [
    "attach", "init", "push", "pull", "sync", "status", "doctor", "tag", "update",
];

/// Absorbed by `attach` and never to reappear as commands.
const ABSORBED: [&str; 2] = ["adopt", "vendor"];

/// `/a.*b/` without a regex engine: every needle present, in this order.
fn contains_in_order(haystack: &str, needles: &[&str]) -> bool {
    let mut rest = haystack;
    for needle in needles {
        match rest.find(needle) {
            Some(at) => rest = &rest[at + needle.len()..],
            None => return false,
        }
    }
    true
}

/// `/^\s*<word>\b/m`: some line begins (after its indent) with exactly this word.
fn starts_a_line(text: &str, word: &str) -> bool {
    text.lines().any(|line| {
        line.trim_start()
            .strip_prefix(word)
            .is_some_and(|rest| !rest.starts_with(|c: char| c.is_alphanumeric() || c == '_'))
    })
}

#[test]
fn update_refuses_to_self_update_when_the_cli_is_running_from_a_source_checkout() {
    let sb = sandbox();
    // The test binary lives under `target/`, which is exactly the dev build `update` refuses.
    let res = run_monosplice(sb.path(), &["update"]);
    assert_ne!(res.exit_code, 0, "stdout: {}", res.stdout);

    let lower = res.stderr.to_lowercase();
    assert!(
        contains_in_order(&lower, &["running", "from source"]),
        "the refusal must say monosplice is running from source, got:\n{}",
        res.stderr
    );
    assert!(
        contains_in_order(&res.stderr, &["git ", " pull"]),
        "the refusal must name a `git … pull` as the way to update a checkout, got:\n{}",
        res.stderr
    );
    // The refusal must come before any release lookup, so it works offline.
    assert!(
        !lower.contains("registry"),
        "no registry may be consulted before refusing, got:\n{}",
        res.stderr
    );
}

#[test]
fn update_is_listed_in_the_top_level_help_alongside_the_other_commands() {
    let sb = sandbox();
    let res = run_monosplice(sb.path(), &["--help"]);
    assert_eq!(res.exit_code, 0, "stderr: {}", res.stderr);

    let all = format!("{}\n{}", res.stdout, res.stderr);
    for command in ADVERTISED {
        assert!(
            starts_a_line(&all, command),
            "help should list {command}, got:\n{all}"
        );
    }
    assert!(
        !starts_a_line(&all, "seed"),
        "seed was retired, got:\n{all}"
    );
    for gone in ABSORBED {
        assert!(
            !starts_a_line(&all, gone),
            "{gone} was absorbed by attach, got:\n{all}"
        );
    }
}
