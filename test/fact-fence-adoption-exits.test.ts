/**
 * #6650: the fact-fence adoption no longer leaks, loops or blocks.
 *
 * Protects:
 * - A leftover fence cell the adoption reuses is re-rendered from the legacy
 *   row, so a stale world cell never publishes a private legacy fact as world
 *   and a stale cell never overwrites the fact's kind or validity; a private
 *   cell is never widened to world (the world row appends instead).
 * - Planner and publisher share one read-back predicate.
 * - A deterministic refusal of the same intent is not resubmitted within a
 *   day, so cycles stop minting identical failed requests; a day later, or a
 *   changed adoption planner, retries once.
 * - One unadoptable legacy row no longer stops the phantom-redirect pass for
 *   the whole source; only a phantom that owns legacy rows is held.
 * Seams: planFence against an engine stub, the managed-brain helper for the
 * coordinator path, PGLite for the extract_facts cycle.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { fenceCellReadBackProblem, parseFactsFence, renderFactsTable, replaceOrInsertFactsFence, type ParsedFact } from '../src/core/facts-fence.ts';
import { fenceUnfencedFacts, planFence, planUnfencedFacts, type UnfencedFactRow } from '../src/core/facts/unfenced-facts.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import { serializePageToMarkdown } from '../src/core/markdown.ts';
import { FACT_FENCE_PLANNER, maintenancePreflight, submitFactFenceAdoption } from '../src/core/persistence/prepared-maintenance.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { declarePersistenceProtocol } from '../src/core/persistence/protocol.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { LEGACY_FILE_SLUG, seedLegacyManagedContent, type LegacySeed } from './helpers/managed-legacy-fixture.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
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
