#!/bin/sh
# monolith installer — https://github.com/jakequist/monolith
#
#   curl -fsSL https://raw.githubusercontent.com/jakequist/monolith/main/install.sh | sh
#
# Installs the latest GitHub release via npm. This is a thin convenience over:
#   npm install -g https://github.com/jakequist/monolith/releases/latest/download/monolith.tgz
set -eu

TARBALL_URL="https://github.com/jakequist/monolith/releases/latest/download/monolith.tgz"

fail() {
  printf '%s\n' "install.sh: $1" >&2
  exit 1
}

command -v git >/dev/null 2>&1 || fail "git is required (>= 2.30) but was not found on PATH."
command -v node >/dev/null 2>&1 || fail "Node.js >= 20 is required but was not found on PATH. Install it from https://nodejs.org (or your version manager), then re-run."
command -v npm >/dev/null 2>&1 || fail "npm is required but was not found on PATH (it normally ships with Node.js)."

node_major=$(node -p 'process.versions.node.split(".")[0]')
[ "$node_major" -ge 20 ] || fail "Node.js >= 20 is required; found $(node --version)."

printf 'Installing monolith from the latest GitHub release…\n'
npm install -g "$TARBALL_URL"

if command -v monolith >/dev/null 2>&1; then
  printf '✓ installed: %s\n' "$(monolith --version)"
  printf 'Get started: cd your-monorepo && monolith init\n'
else
  printf '✓ installed, but `monolith` is not on your PATH yet.\n'
  printf 'Your npm global bin directory (%s) needs to be on PATH.\n' "$(npm prefix -g)/bin"
fi
