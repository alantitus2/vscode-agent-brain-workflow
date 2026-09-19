import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';
import { spawnSync } from 'node:child_process';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const hookScript = path.join(scriptDirectory, 'agent-stop-guard.mjs');
const temporaryDirectories = [];

const createWorkspace = () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-stop-guard-'));
  temporaryDirectories.push(workspace);
  return workspace;
};

const writeState = (workspace, filename, state) => {
  const directory = path.join(workspace, '.agent-runtime', 'handoffs');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, filename), JSON.stringify(state) + '\n');
};

const runHook = (cwd, stopHookActive = false) => {
  const result = spawnSync(process.execPath, [hookScript], {
    cwd,
    input: JSON.stringify({
      cwd,
      hook_event_name: 'Stop',
      stop_hook_active: stopHookActive,
    }) + '\n',
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
};

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    fs.rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

test('blocks an unresolved handoff with a completion checkpoint', () => {
  const workspace = createWorkspace();
  writeState(workspace, 'pending.json', { id: 'pending', status: 'pending' });

  const output = runHook(workspace);

  assert.equal(output.hookSpecificOutput.hookEventName, 'Stop');
  assert.equal(output.hookSpecificOutput.decision, 'block');
  assert.match(output.hookSpecificOutput.reason, /Did you actually complete the task\?/);
});

test('allows a completed or blocked handoff to stop', () => {
  const workspace = createWorkspace();
  writeState(workspace, 'completed.json', {
    id: 'completed',
    status: 'completed',
    solver: { policy: 'none', status: 'not_required', receiptVerified: false },
  });
  writeState(workspace, 'blocked.json', {
    id: 'blocked',
    status: 'blocked',
    solver: { policy: 'required', status: 'timeout', receiptVerified: false },
  });

  assert.deepEqual(runHook(workspace), {});
});

test('blocks a completed handoff that claims an unverified solver receipt', () => {
  const workspace = createWorkspace();
  writeState(workspace, 'false-receipt.json', {
    id: 'false-receipt',
    status: 'completed',
    solver: { policy: 'required', status: 'received', receiptVerified: false },
  });

  const output = runHook(workspace);

  assert.equal(output.hookSpecificOutput.decision, 'block');
  assert.match(output.hookSpecificOutput.reason, /false-receipt=unreadable/);
});

test('honors stop_hook_active after one continuation', () => {
  const workspace = createWorkspace();
  writeState(workspace, 'pending.json', { id: 'pending', status: 'running' });

  const output = runHook(workspace, true);

  assert.equal(output.hookSpecificOutput, undefined);
  assert.match(output.systemMessage, /Stop is allowed now/);
});

test('finds the nested repository from the parent workspace', () => {
  const workspace = createWorkspace();
  const nestedRepository = path.join(workspace, 'motw');
  fs.mkdirSync(path.join(nestedRepository, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(nestedRepository, 'bin', 'agent-handoff'), '');
  writeState(nestedRepository, 'pending.json', { id: 'nested', status: 'pending' });

  const output = runHook(workspace);

  assert.equal(output.hookSpecificOutput.decision, 'block');
  assert.match(output.hookSpecificOutput.reason, /nested=pending/);
});

test('fails closed when a handoff state is malformed', () => {
  const workspace = createWorkspace();
  const directory = path.join(workspace, '.agent-runtime', 'handoffs');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'broken.json'), '{broken\n');

  const output = runHook(workspace);

  assert.equal(output.hookSpecificOutput.decision, 'block');
  assert.match(output.hookSpecificOutput.reason, /broken=unreadable/);
});

test('does not hold an ordinary turn open without a handoff ledger', () => {
  const workspace = createWorkspace();

  assert.deepEqual(runHook(workspace), {});
});
