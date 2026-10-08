/**
 * #5299: the extract_facts cycle phase fences unfenced fact rows itself.
 *
 * Protects: after ONE cycle, every active `row_num IS NULL` fact on a live
 * entity page is appended to that page's `## Facts` fence with a row number,
 * the DB rows carry those row numbers, the guard count is 0 and the phase
 * reconciles in the same run (status ok, no warning); a second cycle changes
 * nothing. Rows that are structurally unfenceable (no backing page, NULL
 * entity slug) are left exactly as they were. Unmanaged brains write the file
 * and mirror it into `pages`; managed brains publish through the coordinator.
 * Fails when: the phase only counts the rows and skips with a warn telling the
 * operator to re-run the v0.32.2 migration (the pre-#5299 behavior), when a
 * fenced row's number differs between the file and the DB, or when the fence
 * step re-appends rows on a second run.
 * Why existing coverage misses it: the migration tests exercise Phase B
 * directly, and the extract_facts guard tests only cover rows that cannot be
 * fenced (no canonical file).
 * Seams: none; real PGLite (and Postgres through the e2e registration),
 * `runCycle` with `phases: ['extract_facts']`, the shared `managedBrain` and
 * legacy managed fixture.
 *
 * #6278 (plan 2.1, 2.2, Decision 57): the fence codec is the adoption's
 * oracle. Protects: a legacy claim with surrounding whitespace or CRLF is
 * adopted with the fence's parsed text written back into `facts.fact` under
 * the SAME id (vectors and provenance kept, no second row inserted); a row
 * the codec would change further (whitespace-only, `~~x~~`, a literal
 * `<br>`) or whose normalized claim and source the page already carries is
 * left exactly as it was (row_num NULL, active, text byte-identical),
 * recorded by location in the stable `FACTS_FENCE_FAILED: <slug>
 * (fence_unrenderable: N row(s), <class>; duplicate_claim: N row(s))` token,
 * while the other rows of the page still adopt; only that page skips
 * destructive reconciliation, another page in the same run reconciles; a
 * withdrawal recorded against the normalized claim still expires the adopted
 * row (the trigger fires on `UPDATE OF fact`); a second cycle changes
 * nothing. Fails when: the adoption refuses the whole page (the pre-#6278
 * `invalid_params` round-trip mismatch, nine refusals per pass in #6278),
 * the write-back is missing (the projection expires the adopted row and
 * inserts a new id), a rejected row is deleted, expired or rewritten, or the
 * source-wide guard skips every page.
 */
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { runCycle } from '../src/core/cycle.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { parseFactsFence } from '../src/core/facts-fence.ts';
import { serializePageToMarkdown } from '../src/core/markdown.ts';
import { managedPersistenceEnabled } from '../src/core/persistence/ownership.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { LEGACY_DB_ONLY_SLUG, LEGACY_FILE_SLUG, seedLegacyManagedContent, type LegacySeed } from './helpers/managed-legacy-fixture.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const SLUG = 'people/alice-example';

/** The guard's own predicate: unfenced active rows on a live page of a source with a checkout. */
async function pendingCount(engine: BrainEngine, sourceId = 'default'): Promise<number> {
  const [row] = await engine.executeRaw<{ n: number }>(
    `SELECT count(*)::int AS n FROM facts f
      WHERE f.source_id = $1 AND f.row_num IS NULL AND f.entity_slug IS NOT NULL AND f.expired_at IS NULL
        AND EXISTS (SELECT 1 FROM pages p WHERE p.source_id = f.source_id AND p.slug = f.entity_slug AND p.deleted_at IS NULL)
        AND EXISTS (SELECT 1 FROM sources s WHERE s.id = f.source_id AND s.local_path IS NOT NULL)`, [sourceId]);
  return Number(row.n);
}

async function factState(engine: BrainEngine) {
  return engine.executeRaw<{ id: number; entity_slug: string | null; fact: string; row_num: number | null; source_markdown_slug: string | null; expired: boolean }>(
    `SELECT id, entity_slug, fact, row_num, source_markdown_slug, expired_at IS NOT NULL AS expired FROM facts ORDER BY id`);
}

async function extractFactsPhase(engine: BrainEngine, root: string) {
  const report = await runCycle(engine, { brainDir: root, sourceId: 'default', phases: ['extract_facts'] });
  return report.phases.find(p => p.phase === 'extract_facts')!;
}

