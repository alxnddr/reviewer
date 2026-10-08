#!/bin/sh
# Installs rvw, Reviewer's CLI, for the current user on a machine without Reviewer.app — a Linux
# dev box, a CI image. On macOS the app installs its own launcher (src/main/cli-install.ts).
#
#   install-cli.sh                          the latest published release
#   install-cli.sh --version 0.6.0          one release
#   install-cli.sh rvw-0.6.0-any.tar.gz     a tarball already on disk (scripts/pack-cli.mjs)
#   install-cli.sh --uninstall
#
# What it leaves behind, and all it leaves behind:
#
#   ~/.local/share/rvw/<version>/cli/rvw.js   the bundle, beside its {"type":"module"} manifest
#   ~/.local/share/rvw/<version>/skills/      what `rvw skills` lists, one directory above it
#   ~/.local/bin/rvw                          a launcher that execs the bundle with the node on PATH
#
# POSIX sh, not bash: the box may only have dash, and the one-line install pipes this into `sh`.
# `cli/install-cli.test.ts` runs it under `sh`, which is dash on the Linux CI runner.
#
# Exit 0 installed (or removed), 1 could not, 2 the invocation itself was wrong.

set -eu

REPO=alxnddr/reviewer
DATA_ROOT="$HOME/.local/share/rvw"
BIN_DIR="$HOME/.local/bin"
SHIM="$BIN_DIR/rvw"

usage() {
  cat <<'EOF'
usage: install-cli.sh [<tarball> | --version <version>]
       install-cli.sh --uninstall

Installs rvw for the current user: the release under ~/.local/share/rvw/<version>,
and a launcher at ~/.local/bin/rvw that runs it with the node on PATH (>= 20).
With no argument, the latest published release is downloaded.
EOF
}

say() {
  printf '%s\n' "$1"
}

fail() {
  printf 'install-cli.sh: %s\n' "$1" >&2
  exit 1
}

misuse() {
  printf 'install-cli.sh: %s\n\n' "$1" >&2
  usage >&2
  exit 2
}

# The inside of a POSIX single-quoted word: every `'` closed, escaped and reopened. The rule
# `quote()` in src/main/cli-install.ts applies, for the same reason — an apostrophe in a home
# directory is enough to need it.
escape_quotes() {
  printf '%s' "$1" | sed "s/'/'\\\\''/g"
}

# The launcher. A copy of `shimScript()` in src/main/cli-install.ts — a shell script cannot import
# TypeScript — so change the two together. It differs in one line, the stale-launcher message,
# because here there is no app whose removal explains it. Deleting itself once the bundle is gone
# is kept: `rm -rf ~/.local/share/rvw` then leaves no `rvw` on the PATH that fails obscurely.
shim_script() {
  printf '%s\n' \
    '#!/bin/sh' \
    "RVW='$(escape_quotes "$1")'" \
    'if [ ! -f "$RVW" ]; then' \
    '  rm -f "$0" 2>/dev/null' \
    '  echo "rvw: $RVW is gone — removed stale launcher." >&2' \
    '  exit 127' \
    'fi' \
    'exec node "$RVW" "$@"'
}

# Whether $1 is a launcher this script wrote: its RVW= line names a bundle under $DATA_ROOT.
# Matched on the path as it is spelled inside the file — quoted — so an apostrophe in the home
# directory does not stop the script recognising its own launcher, which is the trap
# `shimMarker()` in src/main/cli-install.ts documents.
is_ours() {
  grep -qF "RVW='$(escape_quotes "$DATA_ROOT/")" "$1" 2>/dev/null
}

have() {
  command -v "$1" >/dev/null 2>&1
}

fetch() {
  if have curl; then
    curl -fsSL -o "$2" "$1"
  elif have wget; then
    wget -q -O "$2" "$1"
  else
    fail "downloading a release needs curl or wget; or pass a tarball you already have"
  fi
}

# The newest published release's version. GitHub redirects /releases/latest to the release's tag
# page, so the redirect answers the question with no API token, no rate limit and no JSON parser.
# A draft release has no such page, which is why a release still in draft is not found here.
latest_version() {
  url="https://github.com/$REPO/releases/latest"
  landed=""
  if have curl; then
    landed=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "$url") || landed=""
  elif have wget; then
    landed=$(wget -S --spider "$url" 2>&1 | tr -d '\r' | sed -n 's/^ *[Ll]ocation: *//p' | tail -n 1)
  else
    fail "finding the latest release needs curl or wget; or pass a tarball you already have"
  fi
  case $landed in
    */releases/tag/v*) printf '%s\n' "${landed##*/releases/tag/v}" ;;
    *) fail "found no published release of $REPO; pass --version <version>, or a tarball" ;;
  esac
}

work=""
stage=""
staged_shim=""
# Whatever was half-made goes, and the exit status survives the cleanup: some shells report the
# trap's own last status otherwise, which would turn a failed install into a 0.
trap 'status=$?; rm -rf ${work:+"$work"} ${stage:+"$stage"} ${staged_shim:+"$staged_shim"}; exit "$status"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

