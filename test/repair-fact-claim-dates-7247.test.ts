/**
 * #7247: doctor `fact_bulk_dates` and `gbrain repair fact-claim-dates`, on PGLite and Postgres (testBackends).
 *
 * Protects: a day a bulk load stamped onto a large share of a source's facts is reported read-only, with the same
 * rule the repair uses; the repair previews without writing, moves only fence rows whose claim states exactly one
 * earlier date by rewriting the page (so the facts row follows the canonical text), updates database-only facts
 * directly only on an unmanaged brain, refuses a stale preview, leaves every other row and page byte-identical and
 * finds nothing on a second preview.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName } from '../src/core/operations.ts';
import { parseFactsFence, renderFactsTable, type ParsedFact } from '../src/core/facts-fence.ts';
import { claimDate } from '../src/core/facts/bulk-days.ts';
import { factBulkDatesCheck } from '../src/commands/doctor/checks/fact-bulk-dates.ts';
import { runWaveChecks } from '../src/commands/doctor/wave-checks.ts';
import { runRepairCommand } from '../src/commands/repair.ts';
import { resolveRepairScope } from '../src/core/repair/core.ts';
import { AUTO_REPAIR_REGISTRY, repairRunner } from '../src/core/repair/registry.ts';
import { _resetCliExitVerdictForTests } from '../src/core/cli-force-exit.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const DAY = '2026-05-01';
const ACME = 'companies/acme-example';
const ALICE = 'people/alice-example';
const OTHER = 'companies/other-example';
const logger = { info() {}, warn() {}, error() {} };

const fence = (rows: Array<[number, string, string]>) => renderFactsTable(rows.map(([rowNum, claim, validFrom]) => ({ rowNum, claim, kind: 'fact', confidence: 1,
  visibility: 'world', notability: 'medium', validFrom, source: 'bulk-import', active: true })) as ParsedFact[]);
const page = (title: string, type: string, rows: Array<[number, string, string]>) =>
  `---\ntype: ${type}\ntitle: ${title}\n---\n${title} notes.\n\n## Facts\n\n${fence(rows)}\n`;

const ACME_ROWS: Array<[number, string, string]> = [
  [1, 'Acme Example closed a seed round on 2025-03-14', DAY],
  [2, 'Acme Example hired a head of sales', DAY],
  [3, 'Acme Example moved offices on 2024-01-10 and again on 2025-02-01', DAY],
  [4, 'Acme Example plans a launch on 2027-01-01', DAY],
  [5, 'Acme Example was founded on 2019-06-01', '2019-06-01'],
  [6, 'Acme Example opened a lab on 2023-02-30', DAY],
];

async function putPage(ctx: OperationContext, slug: string, content: string) {
  const prior = await ctx.engine.readPageSnapshot(slug, { sourceId: 'default' });
  await operationsByName.put_page.handler(ctx, { slug, content, ...(prior ? { expected_revision: prior.revision } : {}) });
}

/** The bulk load: 240 database-only facts over 24 entities on DAY (every 20th with an earlier date), plus two out-of-range dates. */
async function seedBulk(engine: BrainEngine) {
  await engine.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source, valid_from)
    SELECT 'default', 'companies/filler-' || (g % 24),
           CASE WHEN g % 20 = 0 THEN 'Filler example ' || g || ' was registered on 2024-03-15' ELSE 'Filler example ' || g || ' is a loaded claim' END,
           'fact', 'world', 'bulk-import', $1::timestamptz
      FROM generate_series(1, 240) AS g`, [`${DAY}T00:00:00Z`]);
  for (const fact of ['Filler example dated 2023-02-30', 'Filler example dated 1899-12-31']) {
    await engine.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source, valid_from)
      VALUES ('default', 'companies/filler-0', $1, 'fact', 'world', 'bulk-import', $2::timestamptz)`, [fact, `${DAY}T00:00:00Z`]);
  }
}

