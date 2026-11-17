#!/bin/sh
# Install the forge-design skill into every local coding agent that is present
# (Claude Code, Codex, Grok), so each one knows how to use the bridge.
set -eu

repo_root="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
source_dir="$repo_root/.grok/skills/forge-design"

if [ ! -f "$source_dir/SKILL.md" ]; then
  echo "Skill source not found: $source_dir" >&2
  exit 1
fi

install_into() {
  agent="$1"
  home="$2"
  skills_root="$3"
  if [ ! -d "$home" ]; then
    return 0
  fi
  target_dir="$skills_root/forge-design"
  # Only replace a copy this script made earlier (it carries .bridge-home).
  if [ -e "$target_dir" ] && [ ! -f "$target_dir/.bridge-home" ]; then
    echo "skip $agent: $target_dir exists and was not installed by this script" >&2
    return 0
  fi
  mkdir -p "$skills_root"
  rm -rf "$target_dir"
  cp -R "$source_dir" "$target_dir"
  printf '%s\n' "$repo_root" > "$target_dir/.bridge-home"
  chmod +x "$target_dir/scripts/bridge.sh"
  installed=$((installed + 1))
  echo "$agent: $target_dir"
}

installed=0
install_into "Claude Code" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/skills"
install_into "Codex" "${CODEX_HOME:-$HOME/.codex}" "${CODEX_HOME:-$HOME/.codex}/skills"
install_into "Grok" "${GROK_HOME:-$HOME/.grok}" "${GROK_SKILLS_DIR:-${GROK_HOME:-$HOME/.grok}/skills}"

if [ "$installed" -eq 0 ]; then
  echo "No Claude Code, Codex or Grok found. Install one, then run this again." >&2
  exit 1
fi
