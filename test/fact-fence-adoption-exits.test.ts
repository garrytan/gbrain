/**
 * #6650: the fact-fence adoption no longer leaks, loops or blocks.
 *
 * Protects:
 * - A leftover fence cell the adoption reuses is re-rendered from the legacy
 *   row, so a stale world cell never publishes a private legacy fact as world
 *   and a stale cell never overwrites the fact's kind or validity; a private
 *   cell is never widened to world (the world row appends instead). On an
 *   unmanaged brain (no publisher read-back before #6650) the old planner
 *   fenced a private fact into a leftover world cell and the reconcile made
 *   the fact world in the database too.
 * - Planner and publisher share one read-back predicate.
 * - A deterministic refusal of the same intent is not resubmitted within a
 *   day, so cycles stop minting identical failed requests; a day later, or a
 *   changed adoption planner, retries once.
 * - A suppressed page does not count against the request-ID cap: only pages
 *   that will submit are checked before the fence step admits anything.
 * - One unadoptable legacy row no longer stops the phantom-redirect pass for
 *   the whole source; only a phantom that owns legacy rows is held.
 * - G4: a legacy row with a NULL `notability` (a brain whose column lost its
 *   NOT NULL, as some long-lived brains have it) adopts into its page's fence
 *   with the column default `medium`, on the managed and the unmanaged path,
 *   and the fence row reads back as the row. Before, the fence row rendered
 *   `null` in the notability cell, the codec oracle refused it as `parse`,
 *   and the row stayed unfenced on every run, keeping its page out of
 *   reconciliation and booking the source's facts fence as an
 *   `integrity_guard` halt.
 * - G4: a legacy row that copies a fenced claim of its page (`duplicate_claim`)
 *   is never adopted; `gbrain repair duplicate-facts` keeps the fence row and
 *   retires the legacy copy onto it, and the page then leaves the guard.
 *   Before, the repair kept an older legacy copy and held the fence row.
 * Seams: planFence against an engine stub, the managed-brain helper for the
 * coordinator path, PGLite for the extract_facts cycle, and an unmanaged
 * brain with a source checkout (PGLite and Postgres) for the file path.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { fenceCellReadBackProblem, parseFactsFence, renderFactsTable, replaceOrInsertFactsFence, type ParsedFact } from '../src/core/facts-fence.ts';
import { adoptableClaim, fenceRowOf, fenceUnfencedFacts, planFence, planUnfencedFacts, type UnfencedFactRow } from '../src/core/facts/unfenced-facts.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import { serializePageToMarkdown } from '../src/core/markdown.ts';
import { FACT_FENCE_PLANNER, maintenancePreflight, planFactFenceAdoption, submitFactFenceAdoption } from '../src/core/persistence/prepared-maintenance.ts';
import { principalKey } from '../src/core/persistence/model.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { declarePersistenceProtocol } from '../src/core/persistence/protocol.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { LEGACY_FILE_SLUG, seedLegacyManagedContent, type LegacySeed } from './helpers/managed-legacy-fixture.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { runRepairCommand } from '../src/commands/repair.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { managedPersistenceEnabled } from '../src/core/persistence/ownership.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';

const SLUG = 'people/alice-example';
const noOccupiedRows = { executeRaw: async () => [] } as unknown as BrainEngine;

function legacyRow(overrides: Partial<UnfencedFactRow> = {}): UnfencedFactRow {
  return { id: '41', source_id: 'default', entity_slug: SLUG, fact: 'Alice example moved to Lisbon', kind: 'fact', visibility: 'private',
    notability: 'medium', context: null, valid_from: new Date('2026-02-05T00:00:00Z'), valid_until: null, source: 'mcp:remember',
    confidence: 0.9, claim_metric: null, claim_value: null, claim_unit: null, claim_period: null, page_exists: true, ...overrides };
}

/** A page whose fence holds a leftover row (no database owner) with the legacy claim, as a partial earlier run leaves it. */
function pageWithLeftover(cell: Partial<ParsedFact>): string {
  return replaceOrInsertFactsFence('# Alice Example\n\nProse.\n', renderFactsTable([{ rowNum: 3, active: true, claim: 'Alice example moved to Lisbon',
    kind: 'fact', confidence: 0.9, visibility: 'world', notability: 'medium', validFrom: '2026-02-05', source: 'mcp:remember', ...cell }]));
}

