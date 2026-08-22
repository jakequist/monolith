//! Port of the corresponding TypeScript module — see docs/rust-port.md.
//!
//! Argument surface only for now: the behavior lands with the vendor port.

use crate::report::Failure;

#[derive(clap::Args, Debug)]
pub struct DetachArgs {
    #[arg(
        value_name = "subrepo",
        help = "Subrepo to stop tracking (its name, or its folder)"
    )]
    pub subrepo: String,
}

pub fn run(_args: &DetachArgs) -> Result<(), Failure> {
    Err(Failure::error("monosplice detach: not ported yet"))
}
