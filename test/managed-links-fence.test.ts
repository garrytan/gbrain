/**
 * G5 lane A: on a managed brain, add_link / remove_link write the from page's
 * `## Links` fence through the page-mutation door, and the `links` rows are
 * projected from it (origin_field `links_fence`). Database-only manual edges
 * written before the fence (origin_field NULL) are never touched by an import,
 * and remove_link removes them. Runs on PGLite and, with DATABASE_URL, Postgres.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { operations } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { extractManagedStaleLinks } from '../src/core/persistence/links-maintenance.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { maintenanceAttribution } from '../src/core/persistence/attribution.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';
import { testBackends } from './helpers/test-backends.ts';

const backends = testBackends();
const engines: BrainEngine[] = [];
const dataDir = mkdtempSync(join(tmpdir(), 'gbrain-links-fence-db-'));
let closePostgres: (() => Promise<void>) | undefined;
beforeAll(async () => {
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
  if (backends.includes('pglite')) {
    const engine = new PGLiteEngine();
    await engine.connect({ database_path: dataDir }); await engine.initSchema(); engines.push(engine);
  }
  if (backends.includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engines.push(pg.engine); closePostgres = pg.close;
  }
}, 120_000);
afterAll(async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.(); resetGateway(); rmSync(dataDir, { recursive: true, force: true });
});

const logger = { info() {}, warn() {}, error() {} };
const addLink = operations.find(o => o.name === 'add_link')!;
const removeLink = operations.find(o => o.name === 'remove_link')!;
const ALICE = 'people/alice-example';
const ACME = 'companies/acme-example';
const BETA = 'companies/beta-example';

function ctxFor(engine: BrainEngine, sourceId: string): OperationContext {
  return { engine, sourceId, remote: false, config: { engine: engine.kind, embedding_disabled: true } as never, dryRun: false, logger };
}

async function putPage(engine: BrainEngine, sourceId: string, slug: string, content: string) {
  const snapshot = await engine.readPageSnapshot(slug, { sourceId });
  await submitPageMutation(ctxFor(engine, sourceId), { operation: 'put_page',
    params: { slug, content, request_id: randomUUID(), ...(snapshot ? { expected_revision: snapshot.revision } : {}) } });
}

/** A filesystem source with an active canonical owner: alice, acme and beta are seeded, then managed persistence turns on. */
async function managedFixture(run: (engine: BrainEngine, sourceId: string, root: string) => Promise<void>,
  seed?: (engine: BrainEngine, sourceId: string) => Promise<void>) {
  for (const engine of engines) {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-links-fence-'));
    const root = join(dir, 'brain'); mkdirSync(root);
    const sourceId = `lf-${randomUUID().slice(0, 8)}`;
    try {
      await withEnv({ GBRAIN_HOME: join(dir, 'home') }, async () => {
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
        await engine.setConfig('sync.write_through', 'true');
        await claimWorktree(engine, sourceId, root);
        await putPage(engine, sourceId, ALICE, '---\ntitle: Alice\ntype: person\n---\nAlice works on widgets.');
        await putPage(engine, sourceId, ACME, '---\ntitle: Acme\ntype: company\n---\nAcme makes widgets.');
        await putPage(engine, sourceId, BETA, '---\ntitle: Beta\ntype: company\n---\nBeta makes gadgets.');
        await seed?.(engine, sourceId);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
        await run(engine, sourceId, root);
      });
    } finally {
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

interface Edge { to_slug: string; link_type: string; link_source: string; origin_slug: string | null; origin_field: string | null; context: string }
async function edgesFrom(engine: BrainEngine, sourceId: string, slug = ALICE): Promise<Edge[]> {
  return engine.executeRaw<Edge>(`SELECT t.slug AS to_slug, l.link_type, l.link_source, o.slug AS origin_slug, l.origin_field, l.context
    FROM links l JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id LEFT JOIN pages o ON o.id=l.origin_page_id
    WHERE f.source_id=$1 AND f.slug=$2 ORDER BY t.slug, l.link_type, l.link_source, l.origin_field NULLS FIRST`, [sourceId, slug]);
}
const fenced = (to: string, link_type: string, link_source = 'manual', context = ''): Edge =>
  ({ to_slug: to, link_type, link_source, origin_slug: ALICE, origin_field: 'links_fence', context });

const body = async (engine: BrainEngine, sourceId: string, slug = ALICE) => (await engine.getPage(slug, { sourceId }))!.compiled_truth;
const file = (root: string, slug = ALICE) => readFileSync(join(root, `${slug}.md`), 'utf-8');

/** Deletes rows the way a lost projection would, inside a coordinated transaction (a managed brain refuses bare writes). */
async function coordinated(engine: BrainEngine, sourceId: string, sql: string, params: unknown[]) {
  const attribution = await maintenanceAttribution(engine);
  await engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], () => tx.executeRaw(sql, params), attribution));
}