async function seedPages(ctx: OperationContext) {
  await putPage(ctx, ACME, page('Acme Example', 'company', ACME_ROWS));
  await putPage(ctx, ALICE, page('Alice Example', 'person', [[1, 'Alice Example joined Acme Example on 2024-09-02', DAY]]));
  await putPage(ctx, OTHER, page('Other Example', 'company', [[1, 'Other Example ships quarterly', '2025-01-01']]));
}

const factState = (engine: BrainEngine) => engine.executeRaw<{ id: number; day: string; expired: boolean }>(
  `SELECT id, to_char(valid_from AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, expired_at IS NOT NULL AS expired FROM facts ORDER BY id`);
const fenceDay = async (engine: BrainEngine, slug: string, row: number) => engine.executeRaw<{ day: string }>(
  `SELECT to_char(valid_from AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day FROM facts WHERE source_markdown_slug = $1 AND row_num = $2 AND expired_at IS NULL`, [slug, row]);
const fenceRows = async (engine: BrainEngine, slug: string) => parseFactsFence((await engine.readPageSnapshot(slug, { sourceId: 'default' }))!.page.compiled_truth).facts;
const revision = async (engine: BrainEngine, slug: string) => (await engine.readPageSnapshot(slug, { sourceId: 'default' }))!.revision;

async function preview(engine: BrainEngine, day?: string) {
  return (await repairRunner(engine, { apply: false, logger })).run('fact-claim-dates', await resolveRepairScope(engine, 'default'), { explicit: true, sourceFlag: 'default', day });
}
async function apply(engine: BrainEngine, expect: string, day?: string) {
  return (await repairRunner(engine, { apply: true, logger })).run('fact-claim-dates', await resolveRepairScope(engine, 'default'), { explicit: true, sourceFlag: 'default', expect, day });
}
async function refusal(run: () => Promise<unknown>): Promise<OperationError> {
  try { await run(); } catch (error) { if (error instanceof OperationError) return error; throw error; }
  throw new Error('expected a refusal');
}

