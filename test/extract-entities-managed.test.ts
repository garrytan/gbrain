/**
 * #6262 (P2.17): on a managed brain extract_entities wrote stubs, timeline rows and backlinks directly. The writer
 * guard refused the stub with a raw P0001, the fail-open fallback was refused too, and an existing entity's timeline
 * refusal was swallowed (`status: ok, timelineAdded: false`). Every write now goes through the coordinator at the
 * source page's derived tier; a refusal reaches the caller as its envelope. Synthetic content only.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { operations } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { managedBrain } from './helpers/managed-brain.ts';

const op = operations.find(o => o.name === 'extract_entities')!;
const run = (ctx: OperationContext, text: string) => op.handler(ctx, { text, source_slug: 'meetings/notes' }) as Promise<{
  status: string; quarantined: number; entities: Array<{ slug: string; action: string; timelineAdded: boolean; backlinkCreated: boolean; quarantined?: boolean }> }>;

async function seed(engine: BrainEngine) {
  await engine.putPage('meetings/notes', { type: 'meeting', title: 'Notes', compiled_truth: 'Met people.', timeline: '', frontmatter: {} });
  await engine.putPage('people/alice-example', { type: 'person', title: 'Alice Example', compiled_truth: 'A person.', timeline: '', frontmatter: {} });
}
const page = async (engine: BrainEngine, slug: string) => (await engine.executeRaw<{ trust_tier: string; frontmatter: Record<string, unknown> }>(
  "SELECT trust_tier, frontmatter FROM pages WHERE slug=$1 AND deleted_at IS NULL", [slug]))[0];
const timeline = async (engine: BrainEngine, slug: string) => engine.executeRaw<{ trust_tier: string }>(
  'SELECT t.trust_tier FROM timeline_entries t JOIN pages p ON p.id=t.page_id WHERE p.slug=$1', [slug]);
const backlinks = async (engine: BrainEngine, slug: string) => Number((await engine.executeRaw<{ n: number | string }>(
  `SELECT count(*) AS n FROM links l JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id
    WHERE f.slug=$1 AND t.slug='meetings/notes' AND l.context LIKE 'Entity mention from %'`, [slug]))[0]!.n);

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
/** The same call on an unmanaged brain: the managed result must match it row for row. */
async function unmanaged(text: string, untrusted: boolean): Promise<Baseline> {
  const plain = new PGLiteEngine();
  plainEngines.push(plain);
  await plain.connect({}); await plain.initSchema();
  await seed(plain);
  if (untrusted) await plain.executeRaw("UPDATE pages SET trust_tier='external_untrusted' WHERE slug='meetings/notes'");
  const result = await run({ engine: plain, config: { engine: 'pglite', embedding_disabled: true }, sourceId: 'default', remote: false, dryRun: false,
    logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext, text);
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
      const result = await run(ctx, text);
      expect(result.status).toBe('ok');
      expect(result.entities.find(e => e.slug === 'people/cedar-example')).toMatchObject({ action: 'created', quarantined: true, timelineAdded: true, backlinkCreated: true });
      expect(result.entities.find(e => e.slug === 'people/alice-example')).toMatchObject({ action: 'updated', timelineAdded: true, backlinkCreated: true });
      expect(result.entities.map(({ slug, action, timelineAdded, backlinkCreated }) => ({ slug, action, timelineAdded, backlinkCreated })))
        .toEqual(plain.result.entities.map(({ slug, action, timelineAdded, backlinkCreated }) => ({ slug, action, timelineAdded, backlinkCreated })));
      expect(await snapshot(engine)).toEqual(plain.rows);
      const journal = await engine.executeRaw<{ operation: string; state: string }>(
        "SELECT operation, state FROM persistence_requests WHERE slug='people/cedar-example'");
      expect(journal).toEqual([{ operation: 'put_page', state: 'committed' }]);
    }, { databaseUrl, setup: ({ engine }) => seed(engine) });
  }, 180_000);

  test('an untrusted source page caps the stub and timeline tier as on an unmanaged brain', async () => {
    const plain = untrustedBaseline;
    expect(plain.rows['people/cedar-example']!.tier).toBe('external_untrusted');
    await managedBrain(async ({ engine, ctx }) => {
      await run(ctx, UNTRUSTED_TEXT);
      expect(await snapshot(engine)).toEqual(plain.rows);
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
      const error = await run({ ...ctx, writeWaitMs: 0 }, 'Lunch with Alice Example and Cedar Example today.')
        .then(() => null, e => e as { code?: string; why?: string });
      expect(error?.code).toBe('write_pending');
      expect(error?.why).toContain('1 of 2 entities were written before Cedar Example: people/alice-example');
      // The accepted stub publishes on its own; its timeline row and backlink wait for the rerun.
      expect(await timeline(engine, 'people/cedar-example')).toEqual([]);
      expect(await backlinks(engine, 'people/cedar-example')).toBe(0);
    }, { databaseUrl, setup: ({ engine }) => seed(engine) });
  }, 180_000);
});