test('an unmanaged brain keeps the database-only add_link: no fence, an edge with no origin', async () => {
  await managedFixture(async (engine, sourceId) => {
    expect(await edgesFrom(engine, sourceId)).toEqual([{ to_slug: ACME, link_type: 'works_at', link_source: 'manual', origin_slug: null, origin_field: null, context: '' }]);
    expect(await body(engine, sourceId)).toBe('Alice works on widgets.');
  }, async (engine, sourceId) => {
    expect(await addLink.handler(ctxFor(engine, sourceId), { from: ALICE, to: ACME, link_type: 'works_at' })).toEqual({ status: 'ok' });
  });
});

test('add_link writes a links fence row into the from page (canonical file and stored body) and projects the edge from it', async () => {
  await managedFixture(async (engine, sourceId, root) => {
    const ctx = ctxFor(engine, sourceId);
    expect(await addLink.handler(ctx, { from: ALICE, to: ACME, link_type: 'works_at', context: 'met at a conference' })).toEqual({ status: 'ok' });
    const row = `| ${ACME} | works_at | manual |  |  | met at a conference |`;
    expect(await body(engine, sourceId)).toContain('<!--- gbrain:links:begin -->');
    expect(await body(engine, sourceId)).toContain(row);
    expect(file(root)).toContain('## Links');
    expect(file(root)).toContain(row);
    // One edge, from the fence: the fence's own cells are not also extracted as body references.
    expect(await edgesFrom(engine, sourceId)).toEqual([fenced(ACME, 'works_at', 'manual', 'met at a conference')]);
    // Idempotent: the same add is a no-op result and changes neither the file nor the edges.
    const before = file(root);
    expect(await addLink.handler(ctx, { from: ALICE, to: ACME, link_type: 'works_at', context: 'met at a conference' })).toEqual({ status: 'ok' });
    expect(file(root)).toBe(before);
    expect(await edgesFrom(engine, sourceId)).toEqual([fenced(ACME, 'works_at', 'manual', 'met at a conference')]);
  });
});

test('dated add_link keeps its dates in the fence and projects them as transitions owned by the page', async () => {
  await managedFixture(async (engine, sourceId, root) => {
    const ctx = ctxFor(engine, sourceId);
    expect(await addLink.handler(ctx, { from: ALICE, to: ACME, link_type: 'works_at', valid_from: '2025-03-01' })).toEqual({ status: 'ok' });
    expect(await addLink.handler(ctx, { from: ALICE, to: ACME, link_type: 'works_at', valid_until: '2026-01-01' })).toEqual({ status: 'ok' });
    expect(file(root)).toContain(`| ${ACME} | works_at | manual | 2025-03-01 | 2026-01-01 |  |`);
    const transitions = await engine.executeRaw<{ kind: string; occurred_on: string; producer: string; origin: string | null }>(
      `SELECT lt.kind, lt.occurred_on::text AS occurred_on, lt.producer, o.slug AS origin FROM link_transitions lt
        JOIN pages f ON f.id=lt.from_page_id LEFT JOIN pages o ON o.id=lt.origin_page_id WHERE f.source_id=$1 AND f.slug=$2 ORDER BY lt.kind DESC`, [sourceId, ALICE]);
    expect(transitions).toEqual([{ kind: 'start', occurred_on: '2025-03-01', producer: 'manual', origin: ALICE },
      { kind: 'end', occurred_on: '2026-01-01', producer: 'manual', origin: ALICE }]);
  });
});

