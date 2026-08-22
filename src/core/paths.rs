//! Path helpers: the config's `exclude` globs and subrepo path normalization.

use globset::{GlobBuilder, GlobSet, GlobSetBuilder};

/// Matcher for the config's `exclude` globs. Paths are relative to the subrepo
/// root (no leading slash). Dotfiles are matched by wildcards, which is what
/// picomatch's `dot: true` gave the TS version and what globset does by default.
pub struct Excluder {
    /// `None` when no patterns were configured: matches nothing at all.
    set: Option<GlobSet>,
}

impl Excluder {
    pub fn matches(&self, rel_path: &str) -> bool {
        match &self.set {
            None => false,
            Some(set) => set.is_match(rel_path),
        }
    }
}

/// Build a matcher for the config's `exclude` globs. `literal_separator(true)` is what
/// keeps `*` inside one path component while `**` spans components — picomatch's default
/// and the meaning users expect from `.gitignore`-shaped globs.
pub fn make_excluder(patterns: &[String]) -> Result<Excluder, String> {
    if patterns.is_empty() {
        return Ok(Excluder { set: None });
    }
    let mut builder = GlobSetBuilder::new();
    for p in patterns {
        let glob = GlobBuilder::new(p)
            .literal_separator(true)
            .build()
            .map_err(|e| format!("invalid exclude pattern {}: {e}", quoted(p)))?;
        builder.add(glob);
    }
    let set = builder
        .build()
        .map_err(|e| format!("invalid exclude patterns: {e}"))?;
    Ok(Excluder { set: Some(set) })
}

/// Normalize a configured subrepo path: strip leading/trailing slashes and a leading `./`,
/// reject escapes.
///
/// The `./` tolerance is not cosmetic: it is what a shell's own tab-completion produces, and
/// what the README quickstart types (`attach ./core`). Only the *leading* prefix is forgiven —
/// a `.` or `..` anywhere else still means the caller is pointing outside the subrepo.
pub fn normalize_subrepo_path(p: &str) -> Result<String, String> {
    let mut cleaned = p.trim_start_matches('/').trim_end_matches('/').to_string();
    while let Some(rest) = cleaned.strip_prefix("./") {
        cleaned = rest.trim_start_matches('/').to_string();
    }
    if cleaned.is_empty() || cleaned == "." {
        return Err(format!(
            "subrepo path may not be the repo root: {}",
            quoted(p)
        ));
    }
    if cleaned.split('/').any(|s| s == ".." || s == ".") {
        return Err(format!(
            "subrepo path may not contain '.' or '..' segments: {}",
            quoted(p)
        ));
    }
    Ok(cleaned)
}

