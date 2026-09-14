# Luna Worker + Sol Brain for VS Code Agents

Portable, user-level VS Code Agent Host customizations for a two-session
workflow:

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
Luna Worker profile for ordinary work. The always-on instruction file makes
the default agent behave as Luna and consult the persistent Sol Brain when a
task is architectural, ambiguous, difficult to diagnose, risky, or needs a
material review.

This package is deliberately separate from any application repository. It
contains prompts, user-level agent definitions, installers, and this guide—no
project-specific coding rules, source code, account state, credentials, or
session databases.

## Requirements

- VS Code with Agent Host custom agents and session-management tools enabled.
- A signed-in model provider that exposes GPT-5.6-Luna and GPT-5.6-Sol.
- The same VS Code/Agent Host environment in which you want the customizations
  installed.

VS Code's current user-level Agent Host custom-agent location is
`~/.copilot/agents`. See the [VS Code custom agents documentation](https://code.visualstudio.com/docs/agent-customization/custom-agents).

The included frontmatter uses the provider IDs that worked in the reference
setup:

```text
@provider=openai:gpt-5.6-luna
@provider=openai:gpt-5.6-sol
```

If a different installation exposes different model IDs, update the `model:`
frontmatter and the matching model ID in the bootstrap instructions before
installing.

## Install

Clone or download this repository, then run the installer from its root.

### WSL, Linux, or macOS Agent Host

```bash
./scripts/install-agent-customizations.sh
```

### Windows PowerShell Agent Host

```powershell
.\scripts\install-agent-customizations.ps1
```

Both installers preserve an existing user-level file by default. To
intentionally replace an existing copy with the repository version, add
`--force` to the shell command or `-Force` to the PowerShell command.

Set `COPILOT_HOME` when the Agent Host uses a non-default user directory. The
installer writes only these three files:

```text
<COPILOT_HOME>/agents/luna-worker.agent.md
<COPILOT_HOME>/agents/sol-brain.agent.md
<COPILOT_HOME>/instructions/default-executor-sol-collaboration.instructions.md
```

Restart or reload the VS Code Agent Host after installation if the files do
not appear immediately.

## Use the workflow

1. Open a normal Agent session. Keep the model on GPT-5.6-Luna and set the
   thinking effort to **Max**. Do not select the Luna Worker profile unless you
   want to inspect or explicitly invoke it; the default instruction is already
   active.
2. The default agent looks for one active session titled
   `Sol Brain — Persistent`. If it is missing, it creates exactly one using
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

- `agents/luna-worker.agent.md` — explicit executor/orchestrator profile and
  automatic-consultation policy.
- `agents/sol-brain.agent.md` — persistent reasoning, architecture, diagnosis,
  decision, and review profile with no routine tools.
- `instructions/default-executor-sol-collaboration.instructions.md` —
  always-on default behavior; this is what makes ordinary sessions act as
  Luna without selecting a custom agent.
- `scripts/install-agent-customizations.sh` — WSL/Linux/macOS installer.
- `scripts/install-agent-customizations.ps1` — Windows installer.

## Troubleshooting

### Luna does not consult Sol

Confirm that the normal default agent is active, the session-management tools
are available, and the session title is exactly `Sol Brain — Persistent`.
Reload the Agent Host after installation. If VS Code presents a cross-session
approval prompt, approve it before expecting a response.

### Sol cannot be created

The model picker/provider must expose the exact provider ID used by the prompt.
If it does not, use the available Sol model ID consistently in both agent
frontmatter and the bootstrap instruction, then set its thinking effort to
Max manually.

### Existing customizations were not replaced

That is the default safety behavior. Re-run the installer with `--force` or
`-Force` only after reviewing the repository copies.

### What is not backed up here

Sign-in state, model catalog state, VS Code settings, SSH keys, tokens,
environment variables, session history, and other secrets remain outside this
repository. Back those up through the appropriate account or encrypted-secret
mechanism.
