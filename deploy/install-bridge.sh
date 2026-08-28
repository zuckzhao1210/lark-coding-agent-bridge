#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  LARK_APP_SECRET=... ./deploy/install-bridge.sh [--force] [--workspace PATH] [--home PATH]
EOF
}

force=0
profile=codex
workspace="${BRIDGE_WORKSPACE:-}"
channel_home="${LARK_CHANNEL_HOME:-}"
while (($#)); do
  case "$1" in
    --force) force=1 ;;
    --workspace) workspace="${2:?--workspace requires a path}"; shift ;;
    --home) channel_home="${2:?--home requires a path}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

: "${LARK_APP_SECRET:?Set LARK_APP_SECRET before running this script.}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
workspace="${workspace:-$repo_root}"
channel_home="${channel_home:-$HOME/.lark-channel}"
template="$repo_root/deploy/lark-channel/config.template.json"
config="$channel_home/config.json"
codex_binary="$(command -v codex || true)"
[[ -n "$codex_binary" ]] || { echo "Codex CLI was not found in PATH." >&2; exit 1; }
command -v lark-cli >/dev/null 2>&1 || { echo "lark-cli was not found in PATH." >&2; exit 1; }
[[ -f "$template" ]] || { echo "Missing configuration template: $template" >&2; exit 1; }
if [[ -e "$config" && "$force" -ne 1 ]]; then
  echo "Refusing to overwrite $config. Rerun with --force after backing it up." >&2
  exit 1
fi

export BRIDGE_DEPLOY_TEMPLATE="$template" BRIDGE_DEPLOY_CONFIG="$config"
export BRIDGE_DEPLOY_WORKSPACE="$workspace" BRIDGE_DEPLOY_CODEX="$codex_binary"
node <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const config = JSON.parse(fs.readFileSync(process.env.BRIDGE_DEPLOY_TEMPLATE, 'utf8'));
const profile = config.activeProfile;
const settings = config.profiles[profile];
settings.accounts.app.secret = process.env.LARK_APP_SECRET;
settings.workspaces.default = process.env.BRIDGE_DEPLOY_WORKSPACE;
settings.codex.binaryPath = process.env.BRIDGE_DEPLOY_CODEX;
const target = process.env.BRIDGE_DEPLOY_CONFIG;
fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
fs.writeFileSync(target, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
fs.chmodSync(target, 0o600);
NODE
unset BRIDGE_DEPLOY_TEMPLATE BRIDGE_DEPLOY_CONFIG BRIDGE_DEPLOY_WORKSPACE BRIDGE_DEPLOY_CODEX

cd "$repo_root"
pnpm install --frozen-lockfile
pnpm build
export LARK_CHANNEL_HOME="$channel_home"
node bin/lark-channel-bridge.mjs start --profile "$profile" --workspace "$workspace"
echo "Deployment complete. Bridge home: $channel_home; profile: $profile; workspace: $workspace"
echo "User-identity features may require lark-cli auth login on this machine."
