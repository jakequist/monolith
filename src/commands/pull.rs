//! Port of the corresponding TypeScript module — see docs/rust-port.md.
//!
//! Import new standalone-repo commits into the monorepo, plus the two ways out of a conflict:
//! `--continue` finishes the import the user just resolved, `--abort` throws it away.

use std::path::Path;

use crate::config::ResolvedSubrepo;
use crate::core::importer::{
    abort_import, continue_import, read_sequencer, unmerged_paths, AbortOutcome, PullSequencer,
};
use crate::ops::{
    git_message, import_subrepo, plan_pull_dry_run, pull_in_progress_message,
    report_import_failure, resolve_or_abort_pull, short, DRY_RUN_NOTE, NO_PULL_IN_PROGRESS,
};
use crate::report::{
    each_subrepo, json_quote, require_project, select_subrepos, warn, Failure, SubrepoFailure,
};

#[derive(clap::Args, Debug)]
pub struct PullArgs {
    #[arg(
        value_name = "subrepo",
        help = "Only pull this subrepo (defaults to all)"
    )]
    pub subrepo: Option<String>,

    #[arg(
        long = "continue",
        help = "Finish an import that stopped on a conflict, after resolving and `git add`"
    )]
    pub r#continue: bool,

    #[arg(
        long,
        help = "Abandon an import that stopped on a conflict, restoring the pre-pull state"
    )]
    pub abort: bool,

    #[arg(
        long = "dry-run",
        help = "List the commits a pull would import and write nothing — no commit, no working-tree or index change"
    )]
    pub dry_run: bool,
}

pub fn run(args: &PullArgs) -> Result<(), Failure> {
    let project = require_project()?;
    let root = project.root.as_path();
    let state = read_sequencer(root);

    if args.abort && args.r#continue {
        return Err(Failure::error(
            "--continue and --abort do the opposite things, so monosplice will not guess between them.\nNothing was changed. Run `monosplice pull --continue` to finish the import, or `monosplice pull --abort` to throw it away.",
        ));
    }

    if args.dry_run && (args.abort || args.r#continue) {
        let other = if args.abort { "--abort" } else { "--continue" };
        return Err(Failure::error(format!(
            "--dry-run only previews a fresh pull, so it cannot be combined with {other}.\nNothing was changed. Run `monosplice pull --dry-run` on its own, or `monosplice pull {other}` to act on the interrupted import.",
        )));
    }

    if args.dry_run {
        if let Some(state) = &state {
            return Err(Failure::error(pull_in_progress_message(state, None)));
        }
        let selected = select_subrepos(&project, args.subrepo.as_deref())?;
        return each_subrepo(&selected, |subrepo| preview_one(root, subrepo));
    }

    if args.abort {
        return abort(root, &project.subrepos, state.as_ref());
    }

    if args.r#continue {
        let Some(state) = &state else {
            return Err(Failure::error(NO_PULL_IN_PROGRESS));
        };
        let Some(interrupted) = project.subrepos.iter().find(|s| s.name == state.subrepo) else {
            return Err(missing_entry(state));
        };
        let selected = select_subrepos(&project, args.subrepo.as_deref())?;

        // The refusal below is fatal, not collected — and the interrupted subrepo leads the
        // walk, so checking here is where the TypeScript's first walk step would have.
        require_resolved(root, interrupted)?;

        let mut walk = vec![interrupted];
        walk.extend(
            selected
                .into_iter()
                .filter(|s| s.name != state.subrepo)
                .collect::<Vec<_>>(),
        );
        return each_subrepo(&walk, |subrepo| {
            if subrepo.name == state.subrepo {
                resume(root, subrepo, state)
            } else {
                pull_one(root, subrepo)
            }
        });
    }

    if let Some(state) = &state {
        return Err(Failure::error(pull_in_progress_message(state, None)));
    }

    let selected = select_subrepos(&project, args.subrepo.as_deref())?;
    each_subrepo(&selected, |subrepo| pull_one(root, subrepo))
}

