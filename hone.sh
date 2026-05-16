#!/bin/bash
# Hone CLI entry script for Linux/macOS/WSL
# Set API key via: export DEEPSEEK_API_KEY="sk-..." in ~/.bashrc or ~/.zshrc
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CLI="$SCRIPT_DIR/dist/cli.js"
BUN="$HOME/.bun/bin/bun"

# God Mode: skip all permission prompts (set to 0 to disable)
: "${HONE_GOD_MODE:=1}"
export HONE_GOD_MODE

# Remove Anthropic-specific env vars if they leak
unset USER_TYPE 2>/dev/null
unset ANTHROPIC_API_KEY 2>/dev/null

exec "$BUN" "$CLI" "$@"
