#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ACTION="${1:-setup}"

# Auto-link ~/.local/bin/9remote-local so user can run `9remote-local [status|restart|stop|setup]` from anywhere
mkdir -p "$HOME/.local/bin"
ln -sfn "$ROOT_DIR/9remote-local.sh" "$HOME/.local/bin/9remote-local"

exec node "$ROOT_DIR/scripts/service2200.mjs" "$ACTION"