/// Throw the interrupted import away. The subrepo path comes from the sequencer, so this
/// still works when the config entry was removed while the pull sat unfinished.
fn abort(
    root: &Path,
    subrepos: &[ResolvedSubrepo],
    state: Option<&PullSequencer>,
) -> Result<(), Failure> {
    let Some(state) = state else {
        return Err(Failure::error(
            "No pull is in progress — nothing to abort.\nNothing was changed. Run `monosplice pull` to import new standalone-repo commits.",
        ));
    };
    let sub_path = state.path.clone().or_else(|| {
        subrepos
            .iter()
            .find(|s| s.name == state.subrepo)
            .map(|s| s.path.clone())
    });
    let Some(sub_path) = sub_path else {
        return Err(missing_entry(state));
    };

    let result =
        abort_import(root, &sub_path, state).map_err(|err| Failure::error(git_message(&err)))?;
    for line in describe_abort(state, &sub_path, &result) {
        println!("{line}");
    }
    Ok(())
}

fn describe_abort(state: &PullSequencer, sub_path: &str, result: &AbortOutcome) -> Vec<String> {
    let name = &state.subrepo;
    if !result.rewound {
        let head = result.start_head.as_deref().map(short);
        return vec![
            format!(
                "✓ {name}: pull aborted — dropped the conflicted import of {} and restored {sub_path}/.",
                short(&state.current.sha)
            ),
            format!(
                "  The {} commit(s) this pull had already imported were KEPT: monorepo history has moved since they landed, and monosplice will not rewind past work it did not create.{}",
                result.kept.len(),
                match head {
                    None => String::new(),
                    Some(head) => format!(
                        " Pre-pull HEAD was {head} — `git reset --hard {head}` would undo the rest."
                    ),
                }
            ),
        ];
    }
    if result.discarded.is_empty() {
        return vec![format!(
            "✓ {name}: pull aborted — nothing had been imported; {sub_path}/ is as it was before the pull."
        )];
    }
    vec![format!(
        "✓ {name}: pull aborted — rewound {} imported commit(s); {sub_path}/ is as it was before the pull.",
        result.discarded.len()
    )]
}

fn missing_entry(state: &PullSequencer) -> Failure {
    Failure::error(format!(
        "The interrupted pull references subrepo {}, which is no longer in your config.
Nothing was changed. Restore the entry in your config, or run `monosplice pull --abort` to throw the import away.",
        json_quote(&state.subrepo)
    ))
}

/// A resolved merge is the price of `--continue`; anything still unmerged stops the command.
fn require_resolved(root: &Path, subrepo: &ResolvedSubrepo) -> Result<(), Failure> {
    let unmerged = unmerged_paths(root).map_err(|err| Failure::error(git_message(&err)))?;
    if unmerged.is_empty() {
        return Ok(());
    }
    Err(Failure::error(format!(
        "{}: these files are still unmerged:\n{}\nNothing was changed. Resolve them, `git add` each one, then run:\n{}",
        subrepo.name,
        unmerged
            .iter()
            .map(|f| format!("  {f}"))
            .collect::<Vec<_>>()
            .join("\n"),
        resolve_or_abort_pull()
    )))
}

fn resume(
    root: &Path,
    subrepo: &ResolvedSubrepo,
    state: &PullSequencer,
) -> Result<(), SubrepoFailure> {
    let result = continue_import(root, subrepo, state, &mut |message| warn(&message))
        .map_err(|err| report_import_failure(subrepo, err, None))?;
    report(subrepo, result.imported.len());
    Ok(())
}

/// Report what would be imported and stop. Every call below this line is a read.
fn preview_one(root: &Path, subrepo: &ResolvedSubrepo) -> Result<(), SubrepoFailure> {
    let plan = plan_pull_dry_run(root, subrepo)?;
    if plan.commits().is_empty() {
        println!("{}: up to date ({DRY_RUN_NOTE})", subrepo.name);
        return Ok(());
    }
    println!(
        "{}: {} to pull ({DRY_RUN_NOTE})",
        subrepo.name,
        plan.commits().len()
    );
    for c in plan.commits() {
        println!("  {} {}", short(&c.sha), c.subject);
    }
    Ok(())
}

fn pull_one(root: &Path, subrepo: &ResolvedSubrepo) -> Result<(), SubrepoFailure> {
    let imported = import_subrepo(root, subrepo, None)?;
    report(subrepo, imported);
    Ok(())
}

fn report(subrepo: &ResolvedSubrepo, count: usize) {
    if count == 0 {
        println!("✓ {}: up to date", subrepo.name);
    } else {
        println!("✓ {}: imported {count} commit(s)", subrepo.name);
    }
}
