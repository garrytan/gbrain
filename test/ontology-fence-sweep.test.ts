/**
 * #6264: the maintenance sweep must not fence ontology observations onto an
 * entity page's Facts table, and `gbrain repair ontology-facts` restores the
 * ones it already moved.
 *
 * Protects: after an `ontology_propose`, a sweep, an ordinary rewrite of the
 * entity page and another sweep, `ontology_get` still returns the observation
 * with its own provenance; the row never gets a fence row number and the
 * sweep never republishes the page (which made a client's read-modify-write
 * of the page fail with revision_conflict, so the page kept serving its
 * previous Facts value). An ontology observation does not hold up the
 * extract_facts reconcile of its page either. The repair finds rows fenced
 * the old way (still fenced, or retired by a page write), restores exactly
 * the previewed set, and leaves withdrawn and duplicated observations alone.
 * Fails when: `planUnfencedFacts` selects rows with a `dimension` (the
 * v0.60.53.0 behavior: the observation's source becomes the page and the
 * second sweep retires it), or the empty-fence guard counts them.
 * Why existing coverage misses it: the unfenced-rows tests seed plain fact
 * rows only, and the ontology tests never run a sweep or a page rewrite.
 * Seams: none; real PGLite (and Postgres through the e2e registration), the
 * operations' handlers, `runMaintenanceSweep`, `runCycle` and the repair
 * command. The old fence behavior is reproduced by handing the ontology row
 * to `fenceUnfencedFacts` directly.
 */
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runRepairCommand } from '../src/commands/repair.ts';
import { ontologyFactsCheck } from '../src/commands/doctor/checks/ontology-facts.ts';
import { runCycle } from '../src/core/cycle.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { parseFactsFence } from '../src/core/facts-fence.ts';
import { fenceUnfencedFacts, planUnfencedFacts } from '../src/core/facts/unfenced-facts.ts';
import { parseMarkdown, serializePageToMarkdown } from '../src/core/markdown.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { managedPersistenceEnabled } from '../src/core/persistence/ownership.ts';
import { runMaintenanceSweep } from '../src/core/sweep.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const SLUG = 'people/alder-example';
const page = (claim: string) => `---\ntitle: Alder Example\ntype: person\n---\nAlder Example is a fictional engineer.\n\n## Facts\n`
  + '<!--- gbrain:facts:begin -->\n| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n'
  + `|---|---|---|---|---|---|---|---|---|---|\n| 1 | ${claim} | preference | 1.0 | world | medium | 2026-01-01 |  | manual |  |\n<!--- gbrain:facts:end -->\n`;

const op = (ctx: OperationContext, name: string, params: Record<string, unknown>) => operationsByName[name].handler(ctx, params) as Promise<any>;
/** A managed page write: put_page bound to the revision just read, as a client makes it. */
async function put(ctx: OperationContext, content: string) {
  const current = await ctx.engine.readPageSnapshot(SLUG, { sourceId: 'default' });
  await op(ctx, 'put_page', { slug: SLUG, content, ...(current ? { expected_revision: current.revision } : {}) });
}
const propose = (ctx: OperationContext, dimension: string, value: string, valid_from: string) =>
  op(ctx, 'ontology_propose', { entity: SLUG, dimension, value, valid_from, source: 'manual', visibility: 'world', confidence: 0.9 });
const ontology = async (ctx: OperationContext) => (await op(ctx, 'ontology_get', { entity: SLUG }) as Array<{ dimension: string; value: string; source: string }>)
  .map(r => [r.dimension, r.value, r.source]);
const sweep = (engine: BrainEngine) => runMaintenanceSweep(engine, { sourceId: 'default', budgetMs: 60_000 });
const revision = async (engine: BrainEngine) => (await engine.readPageSnapshot(SLUG, { sourceId: 'default' }))!.revision;
const ontologyRows = (engine: BrainEngine) => engine.executeRaw<{ id: number; dimension: string; row_num: number | null; page: string; expired: boolean }>(
  `SELECT id, dimension, row_num, source_markdown_slug AS page, expired_at IS NOT NULL AS expired FROM facts WHERE dimension IS NOT NULL ORDER BY id`);

interface Brain { engine: BrainEngine; ctx: OperationContext; write(content: string): Promise<void> }

/**
 * An unmanaged brain whose default source has a checkout; `write` updates the
 * page row and its canonical file together, as a sync of an edited file does.
 */
