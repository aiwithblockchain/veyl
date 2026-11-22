#!/usr/bin/env bash
# Build/verify the node agent locally, or create and push the release tag that
# triggers .github/workflows/agent-release.yml.
#
#   bash scripts/agent/build-release.sh          # test + host release build + sha256
#   bash scripts/agent/build-release.sh --tag    # interactive: tag agent-v<version>, push
#
# Never reads or prints secrets. Uses the local git credentials for the push.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
AGENT_DIR="$ROOT/agent"
CARGO_TOML="$AGENT_DIR/Cargo.toml"
REPO_SLUG="aiwithblockchain/veyl"

usage() {
  sed -n '2,9p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

die() {
  echo "error: $*" >&2
  exit 1
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

[ -f "$CARGO_TOML" ] || die "missing $CARGO_TOML"
VERSION="$(awk -F'"' '/^version = /{print $2; exit}' "$CARGO_TOML")"
[ -n "$VERSION" ] || die "could not read the version from $CARGO_TOML"
TAG="agent-v${VERSION}"

TAG_MODE=0
case "${1:-}" in
  "") ;;
  --tag) TAG_MODE=1 ;;
  -h|--help)
    usage
    exit 0
    ;;
  *)
    usage
    exit 2
    ;;
esac

echo "agent version: $VERSION"
echo "release tag:   $TAG"
echo

echo "== cargo test (agent, dev feature) =="
cargo test --manifest-path "$CARGO_TOML" --features dev
echo

echo "== cargo build --release (host target) =="
cargo build --manifest-path "$CARGO_TOML" --release

HOST="$(rustc -vV | awk '/^host:/{print $2}')"
BIN="$AGENT_DIR/target/release/veyl-agent"
[ -f "$BIN" ] || die "missing build output $BIN"
echo
echo "host target:   $HOST"
echo "local binary:  $BIN"
echo "local sha256:  $(sha256_file "$BIN")"
echo
echo "This is a local sanity build only; release artifacts are musl binaries"
echo "built by .github/workflows/agent-release.yml:"
echo "  veyl-agent-linux-amd64"
echo "  veyl-agent-linux-arm64"
echo

if [ "$TAG_MODE" -eq 0 ]; then
  echo "To release: bash scripts/agent/build-release.sh --tag"
  exit 0
fi

# ---------------------------------------------------------------------------
# --tag: only from an interactive shell, and only when agent/ is committed.
# ---------------------------------------------------------------------------
[ -t 0 ] || die "--tag requires an interactive terminal (refusing non-interactively)"

if ! git -C "$ROOT" ls-tree -r --name-only HEAD -- agent | grep -qx "agent/Cargo.toml"; then
  die "agent/ is not committed at HEAD; commit it before tagging"
fi
if [ -n "$(git -C "$ROOT" status --porcelain -- agent)" ]; then
  die "agent/ has uncommitted changes; commit them before tagging"
fi
if git -C "$ROOT" rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  die "local tag $TAG already exists"
fi
if git -C "$ROOT" ls-remote --exit-code --tags origin "refs/tags/$TAG" >/dev/null 2>&1; then
  die "origin already has tag $TAG"
fi

cat <<EOF
About to run:
  git -C $ROOT tag $TAG
  git -C $ROOT push origin $TAG

This pushes the tag to ${REPO_SLUG} and starts the release workflow.
EOF
read -r -p "Proceed? [y/N] " answer
case "$answer" in
  y|Y|yes|YES) ;;
  *)
    echo "aborted"
    exit 1
    ;;
esac

git -C "$ROOT" tag "$TAG"
git -C "$ROOT" push origin "$TAG"

BASE="https://github.com/${REPO_SLUG}/releases/download/${TAG}"
cat <<EOF

Tag pushed. Expected assets (after the workflow finishes):
  ${BASE}/veyl-agent-linux-amd64
  ${BASE}/veyl-agent-linux-arm64
  ${BASE}/SHA256SUMS

Watch the run:   gh run list --workflow agent-release.yml
Release page:    https://github.com/${REPO_SLUG}/releases/tag/${TAG}

Next, fill the control-plane env (wrangler):
  AGENT_VERSION=${VERSION}
  AGENT_DOWNLOAD_URL=${BASE}/veyl-agent-linux-amd64
  AGENT_SHA256=<amd64 hash from SHA256SUMS>

arm64 needs a second AGENT_DOWNLOAD_URL/AGENT_SHA256 pair; the control plane
currently has only one set, so it stays amd64-only until that is added.
EOF
