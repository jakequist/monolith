//! Port of the corresponding TypeScript module — see docs/rust-port.md.
//!
//! npm is no longer the mechanism: the CLI is a single binary, so `update` asks the GitHub
//! Releases API what the latest version is and, when asked to, swaps the running executable
//! for the release asset built for this target triple.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::Command;

use crate::core::release::{
    release_asset_url, version_from_tag, LATEST_RELEASE_API, PACKAGE, RELEASES_PAGE,
};
use crate::report::Failure;

/// Seconds curl may spend on the whole request before it is a network problem.
const REQUEST_TIMEOUT_SECS: &str = "10";

/// The one command that reinstalls monosplice wherever it was installed from. Named verbatim
/// when the binary sits somewhere this process may not write.
const INSTALL_ONELINER: &str =
    "curl -fsSL https://github.com/jakequist/monosplice/releases/latest/download/install.sh | sh";

/// Release asset triple for the platform this binary was built for, decided at compile time.
/// `None` when monosplice publishes no asset for it — a source build on an unsupported
/// target, which `update` has to refuse rather than guess at.
#[cfg(all(target_arch = "x86_64", target_os = "linux"))]
pub const TARGET: Option<&str> = Some("x86_64-unknown-linux-musl");
#[cfg(all(target_arch = "aarch64", target_os = "linux"))]
pub const TARGET: Option<&str> = Some("aarch64-unknown-linux-musl");
#[cfg(all(target_arch = "x86_64", target_os = "macos"))]
pub const TARGET: Option<&str> = Some("x86_64-apple-darwin");
#[cfg(all(target_arch = "aarch64", target_os = "macos"))]
pub const TARGET: Option<&str> = Some("aarch64-apple-darwin");
#[cfg(all(target_arch = "x86_64", target_os = "windows"))]
pub const TARGET: Option<&str> = Some("x86_64-pc-windows-msvc");
#[cfg(not(any(
    all(target_arch = "x86_64", target_os = "linux"),
    all(target_arch = "aarch64", target_os = "linux"),
    all(target_arch = "x86_64", target_os = "macos"),
    all(target_arch = "aarch64", target_os = "macos"),
    all(target_arch = "x86_64", target_os = "windows"),
)))]
pub const TARGET: Option<&str> = None;

#[derive(clap::Args, Debug)]
pub struct UpdateArgs {
    #[arg(
        long,
        help = "Only report the installed and latest versions; change nothing"
    )]
    pub check: bool,
}

pub fn run(args: &UpdateArgs) -> Result<(), Failure> {
    let current = env!("CARGO_PKG_VERSION");

    if args.check {
        let latest = latest_version()?;
        println!("installed: {current}");
        println!("latest:    {latest}");
        if latest == current {
            println!("✓ up to date");
        } else {
            println!("Run `monosplice update` to install {latest}.");
        }
        return Ok(());
    }

    let exe = std::env::current_exe().map_err(|err| {
        Failure::error(format!(
            "Could not find the running monosplice binary: {err}\nNothing was changed. Reinstall with:\n  {INSTALL_ONELINER}"
        ))
    })?;

    // Checked before anything touches the network so a dev checkout fails fast and offline.
    if let Some(root) = source_checkout(&exe) {
        return Err(Failure::error(format!(
            "You're running monosplice from source ({}), not from an installed binary.
`monosplice update` replaces an installed binary, which is not what is on your PATH here.
Update this checkout with git instead:
  git -C {} pull",
            root.display(),
            root.display()
        )));
    }

    let latest = latest_version()?;
    if latest == current {
        println!("✓ monosplice {current} is already up to date");
        return Ok(());
    }

    let target = require_target()?;
    println!("Updating monosplice {current} → {latest}…");
    install(&exe, &latest, target)?;
    println!("✓ monosplice updated to {latest}");
    Ok(())
}

fn require_target() -> Result<&'static str, Failure> {
    TARGET.ok_or_else(|| {
        Failure::error(format!(
            "monosplice publishes no release binary for {}-{}, so there is nothing to update to.
Nothing was changed. Build from source, or look at the release history:
  {RELEASES_PAGE}",
            std::env::consts::ARCH,
            std::env::consts::OS
        ))
    })
}

