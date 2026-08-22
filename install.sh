#!/bin/sh
# monosplice installer — https://github.com/jakequist/monosplice
#
#   curl -fsSL https://github.com/jakequist/monosplice/releases/latest/download/install.sh | sh
#
# Downloads the prebuilt monosplice binary for this platform from GitHub Releases.
#   MONOSPLICE_VERSION      install this version instead of the latest release
#   MONOSPLICE_INSTALL_DIR  install here instead of /usr/local/bin or ~/.local/bin
set -eu

REPO="jakequist/monosplice"
RELEASES="https://github.com/$REPO/releases"

fail() {
  printf 'install.sh: %s\n' "$1" >&2
  exit 1
}

command -v curl >/dev/null 2>&1 || fail "curl is required but was not found on PATH."
command -v tar >/dev/null 2>&1 || fail "tar is required but was not found on PATH."
command -v git >/dev/null 2>&1 || printf 'note: monosplice drives system git (>= 2.30), which is not on PATH.\n' >&2

case "$(uname -s)/$(uname -m)" in
  Linux/x86_64 | Linux/amd64) target="x86_64-unknown-linux-musl" ;;
  Linux/aarch64 | Linux/arm64) target="aarch64-unknown-linux-musl" ;;
  Darwin/x86_64) target="x86_64-apple-darwin" ;;
  Darwin/arm64) target="aarch64-apple-darwin" ;;
  *) fail "there is no prebuilt monosplice binary for $(uname -s)/$(uname -m).
Browse the releases at $RELEASES, or build it yourself:
  cargo install monosplice" ;;
esac

version="${MONOSPLICE_VERSION-}"
if [ -z "$version" ]; then
  latest=$(curl -fsSL --max-time 10 "https://api.github.com/repos/$REPO/releases/latest") ||
    fail "could not ask GitHub for the latest monosplice version.
Check your network and try again, or pick one from $RELEASES and set MONOSPLICE_VERSION."
  version=$(printf '%s\n' "$latest" | sed -n 's/.*"tag_name" *: *"\([^"]*\)".*/\1/p' | head -n 1)
  [ -n "$version" ] || fail "GitHub reported no latest monosplice release. See $RELEASES"
fi
version="${version#v}"

tmp=$(mktemp -d 2>/dev/null || mktemp -d -t monosplice)
trap 'rm -rf "$tmp"' EXIT INT TERM

url="$RELEASES/download/v$version/monosplice-$version-$target.tar.gz"
printf 'Downloading monosplice %s (%s)…\n' "$version" "$target"
curl -fsSL --max-time 120 -o "$tmp/monosplice.tar.gz" "$url" ||
  fail "could not download $url
Check the version and your network, or browse $RELEASES"
[ -s "$tmp/monosplice.tar.gz" ] || fail "the download from $url was empty."
tar -xzf "$tmp/monosplice.tar.gz" -C "$tmp" || fail "could not unpack $url"
[ -f "$tmp/monosplice" ] || fail "that release archive holds no monosplice binary. See $RELEASES"

dir="${MONOSPLICE_INSTALL_DIR-}"
if [ -z "$dir" ]; then
  for candidate in /usr/local/bin "$HOME/.local/bin"; do
    if [ -d "$candidate" ] && [ -w "$candidate" ]; then
      dir="$candidate"
      break
    fi
  done
  [ -n "$dir" ] || dir="$HOME/.local/bin"
fi
mkdir -p "$dir" || fail "could not create $dir. Set MONOSPLICE_INSTALL_DIR to a writable directory and re-run."

# Staged beside the target and renamed, so an interrupted install never leaves a
# half-written monosplice on PATH.
cp "$tmp/monosplice" "$dir/monosplice.new" ||
  fail "could not write to $dir. Set MONOSPLICE_INSTALL_DIR to a writable directory, or re-run with sudo."
chmod 755 "$dir/monosplice.new"
mv -f "$dir/monosplice.new" "$dir/monosplice" || fail "could not install into $dir."

printf '✓ installed monosplice %s to %s\n' "$version" "$dir/monosplice"
case ":${PATH-}:" in
  *":$dir:"*) printf 'Get started: cd your-monorepo && monosplice init\n' ;;
  *) printf 'Add it to your PATH, then run `monosplice init` in your monorepo:\n  export PATH="%s:$PATH"\n' "$dir" ;;
esac
