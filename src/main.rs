//! Command-line entry point: clap parsing, flat subcommand dispatch, and the one place a
//! [`Failure`] becomes an exit code.
//!
//! The error contract (docs/rust-port.md) is what oclif produced and the e2e suite asserts:
//! `Error: <message>` on stderr with newlines intact, exit 2 for a refusal, exit 1 for the
//! places the TS passed `{exit: 1}`, and clap's own exit 2 for a bad command line.
#![allow(dead_code)]

mod commands;
mod config;
mod core;
mod ops;
mod report;

use clap::{Parser, Subcommand};

use report::Failure;

#[derive(Parser, Debug)]
#[command(
    name = "monosplice",
    version,
    about,
    propagate_version = true,
    subcommand_required = true,
    arg_required_else_help = true
)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand, Debug)]
enum Commands {
    #[command(about = "Create a monosplice.toml in the current directory")]
    Init(commands::init::InitArgs),

    #[command(
        about = "Show how far each subrepo is ahead of and behind its standalone remote",
        after_help = "Examples:
  monosplice status
  monosplice status core
  monosplice status --json
  monosplice status --check
  monosplice status --offline"
    )]
    Status(commands::status::StatusArgs),

    #[command(
        about = "Export new monorepo commits to the standalone subrepo remotes",
        after_help = "Examples:
  monosplice push
  monosplice push core
  monosplice push --dry-run
  monosplice push core --yes
  monosplice push core --yes --export-history"
    )]
    Push(commands::push::PushArgs),

    #[command(
        about = "Import new standalone-repo commits into the monorepo",
        after_help = "Examples:
  monosplice pull
  monosplice pull core
  monosplice pull --dry-run
  monosplice pull --continue
  monosplice pull --abort"
    )]
    Pull(commands::pull::PullArgs),

    #[command(
        about = "Pull then push each subrepo, converging the monorepo with its standalone remotes",
        after_help = "Examples:
  monosplice sync
  monosplice sync core
  monosplice sync --continue"
    )]
    Sync(commands::sync::SyncArgs),

    #[command(
        about = "Tag the standalone commit that corresponds to the current monorepo HEAD",
        after_help = "Examples:
  monosplice tag core v1.0.0"
    )]
    Tag(commands::tag::TagArgs),

    #[command(
        about = "Connect a folder to a standalone repo and make first contact; writes the config entry when the folder is not configured yet",
        after_help = "Examples:
  monosplice attach core git@github.com:you/core.git
  monosplice attach core
  monosplice attach packages/lib git@github.com:you/lib.git --name lib
  monosplice attach core git@github.com:you/core.git --yes --export-history
  monosplice attach core --import-history
  monosplice attach core --theirs
  monosplice attach vendor/lodash git@github.com:lodash/lodash.git --fork git@github.com:you/lodash.git"
    )]
    Attach(commands::attach::AttachArgs),

    #[command(
        about = "Stop tracking a subrepo: remove its entry from the config, keeping the folder and all of its history",
        after_help = "Examples:
  monosplice detach core
  monosplice detach packages/lib"
    )]
    Detach(commands::detach::DetachArgs),

    #[command(
        about = "Report the derived sync points for every subrepo and verify they match reality",
        after_help = "Examples:
  monosplice doctor
  monosplice doctor core
  monosplice doctor --json"
    )]
    Doctor(commands::doctor::DoctorArgs),

    #[command(
        about = "Update monosplice to the latest released version",
        after_help = "Examples:
  monosplice update
  monosplice update --check"
    )]
    Update(commands::update::UpdateArgs),

    #[command(
        about = "Print a shell completion script",
        after_help = "Examples:
  monosplice completion bash
  monosplice completion zsh
  monosplice completion fish"
    )]
    Completion(commands::completion::CompletionArgs),
}

fn dispatch(command: &Commands) -> Result<(), Failure> {
    match command {
        Commands::Init(args) => commands::init::run(args),
        Commands::Status(args) => commands::status::run(args),
        Commands::Push(args) => commands::push::run(args),
        Commands::Pull(args) => commands::pull::run(args),
        Commands::Sync(args) => commands::sync::run(args),
        Commands::Tag(args) => commands::tag::run(args),
        Commands::Attach(args) => commands::attach::run(args),
        Commands::Detach(args) => commands::detach::run(args),
        Commands::Doctor(args) => commands::doctor::run(args),
        Commands::Update(args) => commands::update::run(args),
        Commands::Completion(args) => commands::completion::run::<Cli>(args),
    }
}

fn main() {
    let cli = Cli::parse();
    if let Err(failure) = dispatch(&cli.command) {
        // Multi-line messages keep their newlines: no `›` gutter, no wrapping (the oclif
        // behavior the e2e suite asserts on).
        eprintln!("Error: {}", failure.message);
        std::process::exit(failure.exit_code);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory;

    #[test]
    fn the_command_line_definition_is_internally_consistent() {
        Cli::command().debug_assert();
    }

    #[test]
    fn every_command_in_the_surface_is_reachable() {
        let cmd = Cli::command();
        // `help` is clap's own, appended when the command tree is built.
        let names: Vec<&str> = cmd
            .get_subcommands()
            .map(clap::Command::get_name)
            .filter(|name| *name != "help")
            .collect();
        assert_eq!(
            names,
            vec![
                "init",
                "status",
                "push",
                "pull",
                "sync",
                "tag",
                "attach",
                "detach",
                "doctor",
                "update",
                "completion",
            ]
        );
    }
}
