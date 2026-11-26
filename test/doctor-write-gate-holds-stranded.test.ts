/**
 * write_gate_holds_stranded doctor check: a held write (a quarantined fact or take) names its page only by
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

    test('an unbound hold whose page was renamed through an alias is protected through the rename record, so it is not stranded', async () => {
      await page('default', 'people/alice-new');
      await alias('default', 'people/alice-old', 'people/alice-new');
      await hold('default', 'people/alice-old');
      const check = await run({ engine });
      expect(check.status).toBe('ok');
      expect(check.severity).toBeUndefined();
      expect(details(check)).toMatchObject({ complete: true, scanned: 1, stranded: { page_deleted: 0, no_page: 0 }, by_source: {}, items: [] });
    });

    test('the message of an unknown count says the check only detects and changes nothing, and no longer claims a rename leak', async () => {
      await hold('default', 'people/never');
      const check = await run({ engine, entryDeadlineAt: Date.now() - 1 });
      expect(check.status).toBe('warn');
      expect(check.message).toContain('only detects and changes nothing');
      expect(check.message).toContain('gbrain trust review');
      expect(check.message).not.toMatch(/does not fix|restores the quarantine|holds following a page id|renamed page/);
      expect(check.fix).toMatchObject({ argv: ['gbrain', 'trust', 'review'], consent: [], actor: 'agent' });
    });

    test('a displaced alias with the old slug soft-deleted is still protected: the rename history leads to the live page', async () => {
      await page('default', 'people/b');
      await page('default', 'people/a', true);
      await history('default', 'people/a', 'people/b');
      await history('default', 'people/x', 'people/a');
      await alias('default', 'people/x', 'people/a');
      await hold('default', 'people/a');
      const check = await run({ engine });
      expect(check.status).toBe('ok');
      expect(details(check).stranded).toEqual({ page_deleted: 0, no_page: 0 });
      expect(details(check).items).toEqual([]);
    });

    test('two rename destinations are both read by the readers, so the hold is protected', async () => {
      await page('default', 'people/b');
      await page('default', 'people/c');
      await alias('default', 'people/a', 'people/b');
      await history('default', 'people/a', 'people/b');
      await history('default', 'people/a', 'people/c');
      await hold('default', 'people/a');
      const check = await run({ engine });
      expect(check.status).toBe('ok');
      expect(details(check).stranded).toEqual({ page_deleted: 0, no_page: 0 });
      expect(details(check).items).toEqual([]);
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
      expect(details(check)).toMatchObject({ complete: true, scanned: 2, stranded: { page_deleted: 2, no_page: 0 } });
      expect(check.message).toContain('soft-deleted');
    });

    test('a slug with no page and no rename evidence is informational, and ok when nothing else is stranded', async () => {
      await hold('default', 'people/not-yet-written');
      const check = await run({ engine });
      expect(check.status).toBe('ok');
      expect(check.severity).toBe('info');
      expect(details(check)).toMatchObject({ complete: true, stranded: { page_deleted: 0, no_page: 1 } });
      expect(details(check).items[0]).toMatchObject({ class: 'no_page' });
      expect(check.fix).toMatchObject({ argv: ['gbrain', 'trust', 'review'] });
    });

    test('a protected renamed hold beside an informational one is not counted; the informational one is', async () => {
      await page('default', 'people/b');
      await alias('default', 'people/a', 'people/b');
      await hold('default', 'people/a');
      await hold('default', 'people/never');
      const check = await run({ engine });
      expect(check.status).toBe('ok');
      expect(check.severity).toBe('info');
      expect(details(check).stranded).toEqual({ page_deleted: 0, no_page: 1 });
      expect(details(check).items).toHaveLength(1);
    });

    test('holds on live pages, released holds, dropped holds and empty slugs are not stranded', async () => {
      await page('default', 'people/live');
      await hold('default', 'people/live');
      await hold('default', 'people/old-released', { status: 'released' });
      await hold('default', 'people/old-dropped', { status: 'dropped', kind: 'take' });
      await hold('default', '');
      const check = await run({ engine });
      expect(check).toMatchObject({ status: 'ok', details: { complete: true, scanned: 2, stranded: { page_deleted: 0, no_page: 0 }, items: [] } });
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
      expect(details(check).stranded).toEqual({ page_deleted: 0, no_page: 2 });
      expect(details(check).by_source).toEqual({ s1: { page_deleted: 0, no_page: 2 } });
    });

    test('the source scope limits the scan: an explicit source, a remote source list, and an empty scope', async () => {
      await hold('s1', 'people/a');
      await hold('s2', 'people/a');
      expect(details(await run({ engine }))).toMatchObject({ scanned: 2, stranded: { no_page: 2 }, by_source: { s1: { no_page: 1 }, s2: { no_page: 1 } } });
      expect(details(await run({ engine, orphanRatioSourceId: 's2' }))).toMatchObject({ scanned: 1, stranded: { no_page: 1 }, by_source: { s2: { no_page: 1 } } });
      expect(details(await run({ engine, sourceIds: ['s1'] }))).toMatchObject({ scanned: 1, stranded: { no_page: 1 }, by_source: { s1: { no_page: 1 } } });
      const none = await run({ engine, sourceIds: [] });
      expect(none).toMatchObject({ status: 'ok', details: { scanned: 0, stranded: { page_deleted: 0, no_page: 0 } } });
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

    /** A hold bound to page `pageId` (holds remember their page by id), named `slug` as it was when held. */
    const boundHold = async (source: string, slug: string, pageId: string): Promise<string> => {
      const rows = await engine.executeRaw<{ id: string }>(
        `INSERT INTO write_gate_holds (kind, source_id, slug, fingerprint, detector_version, tier, payload, status, page_id)
         VALUES ('fact', $1, $2, $3, 1, 'quarantine', '{}'::jsonb, 'held', $4::bigint) RETURNING id::text AS id`, [source, slug, `fp-${seq++}`, pageId]);
      return `h${rows[0]!.id}`;
    };
    const pageId = async (source: string, slug: string): Promise<string> =>
      (await engine.executeRaw<{ id: string }>('SELECT id::text AS id FROM pages WHERE source_id = $1 AND slug = $2', [source, slug]))[0]!.id;

    describe('holds that follow their page', () => {
      test('a bound hold at the old name of a renamed page is protected by its page, so the check reports ok', async () => {
        await page('default', 'people/b');
        await alias('default', 'people/a', 'people/b');
        await history('default', 'people/a', 'people/b');
        await boundHold('default', 'people/a', await pageId('default', 'people/b'));
        const check = await run({ engine });
        expect(check.status).toBe('ok');
        expect(check.severity).toBeUndefined();
        expect(details(check)).toMatchObject({ complete: true, scanned: 1, stranded: { page_deleted: 0, no_page: 0 }, items: [] });
      });

      test('a bound hold whose page exists is protected even when no rename record names the old slug', async () => {
        await page('default', 'people/b');
        await boundHold('default', 'people/a', await pageId('default', 'people/b'));
        const check = await run({ engine });
        expect(check.status).toBe('ok');
        expect(details(check)).toMatchObject({ stranded: { page_deleted: 0, no_page: 0 }, items: [] });
      });

      test('an unbound hold that the rename record leads to a live page is protected too: readers match it there', async () => {
        await page('default', 'people/b');
        await history('default', 'people/a', 'people/c');
        await history('default', 'people/c', 'people/b');
        await hold('default', 'people/a');
        const check = await run({ engine });
        expect(check.status).toBe('ok');
        expect(details(check)).toMatchObject({ stranded: { page_deleted: 0, no_page: 0 }, items: [] });
      });

      test('a bound hold whose page is soft-deleted is informational, even when the old slug leads to another live page', async () => {
        await page('default', 'people/dead', true);
        await page('default', 'people/other');
        await alias('default', 'people/a', 'people/other');
        await boundHold('default', 'people/a', await pageId('default', 'people/dead'));
        const check = await run({ engine });
        expect(check.status).toBe('ok');
        expect(check.severity).toBe('info');
        expect(details(check).stranded).toEqual({ page_deleted: 1, no_page: 0 });
      });
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
        expect(details(check)).toMatchObject({ health: 'unknown', reason: 'bound', bound: 'row_limit', exact: false, complete: false, scanned: ROW_BUDGET, found_so_far: { page_deleted: 0, no_page: 0 }, row_budget: ROW_BUDGET });
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

    test('a source named constructor keeps its own per-source counts', async () => {
      await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('constructor', 'constructor')");
      await page('constructor', 'people/gone', true);
      await hold('constructor', 'people/gone');
      await hold('constructor', 'people/never');
      const check = await run({ engine });
      expect(details(check).stranded).toEqual({ page_deleted: 1, no_page: 1 });
      expect(Object.hasOwn(details(check).by_source, 'constructor')).toBe(true);
      expect(details(check).by_source.constructor).toEqual({ page_deleted: 1, no_page: 1 });
      expect(JSON.parse(JSON.stringify(details(check).by_source))).toEqual({ constructor: { page_deleted: 1, no_page: 1 } });
    });

    test('a dangling alias target does not matter: the live rename destination protects the hold', async () => {
      await page('default', 'people/c');
      await alias('default', 'people/a', 'people/b');
      await history('default', 'people/a', 'people/c');
      await hold('default', 'people/a');
      const check = await run({ engine });
      expect(check.status).toBe('ok');
      expect(details(check).stranded).toEqual({ page_deleted: 0, no_page: 0 });
    });

    test('the page lookup is probed by its (source_id, slug) index, and answers the same on a large source', async () => {
      await engine.executeRaw(`INSERT INTO pages (source_id, slug, type, title, compiled_truth)
        SELECT 's1', 'notes/unrelated-' || g::text, 'note', 'x', 'x' FROM generate_series(1, 8000) AS g`);
      await page('s1', 'people/dest');
      await page('s1', 'people/gone', true);
      await alias('s1', 'people/moved', 'people/dest');
      await history('s1', 'people/hist-only', 'people/dest');
      await hold('s1', 'people/moved');
      await hold('s1', 'people/hist-only');
      await hold('s1', 'people/gone');
      for (let i = 0; i < 12; i++) await hold('s1', `people/missing-${i}`);
      await engine.executeRaw('ANALYZE pages');
      let statement: { sql: string; params: unknown[] } | null = null;
      const recording = { executeRaw: (sql: string, params?: unknown[]) => {
        if (/slug_rename_history/.test(sql) && /\bpages\b/.test(sql) && !/row_security_active/.test(sql)) statement ??= { sql, params: params ?? [] };
        return engine.executeRaw(sql, params);
      } };
      const check = await run({ engine: recording });
      expect(details(check).stranded).toEqual({ page_deleted: 1, no_page: 12 });
      expect(details(check).items.map((i: { slug: string }) => i.slug)).not.toContain('people/moved');
      expect(details(check).items.map((i: { slug: string }) => i.slug)).not.toContain('people/hist-only');
      expect(statement).not.toBeNull();
      const [row] = await engine.executeRaw<Record<string, unknown>>(`EXPLAIN (FORMAT JSON) ${statement!.sql}`, statement!.params);
      const raw = Object.values(row!)[0];
      const plan = typeof raw === 'string' ? JSON.parse(raw) : raw;
      const nodes: Array<Record<string, unknown>> = [];
      const walk = (n: any): void => { if (n && typeof n === 'object') { if (n['Node Type']) nodes.push(n); for (const v of Object.values(n)) walk(v); } };
      walk(plan);
      expect(nodes.filter(n => n['Relation Name'] === 'pages' && n['Node Type'] === 'Seq Scan')).toEqual([]);
      const probes = nodes.filter(n => n['Index Name'] === 'pages_source_slug_key');
      expect(probes.length).toBeGreaterThan(0);
      for (const probe of probes) expect(String(probe['Index Cond'])).toMatch(/slug/);
    }, 120_000);

    if (backend === 'postgres') describe('a row-security role cannot see the evidence', () => {
      const ROLE = `gb_stranded_probe_${Math.random().toString(16).slice(2, 10)}`;
      const BYPASS_ROLE = `${ROLE}_bypass`;
      const TABLES = ['write_gate_holds', 'slug_aliases', 'slug_rename_history', 'pages'];
      const wasSecured = new Map<string, boolean>();

      beforeAll(async () => {
        for (const t of TABLES) {
          const [r] = await engine.executeRaw<{ on: boolean }>('SELECT relrowsecurity AS on FROM pg_class WHERE oid = $1::regclass', [t]);
          wasSecured.set(t, r!.on);
          await engine.executeRaw(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
        }
        await engine.executeRaw(`CREATE ROLE ${ROLE} NOSUPERUSER NOBYPASSRLS NOINHERIT`);
        await engine.executeRaw(`GRANT USAGE ON SCHEMA public TO ${ROLE}`);
        await engine.executeRaw(`GRANT SELECT ON ${TABLES.join(', ')}, sources TO ${ROLE}`);
        await engine.executeRaw(`CREATE ROLE ${BYPASS_ROLE} NOSUPERUSER BYPASSRLS NOINHERIT`);
        await engine.executeRaw(`GRANT USAGE ON SCHEMA public TO ${BYPASS_ROLE}`);
        await engine.executeRaw(`GRANT SELECT ON ${TABLES.join(', ')}, sources TO ${BYPASS_ROLE}`);
      }, 60_000);

      afterAll(async () => {
        for (const t of TABLES) {
          await engine.executeRaw(`DROP POLICY IF EXISTS ${ROLE}_p ON ${t}`);
          await engine.executeRaw(`DROP POLICY IF EXISTS ${ROLE}_r ON ${t}`);
        }
        for (const role of [ROLE, BYPASS_ROLE]) {
          await engine.executeRaw(`DROP OWNED BY ${role}`);
          await engine.executeRaw(`DROP ROLE IF EXISTS ${role}`);
        }
        for (const t of TABLES) if (!wasSecured.get(t)) await engine.executeRaw(`ALTER TABLE ${t} DISABLE ROW LEVEL SECURITY`);
      }, 60_000);

      const readableBy = async (tables: string[]) => {
        for (const t of TABLES) {
          await engine.executeRaw(`DROP POLICY IF EXISTS ${ROLE}_p ON ${t}`);
          await engine.executeRaw(`DROP POLICY IF EXISTS ${ROLE}_r ON ${t}`);
        }
        for (const t of tables) await engine.executeRaw(`CREATE POLICY ${ROLE}_p ON ${t} FOR SELECT TO ${ROLE} USING (true)`);
      };
      const asRole = (role = ROLE): Promise<Check> => engine.transaction(async tx => {
        await tx.executeRaw(`SET LOCAL ROLE ${role}`);
        return run({ engine: tx });
      });
      const seedRename = async () => {
        await page('default', 'people/b');
        await history('default', 'people/a', 'people/b');
        await hold('default', 'people/never');
      };

      test('hidden holds are unknown, never an empty ok', async () => {
        await seedRename();
        await readableBy([]);
        const check = await asRole();
        expect(check.status).toBe('warn');
        expect(details(check)).toMatchObject({ health: 'unknown', reason: 'row_level_security', count: 'unknown' });
        expect(details(check).hidden_tables).toContain('write_gate_holds');
        expect(check.message).toContain('write_gate_holds');
        expect(check.message).not.toMatch(/no held write|nothing is leaking/i);
      });

      test('hidden rename history is unknown, never a history-only rename read as no page', async () => {
        await seedRename();
        await readableBy(['write_gate_holds', 'slug_aliases', 'pages']);
        const check = await asRole();
        expect(check.status).toBe('warn');
        expect(details(check)).toMatchObject({ health: 'unknown', reason: 'row_level_security' });
        expect(details(check).hidden_tables).toContain('slug_rename_history');
        expect(check.message).toContain('slug_rename_history');
        expect(check.message).not.toMatch(/no held write|nothing is leaking/i);
      });

      test('row security active on a relation makes it hidden whatever its policies say: every active relation is named', async () => {
        await seedRename();
        await readableBy(['write_gate_holds', 'slug_rename_history']);
        expect(details(await asRole()).hidden_tables).toEqual(TABLES);
      });

      test('a permissive SELECT policy on every relation is not enough: the role is still unknown, and no policy predicate is judged', async () => {
        await seedRename();
        await readableBy(TABLES);
        const check = await asRole();
        expect(check.status).toBe('warn');
        expect(details(check)).toMatchObject({ health: 'unknown', reason: 'row_level_security', hidden_tables: TABLES });
      });

      test('a policy USING (false) on write_gate_holds hides every hold: unknown, never ok', async () => {
        await seedRename();
        await readableBy(['slug_aliases', 'slug_rename_history', 'pages']);
        await engine.executeRaw(`CREATE POLICY ${ROLE}_p ON write_gate_holds FOR SELECT TO ${ROLE} USING (false)`);
        const check = await asRole();
        expect(check.status).toBe('warn');
        expect(details(check)).toMatchObject({ health: 'unknown', reason: 'row_level_security', count: 'unknown' });
        expect(details(check).hidden_tables).toContain('write_gate_holds');
        expect(check.message).not.toMatch(/no held write|nothing is leaking/i);
      });

      test('a permissive USING (true) plus a restrictive USING (false) hides every hold: unknown, never ok', async () => {
        await seedRename();
        await readableBy(TABLES);
        await engine.executeRaw(`CREATE POLICY ${ROLE}_r ON write_gate_holds AS RESTRICTIVE FOR SELECT TO ${ROLE} USING (false)`);
        const check = await asRole();
        expect(check.status).toBe('warn');
        expect(details(check)).toMatchObject({ health: 'unknown', reason: 'row_level_security' });
        expect(details(check).hidden_tables).toContain('write_gate_holds');
        expect(check.message).not.toMatch(/no held write|nothing is leaking/i);
      });

      test('a role that bypasses row security reads the evidence and gets the real verdict', async () => {
        await seedRename();
        await readableBy([]);
        const check = await asRole(BYPASS_ROLE);
        expect(check.status).toBe('ok');
        expect(details(check)).toMatchObject({ complete: true, stranded: { no_page: 1 } });
      });

      test('a non-owner role on tables without row security reads the evidence and gets the real verdict', async () => {
        await seedRename();
        await readableBy([]);
        for (const t of TABLES) await engine.executeRaw(`ALTER TABLE ${t} DISABLE ROW LEVEL SECURITY`);
        try {
          const check = await asRole();
          expect(check.status).toBe('ok');
          expect(details(check)).toMatchObject({ complete: true, stranded: { no_page: 1 } });
        } finally {
          for (const t of TABLES) await engine.executeRaw(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY`);
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
