import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, test } from 'node:test';
import { spawnSync } from 'node:child_process';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), 'agent-handoff-guard.mjs');
const temporaryRoots = [];

const createRoot = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-handoff-guard-'));
  temporaryRoots.push(root);
  return root;
};

const invoke = (root, args) => spawnSync(process.execPath, [script, ...args, '--root', root], {
  cwd: path.dirname(script),
  encoding: 'utf8',
});

const invokeWithRootBeforeSeparator = (root, command, args = []) => spawnSync(
  process.execPath,
  [script, command, '--root', root, ...args],
  { cwd: path.dirname(script), encoding: 'utf8' },
);

const assertSuccess = (result) => {
  assert.equal(result.status, 0, result.stderr || result.stdout);
};

const assertFailure = (result, pattern) => {
  assert.notEqual(result.status, 0, result.stdout);
  if (pattern) assert.match(result.stderr, pattern);
};

const begin = (root, id, solver = 'advisory') => assertSuccess(invoke(root, [
  'begin', '--id', id, '--objective', 'test handoff', '--scope', 'guard test', '--solver', solver,
]));

const send = (root, id, baselineTurn = 0) => assertSuccess(invoke(root, [
  'solver-sent', '--id', id, '--baseline-turn', String(baselineTurn),
]));

const receive = (root, id, responseTurn, summary = 'verified response') => assertSuccess(invoke(root, [
  'solver-received', '--id', id, '--response-id', id, '--response-turn', String(responseTurn),
  '--response-role', 'assistant', '--response-state', 'complete', '--summary', summary,
]));

const readState = (root, id) => JSON.parse(invoke(root, ['status', '--id', id]).stdout);

afterEach(() => {
  while (temporaryRoots.length > 0) fs.rmSync(temporaryRoots.pop(), { recursive: true, force: true });
});

test('accepts only a newer complete assistant response and verifies the full lifecycle', () => {
  const root = createRoot();
  const id = 'VALID_RECEIPT_001';
  begin(root, id);
  send(root, id, 12);

  receive(root, id, 13);
  const received = readState(root, id);
  assert.equal(received.solver.receiptVerified, true);
  assert.equal(received.solver.responseId, id);
  assert.equal(received.solver.responseTurn, 13);
  assert.equal(received.solver.responseRole, 'assistant');
  assert.equal(received.solver.responseState, 'complete');

  assertSuccess(invoke(root, ['worker-start', '--id', id]));
  assertSuccess(invokeWithRootBeforeSeparator(root, 'check', ['--id', id, '--', process.execPath, '-e', '']));
  assertSuccess(invoke(root, ['complete', '--id', id, '--summary', 'validated']));
  assertSuccess(invoke(root, ['verify', '--id', id]));
});

test('rejects stale, partial, wrong-role, and wrong-marker receipts', () => {
  const root = createRoot();
  const id = 'RECEIPT_REJECTIONS_01';
  begin(root, id);
  send(root, id, 20);

  assertFailure(invoke(root, [
    'solver-received', '--id', id, '--response-id', id, '--response-turn', '20',
    '--response-role', 'assistant', '--response-state', 'complete', '--summary', 'stale',
  ]), /not newer/);
  assertFailure(invoke(root, [
    'solver-received', '--id', id, '--response-id', id, '--response-turn', '21',
    '--response-role', 'assistant', '--response-state', 'inProgress', '--summary', 'partial',
  ]), /must be complete/);
  assertFailure(invoke(root, [
    'solver-received', '--id', id, '--response-id', id, '--response-turn', '21',
    '--response-role', 'user', '--response-state', 'complete', '--summary', 'wrong role',
  ]), /assistant turn/);
  assertFailure(invoke(root, [
    'solver-received', '--id', id, '--response-id', 'OTHER_RECEIPT_01', '--response-turn', '21',
    '--response-role', 'assistant', '--response-state', 'complete', '--summary', 'wrong marker',
  ]), /does not match/);

  assert.equal(readState(root, id).solver.status, 'sent');
});

test('prevents duplicate sends and duplicate receipts', () => {
  const root = createRoot();
  const id = 'DUPLICATE_RECEIPT_1';
  begin(root, id);
  send(root, id, 1);
  assertFailure(invoke(root, ['solver-sent', '--id', id, '--baseline-turn', '1']), /send exactly once/);
  receive(root, id, 2);
  assertFailure(invoke(root, [
    'solver-received', '--id', id, '--response-id', id, '--response-turn', '3',
    '--response-role', 'assistant', '--response-state', 'complete', '--summary', 'duplicate',
  ]), /still unresolved/);
});

test('requires an explicit local fallback after an advisory timeout', () => {
  const root = createRoot();
  const id = 'ADVISORY_TIMEOUT_01';
  begin(root, id, 'advisory');
  send(root, id, 4);
  assertSuccess(invoke(root, ['solver-timeout', '--id', id, '--reason', 'transport unavailable']));
  assertFailure(invoke(root, ['worker-start', '--id', id]), /local fallback/);
  assertSuccess(invoke(root, ['solver-fallback', '--id', id, '--summary', 'continue locally with disclosed uncertainty']));
  assertSuccess(invoke(root, ['worker-start', '--id', id]));
});

test('late valid responses reopen required work after a timeout', () => {
  const root = createRoot();
  const id = 'REQUIRED_LATE_001';
  begin(root, id, 'required');
  send(root, id, 7);
  assertSuccess(invoke(root, ['solver-timeout', '--id', id, '--reason', 'required response unavailable']));
  assert.equal(readState(root, id).status, 'blocked');
  assertFailure(invoke(root, ['worker-start', '--id', id]), /not allowed/);

  receive(root, id, 8, 'late but valid required response');
  const reopened = readState(root, id);
  assert.equal(reopened.status, 'pending');
  assert.equal(reopened.solver.lateResponse, true);
  assertSuccess(invoke(root, ['worker-start', '--id', id]));
  assertSuccess(invokeWithRootBeforeSeparator(root, 'check', ['--id', id, '--', process.execPath, '-e', '']));
  assertSuccess(invoke(root, ['complete', '--id', id, '--summary', 'completed after verified late response']));
  assertSuccess(invoke(root, ['verify', '--id', id]));
});

test('a late advisory response is recorded without changing already-started work', () => {
  const root = createRoot();
  const id = 'ADVISORY_LATE_01';
  begin(root, id, 'advisory');
  send(root, id, 3);
  assertSuccess(invoke(root, ['solver-timeout', '--id', id, '--reason', 'slow transport']));
  assertSuccess(invoke(root, ['solver-fallback', '--id', id, '--summary', 'local decision already recorded']));
  assertSuccess(invoke(root, ['worker-start', '--id', id]));
  receive(root, id, 4, 'late advisory response');
  const state = readState(root, id);
  assert.equal(state.status, 'running');
  assert.equal(state.worker.status, 'started');
  assert.equal(state.solver.lateResponse, true);
});
