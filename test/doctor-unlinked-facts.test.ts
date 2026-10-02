/**
 * unlinked_facts doctor check (#5836): the unlinked share of active facts and
 * of the last 7 days' new facts, no_subject exclusion, fence-owned rows,
 * origins, 7-day inferred links (both context shapes) and relink links by
 * tier, the thin-client hint, and the degrade path for a brain without
 * fact_relink_attempts.
 *
 * PGLite in-memory ($0).
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { remoteUnlinkedFactsCheck, unlinkedFactsEntry, unlinkedFactsStats, unlinkedFactsVerdict } from '../src/commands/doctor/checks/unlinked-facts.ts';
import { categorizeCheck } from '../src/core/doctor-categories.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';

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

interface Seed { entity?: string | null; source?: string; context?: string | null; daysOld?: number; rowNum?: number | null; mdSlug?: string | null; sourceId?: string; expired?: boolean }

/** Insert `count` facts; returns their ids. */
async function seed(count: number, s: Seed = {}): Promise<number[]> {
  const rows = await engine.executeRaw<{ id: string }>(
    `INSERT INTO facts (source_id, entity_slug, fact, source, context, row_num, source_markdown_slug, created_at, valid_from, expired_at)
     SELECT $1, $2, 'fact ' || g, $3, $4, CASE WHEN $5::int IS NULL THEN NULL ELSE $5::int * 1000 + g END, $6, now() - ($7::int * interval '1 day'), now() - ($7::int * interval '1 day'),
            CASE WHEN $8::boolean THEN now() END
       FROM generate_series(1, $9::int) AS g RETURNING id`,
    [s.sourceId ?? 'default', s.entity === undefined ? 'people/alice-example' : s.entity, s.source ?? 'cli:remember', s.context ?? null,
      s.rowNum ?? null, s.mdSlug ?? null, s.daysOld ?? 0, s.expired === true, count]);
  return rows.map((r) => Number(r.id));
}

async function attempt(ids: number[], outcome: string, tier: string | null = null, daysAgo = 0) {
  for (const id of ids) {
    await engine.executeRaw(
      `INSERT INTO fact_relink_attempts (source_id, fact_id, outcome, tier, attempted_at) VALUES ('default', $1, $2, $3, now() - ($4::int * interval '1 day'))`,
      [id, outcome, tier, daysAgo]);
  }
}

async function check(sourceIds?: string[]) {
  return unlinkedFactsVerdict(await unlinkedFactsStats(engine, sourceIds));
}

