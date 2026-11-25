/**
 * The mention pass on a large or busy source (GST-3609): it always reaches its status write, records a throw on the
 * status row, and keeps the scan for newly added names inside its own time budget.
 *
 * Protects: a throw in the alias refresh, the name-list save or the reconcile leaves state 'failed' with the error on
 * mention_index_status (never a silent 'pending' with no error); an aborted pass records why it stopped; the scan for
 * pages naming a newly added name stops at its share of the budget, saves the name list and marks every page it did
 * not reach due, so the next runs reconcile them in resumable batches; a pass with no time left before the save does
 * not scan at all. Regression: a source whose name-list scan outlasts every run, so no run ever writes its status and
 * nothing drains, with no error recorded anywhere.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import type { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { countMentionDuePages, runMentionPass } from '../src/core/mentions/pass.ts';
import { mentionCoverageNotice, readMentionCoverage } from '../src/core/mentions/coverage.ts';
import { mentionBrain, page, resetMentionBrain, sweep } from './helpers/mention-brain.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = await mentionBrain(); }, 120_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await resetMentionBrain(engine); });
const restores: Array<() => void> = [];
afterEach(() => { while (restores.length) restores.pop()!(); });

const status = async () => (await engine.executeRaw<{ state: string; error: string | null; last_pass_at: string | null; generation: string }>(
  "SELECT state, error, last_pass_at::text AS last_pass_at, generation::text AS generation FROM mention_index_status WHERE source_id = 'default'"))[0]!;
const isPrefilter = (sql: string) => sql.includes("frontmatter->'mention_ignore' AS mention_ignore") && sql.includes('ORDER BY id LIMIT $3');

/**
 * Wraps engine.executeRaw for the test. The wrapper calls through with its own `this`: a PGLite transaction engine
 * inherits the method from the engine (Object.create), so a bound call would leave the transaction and wait on it.
 */
function hookQueries(hook: (sql: string, run: () => Promise<unknown>) => Promise<unknown>) {
  const original = engine.executeRaw;
  const spy = spyOn(engine, 'executeRaw').mockImplementation((function (this: PGLiteEngine, sql: string, ...rest: unknown[]) {
    return hook(sql, () => (original as (...a: unknown[]) => Promise<unknown>).call(this, sql, ...rest));
  }) as never);
  restores.push(() => spy.mockRestore());
}

/** Fails every engine.executeRaw whose SQL matches. */
function failWhen(match: (sql: string) => boolean, message: string) {
  hookQueries((sql, run) => (match(sql) ? Promise.reject(new Error(message)) : run()));
}

/** A brain whose index is complete, then a new company another page names: the next pass saves one added name. */
async function seedAddedName() {
  await page(engine, 'companies/acme', 'company', 'Acme Example', 'A company.');
  await page(engine, 'notes/n1', 'note', 'n1', 'Met Zebra Holdings today.');
  await sweep(engine);
  await page(engine, 'companies/zebra', 'company', 'Zebra Holdings', 'Another company.');
}

describe('a throw inside the pass is recorded on the status row', () => {
  test('in the name-list save (its scan for added names)', async () => {
    await seedAddedName();
    failWhen(isPrefilter, 'made-up scan failure');
    await expect(runMentionPass(engine)).rejects.toThrow('made-up scan failure');
    const s = await status();
    expect(s.state).toBe('failed');
    expect(s.error).toContain('made-up scan failure');
  });

  test('in the alias refresh', async () => {
    await seedAddedName();
    failWhen(sql => sql.includes('FROM page_aliases pa') && sql.includes('LEFT JOIN pages p'), 'connection reset (made up)');
    await expect(runMentionPass(engine)).rejects.toThrow('connection reset');
    const s = await status();
    expect(s.state).toBe('failed');
    expect(s.error).toContain('connection reset');
  });

  test('in the reconcile', async () => {
    await seedAddedName();
    await expect(runMentionPass(engine, { beforePublish: async () => { throw new Error('publish refused (made up)'); } })).rejects.toThrow('publish refused');
    const s = await status();
    expect(s.state).toBe('failed');
    expect(s.error).toContain('publish refused');
  });

  test('an aborted pass records that it stopped', async () => {
    await seedAddedName();
    const stop = new AbortController();
    stop.abort(new Error('caller time limit (made up)'));
    await expect(runMentionPass(engine, { signal: stop.signal })).rejects.toThrow();
    const s = await status();
    expect(s.state).toBe('failed');
    expect(s.error).toContain('caller time limit');
  });

  test('the next pass that ends clears the error', async () => {
    await seedAddedName();
    await expect(runMentionPass(engine, { beforePublish: async () => { throw new Error('publish refused (made up)'); } })).rejects.toThrow();
    await runMentionPass(engine);
    const s = await status();
    expect(s.state).toBe('complete');
    expect(s.error).toBeNull();
  });
});

