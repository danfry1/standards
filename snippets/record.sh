#!/usr/bin/env bash
# Regenerate demo/<crate>.gif. Requires: vhs (brew install vhs).
# See ../rust-release.md § Demo GIF. Replace <crate> and <BIN_ENV>.
#
# Builds the release binary, exports its path for the .tape, and runs VHS from
# demo/ so VHS 0.11's bare `Output <crate>.gif` lands in demo/.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cargo build --release --manifest-path "$REPO/Cargo.toml"

export <BIN_ENV>="$REPO/target/release/<crate>"
( cd "$REPO/demo" && vhs demo.tape )
echo "wrote $REPO/demo/<crate>.gif"
