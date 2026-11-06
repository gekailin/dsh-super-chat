#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

# llm mode: an OpenAI-compatible endpoint (AGENT_API_KEY) or a gateway authorized by AIGC_APPID with AIGC_BASE set.
export AIGC_MODEL="${AIGC_MODEL:-deepseek-v4-flash}"
export PORT="${PORT:-8790}"

exec node src/service.mjs --creds "${CREDS:-creds.json}" "$@"
