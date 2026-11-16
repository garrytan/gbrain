/**
 * GST-2497: saving a fact to a holding page (memory/unattributed, or a folder's <folder>/memory/unattributed).
 *
 * 1. Protects: one save parses the holding page's facts table a bounded number of times, however many readers of the
 *    body run during the write (the withdrawal overlay, the chunker, the remote-read strip, the refusal scan).
 * 2. Fails when: a save on a page of a few hundred rows parses the full table more than three times.
 * 3. Existing coverage: test/facts-fence.test.ts (the parser), test/remember-strict-held-gst2492.test.ts (the shared page).
 * 4. Real seams: the coordinated write and the write door on PGLite and Postgres (DATABASE_URL), a managed Git checkout,
 *    the operation handler as the local CLI calls it, and the parser's own count of the tables it parsed.
 */
import { describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { operationsByName } from '../src/core/operations.ts';
import { performSync } from '../src/commands/sync.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import { factsFenceTableParses, parseFactsFenceFor } from '../src/core/facts-fence.ts';
import { proposeRevision } from '../src/core/access/policy.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { resolveRepairScope, type RepairResult } from '../src/core/repair/core.ts';
import { repairRunner } from '../src/core/repair/registry.ts';
import { publishFenceGeneration, readFenceBlocks, FACT_FENCE_KIND } from '../src/core/generations/fence.ts';
import { factFenceItems, factPreimages, factRetireItem } from '../src/core/generations/adapters/fact-rows.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { HOLDING_PAGE_VERSIONS_PRUNED_PER_WRITE } from '../src/core/page-state/versions.ts';
import { durableGitRepo, git } from './helpers/git-publication.ts';
import { managedBrain, settleManagedGitEffects, type ManagedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const HOLD = 'memory/unattributed';
const ENTITY = 'partners/alice-example/deal-notes';
const FOLDER_HOLD = 'partners/alice-example/memory/unattributed';
const gitRepo = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); };
const call = (ctx: OperationContext, name: string, params: Record<string, unknown>) =>
  operationsByName[name]!.handler(ctx, { request_id: randomUUID(), ...params }) as Promise<Record<string, any>>;
const remember = (ctx: OperationContext, fact: string, entity?: string) => call(ctx, 'remember', { fact, provenance: 'chat 2026-11-13', ...(entity ? { entity } : {}) });
const claims = (n: number) => Array.from({ length: n }, (_, i) => `The pantry inventory note number ${i + 1} is recorded.`);
const versionCount = async (ctx: OperationContext, slug: string) => (await call(ctx, 'get_versions', { slug, limit: 100 }) as unknown as unknown[]).length;
const storedVersions = async (engine: BrainEngine, slug: string) => Number((await engine.executeRaw<{ n: number }>(
  `SELECT count(*)::int AS n FROM page_versions v JOIN pages p ON p.id = v.page_id WHERE p.source_id = 'default' AND p.slug = $1`, [slug]))[0]!.n);
const versionIds = async (engine: BrainEngine, slug: string) => (await engine.executeRaw<{ id: number }>(
  `SELECT v.id FROM page_versions v JOIN pages p ON p.id = v.page_id WHERE p.source_id = 'default' AND p.slug = $1 ORDER BY v.id`, [slug])).map(r => Number(r.id));
const gapSet = async (engine: BrainEngine, slug: string) => (await engine.executeRaw<{ gap: boolean }>(
  `SELECT version_history_gap_at IS NOT NULL AS gap FROM pages WHERE source_id = 'default' AND slug = $1`, [slug]))[0]!.gap;
const activeRows = (engine: BrainEngine, slug: string) => engine.executeRaw<{ fact: string }>(
  `SELECT fact FROM facts WHERE source_id = 'default' AND source_markdown_slug = $1 AND expired_at IS NULL ORDER BY row_num`, [slug]).then(rows => rows.map(r => r.fact));
const fenceClaims = async (engine: BrainEngine, slug: string) => {
  const page = await engine.getPage(slug, { sourceId: 'default' });
  return parseFactsFenceFor(page?.compiled_truth ?? '', { slug }).facts.filter(f => f.active).map(f => f.claim);
};

