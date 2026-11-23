/**
 * write_gate_holds_stranded doctor check: a held write (a quarantined fact or take) remembers its page only by
 * slug, so a rename or a delete can leave the hold naming a slug no live page has. When the old slug leads
 * (through the alias table or the rename history) to a live page, that page's held text is no longer hidden.
 * The check only reports; it changes nothing.
 *
 * The check is found through the doctor registry, never imported, so every test here fails on behavior
 * (the check is not in the registry) before it exists. PGLite always; Postgres too when DATABASE_URL is set.
 * Synthetic data only.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { Check } from '../src/commands/doctor.ts';
import type { DoctorContext, DoctorEntry } from '../src/commands/doctor/context.ts';
import { DOCTOR_CHECK_REGISTRY } from '../src/commands/doctor/registry.ts';
import { categorizeCheck } from '../src/core/doctor-categories.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';

const NAME = 'write_gate_holds_stranded';
const ROW_BUDGET = 5000;
const BATCH = 500;

function entry(): DoctorEntry {
  const found = DOCTOR_CHECK_REGISTRY.find(e => e.name === NAME);
  if (!found) throw new Error(`${NAME} is not in the doctor registry`);
  return found;
}

type Ctx = Omit<Partial<DoctorContext>, 'engine'> & { engine: unknown };
async function run(ctx: Ctx): Promise<Check> {
  const checks = await entry().run(ctx as unknown as DoctorContext) as Check[];
  expect(checks.map(c => c.name)).toEqual([NAME]);
  return checks[0]!;
}

const refusal = () => Object.assign(new Error('this engine does not serve raw SQL for that statement'), { code: 'engine_capability_missing' });

describe('write_gate_holds_stranded registration', () => {
  test('is a registered, categorized brain check emitting its own name', () => {
    expect(entry().emits).toEqual([NAME]);
    expect(categorizeCheck(NAME)).toBe('brain');
  });
});

for (const backend of testBackends()) {
  describe(`write_gate_holds_stranded doctor check (${backend})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    let seq = 0;

    beforeAll(async () => {
      if (backend === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
    }, 120_000);

    afterAll(async () => { await close?.(); }, 60_000);

    beforeEach(async () => {
      for (const t of ['write_gate_holds', 'slug_aliases', 'slug_rename_history', 'pages']) await engine.executeRaw(`DELETE FROM ${t}`);
      await engine.executeRaw("DELETE FROM sources WHERE id <> 'default'");
      for (const id of ['s1', 's2']) await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [id]);
    });

    const page = (source: string, slug: string, deleted = false) => engine.executeRaw(
      `INSERT INTO pages (source_id, slug, type, title, compiled_truth, deleted_at) VALUES ($1, $2, 'note', $2, 'x', ${deleted ? 'now()' : 'NULL'})`, [source, slug]);
    const alias = (source: string, from: string, to: string) =>
      engine.executeRaw('INSERT INTO slug_aliases (source_id, alias_slug, canonical_slug) VALUES ($1, $2, $3)', [source, from, to]);
    const history = (source: string, from: string, to: string) =>
      engine.executeRaw('INSERT INTO slug_rename_history (source_id, old_slug, new_slug) VALUES ($1, $2, $3)', [source, from, to]);
    const hold = async (source: string, slug: string, opts: { status?: string; kind?: string } = {}): Promise<string> => {
      const rows = await engine.executeRaw<{ id: string }>(
        `INSERT INTO write_gate_holds (kind, source_id, slug, fingerprint, detector_version, tier, payload, status)
         VALUES ($1, $2, $3, $4, 1, 'quarantine', '{}'::jsonb, $5) RETURNING id::text AS id`,
        [opts.kind ?? 'fact', source, slug, `fp-${seq++}`, opts.status ?? 'held']);
      return `h${rows[0]!.id}`;
    };
    /** `n` held rows at one slug (fingerprints differ), inserted in one statement. */
    const bulkHolds = (source: string, slug: string, n: number) => engine.executeRaw(
      `INSERT INTO write_gate_holds (kind, source_id, slug, fingerprint, detector_version, tier, payload)
       SELECT 'fact', $1, $2, 'bulk-' || $1 || '-' || g::text, 1, 'quarantine', '{}'::jsonb FROM generate_series(1, $3::int) AS g`, [source, slug, n]);
    const details = (c: Check) => c.details as Record<string, any>;

    test('a hold whose page was renamed through an alias warns, names the new page and its read-only review', async () => {
      await page('default', 'people/alice-new');
      await alias('default', 'people/alice-old', 'people/alice-new');
      const ref = await hold('default', 'people/alice-old');
      const check = await run({ engine });
      expect(check.status).toBe('warn');
      expect(details(check)).toMatchObject({ complete: true, scanned: 1, stranded: { renamed: 1, page_deleted: 0, no_page: 0 },
        by_source: { default: { renamed: 1, page_deleted: 0, no_page: 0 } },
        items: [{ hold_ref: ref, kind: 'fact', source_id: 'default', slug: 'people/alice-old', class: 'renamed', current_slug: 'people/alice-new' }] });
      expect(check.fix).toMatchObject({ argv: ['gbrain', 'trust', 'review'], consent: [], actor: 'agent' });
      expect(check.message).toContain(ref);
      expect(check.message).toContain('people/alice-new');
      expect(check.message).toContain('suspected');
    });

    test('the message says it does not fix the leak, and that release and drop do not restore the quarantine or take back delivered text', async () => {
      await page('default', 'people/alice-new');
      await alias('default', 'people/alice-old', 'people/alice-new');
      await hold('default', 'people/alice-old');
      const message = (await run({ engine })).message;
      expect(message).toContain('does not fix');
      expect(message).toContain('neither release nor drop');
      expect(message).toContain('restores the quarantine');
      expect(message).toContain('already delivered');
      expect(message).toContain('gbrain trust review');
      expect(message).toContain('holds following a page id');
    });

    test('a displaced alias with the old slug soft-deleted still warns once, through the rename history', async () => {
      await page('default', 'people/b');
      await page('default', 'people/a', true);
      await history('default', 'people/a', 'people/b');
      await history('default', 'people/x', 'people/a');
      await alias('default', 'people/x', 'people/a');
      await hold('default', 'people/a');
      const check = await run({ engine });
      expect(check.status).toBe('warn');
      expect(details(check).stranded).toEqual({ renamed: 1, page_deleted: 0, no_page: 0 });
      expect(details(check).items).toHaveLength(1);
      expect(details(check).items[0]).toMatchObject({ class: 'renamed', current_slug: 'people/b' });
    });

    test('two rename destinations count the hold once and are labelled suspected', async () => {
      await page('default', 'people/b');
      await page('default', 'people/c');
      await alias('default', 'people/a', 'people/b');
      await history('default', 'people/a', 'people/b');
      await history('default', 'people/a', 'people/c');
      await hold('default', 'people/a');
      const check = await run({ engine });
      expect(check.status).toBe('warn');
      expect(details(check).stranded.renamed).toBe(1);
      expect(details(check).items).toHaveLength(1);
      expect(details(check).items[0]).toMatchObject({ class: 'renamed', destination_count: 2, current_slug: 'people/b' });
      expect(check.message).toContain('suspected');
    });

    test('a soft-deleted page, or a soft-deleted rename destination, is its own class and does not warn on its own', async () => {
      await page('default', 'people/gone', true);
      await page('default', 'people/dest', true);
      await alias('default', 'people/moved', 'people/dest');
      await hold('default', 'people/gone');
      await hold('default', 'people/moved');
      const check = await run({ engine });
      expect(check.status).toBe('ok');
      expect(check.severity).toBe('info');
      expect(details(check)).toMatchObject({ complete: true, scanned: 2, stranded: { renamed: 0, page_deleted: 2, no_page: 0 } });
      expect(check.message).toContain('soft-deleted');
    });

    test('a slug with no page and no rename evidence is informational, and ok when nothing else is stranded', async () => {
      await hold('default', 'people/not-yet-written');
      const check = await run({ engine });
      expect(check.status).toBe('ok');
      expect(check.severity).toBe('info');
      expect(details(check)).toMatchObject({ complete: true, stranded: { renamed: 0, page_deleted: 0, no_page: 1 } });
      expect(details(check).items[0]).toMatchObject({ class: 'no_page' });
      expect(check.fix).toMatchObject({ argv: ['gbrain', 'trust', 'review'] });
    });

    test('an informational hold beside a renamed one does not hide the warning; both are counted', async () => {
      await page('default', 'people/b');
      await alias('default', 'people/a', 'people/b');
      await hold('default', 'people/a');
      await hold('default', 'people/never');
      const check = await run({ engine });
      expect(check.status).toBe('warn');
      expect(details(check).stranded).toEqual({ renamed: 1, page_deleted: 0, no_page: 1 });
    });

    test('holds on live pages, released holds, dropped holds and empty slugs are not stranded', async () => {
      await page('default', 'people/live');
      await hold('default', 'people/live');
      await hold('default', 'people/old-released', { status: 'released' });
      await hold('default', 'people/old-dropped', { status: 'dropped', kind: 'take' });
      await hold('default', '');
      const check = await run({ engine });
      expect(check).toMatchObject({ status: 'ok', details: { complete: true, scanned: 2, stranded: { renamed: 0, page_deleted: 0, no_page: 0 }, items: [] } });
      expect(check.severity).toBeUndefined();
    });

    test('the same slug in two sources, and a rename recorded only in another source, never count across sources', async () => {
      await page('s2', 'people/a');
      await page('s2', 'people/d');
      await alias('s2', 'people/c', 'people/d');
      await history('s2', 'people/c', 'people/d');
      await hold('s1', 'people/a');
      await hold('s1', 'people/c');
      const check = await run({ engine });
      expect(check.status).toBe('ok');
      expect(details(check).stranded).toEqual({ renamed: 0, page_deleted: 0, no_page: 2 });
      expect(details(check).by_source).toEqual({ s1: { renamed: 0, page_deleted: 0, no_page: 2 } });
    });

    test('the source scope limits the scan: an explicit source, a remote source list, and an empty scope', async () => {
      await page('s1', 'people/b');
      await page('s2', 'people/b');
      await alias('s1', 'people/a', 'people/b');
      await alias('s2', 'people/a', 'people/b');
      await hold('s1', 'people/a');
      await hold('s2', 'people/a');
      expect(details(await run({ engine }))).toMatchObject({ scanned: 2, stranded: { renamed: 2 }, by_source: { s1: { renamed: 1 }, s2: { renamed: 1 } } });
      expect(details(await run({ engine, orphanRatioSourceId: 's2' }))).toMatchObject({ scanned: 1, stranded: { renamed: 1 }, by_source: { s2: { renamed: 1 } } });
      expect(details(await run({ engine, sourceIds: ['s1'] }))).toMatchObject({ scanned: 1, stranded: { renamed: 1 }, by_source: { s1: { renamed: 1 } } });
      const none = await run({ engine, sourceIds: [] });
      expect(none).toMatchObject({ status: 'ok', details: { scanned: 0, stranded: { renamed: 0, page_deleted: 0, no_page: 0 } } });
    });

    test('the check changes nothing: holds, pages, aliases and history read back identical', async () => {
      await page('default', 'people/b');
      await alias('default', 'people/a', 'people/b');
      await history('default', 'people/a', 'people/b');
      await hold('default', 'people/a');
      await hold('default', 'people/never');
      const snapshot = async () => JSON.stringify(await Promise.all(['write_gate_holds ORDER BY id', 'pages ORDER BY id', 'slug_aliases ORDER BY id', 'slug_rename_history ORDER BY old_slug']
        .map(t => engine.executeRaw(`SELECT * FROM ${t}`))), (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
      const before = await snapshot();
      await run({ engine });
      expect(await snapshot()).toBe(before);
    });

    describe('bounded scan', () => {
      test('exactly the row budget of held rows is a complete scan; the last row is still examined', async () => {
        await page('default', 'people/live');
        await bulkHolds('default', 'people/live', ROW_BUDGET - 1);
        await hold('default', 'people/never');
        const check = await run({ engine });
        expect(check.status).toBe('ok');
        expect(details(check)).toMatchObject({ complete: true, scanned: ROW_BUDGET, stranded: { no_page: 1 } });
        expect(details(check).health).toBeUndefined();
      });

      test('one held row past the budget stops the scan: warn, count unknown, never ok, even with zero findings', async () => {
        await page('default', 'people/live');
        await bulkHolds('default', 'people/live', ROW_BUDGET + 1);
        const check = await run({ engine });
        expect(check.status).toBe('warn');
        expect(details(check)).toMatchObject({ health: 'unknown', reason: 'bound', bound: 'row_limit', exact: false, complete: false, scanned: ROW_BUDGET, found_so_far: { renamed: 0, page_deleted: 0, no_page: 0 }, row_budget: ROW_BUDGET });
        expect(check.message).toContain('could not count');
      });

      test('findings before the stop are reported as a lower bound, and the count stays unknown', async () => {
        await page('default', 'people/live');
        await hold('default', 'people/never-1');
        await hold('default', 'people/never-2');
        await bulkHolds('default', 'people/live', ROW_BUDGET - 1);
        const check = await run({ engine });
        expect(check.status).toBe('warn');
        expect(details(check)).toMatchObject({ health: 'unknown', bound: 'row_limit', scanned: ROW_BUDGET, found_so_far: { no_page: 2 } });
        expect(check.message).toContain('at least 2');
      });

      test('live holds and empty slugs use the budget before any filtering, so a stranded hold after them is never reached', async () => {
        await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('a-src', 'a-src'), ('z-src', 'z-src') ON CONFLICT (id) DO NOTHING");
        await page('a-src', 'people/live');
        await bulkHolds('a-src', 'people/live', ROW_BUDGET - 10);
        await bulkHolds('a-src', '', 10);
        await hold('z-src', 'people/never');
        const check = await run({ engine });
        expect(check.status).toBe('warn');
        expect(details(check)).toMatchObject({ health: 'unknown', bound: 'row_limit', scanned: ROW_BUDGET, found_so_far: { no_page: 0 } });
      });

      test('released and dropped holds do not use the budget', async () => {
        await page('default', 'people/live');
        await bulkHolds('default', 'people/live', ROW_BUDGET);
        await engine.executeRaw("UPDATE write_gate_holds SET status = 'released' WHERE id IN (SELECT id FROM write_gate_holds ORDER BY id LIMIT 100)");
        const check = await run({ engine });
        expect(check).toMatchObject({ status: 'ok', details: { complete: true, scanned: ROW_BUDGET - 100 } });
      });

      test('a deadline already past stops before any hold is read: warn, count unknown, bound named deadline', async () => {
        await hold('default', 'people/never');
        const check = await run({ engine, entryDeadlineAt: Date.now() - 1 });
        expect(check.status).toBe('warn');
        expect(details(check)).toMatchObject({ health: 'unknown', reason: 'bound', bound: 'deadline', scanned: 0, complete: false });
      });

      test('holds are read in keyset batches of 500: no payload, no offset, ordered by source and id', async () => {
        await page('default', 'people/live');
        await bulkHolds('default', 'people/live', 2 * BATCH + 200);
        const reads: string[] = [];
        const recording = { executeRaw: (sql: string, params?: unknown[]) => { if (/write_gate_holds/.test(sql) && !/slug_aliases/.test(sql)) reads.push(sql); return engine.executeRaw(sql, params); } };
        const check = await run({ engine: recording });
        expect(check).toMatchObject({ status: 'ok', details: { complete: true, scanned: 2 * BATCH + 200 } });
        expect(reads).toHaveLength(3);
        for (const sql of reads) {
          expect(sql).not.toMatch(/\bpayload\b/i);
          expect(sql).not.toMatch(/\boffset\b/i);
          expect(sql).not.toMatch(/count\(/i);
          expect(sql).toMatch(/order by source_id, id/i);
        }
      });
    });

    describe('unreadable evidence is unknown, never empty or ok', () => {
      const delegating = (fail: (sql: string) => unknown) => ({
        executeRaw: async (sql: string, params?: unknown[]) => { const e = fail(sql); if (e) throw e; return engine.executeRaw(sql, params); },
      });

      test('a rename history table the role cannot read gives a warn with the count unknown', async () => {
        await hold('default', 'people/never');
        const denied = Object.assign(new Error('permission denied for table slug_rename_history'), { code: '42501' });
        const check = await run({ engine: delegating(sql => (/slug_rename_history/.test(sql) ? denied : null)) });
        expect(check.status).toBe('warn');
        expect(details(check)).toMatchObject({ health: 'unknown' });
        expect(check.message).toContain('slug_rename_history');
      });

      test('a rename history table that does not exist is unknown too, not an empty history', async () => {
        await hold('default', 'people/never');
        const missing = Object.assign(new Error('relation "slug_rename_history" does not exist'), { code: '42P01' });
        const check = await run({ engine: delegating(sql => (/slug_rename_history/.test(sql) ? missing : null)) });
        expect(check.status).toBe('warn');
        expect(details(check)).toMatchObject({ health: 'unknown' });
      });

      test('a brain without the hold table predates the write gate and is ok', async () => {
        const missing = Object.assign(new Error('relation "write_gate_holds" does not exist'), { code: '42P01' });
        const check = await run({ engine: delegating(() => missing) });
        expect(check).toMatchObject({ status: 'ok', details: { schema: 'pre_trust' } });
      });

      test('any other read failure is reported with its error, never ok', async () => {
        const check = await run({ engine: delegating(() => new Error('connection reset by peer')) });
        expect(check.status).toBe('warn');
        expect(check.message).toContain('connection reset by peer');
      });

      test('an engine that refuses raw SQL (engine_capability_missing) is a named unknown, not ok and not an empty brain', async () => {
        const refusing = { executeRaw: async () => { throw refusal(); } };
        const check = await run({ engine: refusing });
        expect(check.status).toBe('warn');
        expect(details(check)).toMatchObject({ health: 'unknown', reason: 'engine_capability_missing', count: 'unknown' });
        expect(check.message).toContain('engine_capability_missing');
        expect(check.fix_unavailable_reason).toBe('check_errored');
      });

      test('the refusal is named when only the operator envelope carries the code, and when it comes on a later statement', async () => {
        await hold('default', 'people/never');
        const enveloped = { executeRaw: async () => { throw Object.assign(new Error('refused'), { envelope: { code: 'engine_capability_missing' } }); } };
        expect(details(await run({ engine: enveloped }))).toMatchObject({ health: 'unknown', reason: 'engine_capability_missing' });
        const late = await run({ engine: delegating(sql => (/slug_aliases/.test(sql) ? refusal() : null)) });
        expect(late.status).toBe('warn');
        expect(details(late)).toMatchObject({ health: 'unknown', reason: 'engine_capability_missing' });
      });
    });
  });
}
