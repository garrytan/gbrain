/**
 * #6262 (P2.17): on a managed brain extract_entities wrote stubs, timeline rows and backlinks directly. The writer
 * guard refused the stub with a raw P0001, the fail-open fallback was refused too, and an existing entity's timeline
 * refusal was swallowed (`status: ok, timelineAdded: false`). Every write now goes through the coordinator at the
 * source page's derived tier; a refusal reaches the caller as its envelope. G5 lane B: the timeline row is an
 * `add_timeline_entry` page mutation, so the existing entity page is seeded through the page door (a managed page has
 * its canonical file) and the stub's journal holds both requests; the backlink is the edge the bullet's markdown link
 * derives at publication, not a direct database row. G6: a new entity's stub carries its timeline bullet in its own
 * put_page (one request, one commit), and one call's entity writes are submitted as one batch, which Postgres publishes
 * as one group. Synthetic content only.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { operations } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { testWaitMs } from './helpers/wait-for.ts';

const op = operations.find(o => o.name === 'extract_entities')!;
const run = (ctx: OperationContext, text: string) => op.handler(ctx, { text, source_slug: 'meetings/notes' }) as Promise<{
  status: string; quarantined: number; entities: Array<{ slug: string; action: string; timelineAdded: boolean; backlinkCreated: boolean; quarantined?: boolean }> }>;

const ALICE = '---\ntype: person\ntitle: Alice Example\n---\n\nA person.\n';
async function seed(engine: BrainEngine) {
  await engine.putPage('meetings/notes', { type: 'meeting', title: 'Notes', compiled_truth: 'Met people.', timeline: '', frontmatter: {} });
}
/** The existing entity page, written through put_page: the page door on a managed brain, so it has its canonical file. */
const seedEntity = (ctx: OperationContext) => operations.find(o => o.name === 'put_page')!.handler(ctx, { slug: 'people/alice-example', content: ALICE });
const page = async (engine: BrainEngine, slug: string) => (await engine.executeRaw<{ trust_tier: string; frontmatter: Record<string, unknown> }>(
  "SELECT trust_tier, frontmatter FROM pages WHERE slug=$1 AND deleted_at IS NULL", [slug]))[0];
const timeline = async (engine: BrainEngine, slug: string) => engine.executeRaw<{ trust_tier: string }>(
  'SELECT t.trust_tier FROM timeline_entries t JOIN pages p ON p.id=t.page_id WHERE p.slug=$1', [slug]);
/** Every entity -> source edge, by type and producer. */
const backlinks = async (engine: BrainEngine, slug: string) => engine.executeRaw<{ link_type: string; link_source: string | null }>(
  `SELECT l.link_type, l.link_source FROM links l JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id
    WHERE f.slug=$1 AND t.slug='meetings/notes' ORDER BY l.link_type, l.link_source`, [slug]);
/** The unmanaged brain's direct backlink. */
const DIRECT_EDGE = [{ link_type: '', link_source: 'markdown' }];
/** G5: a managed brain writes no direct backlink; the edge is the one the timeline bullet's `[source](source)` link derives. */
const BULLET_EDGE = { link_type: 'mentions', link_source: 'markdown' };
/** A managed stub also derives the edge its `source:` frontmatter field names. */
const STUB_EDGES = [BULLET_EDGE, { link_type: 'source', link_source: 'frontmatter' }];