type Listed = RepairResult & { listing?: Array<{ item: string; class: string; reason?: string }> };
const quiet = { info: () => {}, warn: () => {}, error: () => {} };
async function repairUnwithdrawn(engine: BrainEngine, opts: { expect?: string; includeAmbiguous?: boolean } = {}): Promise<Listed> {
  const scope = await resolveRepairScope(engine, 'default');
  return (await repairRunner(engine, { apply: opts.expect !== undefined, noEmbed: true, logger: quiet })).run('unwithdrawn-facts', scope,
    { explicit: true, sourceFlag: 'default', ...opts }) as Promise<Listed>;
}
const previewHashOf = (result: RepairResult) => result.apply_command.match(/--expect ([0-9a-f]+)/)![1]!;

/**
 * The #8819 shape on a holding page: a numbered row no fence of the page ever held, retired by a facts-fence generation
 * of the page (recorded with its before-state, as the pre-fix projection did) and expired in that transaction.
 */
async function wronglyRetired(engine: BrainEngine, slug: string, claim: string): Promise<number> {
  await disposePersistenceConsumer(engine);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  try {
    const [row] = await engine.executeRaw<{ id: number }>(`INSERT INTO facts (source_id, fact, kind, visibility, source, row_num, source_markdown_slug)
      VALUES ('default', $1, 'fact', 'private', 'mcp:put_page', 999, $2) RETURNING id`, [claim, slug]);
    const id = Number(row!.id);
    await engine.transaction(async tx => {
      const page = (await tx.readPageSnapshot(slug, { sourceId: 'default' }))!.page;
      const held = parseFactsFenceFor(page.compiled_truth, { slug }).facts.map(f => ({ row_num: f.rowNum, fact: f.claim, visibility: f.visibility }));
      await publishFenceGeneration(tx, { kind: FACT_FENCE_KIND, sourceId: 'default', slug, read: readFenceBlocks(page, 'facts'), items: factFenceItems(held),
        retire: (await factPreimages(tx, 'default', [id])).map(factRetireItem), writer: 'projection' });
      await tx.executeRaw('UPDATE facts SET expired_at=now(), row_num=NULL WHERE id=$1', [id]);
    });
    return id;
  } finally { await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1'); }
}
const factState = async (engine: BrainEngine, id: number) => (await engine.executeRaw<{ row_num: number | null; active: boolean }>(
  'SELECT row_num, expired_at IS NULL AS active FROM facts WHERE id=$1', [id])).map(r => [r.row_num === null ? null : Number(r.row_num), r.active])[0];

/** The holding page grown to `rows` rows by a commit and a sync, as a page an owner has saved to for a while. */
async function grownHoldingPage({ engine, ctx, root }: ManagedBrain, rows: number): Promise<void> {
  await remember(ctx, 'Seed fact number 1 about the garden plan.');
  await settleManagedGitEffects(engine);
  const file = join(root, `${HOLD}.md`);
  const lines = readFileSync(file, 'utf8').split('\n');
  const at = lines.findIndex(line => line.includes('Seed fact number 1 '));
  const extra = Array.from({ length: rows - 1 }, (_, i) => lines[at]!.replace(/^\|\s*1\s*\|/, `| ${i + 2} |`).replace('number 1 ', `number ${i + 2} `));
  lines.splice(at + 1, 0, ...extra);
  writeFileSync(file, lines.join('\n'));
  git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'grow the holding page');
  await performSync(engine, { sourceId: 'default', repoPath: root, noPull: true, noEmbed: true } as never);
  await runExtractFacts(engine, { sourceId: 'default' });
  await settleManagedGitEffects(engine);
}

