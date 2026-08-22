//! Port of the corresponding TypeScript module — see docs/rust-port.md.
//!
//! Argument surface only for now: the behavior lands with the adopt/vendor ports.

use crate::report::Failure;

#[derive(clap::Args, Debug)]
pub struct AttachArgs {
    #[arg(
        value_name = "folder",
        help = "Directory in this monorepo to connect (or the name of a configured subrepo)"
    )]
    pub folder: String,

    #[arg(
        value_name = "url",
        help = "Git URL of the standalone repository. Optional when <folder> is already in your config"
    )]
    pub url: Option<String>,

    #[arg(
        long,
        value_name = "name",
        help = "Subrepo name (default: the last segment of <folder>)"
    )]
    pub name: Option<String>,

    #[arg(
        long,
        value_name = "branch",
        help = "Branch to sync on both sides (default: main)"
    )]
    pub branch: Option<String>,

    #[arg(
        short = 'y',
        long,
        help = "Answer the first-publish confirmation with yes (required in scripts and CI)"
    )]
    pub yes: bool,

    #[arg(
        long = "export-history",
        help = "First publish only: replay every monorepo commit that touched <folder> instead of one baseline commit (not to be confused with --import-history, which goes the other way)"
    )]
    pub export_history: bool,

    #[arg(
        long = "import-history",
        help = "Replay every commit from the standalone repo into <folder> instead of recording one snapshot commit (not to be confused with --export-history, which goes the other way)"
    )]
    pub import_history: bool,

    #[arg(
        long,
        help = "When both sides have content, replace <folder> with the standalone tree"
    )]
    pub theirs: bool,

    #[arg(
        long,
        value_name = "fork",
        help = "Your fork of the repository: pull from <url>, push patches to this remote"
    )]
    pub fork: Option<String>,
}

pub fn run(_args: &AttachArgs) -> Result<(), Failure> {
    Err(Failure::error("monosplice attach: not ported yet"))
}