test('re-deriving the page restores a fence edge whose links row was deleted, and a re-published body does too', async () => {
  await managedFixture(async (engine, sourceId) => {
    const ctx = ctxFor(engine, sourceId);
    await addLink.handler(ctx, { from: ALICE, to: ACME, link_type: 'works_at' });
    const drop = () => coordinated(engine, sourceId, `DELETE FROM links WHERE origin_field='links_fence' AND from_page_id=(SELECT id FROM pages WHERE source_id=$1 AND slug=$2)`, [sourceId, ALICE]);
    await drop();
    expect(await edgesFrom(engine, sourceId)).toEqual([]);
    await extractManagedStaleLinks(engine, { sourceId, slugs: [ALICE] });
    expect(await edgesFrom(engine, sourceId)).toEqual([fenced(ACME, 'works_at')]);
    await drop();
    await putPage(engine, sourceId, ALICE, (await body(engine, sourceId)).replace('Alice works on widgets.', 'Alice still works on widgets.'));
    expect(await edgesFrom(engine, sourceId)).toEqual([fenced(ACME, 'works_at')]);
  });
});

test('removing a row from the fence by a put_page removes its edge; a row whose target does not exist yields no edge and stays', async () => {
  await managedFixture(async (engine, sourceId, root) => {
    const ctx = ctxFor(engine, sourceId);
    await addLink.handler(ctx, { from: ALICE, to: ACME, link_type: 'works_at' });
    await addLink.handler(ctx, { from: ALICE, to: BETA, link_type: '' });
    expect(await edgesFrom(engine, sourceId)).toEqual([fenced(ACME, 'works_at'), fenced(BETA, '')]);
    const ghost = '| companies/ghost-example |  | manual |  |  |  |';
    const edited = (await body(engine, sourceId)).replace(`| ${ACME} | works_at | manual |  |  |  |\n`, '')
      .replace('<!--- gbrain:links:end -->', `${ghost}\n<!--- gbrain:links:end -->`);
    await putPage(engine, sourceId, ALICE, edited);
    expect(await edgesFrom(engine, sourceId)).toEqual([fenced(BETA, '')]);
    expect(file(root)).not.toContain(`| ${ACME} |`);
    expect(file(root)).toContain(ghost);
  });
});

test('remove_link removes the fence row and its edge', async () => {
  await managedFixture(async (engine, sourceId, root) => {
    const ctx = ctxFor(engine, sourceId);
    await addLink.handler(ctx, { from: ALICE, to: ACME, link_type: 'works_at', valid_from: '2025-03-01' });
    await addLink.handler(ctx, { from: ALICE, to: BETA, link_type: '' });
    expect(await removeLink.handler(ctx, { from: ALICE, to: ACME })).toEqual({ status: 'ok', removed: 1 });
    expect(file(root)).not.toContain(`| ${ACME} |`);
    expect(await body(engine, sourceId)).not.toContain(`| ${ACME} |`);
    expect(await edgesFrom(engine, sourceId)).toEqual([fenced(BETA, '')]);
    expect(await engine.executeRaw('SELECT 1 FROM link_transitions lt JOIN pages f ON f.id=lt.from_page_id WHERE f.source_id=$1 AND f.slug=$2', [sourceId, ALICE])).toEqual([]);
    expect(await removeLink.handler(ctx, { from: ALICE, to: ACME })).toEqual({ status: 'ok', removed: 0 });
  });
});