do_install() {
  have node || fail "rvw runs on node >= 20, and there is no node on PATH"
  node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' ||
    fail "rvw needs node >= 20; the node on PATH is $(node --version)"
  have tar || fail "unpacking a release needs tar"

  work=$(mktemp -d "${TMPDIR:-/tmp}/rvw-install.XXXXXX")
  if [ -z "$tarball" ]; then
    [ -n "$version" ] || version=$(latest_version) || exit 1
    tarball="$work/rvw-$version-any.tar.gz"
    say "downloading rvw $version"
    fetch "https://github.com/$REPO/releases/download/v$version/rvw-$version-any.tar.gz" "$tarball" ||
      fail "could not download rvw $version. If $REPO is private, fetch it with \`gh release download v$version -R $REPO -p 'rvw-*-any.tar.gz'\` and pass the file"
  fi
  [ -f "$tarball" ] || fail "no such file: $tarball"

  # Unpacked beside its destination, so moving it into place is a rename on one filesystem, and a
  # dot-name, so the prune below never mistakes a concurrent run's staging for an old version.
  mkdir -p "$DATA_ROOT" "$BIN_DIR"
  stage=$(mktemp -d "$DATA_ROOT/.staging.XXXXXX")
  tar -xzf "$tarball" -C "$stage" || fail "could not unpack $tarball"
  for entry in cli/rvw.js cli/package.json skills; do
    [ -e "$stage/$entry" ] || fail "$tarball is not an rvw release: it has no $entry"
  done

  # The version directory is named by what the bundle says it is, not by the file name: a renamed
  # tarball cannot install under the wrong version, and a bundle that will not run under this node
  # fails here, before it has replaced an install that works.
  reported=$(node "$stage/cli/rvw.js" --version) ||
    fail "the rvw in $tarball does not run under node $(node --version)"
  installed=${reported%% *}
  case $installed in
    '' | */* | .*) fail "the rvw in $tarball reports a version that cannot name a directory: $reported" ;;
  esac
  if [ -n "$version" ] && [ "$installed" != "$version" ]; then
    fail "asked for rvw $version, but the release unpacked as $installed"
  fi

  dest="$DATA_ROOT/$installed"
  rm -rf "$dest"
  mv "$stage" "$dest"
  stage=""

  # Written whole beside the launcher and renamed over it, so an interrupted install never leaves
  # a half-written `rvw` on the PATH. Anything already there is replaced, ours or not, as the app's
  # installer does: installing has to mean `rvw` now runs this release.
  replaced=""
  if [ -e "$SHIM" ] && ! is_ours "$SHIM"; then
    replaced=1
  fi
  staged_shim=$(mktemp "$BIN_DIR/.rvw.XXXXXX")
  shim_script "$dest/cli/rvw.js" >"$staged_shim"
  chmod 755 "$staged_shim"
  mv -f "$staged_shim" "$SHIM"
  staged_shim=""

  # Only the version the launcher names is live; every other version directory is dead weight.
  for old in "$DATA_ROOT"/*; do
    if [ "$old" != "$dest" ] && [ -d "$old" ]; then
      rm -rf "$old"
    fi
  done

  # Not `$reported`: that names the staging directory the bundle was asked from.
  say "installed rvw $installed at $dest"
  say "launcher: $SHIM"
  if [ -n "$replaced" ]; then
    say "(it replaced an rvw at that path that this script had not written)"
  fi
  case ":$PATH:" in
    *":$BIN_DIR:"*)
      winner=$(command -v rvw 2>/dev/null || true)
      if [ -n "$winner" ] && [ "$winner" != "$SHIM" ]; then
        say "warning: $winner is earlier on PATH, so \`rvw\` still runs that one" >&2
      fi
      ;;
    *)
      say "$BIN_DIR is not on your PATH; add it, e.g. in ~/.profile:"
      # Single-quoted on purpose: the line is for the reader to paste, unexpanded.
      # shellcheck disable=SC2016
      say '  export PATH="$HOME/.local/bin:$PATH"'
      ;;
  esac
}

do_uninstall() {
  removed=""
  if [ -e "$SHIM" ] || [ -L "$SHIM" ]; then
    if is_ours "$SHIM"; then
      rm -f "$SHIM"
      say "removed $SHIM"
      removed=1
    else
      say "left $SHIM alone: it is not a launcher this script wrote" >&2
    fi
  fi
  if [ -d "$DATA_ROOT" ]; then
    rm -rf "$DATA_ROOT"
    say "removed $DATA_ROOT"
    removed=1
  fi
  if [ -z "$removed" ]; then
    say "rvw is not installed under $HOME/.local; nothing to remove"
  fi
}

mode=install
tarball=""
version=""
while [ $# -gt 0 ]; do
  case $1 in
    --uninstall) mode=uninstall ;;
    --version)
      [ $# -ge 2 ] || misuse "--version needs a version, e.g. --version 0.6.0"
      version=${2#v}
      shift
      ;;
    --version=*)
      version=${1#--version=}
      version=${version#v}
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    -*) misuse "unknown option: $1" ;;
    *)
      [ -z "$tarball" ] || misuse "one tarball at a time"
      tarball=$1
      ;;
  esac
  shift
done

if [ "$mode" = uninstall ] && { [ -n "$tarball" ] || [ -n "$version" ]; }; then
  misuse "--uninstall takes nothing else"
fi
if [ -n "$tarball" ] && [ -n "$version" ]; then
  misuse "a tarball already has a version; pass one or the other"
fi
# Absolute before anything changes directory: `tar -C` resolves a relative archive differently in
# GNU tar and bsdtar.
case $tarball in
  '' | /*) ;;
  *) tarball="$(pwd)/$tarball" ;;
esac

case $mode in
  install) do_install ;;
  uninstall) do_uninstall ;;
esac
