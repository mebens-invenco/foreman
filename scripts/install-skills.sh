#!/usr/bin/env bash
# Install Invenco shared skills (invenco/invenco-skills) for Foreman's supported
# runners: Claude Code, Codex, and Opencode.
#
# Run once per machine that hosts a Foreman worker. Safe to re-run; skills.sh
# updates installed skills in place. Requires SSH access to GitHub
# (invenco/invenco-skills is private).

set -euo pipefail

if ! command -v npm >/dev/null 2>&1; then
  echo "error: npm not found. Install Node.js first (e.g. via nvm)." >&2
  exit 1
fi

if ! command -v skills >/dev/null 2>&1; then
  echo "Installing skills CLI (skills.sh)..."
  npm install -g skills
fi

# --agent:      Foreman's runners. claude-code lands skills under
#               ~/.claude/skills/; codex and opencode share the universal
#               ~/.agents/skills/ path. Avoid --all here — it expands to
#               every agent the CLI knows about (~50), littering home with
#               unused per-agent dirs.
# --skill '*':  install every skill in the bundle (planning, implementing,
#               reviewing, verifying, tooling, learning). New skills land
#               automatically on re-run.
# --full-depth: SKILL.md files live at skills/<domain>/<name>/, not repo root.
# SSH URL:      repo is private; skills CLI's default HTTPS path lacks auth.
echo "Installing invenco/invenco-skills..."
skills add git@github.com:invenco/invenco-skills.git \
  --global \
  --agent claude-code codex opencode \
  --skill '*' \
  --full-depth \
  -y

echo
echo "Done. Verify with: skills list -g"
