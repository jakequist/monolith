//! Port of the corresponding TypeScript module — see docs/rust-port.md.
//!
//! Argument surface only for now: the behavior lands with the exporter port.

use crate::report::Failure;

#[derive(clap::Args, Debug)]
pub struct TagArgs {
    #[arg(value_name = "subrepo", help = "Name of the subrepo to tag")]
    pub subrepo: String,

    #[arg(
        value_name = "tag",
        help = "Tag name to create on the standalone remote"
    )]
    pub tag: String,
}

pub fn run(_args: &TagArgs) -> Result<(), Failure> {
    Err(Failure::error("monosplice tag: not ported yet"))
}