const FENCE_ROW_1 = `## Facts

<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
| 1 | Alice example joined Acme example | fact | 1.0 | world | high | 2024-01-01 |  | linkedin |  |
<!--- gbrain:facts:end -->
`;

/** An unmanaged brain whose default source checkout holds one entity page with one indexed fence row, plus unfenced rows. */
async function unmanagedBrain(databaseUrl: string | undefined, run: (brain: { engine: BrainEngine; root: string }) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-unfenced-home-'));
  try {
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
      try {
        expect(await managedPersistenceEnabled(engine)).toBe(false);
        const root = join(home, 'brain');
        mkdirSync(root, { recursive: true });
        await engine.executeRaw("UPDATE sources SET local_path = $1 WHERE id = 'default'", [root]);
        const page = await engine.putPage(SLUG, { type: 'person', title: 'Alice Example', compiled_truth: `# Alice Example\n\nProse.\n\n${FENCE_ROW_1}` });
        await engine.executeRaw('UPDATE pages SET source_path = $1 WHERE id = $2', [`${SLUG}.md`, page.id]);
        const snapshot = (await engine.readPageSnapshot(SLUG, { sourceId: 'default' }))!;
        const path = join(root, `${SLUG}.md`);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, serializePageToMarkdown(snapshot.page, snapshot.tags));
        // The fence row already indexed, as an earlier reconcile left it.
        await engine.executeRaw(
          `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability, valid_from, source, confidence, row_num, source_markdown_slug)
           VALUES ('default', $1, 'Alice example joined Acme example', 'fact', 'world', 'high', '2024-01-01', 'linkedin', 1.0, 1, $1)`, [SLUG]);
        // Rows the inline writer's DB-only fallback produced (row_num NULL).
        await engine.executeRaw(
          `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability, valid_from, source, confidence)
           VALUES ('default', $1, 'Alice example moved to Lisbon', 'fact', 'private', 'medium', '2026-02-05T13:45:12Z', 'mcp:remember', 0.9),
                  ('default', $1, 'Alice example prefers async updates', 'preference', 'private', 'medium', '2026-03-01', 'mcp:remember', 0.8),
                  ('default', 'people-jane-doe', 'Unfenceable: no backing page', 'fact', 'private', 'medium', now(), 'mcp:remember', 1.0),
                  ('default', NULL, 'Unfenceable: no entity', 'fact', 'private', 'medium', now(), 'mcp:remember', 1.0)`, [SLUG]);
        await run({ engine, root });
      } finally { await close(); }
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

/** Legacy rows in every shape the fence codec changes (#6278), on `slug`; returns ids keyed by shape. */
async function seedCodecShapes(engine: BrainEngine, slug: string, source = 'mcp:remember'): Promise<Record<string, number>> {
  const shapes: Record<string, string> = {
    trailing: 'Alice example likes tea ',
    crlf: 'Alice example works\r\nremotely',
    nbsp: '\u00a0Alice example runs marathons',
    whitespace_only: '   ',
    struck: '~~Alice example left Acme example~~',
    br: 'Alice example<br>uses tabs',
    duplicate: 'Alice example likes tea',
  };
  const ids: Record<string, number> = {};
  for (const [shape, fact] of Object.entries(shapes)) {
    const [row] = await engine.executeRaw<{ id: number }>(
      `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability, valid_from, source, confidence, context)
       VALUES ('default', $1, $2, 'fact', 'world', 'medium', '2026-03-01', $3, 0.8, 'from a call') RETURNING id`, [slug, fact, source]);
    ids[shape] = Number(row.id);
  }
  return ids;
}

const UNADOPTABLE_TOKEN = (slug: string) => `FACTS_FENCE_FAILED: ${slug} (fence_unrenderable: 3 row(s), empty, line_break_markup, struck; duplicate_claim: 1 row(s))`;

async function rowsById(engine: BrainEngine, ids: number[]) {
  return engine.executeRaw<{ id: number; fact: string; row_num: number | null; source_markdown_slug: string | null; expired: boolean; embedding: string | null; source_session: string | null }>(
    `SELECT id, fact, row_num, source_markdown_slug, expired_at IS NOT NULL AS expired, embedding::text AS embedding, source_session
       FROM facts WHERE id = ANY($1::integer[]) ORDER BY id`, [ids]);
}

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;

  test(`${backend}: unmanaged: codec shapes: whitespace rows adopt with normalized text under their ids, the rest stay legacy rows, the other page still reconciles`, async () => {
    await unmanagedBrain(databaseUrl, async ({ engine, root }) => {
      const ids = await seedCodecShapes(engine, SLUG);
      // A second page with a stale fence-owned row only the reconcile walk can expire.
      const OTHER = 'companies/acme-example';
      const other = await engine.putPage(OTHER, { type: 'company', title: 'Acme Example', compiled_truth: `# Acme Example\n\n${FENCE_ROW_1.replace('Alice example joined Acme example', 'Acme example ships widgets')}` });
      await engine.executeRaw('UPDATE pages SET source_path = $1 WHERE id = $2', [`${OTHER}.md`, other.id]);
      const otherSnapshot = (await engine.readPageSnapshot(OTHER, { sourceId: 'default' }))!;
      mkdirSync(dirname(join(root, `${OTHER}.md`)), { recursive: true });
      writeFileSync(join(root, `${OTHER}.md`), serializePageToMarkdown(otherSnapshot.page, otherSnapshot.tags));
      const [stale] = await engine.executeRaw<{ id: number }>(
        `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability, valid_from, source, confidence, row_num, source_markdown_slug)
         VALUES ('default', $1, 'Acme example used to ship gadgets', 'fact', 'world', 'high', '2024-01-01', 'linkedin', 1.0, 9, $1) RETURNING id`, [OTHER]);
      const before = await rowsById(engine, Object.values(ids));
      const [{ n: factCount }] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM facts');

      const first = await extractFactsPhase(engine, root);
      expect(first.status).toBe('warn');
      expect(first.details).toMatchObject({ legacyRowsPending: 4, unfencedRowsFenced: 5 });
      expect(first.summary).toMatch(new RegExp(`^[1-9]\\d* fact\\(s\\) reconciled across [1-9]\\d* page\\(s\\); skipped 1 page\\(s\\) holding 4 unfenced fact row\\(s\\) that could not be fenced: ${SLUG} `));
      const warnings = (first.details as { warnings: string[] }).warnings;
      expect(warnings).toContain(UNADOPTABLE_TOKEN(SLUG));
      // Location only: no rejected claim text reaches the warnings.
      expect(warnings.join('\n')).not.toContain('left Acme example');
      expect(warnings.join('\n')).not.toContain('uses tabs');

      const file = readFileSync(join(root, `${SLUG}.md`), 'utf8');
      expect(parseFactsFence(file).facts.map(f => [f.rowNum, f.claim])).toEqual([
        [1, 'Alice example joined Acme example'], [2, 'Alice example moved to Lisbon'], [3, 'Alice example prefers async updates'],
        [4, 'Alice example likes tea'], [5, 'Alice example works\nremotely'], [6, 'Alice example runs marathons'],
      ]);
      const after = await rowsById(engine, Object.values(ids));
      const byId = new Map(after.map(r => [Number(r.id), r]));
      // Adopted under the same id, with the fence's parsed text written back.
      expect(byId.get(ids.trailing)).toMatchObject({ fact: 'Alice example likes tea', row_num: 4, source_markdown_slug: SLUG, expired: false });
      expect(byId.get(ids.crlf)).toMatchObject({ fact: 'Alice example works\nremotely', row_num: 5, source_markdown_slug: SLUG, expired: false });
      expect(byId.get(ids.nbsp)).toMatchObject({ fact: 'Alice example runs marathons', row_num: 6, source_markdown_slug: SLUG, expired: false });
      // Rejected rows are exactly as they were.
      for (const shape of ['whitespace_only', 'struck', 'br', 'duplicate']) {
        expect(byId.get(ids[shape])).toEqual(before.find(r => Number(r.id) === ids[shape])!);
        expect(byId.get(ids[shape])!.row_num).toBeNull();
        expect(byId.get(ids[shape])!.expired).toBe(false);
      }
      // No row was inserted for an adopted claim (the write-back keeps the projection from re-deriving it).
      const [{ n: afterCount }] = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM facts');
      expect(afterCount).toBe(factCount + 1); // the acme page's fence row, inserted by the reconcile below
      // The other page reconciled in the same run: its stale row expired, its fence row indexed.
      const [staleRow] = await engine.executeRaw<{ expired: boolean; row_num: number | null }>('SELECT expired_at IS NOT NULL AS expired, row_num FROM facts WHERE id = $1', [stale.id]);
      expect(staleRow).toMatchObject({ expired: true, row_num: null });
      expect(await engine.executeRaw('SELECT 1 FROM facts WHERE source_markdown_slug = $1 AND row_num = 1 AND expired_at IS NULL', [OTHER])).toHaveLength(1);

      const second = await extractFactsPhase(engine, root);
      expect(second.status).toBe('warn');
      expect(second.details).toMatchObject({ legacyRowsPending: 4, unfencedRowsFenced: 0 });
      expect((second.details as { warnings: string[] }).warnings).toContain(UNADOPTABLE_TOKEN(SLUG));
      expect(readFileSync(join(root, `${SLUG}.md`), 'utf8')).toBe(file);
      expect(await rowsById(engine, Object.values(ids))).toEqual(after);
    });
  }, 120_000);

  test(`${backend}: managed: codec shapes adopt through the coordinator under their ids with normalized text, rejected rows stay, another page reconciles, a withdrawal still matches`, async () => {
    let seed!: LegacySeed;
    let ids!: Record<string, number>;
    let withdrawnId!: number;
    let staleId!: number;
    const OTHER = 'people/bob-example';
    await managedBrain(async ({ engine: managed, root: managedRoot }) => {
      const before = await rowsById(managed, [...Object.values(ids), withdrawnId]);
      const first = await extractFactsPhase(managed, managedRoot);
      expect(first.status).toBe('warn');
      expect(first.details).toMatchObject({ legacyRowsPending: 4, unfencedRowsFenced: 7 });
      expect((first.details as { warnings: string[] }).warnings).toContain(UNADOPTABLE_TOKEN(LEGACY_FILE_SLUG));

      const after = await rowsById(managed, [...Object.values(ids), withdrawnId]);
      const byId = new Map(after.map(r => [Number(r.id), r]));
      expect(byId.get(ids.trailing)).toMatchObject({ fact: 'Alice example likes tea', source_markdown_slug: LEGACY_FILE_SLUG, expired: false });
      expect(byId.get(ids.crlf)).toMatchObject({ fact: 'Alice example works\nremotely', source_markdown_slug: LEGACY_FILE_SLUG, expired: false });
      expect(byId.get(ids.nbsp)).toMatchObject({ fact: 'Alice example runs marathons', source_markdown_slug: LEGACY_FILE_SLUG, expired: false });
      for (const shape of ['trailing', 'crlf', 'nbsp']) expect(byId.get(ids[shape])!.row_num).not.toBeNull();
      for (const shape of ['whitespace_only', 'struck', 'br', 'duplicate']) {
        expect(byId.get(ids[shape])).toEqual(before.find(r => Number(r.id) === ids[shape])!);
      }
      // The seeded legacy rows (with vectors) adopted in place too.
      const seeded = await rowsById(managed, seed.legacyFactIds);
      expect(seeded.every(r => r.row_num !== null && !r.expired && r.embedding !== null)).toBe(true);
      // The withdrawal recorded against the normalized claim fires on the write-back: adopted, then expired by the trigger.
      expect(byId.get(withdrawnId)).toMatchObject({ fact: 'Alice example drinks tea', source_markdown_slug: LEGACY_FILE_SLUG, expired: true });
      expect(byId.get(withdrawnId)!.row_num).not.toBeNull();
      // The file carries the normalized claims and none of the rejected ones.
      const file = readFileSync(join(managedRoot, `${LEGACY_FILE_SLUG}.md`), 'utf8');
      const claims = parseFactsFence(file).facts.map(f => f.claim);
      expect(claims).toEqual(expect.arrayContaining(['Alice example likes tea', 'Alice example works\nremotely', 'Alice example runs marathons', 'Alice example drinks tea']));
      expect(claims.filter(c => c === 'Alice example likes tea')).toHaveLength(1);
      expect(claims.some(c => c.includes('left Acme') || c.includes('uses tabs') || c === '')).toBe(false);
      // No second fence-owned row for any adopted claim (the legacy duplicate keeps its text, unfenced).
      expect(await managed.executeRaw(`SELECT id FROM facts WHERE fact = 'Alice example likes tea' AND row_num IS NOT NULL`)).toHaveLength(1);
      expect((await managed.executeRaw<{ id: number }>(`SELECT id FROM facts WHERE fact = 'Alice example likes tea' AND row_num IS NULL`)).map(r => Number(r.id))).toEqual([ids.duplicate]);
      // Another page of the source reconciled in the same run.
      const [staleRow] = await managed.executeRaw<{ expired: boolean }>('SELECT expired_at IS NOT NULL AS expired FROM facts WHERE id = $1', [staleId]);
      expect(staleRow.expired).toBe(true);

      const second = await extractFactsPhase(managed, managedRoot);
      expect(second.details).toMatchObject({ legacyRowsPending: 4, unfencedRowsFenced: 0 });
      expect(await rowsById(managed, [...Object.values(ids), withdrawnId])).toEqual(after);
      expect(readFileSync(join(managedRoot, `${LEGACY_FILE_SLUG}.md`), 'utf8')).toBe(file);
    }, { databaseUrl, setup: async ({ engine: managed, root: managedRoot }) => {
      seed = await seedLegacyManagedContent(managed, managedRoot);
      ids = await seedCodecShapes(managed, LEGACY_FILE_SLUG);
      const [withdrawn] = await managed.executeRaw<{ id: number }>(
        `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability, valid_from, source, confidence)
         VALUES ('default', $1, '  Alice example drinks tea  ', 'fact', 'world', 'medium', '2026-03-01', 'mcp:remember', 0.8) RETURNING id`, [LEGACY_FILE_SLUG]);
      withdrawnId = Number(withdrawn.id);
      await managed.executeRaw(`INSERT INTO fact_withdrawals (source_id, visibility, subject, fact_hash, withdrawn_at)
        VALUES ('default', 'world', '*', gbrain_fact_fingerprint('Alice example drinks tea'), '2026-04-01T00:00:00Z')`);
      const page = await managed.putPage(OTHER, { type: 'person', title: 'Bob Example', compiled_truth: `# Bob Example\n\n${FENCE_ROW_1.replace('Alice example joined Acme example', 'Bob example advises Acme example')}` });
      await managed.executeRaw('UPDATE pages SET source_path=$1 WHERE id=$2', [`${OTHER}.md`, page.id]);
      const snapshot = (await managed.readPageSnapshot(OTHER, { sourceId: 'default' }))!;
      mkdirSync(dirname(join(managedRoot, `${OTHER}.md`)), { recursive: true });
      writeFileSync(join(managedRoot, `${OTHER}.md`), serializePageToMarkdown(snapshot.page, snapshot.tags));
      const [stale] = await managed.executeRaw<{ id: number }>(
        `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, notability, valid_from, source, confidence, row_num, source_markdown_slug)
         VALUES ('default', $1, 'Bob example used to advise Widget co', 'fact', 'world', 'high', '2024-01-01', 'linkedin', 1.0, 9, $1) RETURNING id`, [OTHER]);
      staleId = Number(stale.id);
    } });
  }, 180_000);

  test(`${backend}: unmanaged: one cycle fences row_num-NULL facts onto the page file, reconciles, and a second cycle changes nothing`, async () => {
    await unmanagedBrain(databaseUrl, async ({ engine, root }) => {
      expect(await pendingCount(engine)).toBe(2);

      const first = await extractFactsPhase(engine, root);
      expect(first.status).toBe('ok');
      expect(first.details).toMatchObject({ unfencedRowsFenced: 2, pagesFailed: 0 });
      expect(await pendingCount(engine)).toBe(0);

      const file = readFileSync(join(root, `${SLUG}.md`), 'utf8');
      expect(parseFactsFence(file).facts.map(f => [f.rowNum, f.claim])).toEqual([
        [1, 'Alice example joined Acme example'],
        [2, 'Alice example moved to Lisbon'],
        [3, 'Alice example prefers async updates'],
      ]);
      // The pages cache carries the same fence, so get_page and the reconcile agree with the file.
      const cached = (await engine.getPage(SLUG, { sourceId: 'default' }))!;
      expect(parseFactsFence(cached.compiled_truth).facts.map(f => f.rowNum)).toEqual([1, 2, 3]);

      const after = await factState(engine);
      expect(after.map(r => [r.fact, r.row_num, r.source_markdown_slug, r.expired])).toEqual([
        ['Alice example joined Acme example', 1, SLUG, false],
        ['Alice example moved to Lisbon', 2, SLUG, false],
        ['Alice example prefers async updates', 3, SLUG, false],
        ['Unfenceable: no backing page', null, null, false],
        ['Unfenceable: no entity', null, null, false],
      ]);

      const second = await extractFactsPhase(engine, root);
      expect(second.status).toBe('ok');
      expect(second.details).toMatchObject({ unfencedRowsFenced: 0, factsInserted: 0, factsDeleted: 0 });
      expect(readFileSync(join(root, `${SLUG}.md`), 'utf8')).toBe(file);
      expect(await factState(engine)).toEqual(after);
    });
  }, 120_000);

  test(`${backend}: unmanaged: a page whose canonical file is missing keeps its rows unfenced and is named in the warning`, async () => {
    await unmanagedBrain(databaseUrl, async ({ engine, root }) => {
      rmSync(join(root, `${SLUG}.md`));
      const before = await factState(engine);
      const result = await extractFactsPhase(engine, root);
      expect(result.status).toBe('warn');
      expect(result.summary).toBe(`0 fact(s) reconciled across 0 page(s); skipped 1 page(s) holding 2 unfenced fact row(s) that could not be fenced: ${SLUG} (2 warning(s))`);
      const warnings = (result.details as { warnings: string[] }).warnings;
      expect(warnings.some(w => w.startsWith(`FACTS_FENCE_FAILED: ${SLUG} (canonical file `) && w.includes('does not exist on this host'))).toBe(true);
      expect(warnings.some(w => w.includes('v0.31') || w.includes('force-retry'))).toBe(false);
      expect(await factState(engine)).toEqual(before);
    });
  }, 120_000);

  test(`${backend}: managed: one cycle fences row_num-NULL facts through the coordinator and a second cycle changes nothing`, async () => {
    let seed!: LegacySeed;
    await managedBrain(async ({ engine: managed, root: managedRoot }) => {
      expect(await pendingCount(managed)).toBe(3);
      const first = await extractFactsPhase(managed, managedRoot);
      expect(first.status).toBe('ok');
      expect(first.details).toMatchObject({ unfencedRowsFenced: 3, pagesFailed: 0 });
      expect(await pendingCount(managed)).toBe(0);

      const rows = await managed.executeRaw<{ id: number; row_num: number; source_markdown_slug: string; expired: boolean }>(
        'SELECT id, row_num, source_markdown_slug, expired_at IS NOT NULL AS expired FROM facts WHERE id = ANY($1::integer[]) ORDER BY id',
        [[...seed.legacyFactIds, ...seed.dbOnlyFactIds]]);
      expect(rows.map(r => [Number(r.id), r.row_num, r.source_markdown_slug, r.expired])).toEqual([
        [seed.legacyFactIds[0], 2, LEGACY_FILE_SLUG, false],
        [seed.legacyFactIds[1], 3, LEGACY_FILE_SLUG, false],
        [seed.dbOnlyFactIds[0], 1, LEGACY_DB_ONLY_SLUG, false],
      ]);
      const file = readFileSync(join(managedRoot, `${LEGACY_FILE_SLUG}.md`), 'utf8');
      expect(parseFactsFence(file).facts.map(f => [f.rowNum, f.claim])).toEqual([
        [2, 'Alice example founded Acme example'], [3, 'Alice example moved to Lisbon']]);
      const dbOnly = (await managed.readPageSnapshot(LEGACY_DB_ONLY_SLUG, { sourceId: 'default' }))!;
      expect(parseFactsFence(dbOnly.page.compiled_truth).facts.map(f => [f.rowNum, f.claim])).toEqual([[1, 'Dana example advises Widget co']]);

      const facts = await managed.executeRaw('SELECT id, row_num, fact, expired_at FROM facts ORDER BY id');
      const [{ n: requests }] = await managed.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM persistence_requests');
      const second = await extractFactsPhase(managed, managedRoot);
      expect(second.status).toBe('ok');
      expect(second.details).toMatchObject({ unfencedRowsFenced: 0, factsInserted: 0, factsDeleted: 0 });
      expect(await managed.executeRaw('SELECT id, row_num, fact, expired_at FROM facts ORDER BY id')).toEqual(facts);
      expect(readFileSync(join(managedRoot, `${LEGACY_FILE_SLUG}.md`), 'utf8')).toBe(file);
      expect((await managed.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM persistence_requests'))[0].n).toBe(requests);
    }, { databaseUrl, setup: async ({ engine: managed, root: managedRoot }) => { seed = await seedLegacyManagedContent(managed, managedRoot); } });
  }, 120_000);
}
