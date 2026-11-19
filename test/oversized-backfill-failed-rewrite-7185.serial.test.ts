/**
 * #7174 / #7184 / #7185: a size-skipped page whose backfill rewrite fails.
 *
 * The shape seen on a large brain: an older foresights stored a large page with the
 * gate's `embed_skip: oversized` marker and no chunks; `reindex --oversized`
 * held it for embedding approval and then failed to rewrite it (in the field, a
 * repeated facts fence the managed owner refuses; here, an uncoordinated local
 * edit, which the owner refuses the same way). The page stayed
 * held behind a marker nothing removes, with no chunks, so not even keyword
 * search found it, and doctor said nothing was held.
 *
 * Now: the failed rewrite puts the budget row back, the chunk safety net
 * (`embed --stale`, the cycle's embed phase) chunks the page for keyword
 * search with no vector and no provider call, `embed --held` lists no hold on
 * a marked page, and doctor `oversized_pages` counts the marked pages with and
 * without chunks.
 *
 * Serial: installs the process-global embedding transport seam.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { buildEmbedSkipMarker, EMBED_SKIP_KEY } from '../src/core/embed-skip.ts';
import { runOversizedBackfill, BACKFILL_HOLD_REASON } from '../src/core/oversized-backfill.ts';
import { holdPageEmbedding, listBudgetLimitedPages } from '../src/core/page-embedding-budget.ts';
import { runEmbedCore } from '../src/commands/embed.ts';
import { buildChecks } from '../src/commands/doctor.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { __setEmbedTransportForTests, configureGateway, resetGateway } from '../src/core/ai/gateway.ts';

const DIMS = 1536;
const NEEDLE = 'zebracornflowerneedle';
const F = '<!--- gbrain:facts:begin -->', FE = '<!--- gbrain:facts:end -->';
const FH = '| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|---|---|---|---|---|---|---|---|---|';
const fact = (n: number) => `| ${n} | acme-example ships quarterly | fact | 1.0 | private | medium | 2026-01-01 |  | chat |  |`;
const facts = (n: number) => `${F}\n${FH}\n${fact(n)}\n${FE}`;

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

let engine: PGLiteEngine;
let providerCalls = 0;
let home: string;

function body(bytes: number): string {
  const line = 'alice-example and bob-example talked about acme-example plans today.\n';
  const half = line.repeat(Math.floor(bytes / 2 / line.length));
  return `${half}The secret word is ${NEEDLE}.\n${half}`;
}

/** An older foresights's size skip: the gate's markers and no chunk rows; the body repeats a facts fence, so a rewrite today is refused. */
async function seedFencedSizeSkipped(slug: string, bytes: number): Promise<number> {
  await engine.putPage(slug, { type: 'note', title: 'Long conversation', compiled_truth: `${facts(1)}\n\n${facts(2)}\n\n${body(bytes)}`, timeline: '',
    frontmatter: { [EMBED_SKIP_KEY]: buildEmbedSkipMarker(bytes), content_flag: { reason: 'oversized' } } });
  const [row] = await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE slug = $1', [slug]);
  return Number(row!.id);
}

const budget = (pageId: number) => engine.executeRaw<{ state: string; reason: string | null }>('SELECT state, reason FROM page_embedding_budget WHERE page_id = $1', [pageId]);
const keywordHits = async () => (await engine.searchKeyword(NEEDLE, { limit: 10 })).map(hit => hit.slug);
const chunkState = async (pageId: number) => (await engine.executeRaw<{ chunks: number; vectors: number }>(
  'SELECT count(*)::int AS chunks, count(embedding)::int AS vectors FROM content_chunks WHERE page_id = $1', [pageId]))[0];

beforeAll(async () => {
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: DIMS, env: { ...process.env, OPENAI_API_KEY: 'sk-test-fake' } });
  __setEmbedTransportForTests((async (input: { values: string[] }) => {
    providerCalls++;
    return { embeddings: input.values.map(() => new Array(DIMS).fill(0.001)), usage: { tokens: input.values.length * 4 } };
  }) as never);
  engine = new PGLiteEngine();
  await engine.connect({ embedding_dimensions: DIMS } as never);
  await engine.initSchema();
}, 60_000);
afterAll(async () => { __setEmbedTransportForTests(null); resetGateway(); await engine.disconnect(); });
beforeEach(async () => { await resetPgliteState(engine); providerCalls = 0; home = mkdtempSync(join(tmpdir(), 'backfill-7185-')); });

