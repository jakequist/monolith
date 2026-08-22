//! Port of the corresponding TypeScript module — see docs/rust-port.md.
//!
//! Export new monorepo commits to the standalone remotes. One subrepo refusing (typically:
//! never published, no `--yes`) must not silence the others, so failures are collected by
//! [`each_subrepo`] and reported together at the end.

use std::path::Path;

use crate::config::ResolvedSubrepo;
use crate::core::sync_view::SyncViewOptions;
use crate::ops::{
    confirm_first_publish, export_subrepo, first_publish, load_view, plan_push_dry_run, short,
    upstream_has_no_branch, ConfirmFirstPublishOptions, DryRunPlan, DRY_RUN_NOTE,
};
use crate::report::{each_subrepo, require_project, select_subrepos, Failure, SubrepoFailure};

#[derive(clap::Args, Debug)]
pub struct PushArgs {
    #[arg(
        value_name = "subrepo",
        help = "Only push this subrepo (defaults to all)"
    )]
    pub subrepo: Option<String>,

    #[arg(
        short = 'y',
        long,
        help = "Answer the first-publish confirmation with yes (required in scripts and CI)"
    )]
    pub yes: bool,

    #[arg(
        long = "export-history",
        help = "First publish only: replay every monorepo commit that touched the subrepo instead of one baseline commit (not to be confused with `attach --import-history`, which replays the standalone repo's commits inwards)"
    )]
    pub export_history: bool,

    #[arg(
        long = "dry-run",
        help = "List the commits a push would export and write nothing — no remote ref, no commit, no working-tree change. Scan/transform hooks do NOT run on a dry run, so the list is what would be attempted; the hooks still gate the real push and a rejected commit will stop it."
    )]
    pub dry_run: bool,
}

pub fn run(args: &PushArgs) -> Result<(), Failure> {
    let project = require_project()?;
    let selected = select_subrepos(&project, args.subrepo.as_deref())?;
    let root = project.root.as_path();

    if args.dry_run {
        return each_subrepo(&selected, |subrepo| preview_one(root, subrepo, args));
    }

    each_subrepo(&selected, |subrepo| push_one(root, subrepo, args))
}

/// Report the plan and stop. Every call below this line is a read.
fn preview_one(
    root: &Path,
    subrepo: &ResolvedSubrepo,
    args: &PushArgs,
) -> Result<(), SubrepoFailure> {
    let plan = plan_push_dry_run(root, subrepo, args.export_history)?;

    if let DryRunPlan::FirstPublish {
        export_history,
        commits,
    } = &plan
    {
        let how = if *export_history {
            format!("replaying {} commit(s)", commits.len())
        } else {
            "one baseline commit".to_string()
        };
        println!(
            "{}: would publish {}/ to {} ({}) for the first time — {how} ({DRY_RUN_NOTE})",
            subrepo.name, subrepo.path, subrepo.remote, subrepo.branch
        );
    } else if plan.commits().is_empty() {
        println!("{}: up to date ({DRY_RUN_NOTE})", subrepo.name);
        return Ok(());
    } else {
        println!(
            "{}: {} to push ({DRY_RUN_NOTE})",
            subrepo.name,
            plan.commits().len()
        );
    }

    for c in plan.commits() {
        println!("  {} {}", short(&c.sha), c.subject);
    }
    Ok(())
}

fn push_one(root: &Path, subrepo: &ResolvedSubrepo, args: &PushArgs) -> Result<(), SubrepoFailure> {
    let view = load_view(root, subrepo, SyncViewOptions::default())?;

    if view.pub_head.is_none() && subrepo.upstream.is_some() {
        return Err(SubrepoFailure::new(upstream_has_no_branch(subrepo)));
    }

    if view.pub_head.is_none() {
        let result = first_publish(root, subrepo, args.export_history, || {
            confirm_first_publish(
                subrepo,
                &ConfirmFirstPublishOptions {
                    yes: args.yes,
                    ..Default::default()
                },
            )
        })?;
        let how = if result.export_history {
            format!("replayed {} commit(s)", result.commits)
        } else {
            "one baseline commit".to_string()
        };
        println!(
            "✓ {}: published {}/ to {} ({}) — {how}",
            subrepo.name, subrepo.path, subrepo.remote, subrepo.branch
        );
        return Ok(());
    }

    if args.export_history {
        let pub_head = view.pub_head.as_deref().unwrap_or_default();
        return Err(SubrepoFailure::new(format!(
            "{}: --export-history only applies to the first publish, and {} already has a {} branch ({}).
Nothing was pushed. Run `monosplice push {}` to export new commits.",
            subrepo.name,
            subrepo.remote,
            subrepo.branch,
            short(pub_head),
            subrepo.name
        )));
    }

    let summary = export_subrepo(root, subrepo, Some(view))?;
    let fork = if subrepo.upstream.is_none() {
        String::new()
    } else {
        format!(" to {} ({})", subrepo.remote, subrepo.push_branch)
    };

    if summary.pushed > 0 {
        println!(
            "✓ {}: exported {} commit(s){fork}",
            subrepo.name, summary.pushed
        );
    } else if summary.awaiting > 0 {
        println!(
            "✓ {}: up to date — {} ({}) already carries {} commit(s), awaiting an upstream merge",
            subrepo.name, subrepo.remote, subrepo.push_branch, summary.awaiting
        );
    } else {
        println!("✓ {}: up to date", subrepo.name);
    }
    Ok(())
}