/// The repository this executable was built in, when it was built in one: a `target/`
/// directory in its ancestry, or a crate root carrying a `.git`. Either way `update` must
/// refuse — replacing a `cargo build` artifact is not what the user meant.
fn source_checkout(exe: &Path) -> Option<PathBuf> {
    for ancestor in exe.ancestors().skip(1) {
        if ancestor.file_name() == Some(OsStr::new("target")) {
            return Some(ancestor.parent().unwrap_or(ancestor).to_path_buf());
        }
        if ancestor.join(".git").exists() && ancestor.join("Cargo.toml").is_file() {
            return Some(ancestor.to_path_buf());
        }
    }
    None
}

/// Newest released version, per the GitHub Releases API.
fn latest_version() -> Result<String, Failure> {
    let output = Command::new("curl")
        .args([
            "-fsSL",
            "--max-time",
            REQUEST_TIMEOUT_SECS,
            LATEST_RELEASE_API,
        ])
        .output();

    let output = match output {
        Ok(output) => output,
        // No curl on PATH lands here too, and the fix is the same: look at the releases page.
        Err(err) => return Err(unreachable_github(&format!("could not run curl: {err}"))),
    };

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let detail = if stderr.is_empty() {
            match output.status.code() {
                Some(code) => format!("curl exited {code}"),
                None => "curl was killed by a signal".to_string(),
            }
        } else {
            stderr
        };
        return Err(unreachable_github(&detail));
    }

    let body = String::from_utf8_lossy(&output.stdout).into_owned();
    let parsed: serde_json::Value = serde_json::from_str(&body)
        .map_err(|err| unreachable_github(&format!("could not read the API response: {err}")))?;
    let tag = parsed
        .get("tag_name")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| unreachable_github("the API response carried no tag_name"))?;
    version_from_tag(tag).map_err(|message| unreachable_github(&message))
}

fn unreachable_github(detail: &str) -> Failure {
    Failure::error(format!(
        "Could not ask GitHub for the latest {PACKAGE} version.
{detail}
Check your network, then try again — or look at the release history:
  {RELEASES_PAGE}"
    ))
}

/// Download the release tarball, unpack it and put the new binary where the old one is.
///
/// The swap is a rename over `current_exe`, which is atomic on the same filesystem — a
/// half-written binary on PATH is the one outcome an updater may never produce.
fn install(exe: &Path, version: &str, target: &str) -> Result<(), Failure> {
    let url = release_asset_url(version, target);
    let work = TempDir::new(&format!("monosplice-update-{version}"))?;
    let tarball = work.path().join(format!("{PACKAGE}.tar.gz"));

    let fetched = Command::new("curl")
        .args([
            "-fsSL",
            "--max-time",
            "120",
            "-o",
            &tarball.to_string_lossy(),
            &url,
        ])
        .status();
    match fetched {
        Ok(status) if status.success() => {}
        Ok(status) => {
            return Err(download_failed(
                &url,
                &match status.code() {
                    Some(code) => format!("curl exited {code}"),
                    None => "curl was killed by a signal".to_string(),
                },
            ))
        }
        Err(err) => return Err(download_failed(&url, &format!("could not run curl: {err}"))),
    }

    let unpacked = Command::new("tar")
        .args(["-xzf", &tarball.to_string_lossy(), "-C"])
        .arg(work.path())
        .status();
    match unpacked {
        Ok(status) if status.success() => {}
        Ok(status) => {
            return Err(Failure::error(format!(
                "Could not unpack the monosplice {version} release (tar exited {}).\nNothing was changed. Reinstall with:\n  {INSTALL_ONELINER}",
                status.code().unwrap_or(-1)
            )))
        }
        Err(err) => {
            return Err(Failure::error(format!(
                "Could not run tar to unpack the monosplice {version} release: {err}\nNothing was changed. Reinstall with:\n  {INSTALL_ONELINER}"
            )))
        }
    }

    let downloaded = work.path().join(binary_name());
    if !downloaded.is_file() {
        return Err(Failure::error(format!(
            "The monosplice {version} release archive did not contain a {} binary.\nNothing was changed. Reinstall with:\n  {INSTALL_ONELINER}",
            binary_name()
        )));
    }

    // Written beside the binary it replaces so the rename below stays on one filesystem.
    let staged = with_extension_suffix(exe, "new");
    std::fs::copy(&downloaded, &staged).map_err(|err| cannot_write(exe, &err))?;
    make_executable(&staged).map_err(|err| cannot_write(exe, &err))?;
    if let Err(err) = std::fs::rename(&staged, exe) {
        let _ = std::fs::remove_file(&staged);
        return Err(cannot_write(exe, &err));
    }
    Ok(())
}