test('a legacy database-only manual edge survives re-imports (with and without a fence) and remove_link removes it', async () => {
  await managedFixture(async (engine, sourceId, root) => {
    const ctx = ctxFor(engine, sourceId);
    const legacy: Edge = { to_slug: ACME, link_type: 'works_at', link_source: 'manual', origin_slug: null, origin_field: null, context: 'legacy' };
    expect(await edgesFrom(engine, sourceId)).toEqual([legacy]);
    // A bare re-import of the page without a fence leaves it alone.
    await putPage(engine, sourceId, ALICE, '---\ntitle: Alice\ntype: person\n---\nAlice still works on widgets.');
    await extractManagedStaleLinks(engine, { sourceId, slugs: [ALICE] });
    expect(await edgesFrom(engine, sourceId)).toEqual([legacy]);
    // A re-import of a body that has a fence (to another page) leaves it alone too.
    await addLink.handler(ctx, { from: ALICE, to: BETA, link_type: '' });
    await putPage(engine, sourceId, ALICE, (await body(engine, sourceId)).replace('still works', 'works again'));
    await extractManagedStaleLinks(engine, { sourceId, slugs: [ALICE] });
    expect(await edgesFrom(engine, sourceId)).toEqual([legacy, fenced(BETA, '')]);
    expect(await removeLink.handler(ctx, { from: ALICE, to: ACME, link_type: 'works_at' })).toEqual({ status: 'ok', removed: 1 });
    expect(await edgesFrom(engine, sourceId)).toEqual([fenced(BETA, '')]);
    expect(file(root)).toContain(`| ${BETA} |`);
  }, async (engine, sourceId) => {
    await engine.addLink(ALICE, ACME, 'legacy', 'works_at', 'manual', undefined, undefined, // gbrain-allow-direct-insert: legacy database-only manual edge fixture, written before managed persistence
      { fromSourceId: sourceId, toSourceId: sourceId, originSourceId: sourceId });
  });
});

test('a fenced add_link replaces the database-only twin of its edge; a body that drops the whole fence leaves its edges until remove_link', async () => {
  await managedFixture(async (engine, sourceId) => {
    const ctx = ctxFor(engine, sourceId);
    expect(await addLink.handler(ctx, { from: ALICE, to: ACME, link_type: 'works_at', context: 'fenced' })).toEqual({ status: 'ok' });
    expect(await edgesFrom(engine, sourceId)).toEqual([fenced(ACME, 'works_at', 'manual', 'fenced')]);
    await putPage(engine, sourceId, ALICE, '---\ntitle: Alice\ntype: person\n---\nAlice works on widgets, no fence.');
    expect(await edgesFrom(engine, sourceId)).toEqual([fenced(ACME, 'works_at', 'manual', 'fenced')]);
    // No row in git backs that edge any more, so remove_link removes it.
    expect(await removeLink.handler(ctx, { from: ALICE, to: ACME })).toEqual({ status: 'ok', removed: 1 });
    expect(await edgesFrom(engine, sourceId)).toEqual([]);
  }, async (engine, sourceId) => {
    await engine.addLink(ALICE, ACME, 'legacy', 'works_at', 'manual', undefined, undefined, // gbrain-allow-direct-insert: legacy database-only manual edge fixture, written before managed persistence
      { fromSourceId: sourceId, toSourceId: sourceId, originSourceId: sourceId });
  });
});

test('remove_link keeps an edge derived from the page text and says so, instead of a silent removed: 0', async () => {
  await managedFixture(async (engine, sourceId) => {
    const ctx = ctxFor(engine, sourceId);
    await putPage(engine, sourceId, ALICE, `---\ntitle: Alice\ntype: person\n---\nAlice reads about [[${ACME}]].`);
    const derived = (await edgesFrom(engine, sourceId)).filter(edge => edge.to_slug === ACME);
    expect(derived.map(edge => edge.link_source)).toEqual(['markdown']);
    const result = await removeLink.handler(ctx, { from: ALICE, to: ACME }) as Record<string, unknown>;
    expect(result).toEqual({ status: 'ok', removed: 0, derived_from_text: [{ link_type: derived[0]!.link_type, link_source: 'markdown' }],
      message: `An edge from ${ALICE} to ${ACME} comes from the page text (links, wikilinks or frontmatter), so remove_link kept it. Edit the text of ${ALICE} (edit_page) to remove it.` });
    expect((await edgesFrom(engine, sourceId)).filter(edge => edge.to_slug === ACME)).toEqual(derived);
    // A fenced edge beside it is removed and counted; the derived one is still named.
    await addLink.handler(ctx, { from: ALICE, to: ACME, link_type: 'works_at' });
    expect(await removeLink.handler(ctx, { from: ALICE, to: ACME })).toMatchObject({ status: 'ok', removed: 1, derived_from_text: [{ link_source: 'markdown' }] });
    // Nothing derived matches the filter: no hint.
    expect(await removeLink.handler(ctx, { from: ALICE, to: BETA })).toEqual({ status: 'ok', removed: 0 });
  });
});
