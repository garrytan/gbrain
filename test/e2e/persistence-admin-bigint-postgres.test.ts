/**
 * Real-Postgres regression for #5177: `sources writer claim/status/transfer`
 * crash with "JSON.stringify cannot serialize BigInt." after the first claim.
 *
 * postgres.js decodes int8 columns (persistence_worktrees.owner_epoch,
 * persistence_source_bindings.topology_generation) as JS BigInt, and these
 * results are stringified verbatim by the CLI renderer. The fix casts both
 * columns to ::text at the SQL boundary (see ownership.ts / administration.ts)
 * so both engines emit the same string shape; this file pins the postgres.js
 * side of that contract with a REAL always-BigInt int8 decode (PGlite decodes
 * adaptively — number within the safe-integer range — so small values alone
 * never reproduce the crash there).
 *
 * Run: DATABASE_URL=... bun test test/e2e/persistence-admin-bigint-postgres.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runPersistenceAdministration } from '../../src/core/persistence/administration.ts';
import { getWorktreeBinding } from '../../src/core/persistence/ownership.ts';
import { hasDatabase, setupDB, teardownDB, getEngine } from './helpers.ts';

const skip = !hasDatabase();
const describeE2E = skip ? describe.skip : describe;
if (skip) console.log('Skipping persistence-admin bigint E2E (DATABASE_URL not set)');

describeE2E('persistence admin int8 outputs on Postgres (#5177)', () => {
  beforeAll(async () => { await setupDB(); }, 120_000);
  afterAll(async () => { await teardownDB(); });

  test('writer_claim returns string epochs and survives the bare CLI stringify (the #5177 crash)', async () => {
    const engine = getEngine();
    const sourceId = `bigint-${randomUUID().slice(0, 8)}`;
    const root = join(tmpdir(), `gbrain-e2e-bigint-${randomUUID().slice(0, 8)}`);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'page.md'), 'canonical bytes');
    await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);

    // Pre-fix this call's return value made JSON.stringify throw downstream in
    // the CLI renderer: postgres.js decodes owner_epoch as a raw BigInt here.
    const claim = await runPersistenceAdministration(engine, 'writer_claim', { source_id: sourceId, path: root }) as Record<string, unknown>;
    expect(claim.claimed).toBe(true);
    const binding = claim.binding as { owner_epoch: unknown; topology_generation: unknown };
    expect(typeof binding.owner_epoch).toBe('string');
    expect(typeof binding.topology_generation).toBe('string');
    expect(() => JSON.stringify(claim)).not.toThrow();

    const stored = await getWorktreeBinding(engine, sourceId);
    expect(stored).not.toBeNull();
    expect(typeof stored!.owner_epoch).toBe('string');
    expect(typeof stored!.topology_generation).toBe('string');

    const status = await runPersistenceAdministration(engine, 'writer_status', {}) as Record<string, unknown>;
    expect(() => JSON.stringify(status)).not.toThrow();
    const rows = status.bindings as Array<{ owner_epoch: unknown; topology_generation: unknown }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(typeof rows[0].owner_epoch).toBe('string');
    expect(typeof rows[0].topology_generation).toBe('string');
  }, 30_000);
});