describe('a parsed facts table is reused only as a copy, and only for the same columns and folder (GST-2497)', () => {
  const table = (entity: string) => ['## Facts', '', '<!--- gbrain:facts:begin -->',
    '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context | entity |',
    '|---|---|---|---|---|---|---|---|---|---|---|', `| 1 | The deal closes in May. | fact | 1.0 | world | medium | 2026-11-12 |  | chat |  | ${entity} |`, '<!--- gbrain:facts:end -->', ''].join('\n');
  test('a caller that edits its result changes nothing another caller reads', () => {
    const body = table(ENTITY);
    const first = parseFactsFenceFor(body, { slug: FOLDER_HOLD });
    first.facts[0]!.claim = 'edited'; first.facts.push({ ...first.facts[0]! }); first.warnings.push('edited');
    const before = factsFenceTableParses();
    expect(parseFactsFenceFor(`Prose above.\n\n${body}`, { slug: FOLDER_HOLD })).toMatchObject({ warnings: [], facts: [{ claim: 'The deal closes in May.', entity: ENTITY }] });
    expect(factsFenceTableParses() - before).toBe(0);
  });
  test('the same table parses by its page: the entity column, and which folder\'s entities a folder holding page holds', () => {
    const body = table(ENTITY);
    expect(parseFactsFenceFor(body, { slug: FOLDER_HOLD }).facts).toHaveLength(1);
    expect(parseFactsFenceFor(body, { slug: 'clients/memory/unattributed' })).toMatchObject({ facts: [], warnings: [expect.stringContaining('invalid entity')] });
    expect(parseFactsFenceFor(body, { slug: 'people/alice-example' })).toMatchObject({ facts: [], warnings: [expect.stringContaining('unsupported header column "entity"')] });
    expect(parseFactsFenceFor(body, { reader: true }).facts).toHaveLength(1);
    expect(parseFactsFenceFor(body, { slug: HOLD }).facts).toHaveLength(1);
  });
});

