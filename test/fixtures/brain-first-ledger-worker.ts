/** Child-only barriers: no module mock or environment mutation escapes to the test runner. */
import { mock } from 'bun:test';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as atomic from '../../src/core/bootstrap/atomic-write.ts';
import { acquireNativeLockSync } from '../../src/core/persistence/native-lock.ts';

const [mode, harness, path, pause, release] = process.argv.slice(2);
function barrier() {
  writeFileSync(pause, 'ready');
  const deadline = Date.now() + 12000;
  while (!existsSync(release)) {
    if (Date.now() > deadline) throw new Error('parent did not release ledger write');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}
if (mode === 'hold') {
  const lock = acquireNativeLockSync(join(process.env.GBRAIN_HOME!, '.gbrain/agent-instructions.json.lock'));
  if (!lock) throw new Error('could not hold test lock');
  try { barrier(); } finally { lock.release(); }
  console.log('{}');
} else {
  const original = atomic.atomicWriteTextFile;
  if (pause && mode !== 'stale') mock.module('../../src/core/bootstrap/atomic-write.ts', () => ({ ...atomic,
    atomicWriteTextFile(file: string, text: string, opts?: Parameters<typeof original>[2]) {
      if (file.endsWith('agent-instructions.json')) barrier();
      return original(file, text, opts);
    },
  }));
  const { installerBrainFirst, syncBrainFirst, resolveBrainFirstDecision, priorBrainFirst } = await import('../../src/core/setup/brain-first.ts');
  const target = { harness: harness as 'claude-code' | 'codex', path, role: 'test instructions', project: false };
  const access = { kind: 'mcp' as const, server: 'gbrain' };
  writeFileSync(path + '.started', 'ready');
  const outcome = mode === 'stale' ? (() => {
    const decision = resolveBrainFirstDecision(undefined, priorBrainFirst(harness, path));
    barrier();
    return syncBrainFirst({ target, access, decision, writer: 'synthetic installer', dryRun: false });
  })() : installerBrainFirst({ target, access, writer: 'synthetic installer',
    ...(mode === 'remove' ? { remove: true } : mode === 'decline' ? { instructions: false } : mode === 'dry' ? { dryRun: true } : {}) });
  console.log(JSON.stringify(outcome));
}
