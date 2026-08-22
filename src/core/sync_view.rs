//! Port of src/core (see docs/rust-port.md).
//!
//! Seed only: the tracking-ref names and the two triangular predicates that `config`,
//! `vendor` and the commands need today. The rest of `src/core/sync.ts` — `SyncView`,
//! `NoFetchYetError`, fetching, anchors, ahead/behind — lands from a later agent's branch;
//! do not treat this file as the finished port.

use crate::config::ResolvedSubrepo;

/// Where a subrepo's public branch is mirrored inside the monorepo's object db.
pub fn remote_tracking_ref(name: &str) -> String {
    format!("refs/monosplice/{name}/remote")
}

/// Where the fork's push branch is mirrored (triangular mode only).
pub fn fork_tracking_ref(name: &str) -> String {
    format!("refs/monosplice/{name}/fork")
}

/// The repository every sync decision is made against. With `upstream` configured that is
/// upstream and only upstream: the fork is a derived artifact monosplice rebuilds, so
/// consulting it for imports or anchors would let our own exports masquerade as public
/// history.
pub fn pull_source(s: &ResolvedSubrepo) -> &str {
    s.upstream.as_deref().unwrap_or(&s.remote)
}

/// Is this subrepo pulled from one repository and pushed to another?
pub fn is_triangular(s: &ResolvedSubrepo) -> bool {
    s.upstream.is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn subrepo(upstream: Option<&str>) -> ResolvedSubrepo {
        ResolvedSubrepo {
            name: "core".to_string(),
            path: "core".to_string(),
            remote: "fork".to_string(),
            upstream: upstream.map(str::to_string),
            branch: "main".to_string(),
            push_branch: "main".to_string(),
            exclude: Vec::new(),
            rewrite_message: None,
            transform: None,
            scan: None,
        }
    }

    #[test]
    fn tracking_refs_are_namespaced_per_subrepo() {
        assert_eq!(remote_tracking_ref("core"), "refs/monosplice/core/remote");
        assert_eq!(fork_tracking_ref("core"), "refs/monosplice/core/fork");
    }

    #[test]
    fn upstream_decides_where_the_tree_comes_from() {
        assert_eq!(pull_source(&subrepo(None)), "fork");
        assert!(!is_triangular(&subrepo(None)));
        assert_eq!(pull_source(&subrepo(Some("up"))), "up");
        assert!(is_triangular(&subrepo(Some("up"))));
    }
}