const snapshot = async (engine: BrainEngine) => Object.fromEntries(await Promise.all(['people/cedar-example', 'people/alice-example'].map(async slug => {
  const row = await page(engine, slug);
  return [slug, { tier: row?.trust_tier, provenance: row?.frontmatter.provenance, status: row?.frontmatter.status,
    timeline: (await timeline(engine, slug)).map(t => t.trust_tier), backlinks: await backlinks(engine, slug) }];
})));
const TEXT = 'Lunch with Cedar Example and Alice Example today.';
const UNTRUSTED_TEXT = 'Lunch with Cedar Example today.';
type Baseline = { result: Awaited<ReturnType<typeof run>>; rows: Awaited<ReturnType<typeof snapshot>> };
const plainEngines: PGLiteEngine[] = [];
let baseline: Baseline;
let untrustedBaseline: Baseline;
beforeAll(async () => {
  baseline = await unmanaged(TEXT, false);
  untrustedBaseline = await unmanaged(UNTRUSTED_TEXT, true);
}, 120_000);
afterAll(async () => { for (const engine of plainEngines) await engine.disconnect(); });
afterEach(() => { installFaultHook(undefined); });
/** The same call on an unmanaged brain: the managed result must match it row for row. */
async function unmanaged(text: string, untrusted: boolean): Promise<Baseline> {
  const plain = new PGLiteEngine();
  plainEngines.push(plain);
  await plain.connect({}); await plain.initSchema();
  await seed(plain);
  if (untrusted) await plain.executeRaw("UPDATE pages SET trust_tier='external_untrusted' WHERE slug='meetings/notes'");
  const ctx = { engine: plain, config: { engine: 'pglite', embedding_disabled: true }, sourceId: 'default', remote: false, dryRun: false,
    logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext;
  await seedEntity(ctx);
  const result = await run(ctx, text);
  return { result, rows: await snapshot(plain) };
}

for (const databaseUrl of [undefined, ...(process.env.DATABASE_URL ? [process.env.DATABASE_URL] : [])])
describe(`extract_entities on a managed brain (#6262, ${databaseUrl ? 'postgres' : 'pglite'})`, () => {
  test('a new entity gets a quarantined stub, a timeline row and a backlink; an existing entity gets its timeline row', async () => {
    const text = TEXT;
    const plain = baseline;
    expect(plain.rows['people/cedar-example']).toMatchObject({ provenance: 'auto-extracted', status: 'unverified' });
    expect(plain.rows['people/cedar-example']!.timeline).toHaveLength(1);
    expect(plain.rows['people/alice-example']!.timeline).toHaveLength(1);
    await managedBrain(async ({ engine, ctx }) => {
      await seedEntity(ctx);
      const result = await run(ctx, text);
      expect(result.status).toBe('ok');
      expect(result.entities.find(e => e.slug === 'people/cedar-example')).toMatchObject({ action: 'created', quarantined: true, timelineAdded: true, backlinkCreated: true });
      expect(result.entities.find(e => e.slug === 'people/alice-example')).toMatchObject({ action: 'updated', timelineAdded: true, backlinkCreated: true });
      expect(result.entities.map(({ slug, action, timelineAdded, backlinkCreated }) => ({ slug, action, timelineAdded, backlinkCreated })))
        .toEqual(plain.result.entities.map(({ slug, action, timelineAdded, backlinkCreated }) => ({ slug, action, timelineAdded, backlinkCreated })));
      expect(plain.rows['people/cedar-example']!.backlinks).toEqual(DIRECT_EDGE);
      expect(plain.rows['people/alice-example']!.backlinks).toEqual(DIRECT_EDGE);
      expect(await snapshot(engine)).toEqual({
        'people/cedar-example': { ...plain.rows['people/cedar-example'], backlinks: STUB_EDGES },
        'people/alice-example': { ...plain.rows['people/alice-example'], backlinks: [BULLET_EDGE] },
      });
      const journal = await engine.executeRaw<{ operation: string; state: string }>(
        "SELECT operation, state FROM persistence_requests WHERE slug='people/cedar-example' ORDER BY sequence");
      // G6: the stub's timeline bullet rides in its put_page, so the new entity is one request and one commit.
      expect(journal).toEqual([{ operation: 'put_page', state: 'committed' }]);
    }, { databaseUrl, setup: ({ engine }) => seed(engine) });
  }, 180_000);

  test('an untrusted source page caps the stub and timeline tier as on an unmanaged brain', async () => {
    const plain = untrustedBaseline;
    expect(plain.rows['people/cedar-example']!.tier).toBe('external_untrusted');
    await managedBrain(async ({ engine, ctx }) => {
      await seedEntity(ctx);
      await run(ctx, UNTRUSTED_TEXT);
      expect(plain.rows['people/cedar-example']!.backlinks).toEqual(DIRECT_EDGE);
      expect(await snapshot(engine)).toEqual({ ...plain.rows, 'people/cedar-example': { ...plain.rows['people/cedar-example'], backlinks: STUB_EDGES } });
    }, { databaseUrl, setup: async ({ engine }) => {
      await seed(engine);
      await engine.executeRaw("UPDATE pages SET trust_tier='external_untrusted' WHERE slug='meetings/notes'");
    } });
  }, 180_000);

  test('a refused write returns its envelope, never a raw guard error, and writes no stub', async () => {
    await managedBrain(async ({ engine, ctx }) => {
      await engine.transaction(async tx => {
        await tx.executeRaw("SELECT set_config('gbrain.topology_change','on',true),set_config('gbrain.persistence_protocol','2',true)");
        await tx.executeRaw("UPDATE sources SET archived=true WHERE id='default'");
      });
      const error = await run(ctx, 'Lunch with Cedar Example today.').then(() => null, e => e as { code?: string; message: string });
      expect(error?.code).toBe('source_changed');
      expect(error?.message).not.toContain('writer_coordinator_required');
      expect(await page(engine, 'people/cedar-example')).toBeUndefined();
    }, { databaseUrl, setup: ({ engine }) => seed(engine) });
  }, 180_000);

  test('a stub write still pending stops the batch with write_pending and names what was already written', async () => {
    await managedBrain(async ({ engine, ctx }) => {
      await seedEntity(ctx);
      // Alice's timeline row is a page-door write too, so only the stub's put_page is held back, past the reply deadline.
      let release!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      installFaultHook(async (point, detail) => { if (point === 'consumer:preparing' && detail.operation === 'put_page') await held; });
      const error = await run({ ...ctx, writeWaitMs: testWaitMs(5_000) }, 'Lunch with Alice Example and Cedar Example today.')
        .then(() => null, e => e as { code?: string; why?: string })
        .finally(() => { installFaultHook(undefined); release(); });
      expect(error?.code).toBe('write_pending');
      if (!databaseUrl) {
        expect(error?.why).toContain('1 of 2 entities were written before Cedar Example: people/alice-example');
        // The accepted stub publishes on its own; its timeline row and backlink wait for the rerun.
        expect(await timeline(engine, 'people/cedar-example')).toEqual([]);
        expect(await backlinks(engine, 'people/cedar-example')).toEqual([]);
        return;
      }
      // G6 on Postgres: Alice's bullet and Cedar's stub are one publication group, so the held stub holds Alice's bullet
      // too: nothing was written yet, and the reply claims no entity as written.
      expect(error?.why ?? '').not.toContain('were written before');
      expect(await timeline(engine, 'people/alice-example')).toEqual([]);
      expect(await page(engine, 'people/cedar-example')).toBeUndefined();
      // Released, both accepted writes publish together, each committed, in one transaction.
      let rows: Array<{ slug: string; state: string; published: string | null }> = [];
      for (const start = Date.now(); Date.now() - start < 30_000; await new Promise(r => setTimeout(r, 200))) {
        rows = await engine.executeRaw("SELECT slug,state,published_at::text AS published FROM persistence_requests WHERE slug IN ('people/alice-example','people/cedar-example') AND operation IN ('put_page','add_timeline_entry') AND intent ? 'page_batch' ORDER BY slug");
        if (rows.length === 2 && rows.every(row => row.state === 'committed')) break;
      }
      expect(rows.map(row => [row.slug, row.state])).toEqual([['people/alice-example', 'committed'], ['people/cedar-example', 'committed']]);
      expect(rows[0]!.published).toBe(rows[1]!.published);
      expect(await timeline(engine, 'people/alice-example')).toHaveLength(1);
      expect(await timeline(engine, 'people/cedar-example')).toHaveLength(1);
    }, { databaseUrl, setup: ({ engine }) => seed(engine) });
  }, 180_000);
});
