#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const schemaVersion = 1;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/;
const solverPolicies = new Set(['advisory', 'required', 'none']);
const commands = new Set([
  'begin',
  'solver-sent',
  'solver-received',
  'solver-timeout',
  'solver-fallback',
  'solver-skip',
  'worker-start',
  'check',
  'complete',
  'blocked',
  'status',
  'verify',
  'list',
]);

class GuardError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

const usage = `Usage:
  agent-handoff begin --id ID --objective TEXT --scope TEXT [--solver advisory|required|none]
  agent-handoff solver-sent --id ID --baseline-turn TURN
  agent-handoff solver-received --id ID --response-id ID --response-turn TURN --response-role assistant --response-state complete --summary TEXT
  agent-handoff solver-timeout --id ID --reason TEXT
  agent-handoff solver-fallback --id ID --summary TEXT
  agent-handoff solver-skip --id ID --reason TEXT
  agent-handoff worker-start --id ID
  agent-handoff check --id ID -- COMMAND [ARGUMENT ...]
  agent-handoff complete --id ID --summary TEXT [--file PATH ...]
  agent-handoff blocked --id ID --reason TEXT
  agent-handoff status --id ID
  agent-handoff verify --id ID
  agent-handoff list

The guard stores redacted, non-secret handoff state in .agent-runtime/.
It never stores command output. Updates for one handoff are serialized and
recover a lock whose owner process has exited. Use --help for the transition rules.`;

const fail = (message, exitCode = 1) => {
  throw new GuardError(message, exitCode);
};

const now = () => new Date().toISOString();

const parseArgs = (argv) => {
  const command = argv.shift();
  if (!command || command === '--help' || command === '-h') {
    process.stdout.write(`${usage}\n`);
    process.exit(command ? 0 : 2);
  }
  if (!commands.has(command)) fail(`unknown command '${command}'.\n\n${usage}`, 2);

  const options = { files: [] };
  const commandArgs = [];
  let afterSeparator = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (afterSeparator) {
      commandArgs.push(arg);
      continue;
    }
    if (arg === '--') {
      afterSeparator = true;
      continue;
    }
    if (arg === '--hard-gate') {
      options.solver = 'required';
      continue;
    }
    if (!arg.startsWith('--')) fail(`unexpected argument '${arg}'`, 2);
    const name = arg.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) fail(`--${name} needs a value`, 2);
    if (name === 'file') options.files.push(value);
    else if (name === 'root') options.root = value;
    else if (['id', 'objective', 'scope', 'solver', 'summary', 'reason', 'baseline-turn', 'response-id', 'response-turn', 'response-role', 'response-state'].includes(name)) options[name] = value;
    else fail(`unknown option '--${name}'`, 2);
    index += 1;
  }
  return { command, options, commandArgs };
};

const runtimeDirectory = (options) => path.resolve(options.root || path.join(process.cwd(), '.agent-runtime'));
const handoffDirectory = (options) => path.join(runtimeDirectory(options), 'handoffs');
const handoffPath = (options, id) => path.join(handoffDirectory(options), `${id}.json`);
const lockPath = (options, id) => `${handoffPath(options, id)}.lock`;
const lockWaitMs = 300000;
const malformedLockStaleMs = 120000;

const ensureRuntimeDirectory = (options) => {
  fs.mkdirSync(handoffDirectory(options), { recursive: true, mode: 0o700 });
};

const sleepSynchronously = (milliseconds) => {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, milliseconds);
};

const processIsAlive = (pid) => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && error.code === 'EPERM';
  }
};

const readLockOwner = (filename) => {
  try {
    return JSON.parse(fs.readFileSync(filename, 'utf8'));
  } catch {
    return null;
  }
};

const staleLock = (filename) => {
  const owner = readLockOwner(filename);
  if (owner && Number.isInteger(owner.pid)) return !processIsAlive(owner.pid);
  try {
    return Date.now() - fs.statSync(filename).mtimeMs > malformedLockStaleMs;
  } catch {
    return false;
  }
};