describe('planFence reuses a leftover cell without widening or overwriting it (#6650)', () => {
  test('a stale world cell for a private legacy fact publishes exactly one private row at that position', async () => {
    const plan = await planFence(noOccupiedRows, 'default', SLUG, pageWithLeftover({ visibility: 'world' }), [legacyRow()]);
    if ('warnings' in plan) throw new Error(plan.warnings.join('; '));
    expect(plan.assignments).toEqual([{ id: '41', row_num: 3, fact: 'Alice example moved to Lisbon' }]);
    const rows = parseFactsFence(plan.body).facts;
    expect(rows.map(f => [f.rowNum, f.claim, f.visibility])).toEqual([[3, 'Alice example moved to Lisbon', 'private']]);
  });

  test('a stale cell does not overwrite the legacy fact\'s kind, validity or confidence', async () => {
    const plan = await planFence(noOccupiedRows, 'default', SLUG,
      pageWithLeftover({ visibility: 'private', kind: 'belief', validFrom: '2020-01-01', confidence: 0.2 }), [legacyRow()]);
    if ('warnings' in plan) throw new Error(plan.warnings.join('; '));
    const [cell] = parseFactsFence(plan.body).facts;
    expect(cell).toMatchObject({ rowNum: 3, kind: 'fact', validFrom: '2026-02-05', confidence: 0.9, visibility: 'private' });
  });

  test('a private cell is never reused for a world legacy fact: it stays private and the world row appends', async () => {
    const plan = await planFence(noOccupiedRows, 'default', SLUG, pageWithLeftover({ visibility: 'private' }), [legacyRow({ visibility: 'world' })]);
    if ('warnings' in plan) throw new Error(plan.warnings.join('; '));
    expect(plan.assignments).toEqual([{ id: '41', row_num: 4, fact: 'Alice example moved to Lisbon' }]);
    expect(parseFactsFence(plan.body).facts.map(f => [f.rowNum, f.visibility])).toEqual([[3, 'private'], [4, 'world']]);
  });

  test('a legacy fact keeps its speaker attribution through the fence (fresh and reused rows)', async () => {
    const fresh = await planFence(noOccupiedRows, 'default', SLUG, '# Alice Example\n', [legacyRow({ attributed_to: 'user' })]);
    const reused = await planFence(noOccupiedRows, 'default', SLUG, pageWithLeftover({ visibility: 'private' }), [legacyRow({ attributed_to: 'assistant' })]);
    if ('warnings' in fresh || 'warnings' in reused) throw new Error('unexpected fence warnings');
    expect(parseFactsFence(fresh.body).facts.map(f => f.attributedTo)).toEqual(['user']);
    expect(parseFactsFence(reused.body).facts.map(f => f.attributedTo)).toEqual(['assistant']);
  });

  test('the shared read-back predicate names each mismatch', () => {
    const cell: ParsedFact = { rowNum: 1, active: true, claim: ' a\r\nb ', kind: 'fact', confidence: 1, visibility: 'world', notability: 'high' };
    expect(fenceCellReadBackProblem(cell, { fact: 'a\nb', visibility: 'world' })).toBeNull();
    expect(fenceCellReadBackProblem(undefined, { fact: 'a', visibility: 'world' })).toBe('row_missing');
    expect(fenceCellReadBackProblem({ ...cell, active: false }, { fact: 'a\nb', visibility: 'world' })).toBe('struck');
    expect(fenceCellReadBackProblem({ ...cell, claim: '' }, { fact: '', visibility: 'world' })).toBe('empty');
    expect(fenceCellReadBackProblem(cell, { fact: 'a\nb', visibility: 'private' })).toBe('visibility');
    expect(fenceCellReadBackProblem(cell, { fact: 'a b', visibility: 'world' })).toBe('text');
  });
});

