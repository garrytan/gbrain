/**
 * embeddings doctor check reports the embedding backlog (Foundations 1, F4d).
 *
 * Protects: when chunks lack embeddings, the `embeddings` check names the
 * backlog count and the command that finishes it (`gbrain embed --stale
 * --catch-up`), says it makes paid calls, and carries the same facts in
 * `details` for agents. A clean brain keeps the golden-pinned message.
 * Fails when: the check goes back to recommending a plain `embed --stale`,
 * which stops after its 30-minute budget and on a 52k-document brain left
 * 51,910 chunks behind without saying so.
 * Why new: no test exercised the embeddings check's messages; the doctor
 * goldens only pin the fully embedded case.
 * A keyless brain reports "not applicable" instead of a paid fix.
 * Seam: none (a stub engine answering getHealth and getConfig).
 *
 * Backlog age (E-B): a large backlog (over 1,000 chunks or 1%) warns only when
 * its oldest pending chunk has waited longer than EMBEDDING_BACKLOG_MAX_AGE_S,
 * read from content_chunks.embedding_pending_since, never created_at.
 * Fails when: the check ages the backlog from created_at (an edited old page
 * or a model swap reads as a months-old backlog and asks for paid spend on a
 * brain draining normally), or goes back to "ok at >= 90% coverage whatever
 * the backlog" (forced probe: 136,314 chunks missing at 90% read ok on master).
 * The stub probes answer the age query through executeRaw; the PGLite probes
 * run the real write paths that set and clear the column.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { EMBEDDING_BACKLOG_MAX_AGE_S, embeddingsEntry } from '../src/commands/doctor/checks/schema-health.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import type { Check } from '../src/commands/doctor.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { invalidateStaleSignatureEmbeddingsGuarded } from '../src/core/embedding-invalidation.ts';
import { runSchemaTransition } from '../src/core/embedding-migration.ts';
import { runMigrations } from '../src/core/migrate.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';

async function runCheck(ctx: DoctorContext): Promise<Check[]> {
  return await embeddingsEntry.run(ctx) as Check[];
}

function ctxFor(coverage: number, missing: number, config: Record<string, string> = {}, age?: PendingAge): DoctorContext {
  const engine = {
    getHealth: async () => ({ embed_coverage: coverage, missing_embeddings: missing }),
    getConfig: async (key: string) => config[key] ?? null,
    ...(age ? {
      executeRaw: async (sql: string) => sql.includes('embedding_pending_since')
        ? [{ age_s: age.ageS, unaged: age.unaged ?? 0, backfilled: age.backfilled ?? false }]
        : [],
    } : {}),
  };
  return { engine, progress: { heartbeat() {} } } as unknown as DoctorContext;
}

/** What the age query answers: the oldest pending chunk's wait, unstamped pending rows, backfill label. */
interface PendingAge { ageS: number | null; unaged?: number; backfilled?: boolean }

const HOUR = 3600;
const DAY = 24 * HOUR;

describe('embeddings doctor check: backlog', () => {
  test('a large backlog warns with the count and the catch-up command', async () => {
    const [check] = await runCheck(ctxFor(0.002, 51_910));
    expect(check.status).toBe('warn');
    expect(check.message).toContain('Backlog: 51910 chunk(s) without embeddings');
    expect(check.message).toContain('Fix: gbrain embed --stale --catch-up');
    expect(check.message).toContain('paid embedding calls');
    expect(check.details).toMatchObject({ code: 'embedding_backlog', backlog: 51_910, fix: 'gbrain embed --stale --catch-up' });
  });

  test('a brain with no embeddings yet names the backlog too', async () => {
    const [check] = await runCheck(ctxFor(0, 1200));
    expect(check.status).toBe('warn');
    expect(check.message).toContain('Backlog: 1200 chunk(s)');
  });

  test('a mostly embedded brain stays ok but still reports its backlog', async () => {
    const [check] = await runCheck(ctxFor(0.95, 2600));
    expect(check.status).toBe('ok');
    expect(check.message).toContain('Backlog: 2600 chunk(s)');
    expect(check.details).toMatchObject({ backlog: 2600 });
  });

  test('a keyless brain is not applicable, never told to make paid calls', async () => {
    const [check] = await runCheck(ctxFor(0, 200, { embedding_disabled: 'true' }));
    expect(check.status).toBe('ok');
    expect(check.message).toContain('Not applicable: embeddings are disabled');
    expect(check.message).not.toContain('catch-up');
  });

  test('a fully embedded brain keeps its message and carries no backlog', async () => {
    const [check] = await runCheck(ctxFor(1, 0));
    expect(check).toEqual({ name: 'embeddings', status: 'ok', message: '100% coverage, 0 missing',
      details: { backlog: 0, oldest_pending_age_s: null, age_threshold_s: EMBEDDING_BACKLOG_MAX_AGE_S } });
  });
});

