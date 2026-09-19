#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';

const terminalStatuses = new Set(['blocked', 'completed']);

const readStdin = () => new Promise((resolve, reject) => {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    input += chunk;
  });
  process.stdin.on('end', () => resolve(input));
  process.stdin.on('error', reject);
});

const parseInput = (rawInput) => {
  if (!rawInput.trim()) return {};
  const parsed = JSON.parse(rawInput);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('hook input must be a JSON object');
  }
  return parsed;
};

const sessionDirectory = (input) => {
  const candidate = typeof input.cwd === 'string' && input.cwd.trim()
    ? path.resolve(input.cwd)
    : process.cwd();
  try {
    if (fs.statSync(candidate).isDirectory()) return candidate;
  } catch {
    // Fall back to the hook process directory when the host supplied cwd is stale.
  }
  return process.cwd();
};

const handoffDirectoryIfPresent = (directory) => {
  const candidate = path.join(directory, '.agent-runtime', 'handoffs');
  return fs.existsSync(candidate) ? candidate : null;
};

const findHandoffDirectories = (startingDirectory) => {
  let directory = startingDirectory;
  while (true) {
    const candidate = handoffDirectoryIfPresent(directory);
    if (candidate) return [candidate];
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }

  // A parent workspace can contain several nested repositories. Inspect only
  // immediate nested repositories so unrelated workspace data is never
  // recursively scanned by a stop hook.
  const nested = [];
  for (const entry of fs.readdirSync(startingDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const child = path.join(startingDirectory, entry.name);
    const isRepository = fs.existsSync(path.join(child, '.git'))
      || fs.existsSync(path.join(child, 'bin', 'agent-handoff'));
    const candidate = isRepository ? handoffDirectoryIfPresent(child) : null;
    if (candidate) nested.push(candidate);
  }
  return nested;
};

const readHandoffs = (directory) => {
  if (!fs.existsSync(directory)) return { unresolved: [], malformed: [] };

  const unresolved = [];
  const malformed = [];
  const entries = fs.readdirSync(directory)
    .filter((entry) => entry.endsWith('.json'))
    .sort();

  for (const entry of entries) {
    const filename = path.join(directory, entry);
    try {
      const state = JSON.parse(fs.readFileSync(filename, 'utf8'));
      const id = typeof state.id === 'string' && state.id.trim() ? state.id.trim() : entry.slice(0, -5);
      if (!terminalStatuses.has(state.status)) {
        unresolved.push({ id, status: typeof state.status === 'string' ? state.status : 'unknown' });
      } else if (state.status === 'completed') {
        const solver = state.solver;
        const missingReceipt = !solver
          || typeof solver !== 'object'
          || (solver.status === 'received' && solver.receiptVerified !== true)
          || (solver.policy === 'required' && (solver.status !== 'received' || solver.receiptVerified !== true));
        if (missingReceipt) malformed.push({ id, detail: 'completed handoff has no verified solver receipt' });
      }
    } catch (error) {
      malformed.push({
        id: entry.slice(0, -5),
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { unresolved, malformed };
};

const describe = (unresolved, malformed) => {
  const states = unresolved.map(({ id, status }) => `${id}=${status}`);
  const invalid = malformed.map(({ id }) => `${id}=unreadable`);
  return [...states, ...invalid].join(', ');
};

const main = async () => {
  const input = parseInput(await readStdin());
  const handoffDirectories = findHandoffDirectories(sessionDirectory(input));
  const results = handoffDirectories.map((directory) => readHandoffs(directory));
  const unresolved = results.flatMap((result) => result.unresolved);
  const malformed = results.flatMap((result) => result.malformed);

  if (unresolved.length === 0 && malformed.length === 0) {
    process.stdout.write('{}\n');
    return;
  }

  const summary = describe(unresolved, malformed);
  if (input.stop_hook_active === true) {
    process.stdout.write(`${JSON.stringify({
      systemMessage: `Completion checkpoint already granted one continuation. Stop is allowed now, but the local handoff remains unresolved: ${summary}.`,
    })}\n`);
    return;
  }

  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'Stop',
      decision: 'block',
      reason: `Completion checkpoint: Did you actually complete the task? The local handoff is not terminal (${summary}). Continue working now; after a successful recorded check, run agent-handoff complete, or record a concrete agent-handoff blocked reason before stopping.`,
    },
  })}\n`);
};

main().catch((error) => {
  process.stderr.write(`agent-stop-guard: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
});