describe('fenceRowOf renders an absent column as its column default (G4)', () => {
  test('NULL notability and confidence render as medium and 1, and the row reads back exactly', () => {
    const row = { ...legacyRow(), notability: null, confidence: null };
    const cell = fenceRowOf(row, 7, row.fact);
    expect(cell).toMatchObject({ rowNum: 7, active: true, claim: row.fact, notability: 'medium', confidence: 1 });
    const back = parseFactsFence(renderFactsTable([cell]));
    expect(back.warnings).toEqual([]);
    expect(back.facts).toHaveLength(1);
    expect(back.facts[0]).toMatchObject(cell);
    expect(renderFactsTable(back.facts)).toBe(renderFactsTable([cell]));
    expect(adoptableClaim(row as unknown as UnfencedFactRow)).toEqual({ claim: row.fact });
  });

  test('kind and visibility are never defaulted: a NULL one is refused, not guessed', () => {
    expect(adoptableClaim(legacyRow({ kind: null as unknown as UnfencedFactRow['kind'] }))).toEqual({ rejected: 'parse' });
    expect(adoptableClaim(legacyRow({ visibility: null as unknown as UnfencedFactRow['visibility'] }))).toEqual({ rejected: 'parse' });
  });
});

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  test(`${backend}: a refused adoption is resubmitted once a day or on a planner change, not once per cycle`, async () => {
    let seed!: LegacySeed;
    await managedBrain(async ({ engine }) => {
      const authority = (await maintenancePreflight(engine, 'default'))!;
      const snapshot = (await engine.readPageSnapshot(LEGACY_FILE_SLUG, { sourceId: 'default' }))!;
      // Fence row 1 does not read back as legacy fact 1: the publisher refuses it as a planning defect.
      const content = replaceOrInsertFactsFence(serializePageToMarkdown(snapshot.page, snapshot.tags), renderFactsTable([
        { rowNum: 1, claim: 'Alice example founded Acme example', kind: 'fact', confidence: 0.9, visibility: 'world', notability: 'high', active: true }]));
      const attempt = () => submitFactFenceAdoption(engine, authority, LEGACY_FILE_SLUG,
        { content, expectedRevision: snapshot.revision, assignments: [{ id: seed.legacyFactIds[1], row_num: 1 }], file: true });
      const failed = async () => (await engine.executeRaw<{ n: number }>(
        `SELECT count(*)::int AS n FROM persistence_requests WHERE slug=$1 AND state='failed' AND error_code='fence_unrenderable'`, [LEGACY_FILE_SLUG]))[0].n;

      await expect(attempt()).rejects.toMatchObject({ code: 'fence_unrenderable', message: 'The adopted fence row does not render its legacy fact.' });
      await expect(attempt()).rejects.toMatchObject({ code: 'fence_unrenderable', message: 'The same fact-fence adoption was already refused.' });
      await expect(attempt()).rejects.toMatchObject({ code: 'fence_unrenderable', message: 'The same fact-fence adoption was already refused.' });
      expect(await failed()).toBe(1);

      // Once a day has passed it is retried once (the owner that refused it may have restarted onto newer code).
      await engine.transaction(async tx => {
        await declarePersistenceProtocol(tx);
        await tx.executeRaw(`UPDATE persistence_requests SET completed_at=now()-interval '25 hours' WHERE slug=$1 AND state='failed'`, [LEGACY_FILE_SLUG]);
      });
      await expect(attempt()).rejects.toMatchObject({ code: 'fence_unrenderable', message: 'The adopted fence row does not render its legacy fact.' });
      await expect(attempt()).rejects.toMatchObject({ code: 'fence_unrenderable', message: 'The same fact-fence adoption was already refused.' });
      expect(await failed()).toBe(2);
      // The planner revision is part of the intent, so a planner change gets a fresh identity rather than replaying the refusal.
      expect(await engine.executeRaw(`SELECT 1 FROM persistence_requests WHERE slug=$1 AND (intent->>'planner')::int=$2`, [LEGACY_FILE_SLUG, FACT_FENCE_PLANNER])).toHaveLength(2);
    }, { databaseUrl, setup: async ({ engine, root }) => { seed = await seedLegacyManagedContent(engine, root); } });
  }, 120_000);

  test(`${backend}: a suppressed page does not count against the request-ID cap, so it never refuses the fence step`, async () => {
    await managedBrain(async ({ engine }) => {
      const plan = await planUnfencedFacts(engine, { sourceId: 'default' });
      for (const key of [...plan.groups.keys()]) if (key !== `default\0${LEGACY_FILE_SLUG}`) plan.groups.delete(key);
      const group = plan.groups.get(`default\0${LEGACY_FILE_SLUG}`)!;
      const authority = (await maintenancePreflight(engine, 'default'))!;
      const snapshot = (await engine.readPageSnapshot(LEGACY_FILE_SLUG, { sourceId: 'default' }))!;
      const fence = await planFence(engine, 'default', LEGACY_FILE_SLUG, serializePageToMarkdown(snapshot.page, snapshot.tags), group);
      if ('warnings' in fence) throw new Error(fence.warnings.join('; '));
      const planned = await planFactFenceAdoption(engine, authority, LEGACY_FILE_SLUG, { content: fence.body, expectedRevision: snapshot.revision,
        assignments: fence.assignments.map(a => ({ id: Number(a.id), row_num: a.row_num })) });
      if (planned.kind !== 'submit') throw new Error('expected a fresh plan');
      const principal = authority.writer.principal;
      await engine.transaction(async tx => {
        await declarePersistenceProtocol(tx);
        // The identical adoption was refused as a planning defect an hour ago, and the principal sits exactly at its lifetime-ID cap.
        await tx.executeRaw(`INSERT INTO persistence_requests(principal_kind,principal_id,request_id,operation,source_id,source_incarnation,slug,digest,authority,intent_bytes,
            terminal_reservation,state,error_code,error_message,completed_at,updated_at)
          VALUES($1,$2,$3::uuid,'submit_job','default',(SELECT incarnation FROM sources WHERE id='default'),$4,'refused','{}'::jsonb,0,0,'failed','fence_unrenderable',
            'The adopted fence row does not render its legacy fact.',now()-interval '1 hour',now()-interval '1 hour')`,
        [principal.kind, principal.id, planned.requestId, LEGACY_FILE_SLUG]);
        await tx.executeRaw(`INSERT INTO persistence_counters(key) VALUES($1) ON CONFLICT DO NOTHING`, [principalKey(principal)]);
        await tx.executeRaw(`UPDATE persistence_counters SET lifetime_ids=1000 WHERE key=$1`, [principalKey(principal)]);
      });
      await engine.setConfig('persistence.limits.principal_lifetime_ids', '1000');
      const outcome = await fenceUnfencedFacts(engine, plan);
      expect(outcome.unadoptable_rows.filter(r => r.slug === LEGACY_FILE_SLUG && r.class === 'prior_refusal').length).toBe(fence.assignments.length);
      expect(outcome.fenced).toBe(0);
      // A page that would submit still needs its ID: the same cap refuses once the refusal no longer suppresses it.
      await engine.transaction(async tx => {
        await declarePersistenceProtocol(tx);
        await tx.executeRaw(`UPDATE persistence_requests SET completed_at=now()-interval '25 hours' WHERE request_id=$1::uuid`, [planned.requestId]);
      });
      await expect(fenceUnfencedFacts(engine, await planUnfencedFacts(engine, { sourceId: 'default' }))).rejects.toMatchObject({ code: 'write_quota_exhausted' });
    }, { databaseUrl, setup: async ({ engine, root }) => { await seedLegacyManagedContent(engine, root); } });
  }, 120_000);

  test(`${backend}: a legacy fact that changes after planning is not overwritten by the older plan`, async () => {
    let seed!: LegacySeed;
    await managedBrain(async ({ engine }) => {
      const plan = await planUnfencedFacts(engine, { sourceId: 'default' });
      const changed = seed.legacyFactIds[0];
      await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], async () => {
        await tx.executeRaw(`UPDATE facts SET kind='belief', confidence=0.25 WHERE id=$1`, [changed]);
      }, TEST_WRITE_ATTRIBUTION));
      const outcome = await fenceUnfencedFacts(engine, plan);
      expect(outcome.failed_pages.some(p => p.startsWith(`${LEGACY_FILE_SLUG} (a legacy fact changed after its fence row was planned`))).toBe(true);
      const [row] = await engine.executeRaw<{ kind: string; confidence: number; row_num: number | null }>('SELECT kind, confidence, row_num FROM facts WHERE id=$1', [changed]);
      expect(row).toMatchObject({ kind: 'belief', row_num: null });
      expect(Number(row.confidence)).toBeCloseTo(0.25);
      // The next run replans from the current row and adopts it with its current metadata.
      const again = await fenceUnfencedFacts(engine, await planUnfencedFacts(engine, { sourceId: 'default' }));
      expect(again.fenced_slugs).toContain(LEGACY_FILE_SLUG);
      const [adopted] = await engine.executeRaw<{ kind: string; row_num: number | null }>('SELECT kind, row_num FROM facts WHERE id=$1', [changed]);
      expect(adopted.kind).toBe('belief');
      expect(adopted.row_num).not.toBeNull();
    }, { databaseUrl, setup: async ({ engine, root }) => { seed = await seedLegacyManagedContent(engine, root); } });
  }, 120_000);
}