for (const backend of testBackends()) describe(`[${backend}] saves to a holding page (GST-2497)`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  const strict = (run: (brain: ManagedBrain) => Promise<void>) => managedBrain(async brain => {
    await brain.engine.executeRaw(`UPDATE sources SET config = config || '{"canonical":"git"}'::jsonb WHERE id='default'`);
    await run(brain);
  }, { databaseUrl, setup: gitRepo });

  test('one save to a holding page of 300 rows parses its facts table at most three times', () => strict(async brain => {
    await grownHoldingPage(brain, 300);
    const before = factsFenceTableParses();
    expect(await remember(brain.ctx, 'The pantry holds three jars of honey.')).toMatchObject({ status: 'inserted', page: HOLD });
    await settleManagedGitEffects(brain.engine);
    const parses = factsFenceTableParses() - before;
    expect(parses).toBeGreaterThan(0);
    expect(parses).toBeLessThanOrEqual(3);
    expect(readFileSync(join(brain.root, `${HOLD}.md`), 'utf8')).toContain('The pantry holds three jars of honey.');
  }), 300_000);

  test('eight saves to memory/unattributed keep its newest five saved versions, every row on the page, its fence and its facts, and mark the gap', () => strict(async ({ engine, ctx, root }) => {
    for (const claim of claims(8)) expect(await remember(ctx, claim)).toMatchObject({ status: 'inserted', page: HOLD });
    await settleManagedGitEffects(engine);
    expect(await versionCount(ctx, HOLD)).toBe(5);
    expect(await fenceClaims(engine, HOLD)).toEqual(claims(8));
    const file = readFileSync(join(root, `${HOLD}.md`), 'utf8');
    for (const claim of claims(8)) expect(file).toContain(claim);
    expect(await activeRows(engine, HOLD)).toEqual(claims(8));
    expect(await gapSet(engine, HOLD)).toBe(true);
    expect(git(root, 'log', '--format=%H', '--', `${HOLD}.md`).trim().split('\n').length).toBeGreaterThanOrEqual(8);
  }), 300_000);

  test('a folder holding page keeps its newest five saved versions the same way', () => strict(async ({ engine, ctx }) => {
    await proposeRevision(engine, 'default', [{ id: 'partners', prefix: 'partners/', readable_by: ['member:alice-example'] }], { origin: 'cli', store: 'database', approved: false });
    for (const claim of claims(8)) expect(await remember(ctx, claim, ENTITY)).toMatchObject({ status: 'inserted', page: FOLDER_HOLD });
    await settleManagedGitEffects(engine);
    expect(await versionCount(ctx, FOLDER_HOLD)).toBe(5);
    expect(await fenceClaims(engine, FOLDER_HOLD)).toEqual(claims(8));
    expect(await activeRows(engine, FOLDER_HOLD)).toEqual(claims(8));
    expect(await gapSet(engine, FOLDER_HOLD)).toBe(true);
  }), 300_000);

  test('an ordinary entity page written eight times keeps every saved version', () => strict(async ({ engine, ctx }) => {
    const slug = 'people/alice-example';
    for (let i = 1; i <= 8; i++) {
      const prior = await engine.readPageSnapshot(slug, { sourceId: 'default' });
      await call(ctx, 'put_page', { slug, content: `---\ntype: person\ntitle: Alice Example\n---\n\nEdit number ${i}.\n`, ...(prior ? { expected_revision: prior.revision } : {}) });
    }
    await settleManagedGitEffects(engine);
    expect(await versionCount(ctx, slug)).toBe(7);
    expect(await gapSet(engine, slug)).toBe(false);
  }), 300_000);

  test('a holding page with 250 saved versions sheds at most 100 per save until five are left', () => strict(async ({ engine, ctx }) => {
    await remember(ctx, claims(1)[0]!);
    await settleManagedGitEffects(engine);
    await engine.executeRaw(`INSERT INTO page_versions (page_id, compiled_truth, frontmatter, timeline, title, type, tags)
      SELECT p.id, p.compiled_truth, p.frontmatter, p.timeline, p.title, p.type, '[]'::jsonb FROM pages p, generate_series(1, 250)
       WHERE p.source_id = 'default' AND p.slug = $1`, [HOLD]);
    const left: number[] = [];
    for (const claim of claims(4).slice(1)) { await remember(ctx, claim); left.push(await storedVersions(engine, HOLD)); }
    expect(left).toEqual([151, 52, 5]);
    expect(await activeRows(engine, HOLD)).toEqual(claims(4));
  }), 300_000);

  test('a holding page that a forget and a hand-edit sync left above five saved versions comes back to five on the next save that adds a fact', () => strict(async ({ engine, ctx, root }) => {
    const saved: Array<Record<string, any>> = [];
    for (const claim of claims(8)) saved.push(await remember(ctx, claim));
    await settleManagedGitEffects(engine);
    const five = await versionIds(engine, HOLD);
    expect(five).toHaveLength(5);
    await call(ctx, 'forget', { id: String(saved[2]!.id) });
    await settleManagedGitEffects(engine);
    expect((await versionIds(engine, HOLD)).slice(0, 5)).toEqual(five);
    const file = join(root, `${HOLD}.md`);
    writeFileSync(file, `${readFileSync(file, 'utf8')}\nNotes kept by hand.\n`);
    git(root, 'add', '-A'); git(root, 'commit', '-q', '-m', 'hand edit of the holding page');
    await performSync(engine, { sourceId: 'default', repoPath: root, noPull: true, noEmbed: true } as never);
    await settleManagedGitEffects(engine);
    const above = await versionIds(engine, HOLD);
    expect(above.length).toBeGreaterThan(5);
    expect(above.length - 5).toBeLessThanOrEqual(HOLDING_PAGE_VERSIONS_PRUNED_PER_WRITE);
    expect(above.slice(0, 5)).toEqual(five);
    const active = [...claims(8).filter((_, i) => i !== 2), 'The pantry holds three jars of honey.'];
    expect(await remember(ctx, active.at(-1)!)).toMatchObject({ status: 'inserted', page: HOLD });
    await settleManagedGitEffects(engine);
    expect(await storedVersions(engine, HOLD)).toBe(5);
    expect(await fenceClaims(engine, HOLD)).toEqual(active);
    expect(await activeRows(engine, HOLD)).toEqual(active);
    const text = readFileSync(file, 'utf8');
    for (const claim of active) expect(text).toContain(claim);
    expect(text).toContain('Notes kept by hand.');
    expect(await gapSet(engine, HOLD)).toBe(true);
  }), 300_000);
});

