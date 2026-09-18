// Regression tests for the #5177 BigInt class (SQL boundary layer).
//
// getWorktreeBinding and the writer_status bindings select must cast
// owner_epoch/topology_generation to ::text so BOTH engines emit the same
// string shape. A raw int8 column decodes as a JS BigInt on postgres.js
// (always) and on PGlite for values past Number.MAX_SAFE_INTEGER (pglite 0.4.3
// decodes adaptively), and these results are stringified verbatim by the CLI
// renderer — that crash killed `sources writer status/claim/transfer` exactly
// when the operator needs the output. Leaving the columns uncast made the
// output shape engine- AND value-dependent (the same class the extract-explain
// BigInt fix called out).
//
// Discrimination: reverting src/core/persistence/{ownership,administration}.ts
// makes these assertions see the raw decode again (fails on PGLite too); the
// e2e Postgres variant pins the exact reported crash on postgres.js.
//
// Run: bun test test/persistence-admin-bigint.test.ts

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runPersistenceAdministration } from '../src/core/persistence/administration.ts';
import { getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let home: string;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  home = mkdtempSync(join(tmpdir(), 'gbrain-admin-bigint-'));
}, 60_000);
afterAll(async () => { await engine.disconnect(); rmSync(home, { recursive: true, force: true }); });

/** Isolated GBRAIN_HOME for every test — claim paths touch persistenceHome(). */
async function isolated<T>(run: () => Promise<T>): Promise<T> {
  return withEnv({ GBRAIN_HOME: home, HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, run);
}

function expectStringEpochs(binding: { owner_epoch: unknown; topology_generation: unknown }): void {
  expect(typeof binding.owner_epoch).toBe('string');
  expect(typeof binding.topology_generation).toBe('string');
}

async function seedAndClaim(): Promise<{ sourceId: string; root: string }> {
  const sourceId = `bigint-${randomUUID().slice(0, 8)}`;
  const root = join(home, `root-${randomUUID().slice(0, 8)}`);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'page.md'), 'canonical bytes');
  await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
  const claim = await runPersistenceAdministration(engine, 'writer_claim', { source_id: sourceId, path: root });
  expect(claim.claimed).toBe(true);
  return { sourceId, root };
}

describe('persistence admin BigInt boundary contract (#5177)', () => {
  test('getWorktreeBinding emits owner_epoch/topology_generation as strings on BOTH engines', () => isolated(async () => {
    const { sourceId } = await seedAndClaim();
    const binding = await getWorktreeBinding(engine, sourceId);
    expect(binding).not.toBeNull();
    expect(typeof binding!.owner_epoch).toBe('string');
    expect(typeof binding!.topology_generation).toBe('string');
    expect(Number(binding!.owner_epoch)).toBeGreaterThanOrEqual(1);
    expect(Number(binding!.topology_generation)).toBeGreaterThanOrEqual(1);
  }));

  test('writer_claim returns the binding it committed with string epochs (the #5177 claim output)', () => isolated(async () => {
    const sourceId = `bigint-${randomUUID().slice(0, 8)}`;
    const root = join(home, `root-${randomUUID().slice(0, 8)}`);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'page.md'), 'canonical bytes');
    await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
    const claim = await runPersistenceAdministration(engine, 'writer_claim', { source_id: sourceId, path: root }) as Record<string, unknown>;
    const binding = claim.binding as { owner_epoch: unknown; topology_generation: unknown };
    expect(typeof binding.owner_epoch).toBe('string');
    expect(typeof binding.topology_generation).toBe('string');
    // A bare stringify is exactly what the CLI renderer does with the result.
    expect(() => JSON.stringify(claim)).not.toThrow();
  }));

  test('writer_claim --dry-run carries the current binding with string epochs', () => isolated(async () => {
    const { sourceId, root } = await seedAndClaim();
    const dry = await runPersistenceAdministration(engine, 'writer_claim', { source_id: sourceId, path: root, dry_run: true }) as Record<string, unknown>;
    expect(dry.dry_run).toBe(true);
    expectStringEpochs(dry.current as { owner_epoch: unknown; topology_generation: unknown });
    expect(() => JSON.stringify(dry)).not.toThrow();
  }));

  test('writer_status result is JSON.stringify-safe with string epochs (engine-parity pin)', () => isolated(async () => {
    await seedAndClaim();
    const status = await runPersistenceAdministration(engine, 'writer_status', { probe: false }) as Record<string, unknown>;
    const payload = JSON.parse(JSON.stringify(status)) as {
      bindings: Array<{ owner_epoch: unknown; topology_generation: unknown }>;
      worktrees: Array<{ owner_epoch: unknown; topology_generation: unknown }>;
    };
    const row = payload.bindings[0];
    expect(row).toBeDefined();
    expect(typeof row.owner_epoch).toBe('string');
    expect(typeof row.topology_generation).toBe('string');
    expect(typeof payload.worktrees[0].owner_epoch).toBe('string');
    expect(typeof payload.worktrees[0].topology_generation).toBe('string');
  }));

  test('writer transfer prepare dry-run and real accept receipts carry string epochs end to end', () => isolated(async () => {
    const { sourceId } = await seedAndClaim();
    const dry = await runPersistenceAdministration(engine, 'writer_transfer_prepare', { source_id: sourceId, dry_run: true }) as Record<string, unknown>;
    expectStringEpochs(dry.binding as { owner_epoch: unknown; topology_generation: unknown });
    expect(() => JSON.stringify(dry)).not.toThrow();

    // Real prepare + accept: successor with matching bytes, the epoch
    // increments and the committed binding comes back through the same
    // casted boundary.
    const successor = join(home, `successor-${randomUUID().slice(0, 8)}`);
    mkdirSync(successor, { recursive: true });
    writeFileSync(join(successor, 'page.md'), 'canonical bytes');
    const prepared = await runPersistenceAdministration(engine, 'writer_transfer_prepare', { source_id: sourceId }) as Record<string, unknown>;
    expect(typeof prepared.owner_epoch).toBe('string');
    const accepted = await runPersistenceAdministration(engine, 'writer_transfer_accept', {
      source_id: sourceId, path: successor, expected_epoch: prepared.owner_epoch as string, manifest: (prepared.manifest as { digest: string }).digest,
    }) as Record<string, unknown>;
    expect(accepted.transferred).toBe(true);
    const acceptedBinding = accepted.binding as { owner_epoch: string; topology_generation: unknown };
    expectStringEpochs(acceptedBinding);
    expect(acceptedBinding.owner_epoch).toBe('2');
    expect(() => JSON.stringify(accepted)).not.toThrow();
  }));
});
