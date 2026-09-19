# Workspace Agent Workflow

This repository is workspace-native. The checked-in `AGENTS.md`,
`.github/instructions/`, `.github/agents/`, `.github/hooks/`, and guard scripts
are the active workflow. Do not require or copy files into `~/.copilot`, and do
not require selecting a named agent for the default behavior.

For non-trivial architecture, diagnosis, security, durable-state, or material
review work, the ordinary default executor reuses the canonical
`Sol Brain — Persistent` session. It creates one unique `REQUEST_ID`, records a
local handoff, and records the highest completed Sol transcript turn before
dispatch:

```bash
./bin/agent-handoff begin --id "$REQUEST_ID" \
  --objective "short objective" --scope "exact files" --solver advisory
./bin/agent-handoff solver-sent --id "$REQUEST_ID" --baseline-turn "$BASELINE_TURN"
```

It sends exactly once and polls that same session. `Message sent`, idle status,
partial `inProgress` text, or a prior answer is not a response. Receipt is
recorded only for a newer complete assistant turn containing the exact marker:

```bash
./bin/agent-handoff solver-received --id "$REQUEST_ID" \
  --response-id "$REQUEST_ID" --response-turn "$RESPONSE_TURN" \
  --response-role assistant --response-state complete --summary "decision"
```

After bounded polling fails, it records `solver-timeout`. Advisory work must
also record `solver-fallback` with the local decision and uncertainty before
starting. Required work remains blocked until a valid late response arrives.
Never create a replacement Sol session or retry one request indefinitely.
