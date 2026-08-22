//! Port of the corresponding TypeScript module — see docs/rust-port.md.
//!
//! Argument surface only for now: the behavior lands with the sync-view port.

use crate::report::Failure;

#[derive(clap::Args, Debug)]
pub struct DoctorArgs {
    #[arg(
        value_name = "subrepo",
        help = "Only check this subrepo (defaults to all)"
    )]
    pub subrepo: Option<String>,

    #[arg(long, help = "Print machine-readable JSON and nothing else")]
    pub json: bool,
}

pub fn run(_args: &DoctorArgs) -> Result<(), Failure> {
    Err(Failure::error("monosplice doctor: not ported yet"))
}