const inHome = <T>(fn: () => Promise<T>) => withEnv({ GBRAIN_HOME: home, HOME: home, GBRAIN_AUDIT_DIR: home }, fn).finally(() => rmSync(home, { recursive: true, force: true }));

describe('a size-skipped page whose backfill rewrite fails', () => {
  test('a managed rewrite the owner refuses leaves no hold behind; an existing row is restored', () => managedBrain(async ({ engine: brain, root }) => {
    await brain.setConfig('pages.segmented_storage', 'off');
    await performManagedSync(brain, { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true } as never);
    const ids = await brain.executeRaw<{ id: number; slug: string }>("SELECT id, slug FROM pages WHERE slug LIKE 'chats/%' ORDER BY slug");
    expect(ids.map(row => row.slug)).toEqual(['chats/capped-example', 'chats/fenced-example']);
    await brain.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    for (const { id } of ids) {
      await brain.executeRaw("UPDATE pages SET frontmatter = frontmatter || jsonb_build_object('embed_skip', jsonb_build_object('reason', 'oversized', 'bytes', 1500000)) WHERE id = $1", [id]);
      await brain.executeRaw('DELETE FROM content_chunks WHERE page_id = $1', [id]);
    }
    await brain.executeRaw("INSERT INTO page_embedding_budget (page_id, state, reason) VALUES ($1, 'capped', 'cap_reached')", [Number(ids[0]!.id)]);
    await brain.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    // Both canonical files carry a local edit the owner did not coordinate, so it refuses each rewrite.
    for (const name of ['capped-example', 'fenced-example']) appendFileSync(join(root, 'chats', `${name}.md`), '\nA local edit.\n');

    const receipt = await runOversizedBackfill(brain);
    expect(receipt.failed.map(f => f.slug).sort()).toEqual(['chats/capped-example', 'chats/fenced-example']);
    expect(receipt).toMatchObject({ reindexed: 0, held_for_approval: 0, remaining: 2 });
    const rows = await brain.executeRaw<{ slug: string; state: string; reason: string }>('SELECT p.slug, b.state, b.reason FROM page_embedding_budget b JOIN pages p ON p.id = b.page_id ORDER BY p.slug');
    expect(rows).toEqual([{ slug: 'chats/capped-example', state: 'capped', reason: 'cap_reached' }]);
  }, { setup: ({ root }) => {
    git(root, 'init', '-q');
    mkdirSync(join(root, 'chats'));
    for (const name of ['capped-example', 'fenced-example']) writeFileSync(join(root, 'chats', `${name}.md`), `---\ntype: note\ntitle: Long conversation\n---\n\n${body(1_500_000)}`);
    git(root, 'add', '-A');
    git(root, '-c', 'user.name=E', '-c', 'user.email=e@e.invalid', 'commit', '-qm', 'seed');
  } }), 240_000);

  test('the chunk safety net makes it keyword-searchable with no vector; doctor counts it; embed --held lists no hold on a marked page', () => inHome(async () => {
    const pageId = await seedFencedSizeSkipped('chats/fenced-example', 1_500_000);
    await holdPageEmbedding(engine, pageId, BACKFILL_HOLD_REASON);
    expect(await keywordHits()).toEqual([]);

    const before = (await buildChecks(engine, [])).find(c => c.name === 'oversized_pages');
    expect(before).toMatchObject({ status: 'warn', details: { marked: 1, chunkless: 1 } });
    expect(before!.message).toContain('1 have no chunks, so not even keyword search finds them, and 0 are keyword-only');
    expect(await listBudgetLimitedPages(engine)).toEqual([]);

    const result = await runEmbedCore(engine, { stale: true, quiet: true });
    expect(result.chunkless_pages_healed).toBe(1);
    expect(await keywordHits()).toEqual(['chats/fenced-example']);
    const after = await chunkState(pageId);
    expect(after!.chunks).toBeGreaterThan(100);
    expect(after!.vectors).toBe(0);
    expect(providerCalls).toBe(0);

    const healed = (await buildChecks(engine, [])).find(c => c.name === 'oversized_pages');
    expect(healed).toMatchObject({ status: 'warn', details: { marked: 1, chunkless: 0 } });
  }), 120_000);
});