describe('embeddings doctor check: backlog age', () => {
  test('95% coverage with 50k missing and an old pending chunk warns, with backlog and age in details', async () => {
    const [check] = await runCheck(ctxFor(0.95, 50_000, {}, { ageS: 3 * DAY }));
    expect(check.status).toBe('warn');
    expect(check.message).toContain('Backlog: 50000 chunk(s) without embeddings');
    expect(check.message).toContain('Oldest pending chunk has waited 3d');
    expect(check.details).toMatchObject({ code: 'embedding_backlog', backlog: 50_000, oldest_pending_age_s: 3 * DAY,
      age_threshold_s: EMBEDDING_BACKLOG_MAX_AGE_S, fix: 'gbrain embed --stale --catch-up' });
    expect(check.fix?.consent).toEqual(['paid']);
    expect(check.fix?.argv).toEqual(['gbrain', 'embed', '--stale', '--catch-up', '--yes']);
  });

  test('forced probe: 136,314 chunks missing at 90% coverage for days warns (ok on master)', async () => {
    const [check] = await runCheck(ctxFor(0.9, 136_314, {}, { ageS: 9 * DAY }));
    expect(check.status).toBe('warn');
    expect(check.details).toMatchObject({ backlog: 136_314, oldest_pending_age_s: 9 * DAY });
  });

  test('the audited production shape (89%, 136,314 missing, days old) warns', async () => {
    const [check] = await runCheck(ctxFor(0.893, 136_314, {}, { ageS: 9 * DAY }));
    expect(check.status).toBe('warn');
  });

  test('a fresh brain mid-drain stays ok and still reports backlog, age and threshold', async () => {
    const [check] = await runCheck(ctxFor(0.5, 40_000, {}, { ageS: 2 * HOUR }));
    expect(check.status).toBe('ok');
    expect(check.message).toContain('Backlog: 40000 chunk(s)');
    expect(check.details).toMatchObject({ backlog: 40_000, oldest_pending_age_s: 2 * HOUR, age_threshold_s: EMBEDDING_BACKLOG_MAX_AGE_S });
    expect(check.fix?.consent).toEqual(['paid']);
  });

  test('an old backlog under both size floors stays ok', async () => {
    const [check] = await runCheck(ctxFor(0.9995, 500, {}, { ageS: 30 * DAY }));
    expect(check.status).toBe('ok');
    expect(check.details).toMatchObject({ backlog: 500, oldest_pending_age_s: 30 * DAY });
  });

  test('a small brain mostly missing for days warns on the 1% floor', async () => {
    const [check] = await runCheck(ctxFor(0.2, 400, {}, { ageS: 2 * DAY }));
    expect(check.status).toBe('warn');
  });

  test('an age backfilled from created_at is labelled as such', async () => {
    const [check] = await runCheck(ctxFor(0.95, 50_000, {}, { ageS: 40 * DAY, backfilled: true }));
    expect(check.status).toBe('warn');
    expect(check.details).toMatchObject({ age_source: 'created_at_backfill' });
    expect(check.message).toContain('backfilled from its creation time');
  });

  test('pending chunks without a stamp leave the age unknown and the coverage rule decides', async () => {
    const low = (await runCheck(ctxFor(0.5, 40_000, {}, { ageS: 2 * HOUR, unaged: 3 })))[0];
    expect(low.status).toBe('warn');
    expect(low.details).toMatchObject({ backlog: 40_000, oldest_pending_age_s: null, age_threshold_s: EMBEDDING_BACKLOG_MAX_AGE_S });
    const high = (await runCheck(ctxFor(0.95, 50_000, {}, { ageS: null })))[0];
    expect(high.status).toBe('ok');
  });

  test('a keyless brain is info even with an old backlog', async () => {
    const [check] = await runCheck(ctxFor(0, 50_000, { embedding_disabled: 'true' }, { ageS: 90 * DAY }));
    expect(check.status).toBe('ok');
    expect(check.severity).toBe('info');
    expect(check.readiness_state).toBe('disabled_by_choice');
    expect(check.fix?.consent ?? []).not.toContain('paid');
  });
});

