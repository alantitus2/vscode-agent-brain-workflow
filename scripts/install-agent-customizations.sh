#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

for required_path in \
  "AGENTS.md" \
  ".github/instructions/default-executor-sol-collaboration.instructions.md" \
  ".github/agents/sol-brain.agent.md" \
  ".github/hooks/agent-continuation.json" \
  "bin/agent-handoff" \
  "scripts/agent-handoff-guard.mjs" \
  "scripts/agent-stop-guard.mjs"; do
  if [[ ! -f "${repo_root}/${required_path}" ]]; then
    printf 'Missing workspace workflow file: %s\n' "${repo_root}/${required_path}" >&2
    exit 1
  fi
done

printf 'Workspace-native Agent workflow is present in %s\n' "$repo_root"
printf 'No user-level ~/.copilot files were installed.\n'
