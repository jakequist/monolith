//! Port of the corresponding TypeScript module — see docs/rust-port.md.
//!
//! Argument surface only for now: the behavior lands with the sync-view port.

use crate::report::Failure;

#[derive(clap::Args, Debug)]
pub struct StatusArgs {
    #[arg(
        value_name = "subrepo",
        help = "Only report this subrepo (defaults to all)"
    )]
    pub subrepo: Option<String>,

    #[arg(long, help = "Print machine-readable JSON and nothing else")]
    pub json: bool,

    #[arg(
        long,
        help = "Exit 1 unless every subrepo is fully in sync (for CI); the report itself is unchanged"
    )]
    pub check: bool,

    #[arg(
        long,
        help = "Fetch nothing: measure against the remote-tracking refs the last run left behind. A subrepo that has never been fetched is reported as such rather than guessed at."
    )]
    pub offline: bool,
}

pub fn run(_args: &StatusArgs) -> Result<(), Failure> {
    Err(Failure::error("monosplice status: not ported yet"))
}
