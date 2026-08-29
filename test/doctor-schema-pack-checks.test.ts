/**
 * schema_pack_consistency + schema_pack_source_drift doctor checks
 * (src/commands/doctor/schema-pack-checks.ts).
 *
 * Pins:
 *   - consistency picks the WORST source by untyped percentage;
 *   - warn fires at >= 10% (exactly 10.0% warns), stays ok at 9.9%;
 *   - empty brain -> ok / N-A;
 *   - engine.executeRaw throwing -> check stays OK (fail-open, "Skipped: ...");
 *   - soft-deleted pages are excluded (deleted_at IS NULL filter);
 *   - source drift: 0 or same-value schema_pack.source.* config rows -> ok,
 *     2 distinct values -> warn naming the distinct-pack count.
 *
 * Reality note vs the plan: pages.type is TEXT NOT NULL in the shipped
 * schema (src/core/pglite-schema.ts), so the check's `type IS NULL` arm is
 * only reachable on legacy schemas. `type = ''` is the practical untyped
 * marker and is what these fixtures use.
 */
import { describe, expect, test, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import {
  checkSchemaPackConsistency,
  checkSchemaPackSourceDrift,
} from '../src/commands/doctor/schema-pack-checks.ts';
import type { BrainEngine } from '../src/core/engine.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

/** Register a source row (pages.source_id has an FK to sources.id). */
async function addSource(id: string): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING`,
    [id],
  );
}

/**
 * Seed `total` pages into `sourceId`, of which the first `untyped` carry
 * type = '' (untyped per the check's FILTER) and the rest type = 'note'.
 */
async function seedPages(sourceId: string, untyped: number, total: number): Promise<void> {
  await addSource(sourceId);
  await engine.executeRaw(
    `INSERT INTO pages (slug, source_id, type, title)
     SELECT $1::text || '-p' || n::text,
            $1::text,
            CASE WHEN n <= $2::int THEN '' ELSE 'note' END,
            'title ' || n::text
     FROM generate_series(1, $3::int) AS n`,
    [sourceId, untyped, total],
  );
}

/** Minimal engine stub whose executeRaw always throws. */
const throwingEngine = {
  executeRaw: async () => {
    throw new Error('boom-executeRaw');
  },
} as unknown as BrainEngine;

describe('schema_pack_consistency', () => {
  test('no pages in any source -> ok / N-A', async () => {
    const check = await checkSchemaPackConsistency(engine);
    expect(check.name).toBe('schema_pack_consistency');
    expect(check.status).toBe('ok');
    expect(check.message).toContain('No pages in any source — schema consistency N/A.');
  });

  test('all pages typed -> ok, all-match message', async () => {
    await seedPages('src-clean', 0, 10);
    const check = await checkSchemaPackConsistency(engine);
    expect(check.status).toBe('ok');
    expect(check.message).toBe('All pages match the active schema pack across every source.');
  });

  test('exactly 10% untyped -> warn (boundary is >=, not >)', async () => {
    await seedPages('src-x', 1, 10); // 1/10 = 10.0%
    const check = await checkSchemaPackConsistency(engine);
    expect(check.status).toBe('warn');
    expect(check.message).toContain('Source `src-x`: 1 of 10 pages (10.0%)');
    expect(check.message).toContain('gbrain schema detect --source src-x');
  });

  test('9.9% untyped -> stays ok, names the worst source and the threshold', async () => {
    await seedPages('src-y', 99, 1000); // 99/1000 = 9.9%
    const check = await checkSchemaPackConsistency(engine);
    expect(check.status).toBe('ok');
    expect(check.message).toBe(
      '9.9% untyped at worst (source `src-y`) — under the 10% warn threshold.',
    );
  });

  test('picks the WORST source across a multi-source brain', async () => {
    await seedPages('src-low', 1, 10); // 10.0% — over threshold, but not the worst
    await seedPages('src-high', 5, 10); // 50.0% — the worst
    const check = await checkSchemaPackConsistency(engine);
    expect(check.status).toBe('warn');
    // The message must attribute the warn to the WORST source, not the first.
    expect(check.message).toContain('Source `src-high`: 5 of 10 pages (50.0%)');
    expect(check.message).not.toContain('src-low');
  });

  test('soft-deleted pages are excluded from the percentage', async () => {
    await seedPages('src-del', 5, 10); // 50% untyped...
    await engine.executeRaw(
      `UPDATE pages SET deleted_at = now() WHERE source_id = 'src-del' AND type = ''`,
    ); // ...but every untyped page is soft-deleted
    const check = await checkSchemaPackConsistency(engine);
    expect(check.status).toBe('ok');
    expect(check.message).toBe('All pages match the active schema pack across every source.');
  });

  test('engine.executeRaw throwing -> check stays ok (fail-open), never throws', async () => {
    const check = await checkSchemaPackConsistency(throwingEngine);
    expect(check.name).toBe('schema_pack_consistency');
    expect(check.status).toBe('ok'); // pinned: fail-open, NOT warn/fail
    expect(check.message).toBe('Skipped: boom-executeRaw');
  });
});

describe('schema_pack_source_drift', () => {
  test('no per-source overrides -> ok / N-A', async () => {
    const check = await checkSchemaPackSourceDrift(engine);
    expect(check.name).toBe('schema_pack_source_drift');
    expect(check.status).toBe('ok');
    expect(check.message).toBe('No per-source pack overrides — drift N/A.');
  });

  test('one override row -> ok (single pack, no drift possible)', async () => {
    await engine.setConfig('schema_pack.source.alpha', 'pack-one');
    const check = await checkSchemaPackSourceDrift(engine);
    expect(check.status).toBe('ok');
    expect(check.message).toBe('1 per-source overrides; all point at the same pack.');
  });

  test('two overrides pointing at the SAME pack -> ok', async () => {
    await engine.setConfig('schema_pack.source.alpha', 'pack-one');
    await engine.setConfig('schema_pack.source.beta', 'pack-one');
    const check = await checkSchemaPackSourceDrift(engine);
    expect(check.status).toBe('ok');
    expect(check.message).toBe('2 per-source overrides; all point at the same pack.');
  });

  test('two DISTINCT packs -> warn naming the distinct count and row count', async () => {
    await engine.setConfig('schema_pack.source.alpha', 'pack-one');
    await engine.setConfig('schema_pack.source.beta', 'pack-two');
    const check = await checkSchemaPackSourceDrift(engine);
    expect(check.status).toBe('warn');
    expect(check.message).toContain(
      'Per-source pack divergence detected: 2 distinct packs across 2 sources.',
    );
    expect(check.message).toContain('gbrain sources list');
  });

  test('engine.executeRaw throwing -> check stays ok (fail-open), never throws', async () => {
    const check = await checkSchemaPackSourceDrift(throwingEngine);
    expect(check.status).toBe('ok'); // pinned: fail-open, NOT warn/fail
    expect(check.message).toBe('Skipped: boom-executeRaw');
  });
});