describe('the scan for added names stays inside the pass budget', () => {
  /** 600 note pages (more than one scan batch of 500), the last one naming the added company. */
  async function seedLarge() {
    await page(engine, 'companies/acme', 'company', 'Acme Example', 'A company.');
    await engine.executeRaw(
      `INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline, frontmatter)
       SELECT 'notes/bulk-' || lpad(g::text, 4, '0'), 'default', 'note', 'Bulk ' || g, 'Filler text naming Zebra Holdings in passing.', '', '{}'::jsonb
         FROM generate_series(1, 599) AS g`);
    await page(engine, 'notes/last', 'note', 'last', 'Met Zebra Holdings today.');
    await sweep(engine);
    await page(engine, 'companies/zebra', 'company', 'Zebra Holdings', 'Another company.');
  }

  /** A clock the test moves: Date.now() returns base + offset. */
  function clock() {
    const base = Date.now();
    let offset = 0;
    const spy = spyOn(Date, 'now').mockImplementation(() => base + offset);
    restores.push(() => spy.mockRestore());
    return { base, jump: (ms: number) => { offset = ms; } };
  }

  test('a scan that outlasts its share stops, saves the name list and marks the pages it did not reach due', async () => {
    await seedLarge();
    const t = clock();
    let scans = 0;
    hookQueries(async (sql, run) => {
      const rows = await run();
      if (isPrefilter(sql)) { scans++; t.jump(11_000); }
      return rows;
    });
    const r = await runMentionPass(engine, { deadline: t.base + 10_000 });
    expect(scans).toBe(1);
    expect((await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM mention_gazetteer_entries WHERE source_id = 'default' AND target_slug = 'companies/zebra'"))[0]!.n).toBeGreaterThan(0);
    const s = await status();
    expect(s.last_pass_at).not.toBeNull();
    expect(s.error).toBeNull();
    const lastDue = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM pages p LEFT JOIN page_mention_state m ON m.page_id = p.id
        WHERE p.slug = 'notes/last' AND (m.page_id IS NULL OR m.mention_revision IS DISTINCT FROM p.knowledge_revision)`);
    expect(lastDue[0]!.n).toBe(1);
    expect(r.remaining).toBeGreaterThan(0);
  });

  test('later runs drain what the stopped scan marked, and the added name ends up linked everywhere', async () => {
    await seedLarge();
    const t = clock();
    hookQueries(async (sql, run) => {
      const rows = await run();
      if (isPrefilter(sql)) t.jump(6_000);
      return rows;
    });
    await runMentionPass(engine, { deadline: t.base + 10_000 });
    while (restores.length) restores.pop()!();
    await runMentionPass(engine);
    expect(await countMentionDuePages(engine)).toBe(0);
    const linked = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM links l JOIN pages t ON t.id = l.to_page_id WHERE t.slug = 'companies/zebra' AND l.link_source = 'mentions'`);
    expect(linked[0]!.n).toBe(600);
  });

  test('a pass that leaves a changed name list unsaved does not record the source complete', async () => {
    await page(engine, 'companies/acme', 'company', 'Acme Example', 'A company.');
    await page(engine, 'notes/n1', 'note', 'n1', 'Met Acme Example today.');
    await sweep(engine);
    await engine.executeRaw("DELETE FROM mention_gazetteer_entries WHERE source_id = 'default' AND target_slug = 'companies/acme'");
    const before = await status();
    expect(before.state).toBe('complete');
    const t = clock();
    const r = await runMentionPass(engine, { deadline: t.base - 1 });
    const s = await status();
    expect(s.state).toBe('pending');
    expect(s.last_pass_at).toBe(before.last_pass_at);
    expect(r.state).toBe('pending');
  });

  test('coverage reads a deferred name-list change as pending with a notice, even with no page counted due', async () => {
    await page(engine, 'companies/acme', 'company', 'Acme Example', 'A company.');
    await page(engine, 'notes/n1', 'note', 'n1', 'Met Acme Example today.');
    await sweep(engine);
    await engine.executeRaw("DELETE FROM mention_gazetteer_entries WHERE source_id = 'default' AND target_slug = 'companies/acme'");
    const t = clock();
    await runMentionPass(engine, { deadline: t.base - 1 });
    expect(await countMentionDuePages(engine)).toBe(0);
    const coverage = await readMentionCoverage(engine, ['default']);
    expect(coverage.state).toBe('pending');
    expect(coverage.degraded).toBe(true);
    expect(mentionCoverageNotice(coverage)?.why).toContain('name list');
  });

  test('a pass with no time left before the save does not scan, and still writes its status', async () => {
    await seedAddedName();
    const t = clock();
    let scans = 0;
    hookQueries((sql, run) => { if (isPrefilter(sql)) scans++; return run(); });
    const before = await status();
    await runMentionPass(engine, { deadline: t.base - 1 });
    expect(scans).toBe(0);
    const s = await status();
    expect(s.generation).toBe(before.generation);
    expect(s.state).toBe('pending');
    expect(s.last_pass_at).not.toBeNull();
  });

  /** 1,200 note pages, only the last of which names the added company: a rare new name. */
  async function seedRare() {
    await page(engine, 'companies/acme', 'company', 'Acme Example', 'A company.');
    await engine.executeRaw(
      `INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline, frontmatter)
       SELECT 'notes/bulk-' || lpad(g::text, 4, '0'), 'default', 'note', 'Bulk ' || g, 'Filler text about nothing in particular.', '', '{}'::jsonb
         FROM generate_series(1, 1199) AS g`);
    await page(engine, 'notes/last', 'note', 'last', 'Met Zebra Holdings today.');
    await sweep(engine);
    await page(engine, 'companies/zebra', 'company', 'Zebra Holdings', 'Another company.');
  }

  test('a rare added name is looked for one batch of pages per statement, not in one statement over the whole source', async () => {
    await seedRare();
    const sizes: number[] = [];
    hookQueries(async (sql, run) => {
      const rows = await run();
      if (isPrefilter(sql)) sizes.push((rows as unknown[]).length);
      return rows;
    });
    await runMentionPass(engine);
    expect(sizes.length).toBeGreaterThanOrEqual(3);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(500);
    expect(await countMentionDuePages(engine)).toBe(0);
  });

  test('when the budget runs out between batches the scan stops at a batch edge: the name list is saved and every page past it is due', async () => {
    await seedRare();
    const t = clock();
    let scans = 0;
    hookQueries(async (sql, run) => {
      const rows = await run();
      if (isPrefilter(sql)) { scans++; t.jump(scans === 1 ? 3_000 : 11_000); }
      return rows;
    });
    const r = await runMentionPass(engine, { deadline: t.base + 10_000 });
    expect(scans).toBe(2);
    expect((await engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM mention_gazetteer_entries WHERE source_id = 'default' AND target_slug = 'companies/zebra'"))[0]!.n).toBeGreaterThan(0);
    const due = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM pages p LEFT JOIN page_mention_state m ON m.page_id = p.id
        WHERE p.type = 'note' AND (m.page_id IS NULL OR m.mention_revision IS DISTINCT FROM p.knowledge_revision)`);
    expect(due[0]!.n).toBe(1200 - 999);
    expect(r.state).toBe('pending');
  });
});