const acquireLock = (options, id) => {
  ensureRuntimeDirectory(options);
  const filename = lockPath(options, id);
  const deadline = Date.now() + lockWaitMs;
  while (Date.now() < deadline) {
    try {
      const descriptor = fs.openSync(filename, 'wx', 0o600);
      try {
        fs.writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, createdAt: now() })}\n`);
      } finally {
        fs.closeSync(descriptor);
      }
      return filename;
    } catch (error) {
      if (!(error instanceof Error) || error.code !== 'EEXIST') throw error;
      if (staleLock(filename)) {
        try {
          fs.unlinkSync(filename);
        } catch (unlinkError) {
          if (!(unlinkError instanceof Error) || unlinkError.code !== 'ENOENT') throw unlinkError;
        }
        continue;
      }
      sleepSynchronously(25);
    }
  }
  fail(`could not acquire lock for handoff '${id}' within ${lockWaitMs}ms`);
};

const releaseLock = (filename) => {
  try {
    fs.unlinkSync(filename);
  } catch (error) {
    if (!(error instanceof Error) || error.code !== 'ENOENT') throw error;
  }
};

const withHandoffLock = (options, id, operation) => {
  const filename = acquireLock(options, id);
  try {
    return operation();
  } finally {
    releaseLock(filename);
  }
};

const writeState = (options, state) => {
  ensureRuntimeDirectory(options);
  const destination = handoffPath(options, state.id);
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporary, destination);
};

const readState = (options, id) => {
  if (!idPattern.test(id || '')) fail(`invalid or missing handoff id '${id || ''}'`, 2);
  const filename = handoffPath(options, id);
  if (!fs.existsSync(filename)) fail(`handoff '${id}' does not exist`);
  try {
    const state = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
      fail(`handoff '${id}' does not contain an object state`);
    }
    if (state.id !== id) fail(`handoff '${id}' contains mismatched state id '${state.id || ''}'`);
    if (!state.solver || typeof state.solver !== 'object' || Array.isArray(state.solver)) {
      fail(`handoff '${id}' has no valid solver state`);
    }
    // Normalize records created by the original guard so an interrupted upgrade
    // cannot silently bypass the new receipt invariants.
    state.solver.baselineTurn ??= null;
    state.solver.responseId ??= null;
    state.solver.responseTurn ??= null;
    state.solver.responseRole ??= null;
    state.solver.responseState ??= null;
    state.solver.receiptVerified ??= false;
    state.solver.lateResponse ??= false;
    state.solver.fallback ??= null;
    if (!Array.isArray(state.checks)) state.checks = [];
    return state;
  } catch (error) {
    if (error instanceof GuardError) throw error;
    fail(`handoff '${id}' is unreadable: ${error instanceof Error ? error.message : String(error)}`);
  }
};

const required = (options, name) => {
  if (!options[name] || !String(options[name]).trim()) fail(`--${name} is required`, 2);
  return String(options[name]).trim();
};

const requiredTurn = (options, name) => {
  const raw = required(options, name);
  if (!/^\d+$/.test(raw)) fail(`--${name} must be a non-negative integer`, 2);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) fail(`--${name} is outside the safe integer range`, 2);
  return value;
};

const safeText = (value, maximum = 1200) => String(value).trim().slice(0, maximum);

const redactArgument = (argument) => {
  if (/^(?:[A-Z0-9_]*(?:TOKEN|PASSWORD|SECRET|API_KEY|PRIVATE_KEY|AUTHORIZATION)[A-Z0-9_]*)=/i.test(argument)) {
    return `${argument.split('=', 1)[0]}=<redacted>`;
  }
  if (/^--?(?:token|password|secret|api[-_]?key|private[-_]?key|authorization)=/i.test(argument)) {
    return `${argument.split('=', 1)[0]}=<redacted>`;
  }
  return argument;
};

const safeCommand = (args) => {
  const redacted = [];
  let redactNext = false;
  for (const argument of args) {
    if (redactNext) {
      redacted.push('<redacted>');
      redactNext = false;
      continue;
    }
    if (/^--?(?:token|password|secret|api[-_]?key|private[-_]?key|authorization)$/i.test(argument)) {
      redacted.push(argument);
      redactNext = true;
      continue;
    }
    redacted.push(redactArgument(argument));
  }
  return redacted.join(' ').slice(0, 2000);
};

const transitionAllowed = (state, expected, action) => {
  if (!expected.includes(state.status)) {
    fail(`${action} is not allowed while handoff '${state.id}' is '${state.status}'`);
  }
};

const begin = (options) => {
  const id = required(options, 'id');
  if (!idPattern.test(id)) fail(`handoff id must match ${idPattern}`, 2);
  const solver = options.solver || 'advisory';
  if (!solverPolicies.has(solver)) fail('--solver must be advisory, required, or none', 2);
  withHandoffLock(options, id, () => {
    const destination = handoffPath(options, id);
    if (fs.existsSync(destination)) fail(`handoff '${id}' already exists; use its existing state instead of creating a duplicate`);
    const timestamp = now();
    writeState(options, {
      schemaVersion,
      id,
      objective: safeText(required(options, 'objective')),
      scope: safeText(required(options, 'scope')),
      status: 'pending',
      createdAt: timestamp,
      updatedAt: timestamp,
      solver: {
        policy: solver,
        status: solver === 'none' ? 'not_required' : 'pending',
        attempts: 0,
        sentAt: null,
        respondedAt: null,
        summary: null,
        reason: null,
        baselineTurn: null,
        responseId: null,
        responseTurn: null,
        responseRole: null,
        responseState: null,
        receiptVerified: false,
        lateResponse: false,
        fallback: null,
      },
      worker: {
        status: 'not_started',
        startedAt: null,
        completedAt: null,
      },
      checks: [],
      files: [],
      outcome: null,
    });
  });
  process.stdout.write(`created ${id} solver=${solver}\n`);
};

const update = (options, id, mutator) => {
  return withHandoffLock(options, id, () => {
    const state = readState(options, id);
    mutator(state);
    state.updatedAt = now();
    writeState(options, state);
    return state;
  });
};

const solverSent = (options) => {
  const id = required(options, 'id');
  const baselineTurn = requiredTurn(options, 'baseline-turn');
  const state = update(options, id, (current) => {
    if (current.solver.policy === 'none') fail(`handoff '${id}' does not require a solver`);
    if (current.solver.status !== 'pending') fail(`solver request for '${id}' was already ${current.solver.status}; send exactly once`);
    transitionAllowed(current, ['pending'], 'solver-sent');
    current.solver.status = 'sent';
    current.solver.attempts = 1;
    current.solver.sentAt = now();
    current.solver.baselineTurn = baselineTurn;
  });
  process.stdout.write(`solver sent ${state.id}\n`);
};

const solverReceived = (options) => {
  const id = required(options, 'id');
  const responseId = required(options, 'response-id');
  const responseTurn = requiredTurn(options, 'response-turn');
  const responseRole = required(options, 'response-role');
  const responseState = required(options, 'response-state');
  const summary = safeText(required(options, 'summary'));
  const state = update(options, id, (current) => {
    if (current.solver.status !== 'sent' && current.solver.status !== 'timeout') {
      fail(`solver response for '${id}' requires a sent request that is still unresolved`);
    }
    if (responseId !== id) fail(`solver response id '${responseId}' does not match handoff '${id}'`);
    if (responseRole !== 'assistant') fail(`solver response for '${id}' must be an assistant turn`);
    if (responseState !== 'complete') fail(`solver response for '${id}' must be complete, not '${responseState}'`);
    if (!Number.isSafeInteger(current.solver.baselineTurn)) {
      fail(`solver response for '${id}' has no recorded baseline turn`);
    }
    if (responseTurn <= current.solver.baselineTurn) {
      fail(`solver response turn ${responseTurn} is not newer than baseline turn ${current.solver.baselineTurn}`);
    }
    const wasTimedOut = current.solver.status === 'timeout';
    current.solver.status = 'received';
    current.solver.respondedAt = now();
    current.solver.summary = summary;
    current.solver.responseId = responseId;
    current.solver.responseTurn = responseTurn;
    current.solver.responseRole = responseRole;
    current.solver.responseState = responseState;
    current.solver.receiptVerified = true;
    current.solver.lateResponse = wasTimedOut;
    if (wasTimedOut && current.solver.policy === 'required'
      && current.status === 'blocked'
      && current.outcome?.kind === 'solver_blocked') {
      current.status = 'pending';
      current.worker.status = 'not_started';
      current.outcome = null;
    }
  });
  process.stdout.write(`solver received ${state.id}\n`);
};

const solverTimeout = (options, status, action) => {
  const id = required(options, 'id');
  const reason = safeText(required(options, 'reason'));
  const state = update(options, id, (current) => {
    if (current.solver.status !== 'sent') fail(`${action} for '${id}' requires a sent request`);
    current.solver.status = status;
    current.solver.reason = reason;
    if (current.solver.policy === 'required') {
      current.status = 'blocked';
      current.worker.status = 'blocked';
      current.outcome = { kind: 'solver_blocked', summary: reason, at: now() };
    }
  });
  process.stdout.write(`${action} ${state.id} policy=${state.solver.policy}\n`);
};

const solverFallback = (options) => {
  const id = required(options, 'id');
  const summary = safeText(required(options, 'summary'));
  const state = update(options, id, (current) => {
    if (current.solver.policy !== 'advisory') {
      fail(`handoff '${id}' only permits local fallback for advisory solver policy`);
    }
    if (current.solver.status !== 'timeout') {
      fail(`local fallback for '${id}' requires a recorded solver timeout`);
    }
    if (current.solver.fallback) fail(`local fallback for '${id}' was already recorded`);
    current.solver.fallback = { summary, at: now() };
  });
  process.stdout.write(`solver fallback recorded ${state.id}\n`);
};

const solverSkip = (options) => {
  const id = required(options, 'id');
  const reason = safeText(required(options, 'reason'));
  const state = update(options, id, (current) => {
    if (current.solver.policy === 'required') fail(`required solver handoff '${id}' cannot be skipped`);
    if (current.solver.status !== 'pending') fail(`solver for '${id}' is already ${current.solver.status}`);
    current.solver.status = 'skipped';
    current.solver.reason = reason;
  });
  process.stdout.write(`solver skipped ${state.id}\n`);
};

const workerStart = (options) => {
  const id = required(options, 'id');
  const state = update(options, id, (current) => {
    transitionAllowed(current, ['pending', 'running'], 'worker-start');
    if (current.solver.status === 'sent') fail(`handoff '${id}' still has an unverified solver request; record received, timeout, or skip first`);
    if (current.solver.status === 'timeout' && current.solver.policy === 'advisory' && !current.solver.fallback) {
      fail(`handoff '${id}' requires a recorded local fallback after advisory solver timeout`);
    }
    if (current.solver.policy !== 'none' && current.solver.status === 'pending') {
      fail(`handoff '${id}' requires solver-skip or a sent-and-resolved solver request before worker start`);
    }
    if (current.solver.policy === 'required' && (current.solver.status !== 'received' || !current.solver.receiptVerified)) {
      fail(`required solver decision for '${id}' has not been received`);
    }
    if (current.solver.status === 'received' && !current.solver.receiptVerified) {
      fail(`solver decision for '${id}' has no verified transcript receipt`);
    }
    if (current.worker.status === 'completed') fail(`worker for '${id}' is already complete`);
    current.status = 'running';
    current.worker.status = 'started';
    current.worker.startedAt ||= now();
  });
  process.stdout.write(`worker started ${state.id}\n`);
};

const check = (options, commandArgs) => {
  const id = required(options, 'id');
  if (commandArgs.length === 0) fail('check requires a command after --', 2);
  const { exitCode } = withHandoffLock(options, id, () => {
    const state = readState(options, id);
    transitionAllowed(state, ['running'], 'check');
    if (state.worker.status !== 'started') fail(`worker for '${id}' has not started`);
    const startedAt = now();
    const result = spawnSync(commandArgs[0], commandArgs.slice(1), {
      cwd: process.cwd(),
      env: process.env,
      stdio: 'inherit',
    });
    const exitCode = result.error ? 127 : (typeof result.status === 'number' ? result.status : 1);
    state.checks.push({
      command: safeCommand(commandArgs),
      exitCode,
      startedAt,
      completedAt: now(),
    });
    state.updatedAt = now();
    writeState(options, state);
    return { exitCode };
  });
  process.stdout.write(`recorded check for ${id}: exit=${exitCode}\n`);
  process.exitCode = exitCode;
};

const complete = (options) => {
  const id = required(options, 'id');
  const summary = safeText(required(options, 'summary'));
  const state = update(options, id, (current) => {
    transitionAllowed(current, ['running'], 'complete');
    if (current.worker.status !== 'started') fail(`worker for '${id}' has not started`);
    if (current.checks.length === 0) fail(`handoff '${id}' cannot complete without at least one recorded check`);
    const failedCheck = current.checks.find((entry) => entry.exitCode !== 0);
    if (failedCheck) fail(`handoff '${id}' cannot complete while a recorded check has exit=${failedCheck.exitCode}`);
    if (current.solver.policy === 'required' && (current.solver.status !== 'received' || !current.solver.receiptVerified)) {
      fail(`handoff '${id}' cannot complete without the required solver response`);
    }
    if (current.solver.status === 'received' && !current.solver.receiptVerified) {
      fail(`handoff '${id}' cannot complete with an unverified solver response`);
    }
    current.status = 'completed';
    current.worker.status = 'completed';
    current.worker.completedAt = now();
    current.files = [...new Set(options.files.map((file) => safeText(file, 500)))];
    current.outcome = { kind: 'completed', summary, at: now() };
  });
  process.stdout.write(`completed ${state.id}\n`);
};

const blocked = (options) => {
  const id = required(options, 'id');
  const reason = safeText(required(options, 'reason'));
  const state = update(options, id, (current) => {
    if (current.status === 'completed') fail(`completed handoff '${id}' cannot become blocked`);
    current.status = 'blocked';
    current.worker.status = 'blocked';
    current.outcome = { kind: 'blocked', summary: reason, at: now() };
  });
  process.stdout.write(`blocked ${state.id}\n`);
};

const status = (options, verifyOnly = false) => {
  const id = required(options, 'id');
  const state = readState(options, id);
  if (verifyOnly) {
    if (state.schemaVersion !== schemaVersion) fail(`handoff '${id}' has unsupported schema version`);
    if (state.status !== 'completed') fail(`handoff '${id}' is ${state.status}, not completed`);
    if (state.worker.status !== 'completed' || state.checks.length === 0 || state.checks.some((entry) => entry.exitCode !== 0)) {
      fail(`handoff '${id}' does not satisfy completion invariants`);
    }
    if (state.solver.policy === 'required' && (state.solver.status !== 'received' || !state.solver.receiptVerified)) {
      fail(`handoff '${id}' completed without its required solver response`);
    }
    if (state.solver.status === 'received' && !state.solver.receiptVerified) {
      fail(`handoff '${id}' completed with an unverified solver response`);
    }
    if (!state.outcome || state.outcome.kind !== 'completed' || !state.outcome.summary) {
      fail(`handoff '${id}' has no completed outcome summary`);
    }
    process.stdout.write(`verified ${id}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
};

