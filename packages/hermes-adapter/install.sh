#!/usr/bin/env bash
set -euo pipefail

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
TARGET_DIR="$HERMES_HOME/plugins/chlorim"

mkdir -p "$TARGET_DIR"
cp "$SRC_DIR/plugin.yaml" "$SRC_DIR/__init__.py" "$SRC_DIR/adapter.py" "$SRC_DIR/ws_client.py" "$TARGET_DIR/"

echo "Installed ChlorIM Hermes platform plugin -> $TARGET_DIR"
echo ""
echo "Next steps:"
echo "  1. In ChlorIM web UI -> 设置中心 -> Bots & Agents, create a Bridge Bot (driver: hermes) and copy its chior_bot_... token."
echo "  2. Export credentials (or add them to ~/.hermes/.env):"
echo "       export CHLORIM_URL='http://你的ChlorIM地址:3000'"
echo "       export CHLORIM_BOT_TOKEN='chior_bot_<Token>'"
echo "       export CHLORIM_ALLOWED_ROOTS='\$HOME/Documents/Codes'   # optional: lets ChlorIM browse folders on this host"
echo "       export CHLORIM_HOME_CHANNEL='<channel_id>'              # optional: default channel for Hermes cron deliver=chlorim"
echo "  3. Enable and start Hermes Gateway:"
echo "       hermes plugins enable chlorim"
echo "       hermes gateway status"