describe('extract_facts: an unadoptable row holds only its own phantom (#6650)', () => {
  const STUB = '# alice\n';

  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });
  afterAll(async () => { await engine.disconnect(); });
  beforeEach(async () => { await resetPgliteState(engine); });

  async function withBrain(run: (ctx: { engine: PGLiteEngine; brainDir: string }) => Promise<void>): Promise<void> {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fence-adoption-exits-'));
    const brainDir = path.join(root, 'brain');
    fs.mkdirSync(path.join(root, 'audit'), { recursive: true });
    try {
      await withEnv({ GBRAIN_AUDIT_DIR: path.join(root, 'audit') }, async () => {
        await engine.executeRaw("UPDATE sources SET local_path = $1 WHERE id = 'default'", [brainDir]);
        const write = (slug: string, body: string) => {
          fs.mkdirSync(path.dirname(path.join(brainDir, `${slug}.md`)), { recursive: true });
          fs.writeFileSync(path.join(brainDir, `${slug}.md`), body);
        };
        await engine.putPage(SLUG, { type: 'person', title: SLUG, compiled_truth: '# alice-example\n', frontmatter: {}, timeline: '' });
        write(SLUG, '# alice-example\n');
        await engine.putPage('alice', { type: 'person', title: 'alice', compiled_truth: STUB, frontmatter: {}, timeline: '' });
        write('alice', STUB);
        // A page whose legacy row cannot be fenced here: its canonical file is not on this host.
        await engine.putPage('companies/acme-example', { type: 'company', title: 'Acme', compiled_truth: '# Acme\n', frontmatter: {}, timeline: '' });
        await engine.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability, valid_from, source, confidence)
          VALUES ('default', 'companies/acme-example', 'Acme example ships widgets', 'fact', 'world', 'medium', '2026-03-01', 'mcp:remember', 0.8)`);
        await run({ engine, brainDir });
      });
    } finally {
      await engine.executeRaw("UPDATE sources SET local_path = NULL WHERE id = 'default'");
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  const alive = async (engine: PGLiteEngine, slug: string) =>
    (await engine.executeRaw('SELECT 1 FROM pages WHERE slug=$1 AND deleted_at IS NULL', [slug])).length === 1;

  test('a legacy row on another page no longer stops the source\'s phantom redirects', async () => {
    await withBrain(async ({ engine, brainDir }) => {
      const result = await runExtractFacts(engine, { sourceId: 'default', brainDir });
      expect(result.legacyRowsPending).toBe(1);
      expect(result.phantomsRedirected).toBe(1);
      expect(await alive(engine, 'alice')).toBe(false);
    });
  });

  test('held phantoms do not use up the pass cap: a later phantom still redirects', async () => {
    await withBrain(async ({ engine, brainDir }) => {
      await withEnv({ GBRAIN_PHANTOM_REDIRECT_LIMIT: '1' }, async () => {
        await engine.putPage('aaron', { type: 'person', title: 'aaron', compiled_truth: '# aaron\n', frontmatter: {}, timeline: '' });
        await engine.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability, valid_from, source, confidence)
          VALUES ('default', 'aaron', '   ', 'fact', 'world', 'medium', '2026-03-01', 'mcp:remember', 0.8)`);
        const result = await runExtractFacts(engine, { sourceId: 'default', brainDir });
        expect(result.phantomsHeldLegacyRows).toBe(1);
        expect(result.phantomsRedirected).toBe(1);
        expect(await alive(engine, 'alice')).toBe(false);
        expect(await alive(engine, 'aaron')).toBe(true);
      });
    });
  });

  test('a phantom that is the provenance page of an ontology observation is held, so the move never rewrites its subject', async () => {
    await withBrain(async ({ engine, brainDir }) => {
      await engine.mergeOntologyFact({ entitySlug: 'people/bob-example', dimension: 'role', value: 'advisor', source: 'alice' });
      const result = await runExtractFacts(engine, { sourceId: 'default', brainDir });
      expect(result.phantomsRedirected).toBe(0);
      expect(await alive(engine, 'alice')).toBe(true);
      expect(await engine.executeRaw("SELECT entity_slug, source_markdown_slug FROM facts WHERE dimension='role'"))
        .toEqual([{ entity_slug: 'people/bob-example', source_markdown_slug: 'alice' }]);
    });
  });

  test('a phantom that owns a legacy row is held and keeps its row', async () => {
    await withBrain(async ({ engine, brainDir }) => {
      await engine.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability, valid_from, source, confidence)
        VALUES ('default', 'alice', '   ', 'fact', 'world', 'medium', '2026-03-01', 'mcp:remember', 0.8)`);
      const result = await runExtractFacts(engine, { sourceId: 'default', brainDir });
      expect(result.phantomsRedirected).toBe(0);
      expect(result.phantomsHeldLegacyRows).toBe(1);
      expect(await alive(engine, 'alice')).toBe(true);
      expect(await engine.executeRaw("SELECT 1 FROM facts WHERE entity_slug='alice' AND row_num IS NULL AND expired_at IS NULL")).toHaveLength(1);
    });
  });
});

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  test(`${backend}: unmanaged: a leftover world cell does not make a private legacy fact world (file or database)`, async () => {
    const claim = 'Alice example has a private appointment';
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fence-adoption-unmanaged-'));
    try {
      await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
        const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
        try {
          expect(await managedPersistenceEnabled(engine)).toBe(false);
          const brainDir = path.join(home, 'brain');
          fs.mkdirSync(brainDir, { recursive: true });
          await engine.executeRaw("UPDATE sources SET local_path = $1 WHERE id = 'default'", [brainDir]);
          const page = await engine.putPage(SLUG, { type: 'person', title: 'Alice Example',
            compiled_truth: pageWithLeftover({ rowNum: 1, claim, confidence: 1, validFrom: '2026-03-01' }) });
          await engine.executeRaw('UPDATE pages SET source_path = $1 WHERE id = $2', [`${SLUG}.md`, page.id]);
          // Cell 1 is a leftover: no database row owns it.
          await engine.executeRaw('DELETE FROM facts WHERE source_id = $1 AND source_markdown_slug = $2', ['default', SLUG]);
          const snapshot = (await engine.readPageSnapshot(SLUG, { sourceId: 'default' }))!;
          const file = path.join(brainDir, `${SLUG}.md`);
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, serializePageToMarkdown(snapshot.page, snapshot.tags));
          const [legacy] = await engine.executeRaw<{ id: number }>(
            `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability, valid_from, source, confidence)
             VALUES ('default', $1, $2, 'fact', 'private', 'medium', '2026-03-01', 'mcp:remember', 1.0) RETURNING id`, [SLUG, claim]);

          const result = await runExtractFacts(engine, { sourceId: 'default', brainDir });
          expect(result.unfencedRowsFenced).toBe(1);
          expect(await engine.executeRaw('SELECT id, visibility, row_num FROM facts WHERE source_id = $1 AND fact = $2 AND expired_at IS NULL ORDER BY id',
            ['default', claim])).toEqual([{ id: legacy.id, visibility: 'private', row_num: 1 }]);
          expect(parseFactsFence(fs.readFileSync(file, 'utf8')).facts.filter(f => f.claim === claim).map(f => [f.rowNum, f.visibility]))
            .toEqual([[1, 'private']]);
        } finally { await close(); }
      });
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  }, 120_000);
}

/** G4: the column shape of a brain whose `facts.notability` lost its NOT NULL, and one legacy row on it with no notability. */
async function nullNotabilityRow(engine: BrainEngine, slug: string, claim: string): Promise<number> {
  await engine.executeRaw('ALTER TABLE facts ALTER COLUMN notability DROP NOT NULL');
  const [row] = await engine.executeRaw<{ id: number }>(
    `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability, valid_from, source, confidence)
     VALUES ('default', $1, $2, 'fact', 'world', NULL, '2026-03-01', 'mcp:remember', 0.8) RETURNING id`, [slug, claim]);
  return Number(row.id);
}

/** The adopted row keeps its id and text, its fence row reads back as it, and the fence carries the column default. */
async function expectAdoptedWithDefaultNotability(engine: BrainEngine, file: string, id: number, claim: string): Promise<void> {
  const [row] = await engine.executeRaw<{ id: number; fact: string; row_num: number | null; source_markdown_slug: string | null; expired: boolean; notability: string | null }>(
    'SELECT id, fact, row_num, source_markdown_slug, expired_at IS NOT NULL AS expired, notability FROM facts WHERE id = $1', [id]);
  expect(row).toMatchObject({ fact: claim, source_markdown_slug: SLUG, expired: false });
  expect(row.row_num).not.toBeNull();
  const cell = parseFactsFence(fs.readFileSync(file, 'utf8')).facts.find(f => f.rowNum === Number(row.row_num));
  expect(cell).toMatchObject({ claim, active: true, visibility: 'world', notability: 'medium', kind: 'fact', source: 'mcp:remember' });
  expect(fenceCellReadBackProblem(cell, { fact: row.fact, visibility: 'world' })).toBeNull();
  // The fence is the record: the reconcile derives the cell's notability into the row; nothing else wrote it.
  expect(row.notability).toBe('medium');
  expect((await engine.executeRaw<{ id: number }>('SELECT id FROM facts WHERE source_id = $1 AND fact = $2 ORDER BY id', ['default', claim])).map(r => Number(r.id))).toEqual([id]);
}

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  const claim = 'Alice example mentors founders';

  test(`${backend}: managed: a legacy row with NULL notability adopts through the coordinator with the default notability (G4)`, async () => {
    let id!: number;
    await managedBrain(async ({ engine, root }) => {
      const result = await runExtractFacts(engine, { sourceId: 'default', brainDir: root });
      expect(result.warnings.filter(w => w.startsWith('FACTS_FENCE_FAILED'))).toEqual([]);
      expect(result).toMatchObject({ legacyRowsPending: 0, guardTriggered: false });
      await expectAdoptedWithDefaultNotability(engine, path.join(root, `${LEGACY_FILE_SLUG}.md`), id, claim);
      const again = await runExtractFacts(engine, { sourceId: 'default', brainDir: root });
      expect(again).toMatchObject({ unfencedRowsFenced: 0, legacyRowsPending: 0, guardTriggered: false });
    }, { databaseUrl, setup: async ({ engine, root }) => {
      await seedLegacyManagedContent(engine, root);
      id = await nullNotabilityRow(engine, LEGACY_FILE_SLUG, claim);
    } });
  }, 120_000);

  test(`${backend}: unmanaged: a legacy row with NULL notability adopts onto the page file with the default notability (G4)`, async () => {
    await unmanagedFilePage(databaseUrl, '# Alice Example\n\nProse.\n', async ({ engine, brainDir, file }) => {
      const id = await nullNotabilityRow(engine, SLUG, claim);
      const result = await runExtractFacts(engine, { sourceId: 'default', brainDir });
      expect(result.warnings.filter(w => w.startsWith('FACTS_FENCE_FAILED'))).toEqual([]);
      expect(result).toMatchObject({ unfencedRowsFenced: 1, legacyRowsPending: 0, guardTriggered: false });
      await expectAdoptedWithDefaultNotability(engine, file, id, claim);
      const written = fs.readFileSync(file, 'utf8');
      const again = await runExtractFacts(engine, { sourceId: 'default', brainDir });
      expect(again).toMatchObject({ unfencedRowsFenced: 0, legacyRowsPending: 0, guardTriggered: false, factsInserted: 0, factsDeleted: 0 });
      expect(fs.readFileSync(file, 'utf8')).toBe(written);
    });
  }, 120_000);

  test(`${backend}: unmanaged: an older legacy copy of a fenced claim is retired by repair duplicate-facts and its page leaves the guard (G4)`, async () => {
    const fence = replaceOrInsertFactsFence('# Alice Example\n\nProse.\n', renderFactsTable([{ rowNum: 1, active: true, claim, kind: 'fact', confidence: 0.8,
      visibility: 'world', notability: 'medium', validFrom: '2026-03-01', source: 'mcp:remember' }]));
    await unmanagedFilePage(databaseUrl, fence, async ({ engine, brainDir, file, home }) => {
      const [legacy] = await engine.executeRaw<{ id: number }>(
        `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability, valid_from, source, confidence, created_at)
         VALUES ('default', $1, $2, 'fact', 'world', 'medium', '2026-03-01', 'mcp:remember', 0.8, '2026-01-01T00:00:00Z') RETURNING id`, [SLUG, claim]);
      const first = await runExtractFacts(engine, { sourceId: 'default', brainDir });
      expect(first.warnings).toContain(`FACTS_FENCE_FAILED: ${SLUG} (duplicate_claim: 1 row(s))`);
      expect(first).toMatchObject({ legacyRowsPending: 1, guardTriggered: true });
      const [fenced] = await engine.executeRaw<{ id: number }>('SELECT id FROM facts WHERE source_markdown_slug = $1 AND row_num = 1 AND expired_at IS NULL', [SLUG]);

      const repair = async (args: string[]) => {
        const lines: string[] = [];
        const original = console.log;
        console.log = (...parts: unknown[]) => { lines.push(parts.map(String).join(' ')); };
        try { await withEnv({ GBRAIN_HOME: home }, () => runRepairCommand(engine, ['duplicate-facts', ...args, '--json'])); } finally { console.log = original; }
        return JSON.parse(lines.join('\n')).results[0] as { preview_hash: string; residuals: Record<string, number> };
      };
      const preview = await repair([]);
      expect(preview.residuals).toMatchObject({ copies_to_retire: 1, fence_kept_elsewhere: 0 });
      await repair(['--apply', '--expect', preview.preview_hash, '--yes']);
      const state = async (id: number) => (await engine.executeRaw<{ active: boolean; superseded_by: number | null }>(
        'SELECT expired_at IS NULL AS active, superseded_by FROM facts WHERE id = $1', [id])).map(r => [r.active, r.superseded_by === null ? null : Number(r.superseded_by)]);
      expect(await state(legacy.id)).toEqual([[false, Number(fenced.id)]]);
      expect(await state(fenced.id)).toEqual([[true, null]]);
      const written = fs.readFileSync(file, 'utf8');

      const next = await runExtractFacts(engine, { sourceId: 'default', brainDir });
      expect(next.warnings.filter(w => w.startsWith('FACTS_FENCE_FAILED'))).toEqual([]);
      expect(next).toMatchObject({ legacyRowsPending: 0, guardTriggered: false });
      expect(fs.readFileSync(file, 'utf8')).toBe(written);
    });
  }, 120_000);
}

/** An unmanaged brain whose default source checkout holds `SLUG` as a file-backed page with `body`, its fence rows indexed. */
async function unmanagedFilePage(databaseUrl: string | undefined, body: string,
  run: (brain: { engine: BrainEngine; brainDir: string; file: string; home: string }) => Promise<void>): Promise<void> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fence-adoption-g4-'));
  try {
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
      try {
        expect(await managedPersistenceEnabled(engine)).toBe(false);
        const brainDir = path.join(home, 'brain');
        fs.mkdirSync(brainDir, { recursive: true });
        await engine.executeRaw("UPDATE sources SET local_path = $1 WHERE id = 'default'", [brainDir]);
        const page = await engine.putPage(SLUG, { type: 'person', title: 'Alice Example', compiled_truth: body });
        await engine.executeRaw('UPDATE pages SET source_path = $1 WHERE id = $2', [`${SLUG}.md`, page.id]);
        const snapshot = (await engine.readPageSnapshot(SLUG, { sourceId: 'default' }))!;
        const file = path.join(brainDir, `${SLUG}.md`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, serializePageToMarkdown(snapshot.page, snapshot.tags));
        await runExtractFacts(engine, { sourceId: 'default', brainDir });
        await run({ engine, brainDir, file, home });
      } finally { await close(); }
    });
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
}