/// The TS built these messages with `JSON.stringify(p)`; keep that quoting so the
/// wording is identical for odd paths too.
fn quoted(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| format!("\"{s}\""))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn excluder(patterns: &[&str]) -> Excluder {
        let owned: Vec<String> = patterns.iter().map(|p| (*p).to_string()).collect();
        make_excluder(&owned).expect("patterns compile")
    }

    #[test]
    fn matches_nothing_with_no_patterns() {
        let ex = make_excluder(&[]).expect("empty compiles");
        assert!(!ex.matches("anything.txt"));
    }

    #[test]
    fn matches_globs_including_dotfiles_and_nested_paths() {
        let ex = excluder(&["**/INTERNAL.md", "secrets/**", ".private-*"]);
        assert!(ex.matches("INTERNAL.md"));
        assert!(ex.matches("docs/INTERNAL.md"));
        assert!(ex.matches("secrets/key.pem"));
        assert!(ex.matches(".private-notes"));
        assert!(!ex.matches("README.md"));
        assert!(!ex.matches("src/secrets.ts"));
    }

    // picomatch-parity pins.

    #[test]
    fn globstar_prefix_matches_at_the_root_too() {
        let ex = excluder(&["**/*.md"]);
        assert!(ex.matches("docs/x.md"));
        assert!(ex.matches("x.md"));
        assert!(ex.matches("a/b/c/x.md"));
    }

    #[test]
    fn a_star_does_not_cross_a_slash() {
        let ex = excluder(&["*.md"]);
        assert!(ex.matches("x.md"));
        assert!(!ex.matches("docs/x.md"));
    }

    #[test]
    fn literal_dotfile_patterns_match() {
        let ex = excluder(&[".env"]);
        assert!(ex.matches(".env"));
        assert!(!ex.matches("a/.env"));
    }

    #[test]
    fn a_trailing_globstar_matches_everything_below() {
        let ex = excluder(&["secret/**"]);
        assert!(ex.matches("secret/a/b"));
        assert!(ex.matches("secret/a"));
        assert!(!ex.matches("other/a"));
    }

    #[test]
    fn globstar_matches_dotfiles_at_any_depth() {
        let ex = excluder(&["**/.env"]);
        assert!(ex.matches(".env"));
        assert!(ex.matches("a/.env"));
        assert!(ex.matches("a/b/.env"));
    }

    #[test]
    fn wildcards_match_dotfiles() {
        let ex = excluder(&["**/*"]);
        assert!(ex.matches(".hidden"));
        assert!(ex.matches("a/.hidden"));
    }

    #[test]
    fn any_pattern_matching_excludes() {
        let ex = excluder(&["a.txt", "b.txt"]);
        assert!(ex.matches("a.txt"));
        assert!(ex.matches("b.txt"));
        assert!(!ex.matches("c.txt"));
    }

    #[test]
    fn an_invalid_pattern_is_reported_not_panicked() {
        assert!(make_excluder(&["[".to_string()]).is_err());
    }

    #[test]
    fn strips_slashes() {
        assert_eq!(
            normalize_subrepo_path("/taka-core/").as_deref(),
            Ok("taka-core")
        );
        assert_eq!(
            normalize_subrepo_path("packages/lib").as_deref(),
            Ok("packages/lib")
        );
    }

    #[test]
    fn rejects_root_and_escaping_paths() {
        assert!(normalize_subrepo_path("/").is_err());
        assert!(normalize_subrepo_path(".").is_err());
        assert!(normalize_subrepo_path("a/../b").is_err());
    }

    // S166: the README quickstart types `attach ./core`, and shell completion produces it.
    #[test]
    fn tolerates_a_leading_dot_slash_and_normalizes_it_away() {
        assert_eq!(normalize_subrepo_path("./core").as_deref(), Ok("core"));
        assert_eq!(
            normalize_subrepo_path("./packages/lib").as_deref(),
            Ok("packages/lib")
        );
        assert_eq!(normalize_subrepo_path("./core/").as_deref(), Ok("core"));
        assert_eq!(normalize_subrepo_path(".//core").as_deref(), Ok("core"));
        assert_eq!(normalize_subrepo_path("././core").as_deref(), Ok("core"));
    }

    #[test]
    fn still_rejects_bare_dot_and_dotdot_once_the_leading_dot_slash_is_gone() {
        assert!(normalize_subrepo_path("./").is_err());
        assert!(normalize_subrepo_path("./.").is_err());
        assert!(normalize_subrepo_path("./..").is_err());
        assert!(normalize_subrepo_path("./../core").is_err());
        assert!(normalize_subrepo_path("./a/./b").is_err());
    }

    #[test]
    fn error_messages_quote_the_original_input_json_style() {
        assert_eq!(
            normalize_subrepo_path("/").unwrap_err(),
            "subrepo path may not be the repo root: \"/\""
        );
        assert_eq!(
            normalize_subrepo_path("a/../b").unwrap_err(),
            "subrepo path may not contain '.' or '..' segments: \"a/../b\""
        );
        assert_eq!(
            normalize_subrepo_path("a/\"q\"/../b").unwrap_err(),
            "subrepo path may not contain '.' or '..' segments: \"a/\\\"q\\\"/../b\""
        );
    }
}
