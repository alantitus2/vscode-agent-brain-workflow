# Luna Worker + Sol Brain for VS Code Agents

Workspace-native VS Code Agent Host workflow for a two-session architecture:

```text
normal default agent (Luna Worker / GPT-5.6-Luna)
        │  session-management message when reasoning is valuable
        ▼
one persistent Sol Brain session (GPT-5.6-Sol / Max)
        │  decision, diagnosis, architecture, or review
        ▼
Luna performs the file work, commands, builds, tests, and validation
```

The normal default agent remains the executor. You do not need to select the
Luna Worker profile for ordinary work. `AGENTS.md` and the checked-in
`.github/instructions/` file make the workspace default consult the persistent
Sol Brain when a task is architectural, ambiguous, difficult to diagnose,
risky, or needs a material review.

This repository contains the workspace instructions, optional named profiles,
guard scripts, tests, hook configuration, and this guide—no application source,
account state, credentials, or session databases.

## Requirements

- VS Code with Agent Host custom agents and session-management tools enabled.
- A signed-in model provider that exposes GPT-5.6-Luna and GPT-5.6-Sol.
- The same VS Code/Agent Host environment in which you want the customizations
  installed.

The workspace-scoped Agent Host files live under `.github/agents/` and
`.github/instructions/`. See the [VS Code custom agents documentation](https://code.visualstudio.com/docs/agent-customization/custom-agents).

The included frontmatter uses the provider IDs that worked in the reference
setup:

```text
@provider=openai:gpt-5.6-luna
@provider=openai:gpt-5.6-sol
```

If a different installation exposes different model IDs, update the `model:`
frontmatter and the matching model ID in the bootstrap instructions before
installing.

## Workspace activation

Clone or open this repository as the workspace. No `~/.copilot` copy, user-level
installer, or named-agent selection is required.

Validate the checked-in workflow from its root:

```bash
node --test scripts/agent-handoff-guard.test.mjs scripts/agent-stop-guard.test.mjs scripts/workspace-agent-workflow.test.mjs
```

The legacy installer scripts only validate this workspace layout and never
write user-level files.

## Use the workflow

1. Open a normal Agent session in this workspace. Keep the model on GPT-5.6-Luna and set the
   thinking effort to **Max**. Do not select the Luna Worker profile unless you
   want to inspect or explicitly invoke it; the default instruction is already
   active.
2. The default agent looks for one active session titled
   `Sol Brain — Persistent`. If it is missing, the default workflow creates exactly one using
   `@provider=openai:gpt-5.6-sol`, initializes it for **Max** effort, and reuses
   it thereafter.
3. When the task warrants deeper reasoning, Luna sends Sol a compact request
   in this form:

   ```text
   SOLVER REQUEST
   TASK: <one-sentence goal>
   STATE: <relevant current state and prior decisions>
   CONSTRAINTS: <requirements, non-goals, and risk boundaries>
   EVIDENCE: <targeted files, errors, tests, or observations>
   HYPOTHESIS: <current explanation or proposed approach, if any>
   QUESTION: <specific decision or diagnosis needed from Sol>
   ```

4. Luna uses Sol's decision, then performs the implementation and validation
   itself. Sol is intentionally reasoning-only and has no routine file,
   command, or web tools.

## Reliable handoff contract

The Agent Host session API is not a durable request/reply queue. `Message sent`
proves only enqueue acceptance. The default workflow records a local handoff,
captures the highest completed Sol turn before dispatch, sends exactly once, and
polls the same canonical session.

Receipt is valid only when the transcript shows a newer complete assistant turn
containing the exact `REQUEST_ID`. Idle status, partial `inProgress` text,
prior answers, and queued-message acknowledgements are not completion evidence.
The local guard records that evidence explicitly:

```bash
./bin/agent-handoff begin --id "$REQUEST_ID" \
  --objective "short objective" --scope "exact files" --solver advisory
./bin/agent-handoff solver-sent --id "$REQUEST_ID" --baseline-turn "$BASELINE_TURN"
# Send once, poll the same session, then record either success:
./bin/agent-handoff solver-received --id "$REQUEST_ID" \
  --response-id "$REQUEST_ID" --response-turn "$RESPONSE_TURN" \
  --response-role assistant --response-state complete --summary "decision"
# Or timeout and explicit advisory fallback:
# ./bin/agent-handoff solver-timeout --id "$REQUEST_ID" --reason "no response"
# ./bin/agent-handoff solver-fallback --id "$REQUEST_ID" --summary "local decision and uncertainty"
```

Required work stays blocked until a valid late response arrives. Advisory work
may start only after its fallback is recorded, and a late response cannot be
claimed as influencing work that already started.

Cross-session messages can require an approval prompt from VS Code. Approve
that prompt when the request is expected; this package does not attempt to
bypass that safety boundary. If session-management tools are unavailable,
Luna continues with safe local reasoning and reports the limitation.

Pin the `Sol Brain — Persistent` session in the sidebar as a convenience. The
stable title is what the workflow uses to find and reuse it.

## Small read-only demo

After installation, send this to a normal default Agent session:

```text
Run a small read-only demo of the Luna/Sol workflow in this workspace. Find
one genuinely ambiguous architecture or documentation decision from the
relevant files. Before answering, consult the persistent Sol Brain using the
SOLVER REQUEST format. Then use Sol's returned decision to give me a concise
recommendation with the evidence you considered. Do not edit files or run
commands for this demo.
```

For an execution demo, use the same request but ask Luna to make one small,
reversible documentation change and run the narrowest relevant validation.

## Max, not Ultra

The prompts target **Max** deliberately. Reasoning effort is controlled by the
VS Code model picker rather than reliably by an agent markdown field. Select
GPT-5.6-Sol and Max in the Sol session; VS Code remembers the effort level per
model/session according to its [language-model configuration documentation](https://code.visualstudio.com/docs/agent-customization/language-models).

The prompt says Max, not Ultra, so a newly created Sol session has the intended
cost/quality target. Always verify the picker when starting a fresh session.

## Files

- `AGENTS.md` — workspace instructions for ordinary sessions.
- `.github/instructions/default-executor-sol-collaboration.instructions.md` —
  always-on default behavior; this is what makes ordinary sessions act as
  Luna without selecting a custom agent.
- `.github/agents/` — optional workspace-scoped named profiles.
- `.github/hooks/agent-continuation.json` — workspace Stop hook.
- `bin/agent-handoff` and `scripts/agent-handoff-guard.mjs` — local handoff
  ledger and receipt invariants.
- `agents/` and `instructions/` — legacy portable reference copies only.

## Troubleshooting

### Luna does not consult Sol

Confirm that the normal default agent is active, the session-management tools
are available, and the session title is exactly `Sol Brain — Persistent`.
Reload the Agent Host after opening or updating the workspace if the files do
not appear immediately. If VS Code presents a cross-session approval prompt,
approve it before expecting a response.

### Sol cannot be created

The model picker/provider must expose the exact provider ID used by the prompt.
If it does not, use the available Sol model ID consistently in both agent
frontmatter and the bootstrap instruction, then set its thinking effort to
Max manually.

### What is not backed up here

Sign-in state, model catalog state, VS Code settings, SSH keys, tokens,
environment variables, session history, and other secrets remain outside this
repository. Back those up through the appropriate account or encrypted-secret
mechanism.
