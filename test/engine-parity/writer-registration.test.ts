/**
 * BrainEngine parity — the local writer registration a serve process makes at startup, and the registration read a
 * remote caller's write-request receipts (get_write_request, list_write_requests, cancel_write_request) run under.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: registerServeLocalWriters (persistence/provider.ts) stores one cli and one stdio registration through
 *    readPersistenceBrainId, readLocalWriterRow and insertLocalWriterRow, and leaves them as they are on the next serve
 *    start; receiptAccess (ops/persistence.ts) verifies the caller's registration through readLocalWriterRow, with
 *    `lock` on the cancel path, and returns the same access on every engine arm (PGLite always; Postgres with
 *    DATABASE_URL; the Rust arm through test/engine-parity/harness.ts).
 *  - Regression: a Rust serve that registers no local writer answers writer_registration_required on every receipt
 *    read, and a receipt read that verifies the registration through executeRaw stops on raw_sql on Rust; either way a
 *    remote write on a Rust brain stays write_pending with no receipt the caller can read.
 *  - Why existing coverage misses it: import-path.test.ts covers the three members directly; nothing ran the serve
 *    registration or the receipt read on the Rust arm.
 *  - Seam: GBRAIN_HOME through withEnv (the registration files live under it). Typed members only (no executeRaw: D18).
 */
import { describe, expect } from 'bun:test';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { registerServeLocalWriters } from '../../src/core/persistence/provider.ts';
import { readLocalWriter } from '../../src/core/persistence/identity.ts';
import { receiptAccess } from '../../src/core/ops/persistence.ts';

const { parityTest } = parityArms(testBackends());

/** Runs `fn` with a fresh gbrain home, so each arm registers its own writers; the home is removed afterwards. */
async function inFreshHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-parity-writers-'));
  try { return await withEnv({ GBRAIN_HOME: home }, () => fn(home)); }
  finally { rmSync(home, { recursive: true, force: true }); }
}

function context(engine: BrainEngine, remote: boolean): OperationContext {
  return { engine, config: { engine: engine.kind }, remote, dryRun: false, sourceId: 'default',
    logger: { info() {}, warn() {}, error() {} } } as OperationContext;
}

describe('engine parity: serve writer registration', () => {
  parityTest('a serve registers one cli and one stdio local writer, and a second start leaves them as they are', {
    methods: ['readPersistenceBrainId', 'readLocalWriterRow', 'insertLocalWriterRow'],
  }, (engine) => inFreshHome(async (home) => {
    await registerServeLocalWriters(engine);
    const first = { cli: await readLocalWriter(engine, 'cli'), stdio: await readLocalWriter(engine, 'stdio') };
    await registerServeLocalWriters(engine);
    const rows = {
      cli: await engine.readLocalWriterRow(first.cli.id),
      stdio: await engine.readLocalWriterRow(first.stdio.id),
    };
    const files = readdirSync(join(home, '.gbrain', 'persistence')).map(name => name.replace(/^[0-9a-f-]{36}\./, '<brain>.')).sort();
    return {
      files,
      sameAfterRestart: (await readLocalWriter(engine, 'cli')).id === first.cli.id && (await readLocalWriter(engine, 'stdio')).id === first.stdio.id,
      rows: Object.fromEntries(Object.entries(rows).map(([lane, row]) => [lane,
        row && { lane: row.lane, revoked: row.revoked_at !== null, grant: row.grant_ceiling, hashed: /^[0-9a-f]{64}$/.test(row.credential_hash) }])),
    };
  }));

  parityTest('a receipt read verifies the caller\'s registration through readLocalWriterRow, with the cancel lock', {
    methods: ['readPersistenceBrainId', 'readLocalWriterRow', 'insertLocalWriterRow'],
  }, (engine) => inFreshHome(async () => {
    await registerServeLocalWriters(engine);
    const shape = (access: Awaited<ReturnType<typeof receiptAccess>>) => ({
      principal: access.principal.kind, operations: access.operations ?? null, slugPrefixes: access.slugPrefixes ?? null, sourceIds: access.sourceIds ?? null,
    });
    return {
      remoteGet: shape(await receiptAccess(context(engine, true), 'get_write_request')),
      remoteList: shape(await receiptAccess(context(engine, true), 'list_write_requests')),
      remoteCancel: shape(await receiptAccess(context(engine, true), 'cancel_write_request', true)),
      localGet: shape(await receiptAccess(context(engine, false), 'get_write_request')),
    };
  }));
});
