//! Port of the corresponding TypeScript module — see docs/rust-port.md.
//!
//! Argument surface only for now: the behavior lands with the importer/exporter ports.

use crate::report::Failure;

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

pub fn run(_args: &SyncArgs) -> Result<(), Failure> {
    Err(Failure::error("monosplice sync: not ported yet"))
}
