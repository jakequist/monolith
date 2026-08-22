//! New in the Rust port: `clap_complete` replaces oclif's autocomplete plugin.
//!
//! The script is written to stdout so it can be sourced or redirected; nothing is installed
//! and nothing on disk is touched.

use clap::CommandFactory;
use clap_complete::Shell;

use crate::report::Failure;

#[derive(clap::Args, Debug)]
pub struct CompletionArgs {
    #[arg(value_name = "shell", help = "Shell to print a completion script for")]
    pub shell: Shell,
}

pub fn run<C: CommandFactory>(args: &CompletionArgs) -> Result<(), Failure> {
    let mut cmd = C::command();
    let name = cmd.get_name().to_string();
    clap_complete::generate(args.shell, &mut cmd, name, &mut std::io::stdout());
    Ok(())
}
