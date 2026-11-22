/**
 * Mention links and thin person pages (a bare first name, an X handle).
 *
 * Shape: a person page with a full-name title, a frontmatter alias and an
 * X handle, beside thin person pages whose slugs are the bare first name, the
 * handle and the nickname. Before the person page exists the thin pages are
 * the only candidates and take the links. Once it exists, the next sweep
 * moves every handle and alias mention onto it, links a bare first name to
 * nothing, and leaves the thin pages themselves untouched (same title, body,
 * frontmatter; nothing deleted, merged or renamed); the thin pages titled
 * with the handle and the nickname gain a mention link to the person page. The second sweep is the
 * same path an upgrade takes: the gazetteer's saved entry set changes, so the
 * pages linking to a removed target are re-scanned.
 *
 * Regression: a handle mention landing on the page titled with the handle, a
 * nickname landing on a thin page titled with it while another page declares
 * it in frontmatter, a bare first name linking to a thin first-name page.
 *
 * Runs on PGLite always and on Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { setCliOptions } from '../../src/core/cli-options.ts';
import { extractStaleFromDB } from '../../src/commands/extract.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { serializeMarkdown } from '../../src/core/markdown.ts';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';

const describePg = hasDatabase() ? describe : describe.skip;

// The import path every write takes (sync, put_page): it also stores the frontmatter aliases. No git repository is involved.
const put = (engine: BrainEngine, slug: string, type: string, title: string, body: string, frontmatter: Record<string, unknown> = {}) =>
  importFromContent(engine, slug, serializeMarkdown(frontmatter, body, '', { type: type as never, title, tags: [] }), { noEmbed: true });

async function links(engine: BrainEngine): Promise<string[]> {
  const rows = await engine.executeRaw<{ f: string; t: string }>(
    `SELECT f.slug AS f, t.slug AS t FROM links l JOIN pages f ON f.id = l.from_page_id JOIN pages t ON t.id = l.to_page_id
      WHERE l.link_source = 'mentions' ORDER BY 1, 2`);
  return rows.map(r => `${r.f} -> ${r.t}`);
}

async function thinPages(engine: BrainEngine): Promise<string[]> {
  const rows = await engine.executeRaw<{ slug: string; title: string; type: string; compiled_truth: string; frontmatter: unknown; deleted: boolean }>(
    `SELECT slug, title, type, compiled_truth, frontmatter, deleted_at IS NOT NULL AS deleted FROM pages
      WHERE slug IN ('people/alice', 'people/alicetweets', 'people/ally') ORDER BY slug`);
  return rows.map(r => JSON.stringify([r.slug, r.title, r.type, r.compiled_truth, typeof r.frontmatter === 'string' ? JSON.parse(r.frontmatter) : r.frontmatter, r.deleted]));
}

async function sweep(engine: BrainEngine) {
  setCliOptions({ quiet: true, progressJson: false, progressInterval: 1000, explain: false, timeoutMs: null, brain: null });
  const r = await extractStaleFromDB(engine, { dryRun: false, jsonMode: false, quiet: true, catchUp: true });
  return { state: r.mentions?.state, remaining: r.mentions?.remaining };
}

async function scenario(engine: BrainEngine) {
  await engine.setConfig('schema_pack', 'gbrain-base-v2');
  await put(engine, 'people/alice', 'person', 'Alice', 'Stub.', { x_handle: 'unknown' });
  await put(engine, 'people/alicetweets', 'person', 'alicetweets', 'Stub.');
  await put(engine, 'people/ally', 'person', 'Ally', 'Stub.');
  await put(engine, 'notes/first-name', 'note', 'First name', 'Lunch with Alice today.');
  await put(engine, 'notes/handle', 'note', 'Handle', 'Reposted a thread from @alicetweets.');
  await put(engine, 'notes/nickname', 'note', 'Nickname', 'Ally sent the deck.');
  await put(engine, 'notes/placeholder', 'note', 'Placeholder', 'Owner: @unknown, status unknown.');
  const before = { sweep: await sweep(engine), links: await links(engine), thin: await thinPages(engine) };

  await put(engine, 'people/alice-example', 'person', 'Alice Example', 'Founder of Acme Example.',
    { aliases: ['Ally'], x_handle: '@alicetweets' });
  await put(engine, 'notes/fresh', 'note', 'Fresh', 'Alice said @alicetweets would post it; Ally agreed.');
  await put(engine, 'notes/full', 'note', 'Full', 'Alice Example joined the call.');
  const after = { sweep: await sweep(engine), links: await links(engine), thin: await thinPages(engine) };
  return { before, after };
}

const expectFixed = (r: Awaited<ReturnType<typeof scenario>>) => {
  expect(r.before.sweep).toEqual({ state: 'complete', remaining: 0 });
  // Before the person page exists the thin pages are the only candidates.
  expect(r.before.links).toEqual([
    'notes/first-name -> people/alice',
    'notes/handle -> people/alicetweets',
    'notes/nickname -> people/ally',
  ]);
  expect(r.after.sweep).toEqual({ state: 'complete', remaining: 0 });
  expect(r.after.links).toEqual([
    'notes/fresh -> people/alice-example',
    'notes/full -> people/alice-example',
    'notes/handle -> people/alice-example',
    'notes/nickname -> people/alice-example',
    // The thin pages titled with the handle and the nickname name the person by them.
    'people/alicetweets -> people/alice-example',
    'people/ally -> people/alice-example',
  ]);
  expect(r.after.thin).toEqual(r.before.thin);
  expect(r.after.thin).toHaveLength(3);
};

let pglite: PGLiteEngine;
let pgliteRun: Awaited<ReturnType<typeof scenario>>;
beforeAll(async () => {
  pglite = new PGLiteEngine();
  await pglite.connect({});
  await pglite.initSchema();
  pgliteRun = await scenario(pglite);
}, 180_000);
afterAll(async () => { await pglite.disconnect(); });

describe('mentions and thin person pages (PGLite)', () => {
  test('handle and alias mentions land on the person page, a bare first name links nothing, thin pages stay as they were', () => {
    expectFixed(pgliteRun);
  });
});

describePg('mentions and thin person pages (Postgres)', () => {
  let pgRun: Awaited<ReturnType<typeof scenario>>;
  beforeAll(async () => {
    const pg = await setupDB();
    for (const table of ['page_aliases', 'page_mention_state', 'mention_gazetteer_entries', 'mention_index_status']) await pg.executeRaw(`DELETE FROM ${table}`);
    pgRun = await scenario(pg);
  }, 180_000);
  afterAll(async () => { await teardownDB(); });

  test('the same outcome on Postgres', () => {
    expectFixed(pgRun);
    expect(pgRun).toEqual(pgliteRun);
  });
});
