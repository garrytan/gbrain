/**
 * Local federated read fan-out — E2E regression (PGLite in-memory).
 *
 * Scenario 1 of docs/guides/multi-source-brains.md ("Unified knowledge
 * recall") promises that federated sources participate in cross-source
 * default search. Pre-fix, only OAuth clients with federated_read got the
 * sourceIds[] path; every local transport (CLI, gbrain call, stdio MCP)
 * pinned reads to the scalar active source.
 *
 * This file pins the new behavior end-to-end at the op-handler layer:
 *   - fan-out spans federated sources and NEVER leaks isolated ones
 *   - an isolated active source keeps its scalar scope
 *   - explicit per-call source_id pins (even into isolated sources)
 *   - writes stay scalar under an expanded read scope
 *   - auth grants always beat the local array; [] never widens
 *   - archived federated sources are excluded from the union
 *   - code traversal + chronicle_backfill keep single-source behavior
 *
 * Mold: test/e2e/source-isolation-pglite.test.ts (PGLite, no DATABASE_URL).
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { resolveLocalFederatedReadScope } from '../../src/core/sources-load.ts';
import {
  operations,
  resolveRequestedScope,
  type OperationContext,
} from '../../src/core/operations.ts';

let engine: PGLiteEngine;

// Hermeticity: on dev machines with a real ~/.gbrain/config.json + API keys,
// the search op's gateway probes would otherwise make REAL network calls
// (slow, nondeterministic, and >5s-per-test on cold environments). Point
// GBRAIN_HOME at an empty tempdir and clear provider keys so every search
// path resolves keyword-only and deterministic. E2E files run in their own
// process (run-e2e.sh is sequential), so env mutation here cannot leak into
// parallel unit shards.
const SAVED_ENV: Record<string, string | undefined> = {};
const ENV_KEYS = ['GBRAIN_HOME', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'VOYAGE_API_KEY', 'ZEROENTROPY_API_KEY'];

beforeAll(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  for (const k of ENV_KEYS) SAVED_ENV[k] = process.env[k];
  process.env.GBRAIN_HOME = mkdtempSync(join(tmpdir(), 'gbrain-fed-e2e-'));
  delete process.env.OPENAI_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.VOYAGE_API_KEY;
  delete process.env.ZEROENTROPY_API_KEY;
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
  for (const k of ENV_KEYS) {
    if (SAVED_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = SAVED_ENV[k];
  }
});

async function seedPage(sourceId: string, slug: string, type: string, title: string, text: string) {
  await engine.putPage(slug, {
    type,
    title,
    compiled_truth: text,
    timeline: '',
    frontmatter: {},
  }, { sourceId });
  await engine.upsertChunks(slug, [{
    chunk_index: 0,
    chunk_text: text,
    chunk_source: 'compiled_truth',
    token_count: 12,
  }], { sourceId });
}

beforeEach(async () => {
  await resetPgliteState(engine);
  // 'default' is re-seeded federated by resetPgliteState. Add: two federated
  // peers, one isolated, one ARCHIVED federated (must stay out of the union).
  await engine.executeRaw(
    `INSERT INTO sources (id, name, config) VALUES
       ('fed-a', 'fed-a', '{"federated": true}'::jsonb),
       ('fed-b', 'fed-b', '{"federated": true}'::jsonb),
       ('iso-c', 'iso-c', '{}'::jsonb)
     ON CONFLICT DO NOTHING`,
  );
  await engine.executeRaw(
    `INSERT INTO sources (id, name, config, archived) VALUES
       ('arch-d', 'arch-d', '{"federated": true}'::jsonb, true)
     ON CONFLICT DO NOTHING`,
  );

  await seedPage('fed-a', 'notes/apollo', 'note', 'Apollo (fed-a)', 'apollo widgets live here. sharedctx marker.');
  await seedPage('fed-b', 'notes/boreas', 'note', 'Boreas (fed-b)', 'boreas gadgets live here. sharedctx marker.');
  await seedPage('iso-c', 'notes/chronos', 'note', 'Chronos (iso-c)', 'chronos trinkets live here. sharedctx marker.');
  await seedPage('arch-d', 'notes/daphne', 'note', 'Daphne (arch-d)', 'daphne relics live here. sharedctx marker.');

  // Same slug in a federated AND an isolated source — explicit-pin case.
  await seedPage('fed-a', 'notes/omni', 'note', 'Omni federated copy', 'omni federated body.');
  await seedPage('iso-c', 'notes/omni', 'note', 'Omni isolated copy', 'omni isolated body.');

  // chronicle_backfill enumeration targets (type=meeting).
  await seedPage('fed-a', 'meetings/2026-01-01-sync', 'meeting', 'Sync A', 'meeting notes a.');
  await seedPage('fed-b', 'meetings/2026-01-02-sync', 'meeting', 'Sync B', 'meeting notes b.');
});

function localCtx(partial: Partial<OperationContext> = {}): OperationContext {
  return {
    engine,
    config: { engine: 'pglite' as const },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote: false,
    sourceId: 'fed-a',
    ...partial,
  } as OperationContext;
}

function op(name: string) {
  const found = operations.find(o => o.name === name);
  expect(found).toBeDefined();
  return found!;
}

describe('resolveLocalFederatedReadScope against a real engine', () => {
  test('federated active source → union of federated, excluding isolated + archived', async () => {
    const ids = await resolveLocalFederatedReadScope(engine, 'fed-a');
    expect(ids).toBeDefined();
    expect(ids!.sort()).toEqual(['default', 'fed-a', 'fed-b']);
  });

  test('isolated active source → undefined (scalar pin preserved)', async () => {
    expect(await resolveLocalFederatedReadScope(engine, 'iso-c')).toBeUndefined();
  });

  test('archived active source → undefined even though federated', async () => {
    expect(await resolveLocalFederatedReadScope(engine, 'arch-d')).toBeUndefined();
  });
});

describe('local federated read fan-out at the op-handler layer', () => {
  test('search with expanded ctx spans federated sources and hides isolated + archived', async () => {
    const sourceIds = await resolveLocalFederatedReadScope(engine, 'fed-a');
    const ctx = localCtx({ sourceIds });
    const rows = (await op('search').handler(ctx, { query: 'sharedctx' })) as Array<{ source_id?: string; slug: string }>;
    const sources = new Set(rows.map(r => r.source_id));
    expect(sources.has('fed-a')).toBe(true);
    expect(sources.has('fed-b')).toBe(true);
    expect(sources.has('iso-c')).toBe(false);
    expect(sources.has('arch-d')).toBe(false);
  });

  test('isolated active source keeps its scalar scope', async () => {
    // Transport contract: helper returned undefined, so ctx has no sourceIds.
    const ctx = localCtx({ sourceId: 'iso-c' });
    const rows = (await op('search').handler(ctx, { query: 'sharedctx' })) as Array<{ source_id?: string }>;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.source_id).toBe('iso-c');
  });

  test('explicit --source pins to the named source (isolated stays reachable)', async () => {
    // Transport contract: an explicit --source never calls the fan-out
    // resolver, so ctx carries ONLY the scalar. get_page then reads the
    // isolated copy even though a federated sibling shares the slug.
    const ctx = localCtx({ sourceId: 'iso-c' });
    const page = (await op('get_page').handler(ctx, { slug: 'notes/omni' })) as { title?: string };
    expect(page?.title).toBe('Omni isolated copy');
  });

  test('get_page without per-call source resolves within the federated union', async () => {
    const sourceIds = await resolveLocalFederatedReadScope(engine, 'fed-a');
    const ctx = localCtx({ sourceIds });
    const page = (await op('get_page').handler(ctx, { slug: 'notes/omni' })) as { title?: string };
    expect(page?.title).toBe('Omni federated copy');
  });

  test('writes stay scalar: add_tag under expanded ctx lands only on the active source', async () => {
    const sourceIds = await resolveLocalFederatedReadScope(engine, 'fed-a');
    const ctx = localCtx({ sourceIds });
    // notes/apollo exists in fed-a; a same-named slug is NOT in fed-b, so
    // assert via SQL that the tag row binds to fed-a's page only.
    await op('add_tag').handler(ctx, { slug: 'notes/apollo', tag: 'fanout-proof' });
    const rows = await engine.executeRaw<{ source_id: string }>(
      `SELECT p.source_id FROM pages p
        JOIN tags t ON t.page_id = p.id
       WHERE t.tag = $1`,
      ['fanout-proof'],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].source_id).toBe('fed-a');
  });

  test('auth.allowedSources always beats the local array', async () => {
    const ctx = localCtx({
      remote: true,
      sourceIds: ['default', 'fed-a', 'fed-b'],
      auth: {
        token: 't', clientId: 'c', scopes: ['read'],
        sourceId: 'fed-b', allowedSources: ['fed-b'],
      } as OperationContext['auth'],
    });
    const rows = (await op('search').handler(ctx, { query: 'sharedctx' })) as Array<{ source_id?: string }>;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.source_id).toBe('fed-b');
  });

  test('empty ctx.sourceIds never widens — scalar wins', async () => {
    const ctx = localCtx({ sourceIds: [] });
    const rows = (await op('search').handler(ctx, { query: 'sharedctx' })) as Array<{ source_id?: string }>;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.source_id).toBe('fed-a');
  });

  test('code traversal does not throw under an expanded local scope (CLI and stdio shapes)', async () => {
    const sourceIds = await resolveLocalFederatedReadScope(engine, 'fed-a');
    const cli = localCtx({ sourceIds });
    const stdio = localCtx({ sourceIds, remote: true });
    // Pre-fix, resolveCodeIntelScope threw invalid_params on multi-element
    // sourceIds. Empty result is fine; throwing is the regression.
    const a = (await op('code_callers').handler(cli, { symbol: 'nonexistentFn' })) as unknown;
    const b = (await op('code_callers').handler(stdio, { symbol: 'nonexistentFn' })) as unknown;
    expect(a).toBeDefined();
    expect(b).toBeDefined();
  });

  test('chronicle_backfill enumerates only the active scalar source under expanded ctx', async () => {
    const sourceIds = await resolveLocalFederatedReadScope(engine, 'fed-a');
    const ctx = localCtx({ sourceIds });
    const result = (await op('chronicle_backfill').handler(ctx, { dry_run: true })) as { scanned: number };
    // fed-a has exactly one page of the swept types (meetings/2026-01-01-sync);
    // fed-b's meeting must NOT be scanned even though it is in read scope.
    expect(result.scanned).toBe(1);
  });
});

describe('cycle → patterns home-source threading (Q3-3 pin)', () => {
  test('runCycle threads the cycle source into the patterns gate', async () => {
    // If the `sourceId: cycleSourceId` line in runCycle's patterns call site
    // is ever lost, patterns would treat undefined as 'default' and silently
    // skip forever on any brain with home_source != default. Differential
    // pin: home=fed-a + cycle for fed-a → the phase must NOT skip as
    // not_home_source (it may skip for other reasons — disabled corpus,
    // insufficient evidence); home=fed-a + cycle for fed-b → MUST skip as
    // not_home_source.
    await engine.setConfig('dream.home_source', 'fed-a');
    const { runCycle } = await import('../../src/core/cycle.ts');
    try {
      const own = await runCycle(engine, { brainDir: '/tmp/nonexistent', phases: ['patterns'], sourceId: 'fed-a' } as never);
      const ownPhase = own.phases.find((p: { phase: string }) => p.phase === 'patterns');
      expect((ownPhase?.details as { reason?: string } | undefined)?.reason).not.toBe('not_home_source');

      const foreign = await runCycle(engine, { brainDir: '/tmp/nonexistent', phases: ['patterns'], sourceId: 'fed-b' } as never);
      const foreignPhase = foreign.phases.find((p: { phase: string }) => p.phase === 'patterns');
      expect((foreignPhase?.details as { reason?: string } | undefined)?.reason).toBe('not_home_source');
    } finally {
      await engine.unsetConfig('dream.home_source');
    }
  });
});

describe('pure scope-resolution invariants', () => {
  test('explicit source_id param pins regardless of ctx.sourceIds', () => {
    const ctx = localCtx({ sourceIds: ['default', 'fed-a', 'fed-b'] });
    expect(resolveRequestedScope(ctx, 'iso-c', false)).toEqual({ sourceId: 'iso-c' });
  });

  test('__all__ for a trusted local caller spans the whole brain (isolated included)', () => {
    const ctx = localCtx({ sourceIds: ['default', 'fed-a', 'fed-b'] });
    expect(resolveRequestedScope(ctx, '__all__', false)).toEqual({});
    expect(resolveRequestedScope(ctx, undefined, true)).toEqual({});
  });
});
