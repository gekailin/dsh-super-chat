#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

# 接入 dsh-super-chat 面板
export AGENT_MODE=superchat
export SUPERCHAT_URL="${SUPERCHAT_URL:-http://127.0.0.1:3080}"
export SUPERCHAT_PATH="${SUPERCHAT_PATH:-/super-chat/api}"
export SUPERCHAT_HEADER="${SUPERCHAT_HEADER:-x-super-chat-request}"
export STATE_FILE="${STATE_FILE:-state.json}"
export PORT="${PORT:-8790}"

exec node src/service.mjs --creds "${CREDS:-creds.json}" "$@"