/** Doctor: the bulk day with its counts; the SQL claim-date count agrees with claimDate on every fact of the day. */
async function expectFinding(engine: BrainEngine, dated: number) {
  const finding = await factBulkDatesCheck(engine);
  expect(finding.status).toBe('warn');
  expect(finding.message).toContain('record when the facts were loaded, not when they happened');
  expect(finding.fix).toMatchObject({ argv: ['gbrain', 'repair', 'fact-claim-dates', '--source', 'default', '--json'] });
  const [day] = finding.details!.days as Array<Record<string, any>>;
  expect(day).toMatchObject({ source_id: 'default', day: DAY, facts: 248, dated_claims: dated });
  expect(day!.entities).toBeGreaterThanOrEqual(24);
  expect(day!.top_sources[0]).toEqual({ source: 'bulk-import', facts: 248 });
  const claims = await engine.executeRaw<{ fact: string }>(`SELECT fact FROM facts WHERE expired_at IS NULL AND (valid_from AT TIME ZONE 'UTC')::date = $1::date`, [DAY]);
  expect(claims.filter(row => 'date' in claimDate(row.fact, DAY)).length).toBe(dated);
}

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  describe(`#7247 fact-claim-dates on a managed brain (${backend})`, () => {
    test('doctor finding; preview writes nothing; a stale preview refuses; apply rewrites exactly the planned fence rows; a second preview is empty', async () => {
      await managedBrain(async ({ engine, ctx, root }) => {
        await seedPages(ctx);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        try { await seedBulk(engine); } finally { await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1'); }
        await expectFinding(engine, 14);
        const wave = (await runWaveChecks(engine, { only: 'wave' })).find(f => f.spec.id === 'fact_bulk_dates')!;
        expect(wave.state).toBe('finding');
        expect(wave.spec.count(wave.check.details!)).toBe(248);

        expect(AUTO_REPAIR_REGISTRY.map(spec => spec.kind)).not.toContain('fact-claim-dates');
        await expect((await repairRunner(engine, { apply: false, logger })).run('fact-claim-dates', await resolveRepairScope(engine, 'default'), { sourceFlag: 'default' }))
          .rejects.toMatchObject({ code: 'explicit_kind_required' });

        const before = await factState(engine);
        const revisions = { acme: await revision(engine, ACME), other: await revision(engine, OTHER) };
        const otherFile = readFileSync(join(root, `${OTHER}.md`), 'utf8');
        const dry = await preview(engine);
        expect(dry.affected).toBe(2);
        expect(dry.residuals).toEqual({ no_date: 229, several_dates: 1, date_not_earlier: 4, database_only_managed: 12 });
        expect(dry.listing!.map(entry => [entry.class, entry.item.split(' ')[0]])).toEqual([['rewrite', `default:${ACME}`], ['rewrite', `default:${ALICE}`]]);
        expect(dry.listing![0]!.detail).toContain(`#1 ${DAY} -> 2025-03-14`);
        expect(dry.warnings!.join('\n')).toContain('These dates record when the facts were loaded, not when they happened.');
        expect(dry.apply_command).toBe(`gbrain repair fact-claim-dates --source default --apply --expect ${dry.preview_hash} --yes`);
        expect(await factState(engine)).toEqual(before);
        expect(await revision(engine, ACME)).toBe(revisions.acme);

        expect((await refusal(() => apply(engine, 'f'.repeat(64)))).code).toBe('preview_changed');
        expect((await refusal(() => apply(engine, undefined as never))).code).toBe('invalid_params');
        // The plan moves when a candidate page does: the old hash refuses, a new preview approves the new plan.
        const stale = dry.preview_hash!;
        await putPage(ctx, ALICE, page('Alice Example', 'person', [[1, 'Alice Example joined Acme Example on 2024-09-02', DAY], [2, 'Alice Example likes tea', DAY]]));
        expect((await refusal(() => apply(engine, stale))).code).toBe('preview_changed');
        const fresh = await preview(engine);
        expect(fresh.preview_hash).not.toBe(stale);

        _resetCliExitVerdictForTests();
        const lines: string[] = [];
        const original = console.log;
        console.log = (...parts: unknown[]) => { lines.push(parts.map(String).join(' ')); };
        try {
          await withEnv({ GBRAIN_INTERACTIVE: '0', CI: '1' }, () =>
            runRepairCommand(engine, ['fact-claim-dates', '--source', 'default', '--apply', '--expect', fresh.preview_hash!, '--yes', '--json']));
        } finally { console.log = original; }
        const applied = (JSON.parse(lines.join('\n')) as { results: Array<Record<string, any>> }).results[0]!;
        expect(applied).toMatchObject({ mode: 'apply', applied: 2, failed: [], outcomes: { rewritten: 2 } });

        const acme = await fenceRows(engine, ACME);
        expect(acme.find(row => row.rowNum === 1)!.validFrom).toBe('2025-03-14');
        expect(acme.filter(row => row.rowNum !== 1).map(row => [row.rowNum, row.claim, row.validFrom])).toEqual(ACME_ROWS.filter(([n]) => n !== 1));
        expect(await fenceDay(engine, ACME, 1)).toEqual([{ day: '2025-03-14' }]);
        expect(await fenceDay(engine, ACME, 2)).toEqual([{ day: DAY }]);
        expect(await fenceDay(engine, ALICE, 1)).toEqual([{ day: '2024-09-02' }]);
        expect(await fenceDay(engine, ALICE, 2)).toEqual([{ day: DAY }]);
        expect(readFileSync(join(root, `${ACME}.md`), 'utf8')).toContain('2025-03-14');
        // Other pages and database-only facts are untouched.
        expect(await revision(engine, OTHER)).toBe(revisions.other);
        expect(readFileSync(join(root, `${OTHER}.md`), 'utf8')).toBe(otherFile);
        const fillers = await engine.executeRaw<{ n: number }>(`SELECT count(*)::int AS n FROM facts WHERE entity_slug LIKE 'companies/filler-%' AND expired_at IS NULL
          AND (valid_from AT TIME ZONE 'UTC')::date = $1::date`, [DAY]);
        expect(fillers[0]!.n).toBe(242);

        const again = await preview(engine);
        expect(again.affected).toBe(0);
        expect(again.residuals.database_only_managed).toBe(12);
        expect((await factBulkDatesCheck(engine)).details!.days).toMatchObject([{ day: DAY, dated_claims: 12 }]);
      }, { databaseUrl });
    }, 240_000);
  });

  describe(`#7247 fact-claim-dates on an unmanaged brain (${backend})`, () => {
    let engine: BrainEngine;
    let close: (() => Promise<void>) | undefined;
    let ctx: OperationContext;
    beforeAll(async () => {
      if (backend === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(databaseUrl!));
      else { const pglite = new PGLiteEngine(); await pglite.connect({}); await pglite.initSchema(); engine = pglite; }
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      ctx = { engine, config: { engine: engine.kind, embedding_disabled: true } as never, sourceId: 'default', remote: false, dryRun: false, logger };
    }, 120_000);
    afterAll(async () => { if (close) await close(); else await engine.disconnect(); });

    test('fence rows move through the page and database-only facts in place; scoped doctor; --day; idempotent', async () => {
      await seedPages(ctx);
      await seedBulk(engine);
      await putPage(ctx, 'companies/later-example', page('Later Example', 'company', [[1, 'Later Example signed a lease on 2025-12-01', '2026-06-10']]));
      await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('source-a', 'source-a') ON CONFLICT DO NOTHING`);
      await expectFinding(engine, 14);
      // A caller scoped to another source sees nothing of this one.
      expect((await factBulkDatesCheck(engine, ['source-a'])).status).toBe('ok');
      expect((await refusal(async () => (await repairRunner(engine, { apply: false, logger })).run('fact-claim-dates', await resolveRepairScope(engine), { explicit: true }))).code)
        .toBe('invalid_params');

      const revisions = { other: await revision(engine, OTHER), later: await revision(engine, 'companies/later-example') };
      const dry = await preview(engine);
      expect(dry.affected).toBe(8);
      expect(dry.residuals).toEqual({ no_date: 229, several_dates: 1, date_not_earlier: 4 });
      expect(dry.listing!.filter(entry => entry.class === 'update').map(entry => entry.detail!.split(':')[0])).toEqual(Array(6).fill('2 database-only fact(s) take the date their claim states'));

      const applied = await apply(engine, dry.preview_hash!);
      expect(applied.outcomes).toEqual({ rewritten: 2, updated: 6 });
      expect(await fenceDay(engine, ACME, 1)).toEqual([{ day: '2025-03-14' }]);
      expect(await fenceDay(engine, ALICE, 1)).toEqual([{ day: '2024-09-02' }]);
      const moved = await engine.executeRaw<{ day: string; n: number }>(`SELECT to_char(valid_from AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, count(*)::int AS n FROM facts
        WHERE fact LIKE '%was registered on 2024-03-15' GROUP BY 1`);
      expect(moved).toEqual([{ day: '2024-03-15', n: 12 }]);
      expect(await revision(engine, OTHER)).toBe(revisions.other);
      expect(await revision(engine, 'companies/later-example')).toBe(revisions.later);
      expect((await preview(engine)).affected).toBe(0);
      expect((await factBulkDatesCheck(engine)).details!.days).toMatchObject([{ day: DAY, dated_claims: 0 }]);

      // --day names a loaded day the rule does not detect; the hash and apply command carry it.
      expect((await preview(engine)).listing!.some(entry => entry.item.includes('later-example'))).toBe(false);
      const named = await preview(engine, '2026-06-10');
      expect(named.affected).toBe(1);
      expect(named.apply_command).toContain('--day 2026-06-10');
      expect((await refusal(() => apply(engine, named.preview_hash!))).code).toBe('preview_changed');
      expect((await apply(engine, named.preview_hash!, '2026-06-10')).outcomes).toEqual({ rewritten: 1 });
      expect(await fenceDay(engine, 'companies/later-example', 1)).toEqual([{ day: '2025-12-01' }]);
    }, 240_000);
  });
}
