import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const read = (relativePath) => fs.readFileSync(path.join(repositoryRoot, relativePath), 'utf8');

test('workspace contains the active default workflow and guard', () => {
  for (const relativePath of [
    'AGENTS.md',
    '.github/instructions/default-executor-sol-collaboration.instructions.md',
    '.github/hooks/agent-continuation.json',
    'bin/agent-handoff',
    'scripts/agent-handoff-guard.mjs',
    'scripts/agent-stop-guard.mjs',
  ]) {
    assert.equal(fs.existsSync(path.join(repositoryRoot, relativePath)), true, relativePath);
  }

  const instructions = read('.github/instructions/default-executor-sol-collaboration.instructions.md');
  assert.match(instructions, /default behavior/);
  assert.match(instructions, /--baseline-turn TURN/);
  assert.match(instructions, /--response-state complete/);
  assert.match(instructions, /solver-fallback/);

  const repositoryInstructions = read('AGENTS.md');
  assert.match(repositoryInstructions, /workspace/i);
  assert.match(repositoryInstructions, /complete assistant turn/i);
});

test('workspace installer validation does not target user-level Agent Host files', () => {
  const shellPath = fs.existsSync(path.join(repositoryRoot, 'scripts/install-agent-customizations.sh'))
    ? 'scripts/install-agent-customizations.sh'
    : 'scripts/dev/install-agent-customizations.sh';
  const powershellPath = fs.existsSync(path.join(repositoryRoot, 'scripts/install-agent-customizations.ps1'))
    ? 'scripts/install-agent-customizations.ps1'
    : 'scripts/dev/install-agent-customizations.ps1';
  const shell = read(shellPath);
  const powershell = read(powershellPath);
  assert.doesNotMatch(shell, /target_root|COPILOT_HOME/);
  assert.doesNotMatch(powershell, /targetRoot|COPILOT_HOME/);
});
