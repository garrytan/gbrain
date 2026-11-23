/**
 * Refusal-swallow sites in the job operations and the remediation run (triage rows 12 and 13): a catch around a raw-SQL
 * queue read must not turn the Rust engine's `engine_capability_missing` refusal into a quiet default.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: the no-worker notice and the manual-only skip list read the queue through typed members, so an engine whose
 *    `executeRaw` refuses (a Rust brain) tells the user what PGLite tells them.
 *  - Regression: the raw reads were refused and dropped, so `submit_job` on a Rust brain never said "no worker is running"
 *    and a remediation run never named the manual-only jobs an earlier run had queued.
 *  - Why existing coverage misses it: the ops and remediation tests run PGLite, where the raw reads succeed.
 *  - Seam: a PGLite engine wrapped so `executeRaw` throws the real refusal (test/helpers/refusing-engine.ts) and, where the
 *    case is reachable, a real Rust brain (needs the addon; skipped without it unless GBRAIN_TEST_RUST_ADDON_REQUIRED=1).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName } from '../src/core/operations.ts';
import type { Notice } from '../src/core/ops/contract.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { withEnv } from './helpers/with-env.ts';
import { refusingEngine } from './helpers/refusing-engine.ts';
import { openRustBrain, removeBrainDir, rustArmAddonPath } from './engine-parity/rust-arm.ts';

let pg: PGLiteEngine;
let home: string;
beforeAll(async () => {
  pg = new PGLiteEngine();
  await pg.connect({});
  await pg.initSchema();
  home = mkdtempSync(join(tmpdir(), 'gbrain-refusal-ops-'));
}, 120_000);
afterAll(async () => {
  await pg.disconnect();
  rmSync(home, { recursive: true, force: true });
});

const rustRun = existsSync(rustArmAddonPath()) || process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1' ? test : test.skip;

/** The notice codes `submit_job` emits for one queued job on `engine`, with no worker registered anywhere. */
async function submitNoticeCodes(engine: BrainEngine): Promise<string[]> {
  const notices: Notice[] = [];
  const ctx = { engine, logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: false, emitNotice: (n: Notice) => { notices.push(n); } } as unknown as OperationContext;
  await withEnv({ GBRAIN_HOME: home }, () => operationsByName.submit_job!.handler(ctx, { name: 'lint', data: {} }));
  return notices.map((n) => n.code);
}

describe('job operation refusal-swallow sites', () => {
  test('S12 emitNoWorkerNotice: the waiting count comes from the typed countJobsByStatus, so an engine whose raw SQL refuses still says no worker is running', async () => {
    expect(await submitNoticeCodes(pg)).toContain('no_worker');
    expect(await submitNoticeCodes(refusingEngine(pg))).toContain('no_worker');
  });

  rustRun('S12 on a Rust brain: submit_job says no worker is running', async () => {
    const { engine, dir } = await openRustBrain();
    try {
      expect(await submitNoticeCodes(engine as unknown as BrainEngine)).toContain('no_worker');
    } finally {
      await engine.disconnect();
      removeBrainDir(dir);
    }
  });
});
