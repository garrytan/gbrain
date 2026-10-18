/**
 * Doctor `embedding_state` (#6696 B3): statuses per condition, tier mapping
 * (ops -> index-backed counts, unknown without a covering index; any other or
 * undefined tier -> exact), and no double warning on what `embeddings` and
 * `quarantined_pages` already own.
 *
 * Protects: the BRAIN check an operator and lane B's ops tier read. Regression:
 * warning on the pending backlog (double warn), warning on embed_skip by design,
 * or scanning on the ops tier. PGLite in-memory ($0).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { embeddingStateEntry } from '../src/commands/doctor/checks/embedding-state.ts';
import { categorizeCheck } from '../src/core/doctor-categories.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';

let engine: PGLiteEngine;

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
  await engine.unsetConfig('search_embedding_column');
  await engine.unsetConfig('embedding_columns');
  await engine.unsetConfig('embedding_disabled');
});

interface Out { name: string; status: string; message: string; severity?: string; readiness_state?: string; details: Record<string, unknown>; fix?: { argv?: string[]; preview_argv?: string[]; verify?: { argv?: string[] } } }

async function run(tier?: 'ops' | 'standard' | 'deep'): Promise<Out> {
  const ctx = { engine, progress: { heartbeat() {} }, ...(tier ? { tier } : {}) } as unknown as DoctorContext;
  const checks = await embeddingStateEntry.run(ctx) as Out[];
  expect(checks).toHaveLength(1);
  return checks[0]!;
}

async function page(slug: string, opts: { body?: string; frontmatter?: Record<string, unknown>; deletedHoursAgo?: number } = {}): Promise<number> {
  await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: opts.body ?? `${slug} body` });
  const [row] = await engine.executeRaw<{ id: number }>(
    `UPDATE pages SET frontmatter = $2::jsonb, deleted_at = CASE WHEN $3::int IS NULL THEN NULL ELSE now() - make_interval(hours => $3::int) END
      WHERE slug = $1 AND source_id = 'default' RETURNING id`, [slug, JSON.stringify(opts.frontmatter ?? {}), opts.deletedHoursAgo ?? null]);
  await engine.executeRaw('DELETE FROM content_chunks WHERE page_id = $1', [row!.id]);
  return row!.id;
}

async function chunk(pageId: number, vector: boolean): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO content_chunks (page_id, chunk_index, chunk_text, embedding, embedding_pending_since)
     VALUES ($1, (SELECT count(*) FROM content_chunks WHERE page_id = $1), 'text', ${vector ? 'array_fill(0.1::real, ARRAY[1536])::vector' : 'NULL'}, ${vector ? 'NULL' : 'now()'})`, [pageId]);
}

describe('doctor embedding_state', () => {
  test('entry contract: BRAIN category, ops tier, not applicable on PGLite ops', () => {
    expect(categorizeCheck('embedding_state')).toBe('brain');
    expect(embeddingStateEntry).toMatchObject({ name: 'embedding_state', emits: ['embedding_state'], tier: 'ops', opsPglite: 'not_applicable' });
  });

  test('ok when every chunk is embedded; an undefined tier counts exactly', async () => {
    await chunk(await page('notes/alice-example'), true);
    const c = await run();
    expect(c).toMatchObject({ name: 'embedding_state', status: 'ok' });
    expect(c.severity).toBeUndefined();
    expect(c.details).toMatchObject({ basis: 'exact', exact: true, mode: 'full', unsearchable: 0 });
  });

  test('a pending backlog and quarantined pages stay ok here (embeddings and quarantined_pages own those warnings)', async () => {
    await chunk(await page('notes/acme-example'), false);
    await page('notes/junk-hidden', { frontmatter: { quarantine: { reason: 'junk_pattern', detail: 'captcha', assessed_at: '2026-01-01T00:00:00Z' } } });
    const c = await run('standard');
    expect(c.status).toBe('ok');
    expect(c.details).toMatchObject({ unsearchable: 2 });
    expect(c.message).toContain("embeddings check's to age and warn on");
    expect(c.message).toContain('quarantined_pages');
  });

  test('keyword_only (embed_skip by design) and deleted chunks inside the purge window are info', async () => {
    await chunk(await page('notes/fund-a-oversized', { frontmatter: { embed_skip: { reason: 'oversized', bytes: 600_000, assessed_at: '2026-01-01T00:00:00Z' } } }), false);
    await chunk(await page('notes/deleted-recent', { deletedHoursAgo: 1 }), true);
    const c = await run('standard');
    expect(c).toMatchObject({ status: 'ok', severity: 'info', readiness_state: 'disabled_by_choice' });
    expect(c.message).toContain('pages unsearchable --state keyword_only');
  });

  test('deleted chunks past the purge window warn and point at pages purge-deleted', async () => {
    await chunk(await page('notes/deleted-old', { deletedHoursAgo: 100 }), true);
    const c = await run('deep');
    expect(c.status).toBe('warn');
    expect(c.details.code).toBe('deleted_page_chunks_overdue');
    expect(c.fix?.argv).toEqual(['gbrain', 'pages', 'purge-deleted', '--yes']);
    expect(c.fix?.preview_argv).toEqual(['gbrain', 'pages', 'purge-deleted', '--dry-run', '--json']);
    expect(c.fix?.verify?.argv).toEqual(['gbrain', 'doctor', '--only', 'embedding_state', '--json']);
  });

  test('a chunkless page with body text warns on a keyed brain and is info on a keyless one', async () => {
    await page('notes/stub-with-body');
    const keyed = await run('standard');
    expect(keyed.status).toBe('warn');
    expect(keyed.details.code).toBe('chunkless_pages_healable');
    expect(keyed.fix?.argv).toEqual(['gbrain', 'embed', '--stale', '--catch-up', '--yes']);
    await engine.setConfig('embedding_disabled', 'true');
    const keyless = await run('standard');
    expect(keyless).toMatchObject({ status: 'ok', severity: 'info', readiness_state: 'disabled_by_choice' });
  });

  test('ops tier: index-backed estimate on the legacy column; unknown (warn, health unknown) without a covering index', async () => {
    await chunk(await page('notes/alice-example'), false);
    const ops = await run('ops');
    expect(ops.status).toBe('ok');
    expect(ops.details).toMatchObject({ basis: 'estimated', exact: false, mode: 'ops', covering_index: 'content_chunks_stale_idx' });
    await engine.executeRaw('ALTER TABLE content_chunks ADD COLUMN IF NOT EXISTS embedding_reg8 vector(8)');
    await engine.setConfig('embedding_columns', JSON.stringify({ embedding_reg8: { provider: 'openai:text-embedding-3-small', dimensions: 8, type: 'vector' } }));
    await engine.setConfig('search_embedding_column', 'embedding_reg8');
    const unknown = await run('ops');
    expect(unknown.status).toBe('warn');
    expect(unknown.details).toMatchObject({ health: 'unknown', exact: false, reason: 'no_covering_index', code: 'embedding_state_unknown', status: 'unknown' });
    expect(unknown.fix?.argv).toEqual(['gbrain', 'doctor', '--only', 'embedding_state', '--json']);
    expect((await run('standard')).details).toMatchObject({ basis: 'exact', active_column: 'embedding_reg8' });
  });
});