describe('embeddings doctor check: pending age on a real brain [pglite]', () => {
  let engine: PGLiteEngine;
  let dims = 0;
  const MODEL = 'openai:text-embedding-3-large';

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 60_000);

  afterAll(async () => {
    await engine.disconnect();
  });

  beforeEach(async () => {
    await resetPgliteState(engine);
    const rows = await engine.executeRaw<{ dim: number }>(
      `SELECT atttypmod AS dim FROM pg_attribute WHERE attrelid = 'content_chunks'::regclass AND attname = 'embedding' AND attnum > 0`);
    dims = Number(rows[0]?.dim);
  });

  const doctor = async () => (await runCheck({ engine, progress: { heartbeat() {} } } as unknown as DoctorContext))[0];
  const vector = () => { const v = new Float32Array(dims); v[0] = 1; return v; };

  /** One sealed page per slug, its chunk embedded through the real upsert, created 90 days ago. */
  async function seedEmbeddedPages(slugs: string[]): Promise<void> {
    for (const slug of slugs) {
      await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `# ${slug}` });
      await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_text: `${slug} body`, chunk_source: 'compiled_truth', model: MODEL }]);
      await engine.upsertChunks(slug, [{ chunk_index: 0, chunk_text: `${slug} body`, chunk_source: 'compiled_truth', embedding: vector(), model: MODEL }]);
    }
    await engine.executeRaw(`UPDATE content_chunks SET created_at = now() - interval '90 days'`);
  }

  test('an embedded chunk carries no pending stamp; a fresh insert without a vector does', async () => {
    await seedEmbeddedPages(['notes/embedded-alice-example']);
    await engine.putPage('notes/fresh-alice-example', { type: 'note', title: 'fresh', compiled_truth: '# fresh' });
    await installFixtureChunks(engine, 'notes/fresh-alice-example', [{ chunk_index: 0, chunk_text: 'fresh body', chunk_source: 'compiled_truth' }]);
    const rows = await engine.executeRaw<{ slug: string; pending: boolean }>(
      `SELECT p.slug, cc.embedding_pending_since IS NOT NULL AS pending FROM content_chunks cc JOIN pages p ON p.id = cc.page_id ORDER BY p.slug`);
    expect(rows.map(r => [r.slug, r.pending])).toEqual([['notes/embedded-alice-example', false], ['notes/fresh-alice-example', true]]);
  });

  test('a fresh brain mid-drain stays ok', async () => {
    for (const slug of ['notes/a-alice-example', 'notes/b-alice-example', 'notes/c-alice-example']) {
      await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `# ${slug}` });
      await installFixtureChunks(engine, slug, [{ chunk_index: 0, chunk_text: `${slug} body`, chunk_source: 'compiled_truth' }]);
    }
    await engine.upsertChunks('notes/a-alice-example', [{ chunk_index: 0, chunk_text: 'notes/a-alice-example body', chunk_source: 'compiled_truth', embedding: vector(), model: MODEL }]);
    const check = await doctor();
    expect(check.status).toBe('ok');
    expect(check.details).toMatchObject({ backlog: 2, age_threshold_s: EMBEDDING_BACKLOG_MAX_AGE_S });
    expect((check.details as { oldest_pending_age_s: number }).oldest_pending_age_s).toBeLessThan(HOUR);
  });

  test('an edited old page stays ok: its wait starts when the edit cleared the vector, not at created_at', async () => {
    await seedEmbeddedPages(['notes/edited-alice-example']);
    expect((await doctor()).details).toMatchObject({ backlog: 0 });
    await engine.upsertChunks('notes/edited-alice-example', [{ chunk_index: 0, chunk_text: 'edited body', chunk_source: 'compiled_truth' }]);
    const check = await doctor();
    expect(check.status).toBe('ok');
    expect(check.details).toMatchObject({ backlog: 1 });
    expect((check.details as { oldest_pending_age_s: number }).oldest_pending_age_s).toBeLessThan(HOUR);
    await engine.executeRaw(`UPDATE content_chunks SET embedding_pending_since = now() - interval '2 days'`);
    expect((await doctor()).status).toBe('warn');
  });

  test('a model-swap invalidation actively draining stays ok', async () => {
    await seedEmbeddedPages(['notes/swap-a-alice-example', 'notes/swap-b-alice-example']);
    const invalidated = await invalidateStaleSignatureEmbeddingsGuarded(engine, { signature: `voyage:voyage-4:${dims}`, includeNullSignature: true });
    expect(invalidated).toBe(2);
    let check = await doctor();
    expect(check.status).toBe('ok');
    expect(check.details).toMatchObject({ backlog: 2 });
    expect((check.details as { oldest_pending_age_s: number }).oldest_pending_age_s).toBeLessThan(HOUR);
    await engine.upsertChunks('notes/swap-a-alice-example', [{ chunk_index: 0, chunk_text: 'notes/swap-a-alice-example body', chunk_source: 'compiled_truth', embedding: vector(), model: MODEL }]);
    check = await doctor();
    expect(check.status).toBe('ok');
    expect(check.details).toMatchObject({ backlog: 1 });
  });

  test('the migration backfills chunks already missing a vector to created_at once, and doctor labels that age', async () => {
    await seedEmbeddedPages(['notes/backfill-embedded-alice-example']);
    await engine.putPage('notes/backfill-pending-alice-example', { type: 'note', title: 'pending', compiled_truth: '# pending' });
    await installFixtureChunks(engine, 'notes/backfill-pending-alice-example', [{ chunk_index: 0, chunk_text: 'pending body', chunk_source: 'compiled_truth' }]);
    await engine.executeRaw(`UPDATE content_chunks SET embedding_pending_since = NULL, created_at = now() - interval '40 days'`);
    await engine.executeRaw(`DELETE FROM config WHERE key = 'embedding_pending_since_backfilled_at'`);
    await engine.setConfig('version', '219');
    await runMigrations(engine);
    const rows = await engine.executeRaw<{ slug: string; backfilled: boolean | null }>(
      `SELECT p.slug, cc.embedding_pending_since = cc.created_at AS backfilled FROM content_chunks cc JOIN pages p ON p.id = cc.page_id ORDER BY p.slug`);
    expect(rows.map(r => [r.slug, r.backfilled])).toEqual([['notes/backfill-embedded-alice-example', null], ['notes/backfill-pending-alice-example', true]]);
    const stamp = await engine.getConfig('embedding_pending_since_backfilled_at');
    expect(stamp).not.toBeNull();
    const check = await doctor();
    expect(check.status).toBe('warn');
    expect(check.details).toMatchObject({ backlog: 1, age_source: 'created_at_backfill' });
    await engine.setConfig('version', '219');
    await runMigrations(engine);
    expect(await engine.getConfig('embedding_pending_since_backfilled_at')).toBe(stamp);
  });

  test('a column rebuild stamps every chunk it emptied, keeping an older pending stamp', async () => {
    await seedEmbeddedPages(['notes/rebuilt-alice-example']);
    await engine.putPage('notes/waiting-alice-example', { type: 'note', title: 'waiting', compiled_truth: '# waiting' });
    await installFixtureChunks(engine, 'notes/waiting-alice-example', [{ chunk_index: 0, chunk_text: 'waiting body', chunk_source: 'compiled_truth' }]);
    await engine.executeRaw(`UPDATE content_chunks SET embedding_pending_since = now() - interval '3 days' WHERE embedding IS NULL`);
    await runSchemaTransition(engine, dims === 512 ? 256 : 512);
    const rows = await engine.executeRaw<{ slug: string; waited_s: number; stamped_at_null: boolean }>(
      `SELECT p.slug, EXTRACT(EPOCH FROM now() - cc.embedding_pending_since)::float8 AS waited_s,
              cc.embedded_at IS NULL AS stamped_at_null
         FROM content_chunks cc JOIN pages p ON p.id = cc.page_id ORDER BY p.slug`);
    expect(rows.map(r => r.slug)).toEqual(['notes/rebuilt-alice-example', 'notes/waiting-alice-example']);
    expect(rows.every(r => r.stamped_at_null)).toBe(true);
    expect(Number(rows[0].waited_s)).toBeLessThan(HOUR);
    expect(Number(rows[1].waited_s)).toBeGreaterThan(2 * DAY);
  });
});
