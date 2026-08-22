//! Port of the corresponding TypeScript module — see docs/rust-port.md.
//!
//! Pull then push each subrepo. Import before export, always: publishing from a half-converged
//! monorepo would export work the standalone repo has not been reconciled with.

use std::path::Path;

use crate::config::{Project, ResolvedSubrepo};
use crate::core::importer::{continue_import, read_sequencer, unmerged_paths, PullSequencer};
use crate::ops::{
    export_subrepo, git_message, import_subrepo, pull_in_progress_message, report_import_failure,
    resolve_or_abort, NO_PULL_IN_PROGRESS,
};
use crate::report::{each_subrepo, json_quote, require_project, select_subrepos, warn, Failure};

/// `sync` finishes its own interrupted run, so its conflict names its own verb.
const SYNC_CONTINUE: &str = "monosplice sync --continue";

#[derive(clap::Args, Debug)]
pub struct SyncArgs {
    #[arg(
        value_name = "subrepo",
        help = "Only sync this subrepo (defaults to all)"
    )]
    pub subrepo: Option<String>,

    #[arg(
        long = "continue",
        help = "Finish a sync that stopped on a conflict, after resolving and `git add`: completes the import, then pushes every subrepo (the push phase never ran)"
    )]
    pub r#continue: bool,
}

pub fn run(args: &SyncArgs) -> Result<(), Failure> {
    let project = require_project()?;
    let root = project.root.as_path();

    let state = read_sequencer(root);
    if args.r#continue {
        if state.is_none() {
            return Err(Failure::error(NO_PULL_IN_PROGRESS));
        }
    } else if let Some(state) = &state {
        return Err(Failure::error(pull_in_progress_message(
            state,
            Some(SYNC_CONTINUE),
        )));
    }

    // Resolved before anything is written, so an unknown name refuses without side effects.
    // The subrepo that was interrupted is always part of the walk, even when a different one
    // was named: it is the one whose push phase never ran.
    let selected = select_subrepos(&project, args.subrepo.as_deref())?;
    let interrupted = state
        .as_ref()
        .and_then(|state| project.subrepos.iter().find(|s| s.name == state.subrepo));
    let walk: Vec<&ResolvedSubrepo> = match interrupted {
        Some(interrupted) if !selected.iter().any(|s| s.name == interrupted.name) => {
            let mut walk = vec![interrupted];
            walk.extend(selected.iter().copied());
            walk
        }
        _ => selected,
    };

    // Commits the interrupted import landed before the walk resumes. They belong to the
    // subrepo's tally below, which would otherwise report the resumed pull as "imported 0".
    let resumed: Option<(String, usize)> = match &state {
        Some(state) => Some((state.subrepo.clone(), resume(&project, state)?)),
        None => None,
    };

    // A subrepo that refuses is collected and the next one still runs — except a conflict,
    // which halts the run.
    //
    // After a `--continue` this walks EVERY selected subrepo again, push included: the
    // interrupted run never reached its push phase, and a subrepo that is already converged
    // simply reports "up to date".
    each_subrepo(&walk, |subrepo| {
        let already = match &resumed {
            Some((name, count)) if *name == subrepo.name => *count,
            _ => 0,
        };
        let imported = already + import_subrepo(root, subrepo, Some(SYNC_CONTINUE))?;
        let pushed = export_subrepo(root, subrepo, None)?.pushed;

        if imported == 0 && pushed == 0 {
            println!("✓ {}: up to date", subrepo.name);
        } else {
            println!("✓ {}: imported {imported}, exported {pushed}", subrepo.name);
        }
        Ok(())
    })
}

/// Finish the commit the user just resolved, exactly as `pull --continue` does.
fn resume(project: &Project, state: &PullSequencer) -> Result<usize, Failure> {
    let root: &Path = project.root.as_path();
    let Some(subrepo) = project.subrepos.iter().find(|s| s.name == state.subrepo) else {
        return Err(Failure::error(format!(
            "The interrupted pull references subrepo {}, which is no longer in your config.
Nothing was changed. Restore the entry in your config, or run `monosplice pull --abort` to throw the import away.",
            json_quote(&state.subrepo)
        )));
    };

    let unmerged = unmerged_paths(root).map_err(|err| Failure::error(git_message(&err)))?;
    if !unmerged.is_empty() {
        return Err(Failure::error(format!(
            "{}: these files are still unmerged:\n{}\nNothing was changed. Resolve them, `git add` each one, then run:\n{}",
            subrepo.name,
            unmerged
                .iter()
                .map(|f| format!("  {f}"))
                .collect::<Vec<_>>()
                .join("\n"),
            resolve_or_abort(Some(SYNC_CONTINUE))
        )));
    }

    // Not collected: this runs before the walk, so a second conflict has no walk to be
    // collected into and must stop the command where it stands.
    let result =
        continue_import(root, subrepo, state, &mut |message| warn(&message)).map_err(|err| {
            Failure::error(report_import_failure(subrepo, err, Some(SYNC_CONTINUE)).message)
        })?;

    Ok(result.imported.len())
}