for (const backend of testBackends()) describe(`[${backend}] gbrain repair unwithdrawn-facts on a pruned holding page (GST-2497)`, () => {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  test('a row wrongly retired on a holding page whose versions were pruned is ambiguous, and --include-ambiguous with that preview\'s hash restores it', () => managedBrain(async ({ engine, ctx }) => {
    await engine.executeRaw(`UPDATE sources SET config = config || '{"canonical":"git"}'::jsonb WHERE id='default'`);
    for (const claim of claims(8)) await remember(ctx, claim);
    await settleManagedGitEffects(engine);
    expect(await gapSet(engine, HOLD)).toBe(true);
    const id = await wronglyRetired(engine, HOLD, 'The pantry was restocked in October.');
    const item = `default:${HOLD}#${id}`;
    const plain = await repairUnwithdrawn(engine);
    expect(plain.listing!.map(row => [row.item, row.class])).toEqual([[item, 'ambiguous']]);
    expect(JSON.stringify(plain)).toContain('version history has a gap');
    const wide = await repairUnwithdrawn(engine, { includeAmbiguous: true });
    expect(wide.listing!.map(row => [row.item, row.class])).toEqual([[item, 'ambiguous']]);
    await expect(repairUnwithdrawn(engine, { expect: previewHashOf(wide) })).rejects.toMatchObject({ code: 'preview_changed' });
    expect(await factState(engine, id)).toEqual([null, false]);
    expect((await repairUnwithdrawn(engine, { expect: previewHashOf(wide), includeAmbiguous: true })).applied).toBe(1);
    expect(await factState(engine, id)).toEqual([999, true]);
    await remember(ctx, 'One more save after the restore.');
    await settleManagedGitEffects(engine);
    expect(await factState(engine, id)).toEqual([999, true]);
    expect(await activeRows(engine, HOLD)).toEqual([...claims(8), 'The pantry was restocked in October.', 'One more save after the restore.']);
  }, { databaseUrl, setup: gitRepo }), 300_000);
});

describe('a holding page on a brain with no Git repository (GST-2497)', () => {
  for (const backend of testBackends()) test(`[${backend}] eight saves keep five versions, the facts rows rebuild the table as it was after the third save, and an as_of read says history is incomplete`, async () => {
    const { engine, close } = await isolatedSharedSkillsEngine(backend === 'postgres' ? requirePostgresTestDatabase() : undefined);
    try {
      const ctx = { engine, config: { engine: engine.kind, embedding_disabled: true }, sourceId: 'default', remote: false, dryRun: false, logger: { info() {}, warn() {}, error() {} } } as OperationContext;
      let third: Array<[number, string]> = [], at = '';
      for (const [i, claim] of claims(8).entries()) {
        expect(await remember(ctx, claim)).toMatchObject({ status: 'inserted' });
        if (i === 0) await engine.executeRaw(`UPDATE pages SET frontmatter = frontmatter || '{"valid_from":"2026-01-01"}'::jsonb WHERE source_id = 'default' AND slug = $1`, [HOLD]);
        if (i !== 2) continue;
        const page = await engine.getPage(HOLD, { sourceId: 'default' });
        third = parseFactsFenceFor(page!.compiled_truth, { slug: HOLD }).facts.filter(f => f.active).map(f => [f.rowNum, f.claim]);
        at = String((await engine.executeRaw<{ at: string }>('SELECT clock_timestamp()::text AS at'))[0]!.at);
      }
      expect(third.map(([, claim]) => claim)).toEqual(claims(3));
      expect(await versionCount(ctx, HOLD)).toBe(5);
      expect(await fenceClaims(engine, HOLD)).toEqual(claims(8));
      const rebuilt = await engine.executeRaw<{ row_num: number; fact: string }>(`SELECT row_num, fact FROM facts WHERE source_id = 'default' AND source_markdown_slug = $1
        AND created_at <= $2::timestamptz AND (expired_at IS NULL OR expired_at > $2::timestamptz) ORDER BY row_num`, [HOLD, at]);
      expect(rebuilt.map(r => [Number(r.row_num), r.fact])).toEqual(third);
      const before = await call(ctx, 'get_page', { slug: HOLD, as_of: '2025-06-01' });
      expect(before.valid_time).toMatchObject({ status: 'before_recorded_history', history: 'incomplete', uncertain: true, why: 'history_gap' });
    } finally { await close(); }
  }, 300_000);
});
