//! Port of the corresponding TypeScript module — see docs/rust-port.md.
//!
//! Argument surface only for now: the behavior lands with the importer port.

use crate::report::Failure;

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

pub fn run(_args: &PullArgs) -> Result<(), Failure> {
    Err(Failure::error("monosplice pull: not ported yet"))
}
