//! Port of src/core (see docs/rust-port.md).
//!
//! Where the CLI installs itself from. npm is no longer the mechanism: `update` reads the
//! GitHub Releases API and swaps the binary, so the asset is a per-target tarball.

/// The literal behind `RELEASE_REPO`, so the URLs below can be `const`.
macro_rules! release_repo {
    () => {
        "jakequist/monosplice"
    };
}

/// GitHub repo that hosts the releases the CLI installs from.
pub const RELEASE_REPO: &str = release_repo!();

/// Package, binary and tarball name.
pub const PACKAGE: &str = "monosplice";

pub const RELEASES_PAGE: &str = concat!("https://github.com/", release_repo!(), "/releases");
pub const LATEST_RELEASE_API: &str = concat!(
    "https://api.github.com/repos/",
    release_repo!(),
    "/releases/latest"
);

/// `JSON.stringify` of a string, so the error quotes the tag exactly as the TS did.
fn json_quote(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for c in value.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// `v1.2.3` → `1.2.3`. Errors when the tag carries no version.
pub fn version_from_tag(tag: &str) -> Result<String, String> {
    let trimmed = tag.trim();
    let version = trimmed.strip_prefix('v').unwrap_or(trimmed);
    if version.is_empty() {
        return Err(format!(
            "release tag {} does not contain a version",
            json_quote(tag)
        ));
    }
    Ok(version.to_string())
}

/// Immutable, versioned asset URL for a target triple — installing this guarantees you get
/// the version that was just checked, not whatever "latest" points at by then.
pub fn release_asset_url(version: &str, target: &str) -> String {
    format!("{RELEASES_PAGE}/download/v{version}/{PACKAGE}-{version}-{target}.tar.gz")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urls_point_at_the_release_repo() {
        assert_eq!(RELEASE_REPO, "jakequist/monosplice");
        assert_eq!(
            RELEASES_PAGE,
            "https://github.com/jakequist/monosplice/releases"
        );
        assert_eq!(
            LATEST_RELEASE_API,
            "https://api.github.com/repos/jakequist/monosplice/releases/latest"
        );
    }

    #[test]
    fn strips_a_leading_v() {
        assert_eq!(version_from_tag("v1.2.3").unwrap(), "1.2.3");
    }

    #[test]
    fn accepts_a_tag_that_is_already_a_bare_version() {
        assert_eq!(version_from_tag("0.1.0").unwrap(), "0.1.0");
    }

    #[test]
    fn keeps_prerelease_and_build_metadata_intact() {
        assert_eq!(version_from_tag("v1.0.0-rc.1").unwrap(), "1.0.0-rc.1");
        assert_eq!(version_from_tag("v1.0.0+build.5").unwrap(), "1.0.0+build.5");
    }

    #[test]
    fn only_strips_the_first_v() {
        assert_eq!(version_from_tag("vv1.0.0").unwrap(), "v1.0.0");
    }

    #[test]
    fn ignores_surrounding_whitespace() {
        assert_eq!(version_from_tag("  v1.2.3\n").unwrap(), "1.2.3");
    }

    #[test]
    fn rejects_tags_with_nothing_left_after_the_v() {
        assert!(version_from_tag("").is_err());
        assert!(version_from_tag("   ").is_err());
        let message = version_from_tag("v").expect_err("expected an error");
        assert_eq!(message, "release tag \"v\" does not contain a version");
    }

    #[test]
    fn asset_url_points_at_the_versioned_per_target_tarball() {
        assert_eq!(
            release_asset_url("1.2.3", "x86_64-unknown-linux-gnu"),
            "https://github.com/jakequist/monosplice/releases/download/v1.2.3/monosplice-1.2.3-x86_64-unknown-linux-gnu.tar.gz"
        );
    }
}