describe('unlinked_facts doctor check', () => {
  test('is a brain check and ok on an empty brain', async () => {
    expect(categorizeCheck('unlinked_facts')).toBe('brain');
    const ctx = { engine, orphanRatioSourceId: undefined, progress: { heartbeat() {} } } as unknown as DoctorContext;
    const [c] = await unlinkedFactsEntry.run(ctx) as Array<{ name: string; status: string }>;
    expect(c).toMatchObject({ name: 'unlinked_facts', status: 'ok' });
  });

  test('warns when over 25% of at least 20 new facts are unlinked, with the relink hint', async () => {
    await seed(14);
    await seed(6, { entity: null });
    const c = await check();
    expect(c.status).toBe('warn');
    expect(c.message).toContain('30.0% of 20 new facts unlinked');
    expect(c.message).toContain('gbrain facts relink --dry-run');
    expect((c.details as any).window).toMatchObject({ active: 20, unlinked: 6, capped: false });
  });

  test('ok at exactly 25%, below 20 new facts, and when only old facts are unlinked', async () => {
    await seed(15);
    await seed(5, { entity: null });
    expect((await check()).status).toBe('ok');
    await resetPgliteState(engine);
    await seed(5);
    await seed(10, { entity: null });
    expect((await check()).status).toBe('ok');
    await resetPgliteState(engine);
    await seed(20);
    await seed(30, { entity: null, daysOld: 30 });
    const c = await check();
    expect(c.status).toBe('ok');
    expect((c.details as any).window).toMatchObject({ active: 50, unlinked: 30 });
    expect(c.message).toContain('60.0% of 50 active facts have no entity');
  });

  test('facts judged no_subject are excluded from the 7-day share and counted', async () => {
    await seed(15);
    const unlinked = await seed(10, { entity: null });
    expect((await check()).status).toBe('warn');
    await attempt(unlinked.slice(0, 6), 'no_subject');
    const c = await check();
    expect(c.status).toBe('ok');
    expect((c.details as any).new_7d).toMatchObject({ facts: 25, unlinked: 10, no_subject: 6, eligible: 19, unlinked_eligible: 4 });
    expect((c.details as any).no_subject).toBe(6);
    expect(c.message).toContain('6 judged no_subject');
  });

  test('expired, superseded-by-time and audit rows do not count', async () => {
    await seed(20);
    await seed(10, { entity: null, expired: true });
    await engine.executeRaw(`UPDATE facts SET valid_until = now() - interval '1 hour' WHERE id IN (SELECT id FROM facts WHERE entity_slug IS NOT NULL LIMIT 2)`);
    await seed(10, { entity: null, source: 'cli:extract-conversation-facts:terminal:v2' });
    const s = await unlinkedFactsStats(engine);
    expect(s!.window).toMatchObject({ active: 18, unlinked: 0 });
  });

  test('fence_owned counts unlinked rows with row_num or source_markdown_slug; origins bucket the source', async () => {
    await seed(3, { entity: null, source: 'mcp:put_page', rowNum: 1, mdSlug: 'notes/acme-example' });
    await seed(2, { entity: null, source: 'sync:import', mdSlug: 'notes/acme-example' });
    await seed(1, { entity: null, source: 'hook:writeback' });
    await seed(1, { entity: null, source: 'file_upload' });
    await seed(4, { entity: null, source: 'cli:remember' });
    await seed(5, { source: 'mcp:put_page', rowNum: 2, mdSlug: 'notes/acme-example' });
    const s = await unlinkedFactsStats(engine);
    expect(s!.window).toMatchObject({ active: 16, unlinked: 11, fence_owned: 5 });
    expect(s!.origins).toEqual([{ origin: 'extraction', unlinked: 4 }, { origin: 'remember', unlinked: 4 }, { origin: 'mcp:put_page', unlinked: 3 }]);
  });

  test('7-day inferred links by tier for both context shapes, and relink links by tier', async () => {
    await seed(2, { context: 'entity inferred from page' });
    await seed(3, { context: 'notes/acme-example — entity inferred from mention' });
    await seed(1, { context: 'notes/acme-example — entity inferred from page' });
    await seed(4, { context: 'entity inferred from mention', daysOld: 10 });
    await seed(1, { context: 'notes/acme-example' });
    const linked = await seed(3);
    await attempt(linked.slice(0, 2), 'linked', 'page');
    await attempt(linked.slice(2), 'linked', 'model');
    const old = await seed(1);
    await attempt(old, 'linked', 'page', 9);
    const s = await unlinkedFactsStats(engine);
    expect(s!.inferred_7d).toEqual({ page: 3, mention: 3 });
    expect(s!.relinked_7d).toEqual({ page: 2, model: 1 });
    const c = unlinkedFactsVerdict(s);
    expect(c.message).toContain('7-day links: inferred page 3, mention 3; relink page 2, model 1');
  });

  test('scopes to the requested sources', async () => {
    await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('other', 'other') ON CONFLICT DO NOTHING`);
    await seed(20, { entity: null, sourceId: 'other' });
    await seed(20);
    expect((await check(['default'])).status).toBe('ok');
    expect((await check(['other'])).status).toBe('warn');
    expect((await unlinkedFactsStats(engine))!.window.unlinked).toBe(20);
  });

  test('thin client: the hint asks the brain host operator to run relink', async () => {
    await seed(10);
    await seed(10, { entity: null });
    const c = unlinkedFactsVerdict(await unlinkedFactsStats(engine), { thinClient: true });
    expect(c.status).toBe('warn');
    expect(c.message).toContain('ask the brain host operator to run: gbrain facts relink --dry-run');
    const remote = await remoteUnlinkedFactsCheck(engine, { sourceIds: ['default'], remote: true });
    expect(remote).toMatchObject({ name: 'unlinked_facts', status: 'warn' });
    expect(remote.message).toContain('ask the brain host operator');
    expect((await remoteUnlinkedFactsCheck(engine, {})).message).toContain('ask the brain host operator');
    expect((await remoteUnlinkedFactsCheck(engine, { remote: false })).message).toContain('preview links: gbrain facts relink --dry-run');
  });

  test('degrades without fact_relink_attempts: relink figures omitted, nothing excluded', async () => {
    await seed(10);
    await seed(10, { entity: null });
    await engine.executeRaw('ALTER TABLE fact_relink_attempts RENAME TO fact_relink_attempts_hidden');
    let s: Awaited<ReturnType<typeof unlinkedFactsStats>>;
    try { s = await unlinkedFactsStats(engine); } finally { await engine.executeRaw('ALTER TABLE fact_relink_attempts_hidden RENAME TO fact_relink_attempts'); }
    expect(s!.no_subject).toBeNull();
    expect(s!.relinked_7d).toBeNull();
    const c = unlinkedFactsVerdict(s);
    expect(c.status).toBe('warn');
    expect(c.message).toContain('relink history unavailable');
  });
});
