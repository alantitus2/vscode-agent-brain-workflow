#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
target_root="${COPILOT_HOME:-${HOME}/.copilot}"
force=0

for arg in "$@"; do
  case "$arg" in
    --force) force=1 ;;
    --help|-h)
      cat <<'EOF'
Usage: ./scripts/install-agent-customizations.sh [--force]

Install the repository's user-level VS Code Agent Host customizations into
${COPILOT_HOME:-$HOME/.copilot}. Existing files are preserved by default.
Use --force only when you intentionally want to replace them.
EOF
      exit 0
      ;;
    *)
      printf 'Unknown option: %s\n' "$arg" >&2
      exit 2
      ;;
  esac
done

for relative_path in \
  "agents/luna-worker.agent.md" \
  "agents/sol-brain.agent.md" \
  "instructions/default-executor-sol-collaboration.instructions.md"; do
  source_path="${repo_root}/${relative_path}"
  target_path="${target_root}/${relative_path}"

  if [[ ! -f "$source_path" ]]; then
    printf 'Missing customization file: %s\n' "$source_path" >&2
    exit 1
  fi

  mkdir -p "$(dirname -- "$target_path")"
  if [[ "$force" -eq 1 || ! -e "$target_path" ]]; then
    cp -- "$source_path" "$target_path"
    printf 'Installed: %s\n' "$target_path"
  else
    printf 'Preserved existing file: %s\n' "$target_path"
  fi
done

printf 'Installed VS Code Agent Host customizations from %s\n' "$repo_root"
