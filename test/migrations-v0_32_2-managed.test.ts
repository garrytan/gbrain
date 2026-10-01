/**
 * v0.32.2 fence backfill on a managed brain.
 *
 * Protects: on a managed brain the backfill publishes each entity page's
 * facts fence through the coordinator and adopts the legacy fact rows in
 * place (managed_maintenance_adopt_fact_fence), for file-backed and
 * database-only pages alike.
 * Fails when: the phase writes fence files into the managed worktree or
 * runs a raw `UPDATE facts` (the managed writer guard refuses it and the
 * orchestrator chain wedges), when adoption inserts duplicate rows instead
 * of keeping the legacy ids and vectors, or when it expires a
 * conversation-extractor row on the same page.
 * Seams: none; `managedBrain` and the migration's exported `__testing` phases.
 */
import { expect, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { __testing } from '../src/commands/migrations/v0_32_2.ts';
import type { OrchestratorOpts } from '../src/commands/migrations/types.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { parseFactsFence, renderFactsTable, replaceOrInsertFactsFence } from '../src/core/facts-fence.ts';
import { serializePageToMarkdown } from '../src/core/markdown.ts';
import { maintenancePreflight, submitFactFenceAdoption } from '../src/core/persistence/prepared-maintenance.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { LEGACY_DB_ONLY_SLUG, LEGACY_FILE_SLUG, seedLegacyManagedContent, type LegacySeed } from './helpers/managed-legacy-fixture.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const OPTS: OrchestratorOpts = { yes: true, dryRun: false, noAutopilotInstall: true };

async function factRows(engine: BrainEngine, ids: number[]) {
  return engine.executeRaw<Record<string, unknown>>(
    `SELECT id, row_num, source_markdown_slug, fact, expired_at, embedding::text AS embedding, embedded_at::text AS embedded_at,
            source_session, confidence, notability, context, (extract(epoch FROM valid_from))::bigint AS valid_from_epoch FROM facts WHERE id = ANY($1::integer[]) ORDER BY id`, [ids]);
}

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  test(`${backend}: legacy facts are fenced through the coordinator and adopted in place`, async () => {
    let seed!: LegacySeed;
    await managedBrain(async ({ engine, root }) => {
      const adopted = [...seed.legacyFactIds, ...seed.dbOnlyFactIds];
      const before = await factRows(engine, [...adopted, seed.extractorFactId]);
      const [{ n: factCount }] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM facts');

      const phase = await __testing.phaseBFenceFacts(engine, OPTS);
      expect(phase).toMatchObject({ name: 'fence_facts', status: 'complete' });
      expect(phase.detail).toContain('scanned=3 fenced=3 pages=2');
      expect(await __testing.phaseCVerify(engine, OPTS)).toMatchObject({ status: 'complete', detail: 'pages_checked=2' });

      const after = await factRows(engine, [...adopted, seed.extractorFactId]);
      expect(after.map(r => [Number(r.id), r.row_num, r.source_markdown_slug, r.expired_at])).toEqual([
        [seed.legacyFactIds[0], 2, LEGACY_FILE_SLUG, null],
        [seed.legacyFactIds[1], 3, LEGACY_FILE_SLUG, null],
        [seed.dbOnlyFactIds[0], 1, LEGACY_DB_ONLY_SLUG, null],
        [seed.extractorFactId, 1, LEGACY_FILE_SLUG, null],
      ]);
      for (let i = 0; i < after.length; i++) {
        for (const key of ['fact', 'embedding', 'embedded_at', 'source_session', 'confidence', 'notability', 'context', 'valid_from_epoch']) {
          expect(after[i][key]).toEqual(before[i][key]);
        }
      }
      expect((await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM facts'))[0].n).toBe(factCount);

      const file = readFileSync(join(root, `${LEGACY_FILE_SLUG}.md`), 'utf8');
      expect(parseFactsFence(file).facts.map(f => [f.rowNum, f.claim])).toEqual([
        [2, 'Alice example founded Acme example'], [3, 'Alice example moved to Lisbon']]);
      const dbOnly = (await engine.readPageSnapshot(LEGACY_DB_ONLY_SLUG, { sourceId: 'default' }))!;
      expect(parseFactsFence(dbOnly.page.compiled_truth).facts.map(f => f.rowNum)).toEqual([1]);
      expect(existsSync(join(root, `${LEGACY_DB_ONLY_SLUG}.md`))).toBe(false);

      expect(await engine.executeRaw('SELECT row_num, resolved_quality, resolved_by FROM takes t JOIN pages p ON p.id=t.page_id WHERE p.slug=$1 ORDER BY row_num',
        [LEGACY_FILE_SLUG])).toEqual([{ row_num: 1, resolved_quality: 'correct', resolved_by: 'people/alice-example' },
        { row_num: 2, resolved_quality: null, resolved_by: null }]);

      const authority = (await maintenancePreflight(engine, 'default'))!;
      const page = (await engine.readPageSnapshot(LEGACY_FILE_SLUG, { sourceId: 'default' }))!;
      const readopt = replaceOrInsertFactsFence(serializePageToMarkdown(page.page, page.tags), renderFactsTable([...parseFactsFence(file).facts,
        { rowNum: 9, claim: 'Alice example founded Acme example', kind: 'fact', confidence: 0.9, visibility: 'world', notability: 'high', active: true }]));
      await expect(submitFactFenceAdoption(engine, authority, LEGACY_FILE_SLUG, { content: readopt, expectedRevision: page.revision,
        assignments: [{ id: seed.legacyFactIds[0], row_num: 9 }], file: true })).rejects.toMatchObject({ code: 'revision_conflict' });

      const rerun = await __testing.phaseBFenceFacts(engine, OPTS);
      expect(rerun).toMatchObject({ status: 'complete' });
      expect(rerun.detail).toContain('scanned=0 fenced=0 pages=0');
      expect(await factRows(engine, [...adopted, seed.extractorFactId])).toEqual(after);
    }, { databaseUrl, setup: async ({ engine, root }) => {
      seed = await seedLegacyManagedContent(engine, root);
      // A take graded only in the database, as a pre-activation grader left it.
      const [{ id }] = await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE slug=$1', [LEGACY_FILE_SLUG]);
      await engine.addTakesBatch([{ page_id: id, row_num: 1, claim: 'Acme example raised a seed round', kind: 'fact', holder: 'world',
        weight: 1, since_date: '2026-01', source: 'press note', active: true, superseded_by: null }]);
      await engine.resolveTake(id, 1, { quality: 'correct', source: 'grader note', resolvedBy: 'people/alice-example' });
    } });
  }, 120_000);

  test(`${backend}: a refused adoption is retried under a new request identity once the file is restored`, async () => {
    let seed!: LegacySeed;
    await managedBrain(async ({ engine, root }) => {
      const path = join(root, `${LEGACY_FILE_SLUG}.md`);
      const file = readFileSync(path, 'utf8');
      writeFileSync(path, `${file}\nAn uncoordinated local edit.\n`);
      const refused = await __testing.phaseBFenceFacts(engine, OPTS);
      expect(refused.status).toBe('failed');
      expect(refused.detail).toContain('uncoordinated local edit');
      writeFileSync(path, file);
      const retried = await __testing.phaseBFenceFacts(engine, OPTS);
      expect(retried).toMatchObject({ status: 'complete' });
      expect(retried.detail).toContain('scanned=2 fenced=2 pages=1');
    }, { databaseUrl, setup: async ({ engine, root }) => { seed = await seedLegacyManagedContent(engine, root); } });
  }, 120_000);

  test(`${backend}: the adoption intent refuses a taken position and a duplicate assignment, changing nothing`, async () => {
    let seed!: LegacySeed;
    await managedBrain(async ({ engine, root }) => {
      const authority = (await maintenancePreflight(engine, 'default'))!;
      const snapshot = (await engine.readPageSnapshot(LEGACY_FILE_SLUG, { sourceId: 'default' }))!;
      const file = readFileSync(join(root, `${LEGACY_FILE_SLUG}.md`), 'utf8');
      const before = await factRows(engine, [...seed.legacyFactIds, seed.extractorFactId]);
      const content = replaceOrInsertFactsFence(serializePageToMarkdown(snapshot.page, snapshot.tags), renderFactsTable([
        { rowNum: 1, claim: 'Alice example founded Acme example', kind: 'fact', confidence: 0.9, visibility: 'world', notability: 'high', active: true }]));
      const attempt = (assignments: Array<{ id: number; row_num: number }>) => submitFactFenceAdoption(engine, authority, LEGACY_FILE_SLUG,
        { content, expectedRevision: snapshot.revision, assignments, file: true });
      await expect(attempt([{ id: seed.legacyFactIds[0], row_num: 1 }])).rejects.toMatchObject({ code: 'revision_conflict' });
      await expect(attempt([{ id: seed.legacyFactIds[1], row_num: 1 }])).rejects.toMatchObject({ code: 'invalid_params' });
      await expect(attempt([{ id: seed.legacyFactIds[0], row_num: 1 }, { id: seed.legacyFactIds[1], row_num: 1 }]))
        .rejects.toMatchObject({ code: 'invalid_params' });
      expect(await factRows(engine, [...seed.legacyFactIds, seed.extractorFactId])).toEqual(before);
      expect(readFileSync(join(root, `${LEGACY_FILE_SLUG}.md`), 'utf8')).toBe(file);
    }, { databaseUrl, setup: async ({ engine, root }) => { seed = await seedLegacyManagedContent(engine, root); } });
  }, 120_000);

  test(`${backend}: exhausted request IDs refuse the adoption up front with the capacity command`, async () => {
    let seed!: LegacySeed;
    await managedBrain(async ({ engine, root }) => {
      const before = await factRows(engine, [...seed.legacyFactIds, ...seed.dbOnlyFactIds]);
      const file = readFileSync(join(root, `${LEGACY_FILE_SLUG}.md`), 'utf8');
      const phase = await __testing.phaseBFenceFacts(engine, OPTS);
      expect(phase).toMatchObject({ name: 'fence_facts', status: 'failed' });
      expect(phase.detail).toStartWith('queue_capacity: Write capacity exhausted: principal permanent request IDs (0 used of 0).');
      expect(phase.detail).toContain('gbrain config set persistence.limits.principal_lifetime_ids ');
      expect(await factRows(engine, [...seed.legacyFactIds, ...seed.dbOnlyFactIds])).toEqual(before);
      expect(readFileSync(join(root, `${LEGACY_FILE_SLUG}.md`), 'utf8')).toBe(file);
      expect(await engine.executeRaw("SELECT id FROM persistence_requests WHERE operation='submit_job'")).toEqual([]);
    }, { databaseUrl, setup: async ({ engine, root }) => {
      seed = await seedLegacyManagedContent(engine, root);
      await engine.setConfig('persistence.limits.principal_lifetime_ids', '0');
    } });
  }, 120_000);

  test(`${backend}: an archived source's legacy facts are skipped and never block the active source`, async () => {
    let seed!: LegacySeed;
    await managedBrain(async ({ engine }) => {
      const phase = await __testing.phaseBFenceFacts(engine, OPTS);
      expect(phase).toMatchObject({ name: 'fence_facts', status: 'complete' });
      expect(phase.detail).toContain('fenced=3 pages=2');
      expect(phase.detail).toContain('skipped_archived=1');
      expect((await factRows(engine, seed.legacyFactIds)).map(r => r.row_num)).toEqual([2, 3]);
    }, { databaseUrl, setup: async ({ engine, root }) => {
      seed = await seedLegacyManagedContent(engine, root);
      await engine.executeRaw("INSERT INTO sources (id, name, archived) VALUES ('archived-example', 'Archived example', true)");
      await engine.putPage('people/erin-example', { type: 'person', title: 'Erin Example', compiled_truth: '# Erin Example' }, { sourceId: 'archived-example' });
      await engine.executeRaw(`INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability, valid_from, source, confidence)
        VALUES ('archived-example', 'people/erin-example', 'Erin example left Acme example', 'fact', 'world', 'medium', now(), 'mcp:put_page', 0.8)`);
    } });
  }, 120_000);
}