const list = (options) => {
  const directory = handoffDirectory(options);
  if (!fs.existsSync(directory)) {
    process.stdout.write('no handoffs\n');
    return;
  }
  const entries = fs.readdirSync(directory).filter((entry) => entry.endsWith('.json')).sort();
  if (entries.length === 0) {
    process.stdout.write('no handoffs\n');
    return;
  }
  for (const entry of entries) {
    const state = JSON.parse(fs.readFileSync(path.join(directory, entry), 'utf8'));
    process.stdout.write(`${state.id}\t${state.status}\tsolver=${state.solver.status}\tworker=${state.worker.status}\n`);
  }
};

const main = () => {
  const { command, options, commandArgs } = parseArgs(process.argv.slice(2));
  if (command === 'begin') return begin(options);
  if (command === 'solver-sent') return solverSent(options);
  if (command === 'solver-received') return solverReceived(options);
  if (command === 'solver-timeout') return solverTimeout(options, 'timeout', 'solver timeout');
  if (command === 'solver-fallback') return solverFallback(options);
  if (command === 'solver-skip') return solverSkip(options);
  if (command === 'worker-start') return workerStart(options);
  if (command === 'check') return check(options, commandArgs);
  if (command === 'complete') return complete(options);
  if (command === 'blocked') return blocked(options);
  if (command === 'status') return status(options);
  if (command === 'verify') return status(options, true);
  if (command === 'list') return list(options);
  fail(`unhandled command '${command}'`, 2);
};

try {
  main();
} catch (error) {
  const exitCode = error instanceof GuardError ? error.exitCode : 1;
  process.stderr.write(`agent-handoff: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = exitCode;
}