async function unmanagedBrain(databaseUrl: string | undefined, run: (b: Brain) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-ontology-sweep-'));
  try {
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
      try {
        expect(await managedPersistenceEnabled(engine)).toBe(false);
        const root = join(home, 'brain');
        mkdirSync(join(root, 'people'), { recursive: true });
        await engine.executeRaw("UPDATE sources SET local_path = $1 WHERE id = 'default'", [root]);
        const ctx: OperationContext = { engine, config: { engine: engine.kind, embedding_disabled: true } as never, sourceId: 'default',
          remote: false, dryRun: false, logger: { info() {}, warn() {}, error() {} } };
        const write = async (content: string) => {
          const parsed = parseMarkdown(content, `${SLUG}.md`);
          const row = await engine.putPage(SLUG, { type: parsed.type, title: parsed.title, compiled_truth: parsed.compiled_truth });
          await engine.executeRaw('UPDATE pages SET source_path = $1 WHERE id = $2', [`${SLUG}.md`, row.id]);
          const snapshot = (await engine.readPageSnapshot(SLUG, { sourceId: 'default' }))!;
          writeFileSync(join(root, `${SLUG}.md`), serializePageToMarkdown(snapshot.page, snapshot.tags));
        };
        await run({ engine, ctx, write });
      } finally { await close(); }
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

async function repair(engine: BrainEngine, args: string[]) {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...parts: unknown[]) => { lines.push(parts.map(String).join(' ')); };
  try { await runRepairCommand(engine, ['ontology-facts', ...args, '--json']); } finally { console.log = original; }
  return JSON.parse(lines.join('\n')).results[0] as { affected: number; applied: number; apply_command: string;
    listing?: Array<{ item: string; class: string }>; outcomes?: Record<string, number>; residuals: Record<string, number> };
}

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  const brains = [
    ['managed', (run: (b: Brain) => Promise<void>) => managedBrain(b => run({ ...b, write: content => put(b.ctx, content) }), { databaseUrl })],
    ['unmanaged', (run: (b: Brain) => Promise<void>) => unmanagedBrain(databaseUrl, run)],
  ] as const;

  for (const [mode, brain] of brains) {
    test(`${backend}: ${mode}: an ontology observation survives a sweep, a page rewrite and another sweep, and the sweep leaves the page alone`, async () => {
      await brain(async ({ engine, ctx, write }) => {
        await write(page('Alder Example likes example tea'));
        expect((await propose(ctx, 'location', 'Example City', '2026-02-01')).action).toBe('inserted');
        const before = await revision(engine);

        await sweep(engine);
        expect(await revision(engine)).toBe(before);
        expect(await ontology(ctx)).toEqual([['location', 'Example City', 'manual']]);

        await write(page('Alder Example likes example coffee'));
        await sweep(engine);
        expect(await ontology(ctx)).toEqual([['location', 'Example City', 'manual']]);
        expect((await ontologyRows(engine)).map(r => [r.row_num, r.page, r.expired])).toEqual([[null, 'manual', false]]);
        const fence = parseFactsFence((await engine.getPage(SLUG, { sourceId: 'default' }))!.compiled_truth).facts;
        expect(fence.map(f => f.claim)).toEqual(['Alder Example likes example coffee']);
      });
    }, 120_000);
  }

  test(`${backend}: managed: a page write bound to a revision read before the sweep still lands, so the page serves its new Facts value`, async () => {
    await managedBrain(async ({ engine, ctx }) => {
      await put(ctx, page('Alder Example likes example tea'));
      await propose(ctx, 'location', 'Example City', '2026-02-01');
      // The client reads the page, the idle sweep runs, then the client writes the page back.
      const read = await op(ctx, 'get_page', { slug: SLUG, include_content: true });
      await sweep(engine);
      await op(ctx, 'put_page', { slug: SLUG, content: page('Alder Example likes example coffee'), expected_revision: read.revision });
      const fence = parseFactsFence((await engine.getPage(SLUG, { sourceId: 'default' }))!.compiled_truth).facts;
      expect(fence.filter(f => f.active).map(f => f.claim)).toEqual(['Alder Example likes example coffee']);
    }, { databaseUrl });
  }, 120_000);

  test(`${backend}: unmanaged: an ontology observation does not hold up the extract_facts reconcile of its page`, async () => {
    await unmanagedBrain(databaseUrl, async ({ engine, ctx, write }) => {
      await write(page('Alder Example likes example tea'));
      await propose(ctx, 'location', 'Example City', '2026-02-01');
      // The page's fence row is not indexed yet (an edit synced from another host, never reconciled).
      await engine.executeRaw('DELETE FROM facts WHERE dimension IS NULL');
      const report = await runCycle(engine, { brainDir: null, sourceId: 'default', phases: ['extract_facts'] });
      const phase = report.phases.find(p => p.phase === 'extract_facts')!;
      expect(phase.summary).not.toContain('skipped');
      expect(phase.details).toMatchObject({ factsInserted: 1, unfencedRowsFenced: 0 });
      const active = await engine.executeRaw<{ fact: string }>('SELECT fact FROM facts WHERE dimension IS NULL AND expired_at IS NULL ORDER BY id');
      expect(active.map(r => r.fact)).toEqual(['Alder Example likes example tea']);
      expect(await ontology(ctx)).toEqual([['location', 'Example City', 'manual']]);
    });
  }, 120_000);

  test(`${backend}: managed: repair ontology-facts restores observations the old fence step moved, and keeps withdrawn and duplicated ones`, async () => {
    await managedBrain(async ({ engine, ctx }) => {
      await put(ctx, page('Alder Example likes example tea'));
      await propose(ctx, 'location', 'Example City', '2026-02-01');
      await propose(ctx, 'role', 'engineer', '2026-02-01');
      await propose(ctx, 'employer', 'Acme Example', '2026-02-01');
      await propose(ctx, 'expertise', 'databases', '2026-02-01');
      const [location, role, employer, expertise] = (await ontologyRows(engine)).map(r => Number(r.id));

      // The pre-fix fence step: every ontology row of the page is fenced through the coordinator.
      const plan = await planUnfencedFacts(engine, { sourceId: 'default' });
      expect(plan.groups.size).toBe(0);
      const rows = await engine.executeRaw<any>(
        `SELECT id, source_id, entity_slug, fact, kind, visibility, notability, context, valid_from, valid_until, source, confidence,
                claim_metric, claim_value, claim_unit, claim_period, true AS page_exists FROM facts WHERE dimension IS NOT NULL ORDER BY id`);
      plan.groups.set(`default\0${SLUG}`, rows);
      expect((await fenceUnfencedFacts(engine, plan)).fenced).toBe(4);
      expect((await ontology(ctx)).map(r => r[2])).toEqual([SLUG, SLUG, SLUG, SLUG]);

      // The user forgets employer while it is fenced.
      await op(ctx, 'forget_fact', { id: employer });
      // A page rewrite from the client's own copy drops the fenced rows except role, and a sweep retires them.
      const fenced = parseFactsFence((await engine.getPage(SLUG, { sourceId: 'default' }))!.compiled_truth).facts;
      const roleRow = fenced.find(f => f.claim === 'role: engineer')!;
      await put(ctx, page('Alder Example likes example coffee').replace('<!--- gbrain:facts:end -->',
        `| ${roleRow.rowNum} | role: engineer | fact | 0.9 | world | medium | 2026-02-01 |  | manual |  |\n<!--- gbrain:facts:end -->`));
      await sweep(engine);
      expect((await ontology(ctx)).map(r => r[0])).toEqual(['role']);
      // The agent proposes expertise again after it went missing.
      expect((await propose(ctx, 'expertise', 'databases', '2026-02-01')).action).toBe('inserted');

      const check = await ontologyFactsCheck(engine, ['default']);
      expect(check).toMatchObject({ name: 'ontology_facts_fenced', status: 'warn', details: { fenced: 1, retired: 1, excluded: 2 } });
      expect(check.message).toContain('gbrain repair ontology-facts');

      const preview = await repair(engine, ['--source', 'default']);
      expect(preview).toMatchObject({ affected: 2, applied: 0, residuals: { fenced: 1, retired: 1, excluded_withdrawn: 1, excluded_duplicate: 1 } });
      expect(preview.listing!.map(l => [l.item, l.class])).toEqual([
        [`default:${SLUG}#location`, 'retired'], [`default:${SLUG}#role`, 'fenced'],
        [`default:${SLUG}#employer`, 'excluded_withdrawn'], [`default:${SLUG}#expertise`, 'excluded_duplicate'],
      ]);
      await expect(runRepairCommand(engine, ['ontology-facts', '--source', 'default', '--apply', '--json'])).rejects.toThrow(/restores only the set a preview printed/);

      const hash = preview.apply_command.match(/--expect ([0-9a-f]+)/)![1];
      const applied = await repair(engine, ['--source', 'default', '--apply', '--expect', hash]);
      expect(applied).toMatchObject({ applied: 2, outcomes: { restored: 2 } });

      const after = new Map((await ontologyRows(engine)).map(r => [Number(r.id), [r.row_num, r.page, r.expired]]));
      expect(after.get(location)).toEqual([null, 'manual', false]);
      expect(after.get(role)).toEqual([null, 'manual', false]);
      expect(after.get(employer)![2]).toBe(true);
      expect(after.get(expertise)).toEqual([null, SLUG, true]);
      expect((await ontology(ctx)).sort()).toEqual([
        ['expertise', 'databases', 'manual'], ['location', 'Example City', 'manual'], ['role', 'engineer', 'manual']]);
      expect(await ontologyFactsCheck(engine, ['default'])).toMatchObject({ status: 'ok', details: { fenced: 0, retired: 0, excluded: 2 } });
      expect((await repair(engine, ['--source', 'default'])).affected).toBe(0);
    }, { databaseUrl });
  }, 180_000);
}
