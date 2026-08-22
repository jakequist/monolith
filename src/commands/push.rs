//! Port of the corresponding TypeScript module — see docs/rust-port.md.
//!
//! Argument surface only for now: the behavior lands with the exporter port.

use crate::report::Failure;

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

pub fn run(_args: &PushArgs) -> Result<(), Failure> {
    Err(Failure::error("monosplice push: not ported yet"))
}