fn download_failed(url: &str, detail: &str) -> Failure {
    Failure::error(format!(
        "Could not download {url}
{detail}
Nothing was changed. Check your network and try again, or look at the release history:
  {RELEASES_PAGE}"
    ))
}

fn cannot_write(exe: &Path, err: &std::io::Error) -> Failure {
    if err.kind() == std::io::ErrorKind::PermissionDenied {
        return Failure::error(format!(
            "monosplice does not have permission to replace {}.
Nothing was changed. Reinstall it where you installed it from:
  {INSTALL_ONELINER}",
            exe.display()
        ));
    }
    Failure::error(format!(
        "Could not replace {}: {err}\nNothing was changed. Reinstall with:\n  {INSTALL_ONELINER}",
        exe.display()
    ))
}

fn binary_name() -> String {
    format!("{PACKAGE}{}", std::env::consts::EXE_SUFFIX)
}

/// `<exe>.new`, keeping any existing extension (`monosplice.exe` → `monosplice.exe.new`).
fn with_extension_suffix(exe: &Path, suffix: &str) -> PathBuf {
    let mut name = exe.as_os_str().to_os_string();
    name.push(".");
    name.push(suffix);
    PathBuf::from(name)
}

#[cfg(unix)]
fn make_executable(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
}

#[cfg(not(unix))]
fn make_executable(_path: &Path) -> std::io::Result<()> {
    Ok(())
}

/// Scratch directory for one update, removed when the update ends however it ends.
struct TempDir(PathBuf);

impl TempDir {
    fn new(tag: &str) -> Result<Self, Failure> {
        let dir = std::env::temp_dir().join(format!("{tag}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).map_err(|err| {
            Failure::error(format!(
                "Could not create a temporary directory at {}: {err}\nNothing was changed.",
                dir.display()
            ))
        })?;
        Ok(TempDir(dir))
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_target_triple_describes_the_platform_this_was_built_for() {
        let target = require_target().expect("the test runner is a released platform");
        assert!(
            target.starts_with(std::env::consts::ARCH),
            "triple must start with the arch: {target}"
        );
        assert_eq!(
            target.split('-').count(),
            4,
            "a target triple has four dash-separated parts: {target}"
        );
    }

    #[test]
    fn the_asset_url_names_the_versioned_tarball_for_this_target() {
        let target = require_target().expect("the test runner is a released platform");
        let url = release_asset_url("9.9.9", target);
        assert!(
            url.ends_with(&format!("monosplice-9.9.9-{target}.tar.gz")),
            "{url}"
        );
    }

    #[test]
    fn a_cargo_build_artifact_reads_as_a_source_checkout() {
        let exe = Path::new("/home/me/monosplice/target/debug/monosplice");
        assert_eq!(
            source_checkout(exe),
            Some(PathBuf::from("/home/me/monosplice"))
        );
    }

    #[test]
    fn an_installed_binary_does_not_read_as_a_source_checkout() {
        assert_eq!(
            source_checkout(Path::new("/usr/local/bin/monosplice")),
            None
        );
    }

    #[test]
    fn the_staged_binary_sits_beside_the_one_it_replaces() {
        assert_eq!(
            with_extension_suffix(Path::new("/usr/local/bin/monosplice"), "new"),
            PathBuf::from("/usr/local/bin/monosplice.new")
        );
    }

    #[test]
    fn the_reinstall_hint_is_the_documented_one_liner() {
        assert!(INSTALL_ONELINER.starts_with("curl -fsSL https://github.com/jakequist/monosplice/releases/latest/download/install.sh"));
        assert!(INSTALL_ONELINER.ends_with("| sh"));
    }
}
