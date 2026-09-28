#!/bin/bash
# SessionStart hook for Claude Code on the web: install deps so the
# servers, test suites and `npm run shots` work from the first turn.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

cd "${CLAUDE_PROJECT_DIR:-$(dirname "$0")/../..}"

# npm install (not ci) so the cached container keeps node_modules warm.
npm install --no-audit --no-fund

# Screenshots: use the sandbox's pre-installed Chromium and tolerate the
# TLS-intercepting proxy (only affects Google Fonts in shots).
if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
  if [ -x /opt/pw-browsers/chromium ]; then
    echo 'export PLAYWRIGHT_CHROMIUM_PATH=/opt/pw-browsers/chromium' >> "$CLAUDE_ENV_FILE"
  fi
  echo 'export SHOTS_IGNORE_HTTPS_ERRORS=1' >> "$CLAUDE_ENV_FILE"
  # Repeated test runs must not hit Groq/Razorpay rate limits.
  echo 'export DEMO_MODE=true' >> "$CLAUDE_ENV_FILE"
fi
