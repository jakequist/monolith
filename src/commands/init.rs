//! Port of the corresponding TypeScript module — see docs/rust-port.md.
//!
//! `init` scaffolds the config. The TS wrote a JavaScript module; the Rust port writes
//! `monosplice.toml`, and the template is entirely commented out on purpose: an
//! array-of-tables cannot be appended to a `subrepos = []` that is already there, so the
//! example block has to be a comment for `attach` to have somewhere to write.

use std::path::Path;

use crate::config::{find_config, CONFIG_FILENAME};
use crate::core::git::git_ok;
use crate::report::Failure;

pub const TEMPLATE: &str = r#"# Monosplice configuration.
# Docs: https://github.com/jakequist/monosplice
#
# Each subrepo is one [[subrepos]] block:
#
# [[subrepos]]
# path = "packages/my-lib"
# remote = "git@github.com:me/my-lib.git"
# branch = "main"
# exclude = []
"#;

#[derive(clap::Args, Debug)]
pub struct InitArgs {}

pub fn run(_args: &InitArgs) -> Result<(), Failure> {
    let cwd = std::env::current_dir()
        .map_err(|err| Failure::error(format!("Cannot read the current directory: {err}")))?;
    run_in(&cwd)
}

fn run_in(cwd: &Path) -> Result<(), Failure> {
    let existing = find_config(cwd).map_err(|err| Failure::error(err.0))?;
    if let Some(path) = existing {
        println!("Already initialized: {}", path.display());
        return Ok(());
    }

    if !git_ok(cwd, &["rev-parse", "--is-inside-work-tree"]) {
        return Err(Failure::error(
            "Not inside a git repository. Run `git init` first — monosplice manages subdirectories of a git repo.",
        ));
    }

    let target = cwd.join(CONFIG_FILENAME);
    std::fs::write(&target, TEMPLATE).map_err(|err| {
        Failure::error(format!(
            "Could not write {}: {err}\nNothing was changed.",
            target.display()
        ))
    })?;

    println!("Created {}", target.display());
    println!("Add your subrepos to the config, then run `monosplice push <name>` to publish one");
    println!(
        "(or skip the hand-editing: `monosplice attach <folder> <git-url>` writes the entry and"
    );
    println!("makes first contact for you, whichever side already has content).");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_template_carries_a_commented_subrepos_example() {
        let commented = |needle: &str| {
            TEMPLATE
                .lines()
                .any(|l| l.trim_start().starts_with('#') && l.contains(needle))
        };
        assert!(commented("[[subrepos]]"), "{TEMPLATE}");
        assert!(commented("path = "), "{TEMPLATE}");
        assert!(commented("remote = "), "{TEMPLATE}");
        assert!(commented("branch = "), "{TEMPLATE}");
        assert!(commented("exclude = "), "{TEMPLATE}");
    }

    /// The template must load through the real loader as "nothing attached yet", or `attach`
    /// would have no valid file to append its first entry to.
    #[test]
    fn the_template_is_a_valid_empty_config() {
        let resolved = crate::config::resolve_config(TEMPLATE, Path::new("/repo/monosplice.toml"))
            .expect("the scaffold must be valid TOML the loader accepts");
        assert!(resolved.is_empty());
    }
}
