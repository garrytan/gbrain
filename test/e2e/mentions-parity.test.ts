/**
 * Entity mention index: PGLite and Postgres parity.
 *
 * Protects: the v206 migration shape (origin-aware page_aliases, mention
 * state, entry and status tables) and the pass, alias writes, entity card
 * and get_backlinks paging producing the same rows on both engines. Bound
 * `text[]` parameters, the JSONB-free status writes and the conditional
 * publish's `FOR SHARE` reads run on real Postgres here, which PGLite cannot
 * prove. Regression: an engine-specific SQL difference in the pass or the
 * referrer query.
 *
 * Gated by DATABASE_URL (skips without it); the PGLite half always runs.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { setCliOptions } from '../../src/core/cli-options.ts';
import { extractStaleFromDB } from '../../src/commands/extract.ts';
import { buildEntityCard } from '../../src/core/verbs/entity-card.ts';
import { readReferrerPage } from '../../src/core/mentions/referrers.ts';
import { loadSourcePack } from '../../src/core/mentions/policy.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { serializeMarkdown } from '../../src/core/markdown.ts';
import { resolveQueryEntity, searchAliasRequired } from '../../src/core/search/alias-fanout.ts';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';

const SKIP_PG = !hasDatabase();
const describeBoth = SKIP_PG ? describe.skip : describe;

async function seed(engine: BrainEngine): Promise<void> {
  await engine.setConfig('schema_pack', 'gbrain-base-v2');
  const put = (slug: string, type: string, title: string, body: string) =>
    engine.putPage(slug, { type: type as never, title, compiled_truth: body, timeline: '', frontmatter: {} }, { sourceId: 'default' });
  await put('crm/123', 'crm', 'CRM record: Quormiro Capital', 'Account code: QUCO\nOwner: Dana Example');
  await put('crm/124', 'crm', 'CRM record: Quormiro Labs', 'Account code: QULA');
  await put('people/dana', 'person', 'Dana Example', 'Account owner.');
  for (let i = 0; i < 14; i++) await put(`tickets/t${String(i).padStart(2, '0')}`, 'ticket', `Ticket ${i}`, `Customer: QUCO\nStatus: ${i === 3 ? 'Open' : 'Closed'}`);
  await put('meetings/m1', 'meeting', 'Meeting: QULA renewal prep', 'Quormiro asked about Dana Example.');
  await put('notes/lower', 'note', 'Lowercase', 'quco is not a code here');
  // Identity siblings: the account sheet declares a nickname; a note names only the shared subject.
  await put('accounts/quormiro-capital', 'account', 'Account sheet: Quormiro Capital', 'Internal nickname: Copper Fox');
  await put('notes/subject-only', 'note', 'Renewal call', 'Quormiro Capital called about the renewal.');
  const doc = (slug: string, body: string) => importFromContent(engine, slug, serializeMarkdown({}, body, '', { type: 'note', title: slug, tags: [] }), { noEmbed: true, forceRechunk: true });
  await doc('docs/cf1', 'Copper Fox renewal slipped; refund pending.');
  await doc('docs/cf2', 'Copper Fox renewal closed on time.');
  // Distinct referrer dates: both engines order the newest-first page identically,
  // independent of how many writes share one clock tick.
  await engine.executeRaw(
    `UPDATE pages SET effective_date = TIMESTAMPTZ '2026-01-01T00:00:00Z' + (substring(slug from 10)::int * INTERVAL '1 day')
      WHERE slug LIKE 'tickets/t%'`);
}

async function snapshot(engine: BrainEngine) {
  setCliOptions({ quiet: true, progressJson: false, progressInterval: 1000, explain: false, timeoutMs: null, brain: null });
  const sweep = await extractStaleFromDB(engine, { dryRun: false, jsonMode: false, quiet: true, catchUp: true });
  const links = await engine.executeRaw<{ f: string; t: string }>(
    `SELECT f.slug AS f, t.slug AS t FROM links l JOIN pages f ON f.id = l.from_page_id JOIN pages t ON t.id = l.to_page_id
      WHERE l.link_source = 'mentions' ORDER BY 1, 2`);
  const aliases = await engine.executeRaw<{ slug: string; alias_norm: string; origin: string; case_sensitive: boolean }>(
    'SELECT slug, alias_norm, origin, case_sensitive FROM page_aliases ORDER BY slug, origin, alias_norm');
  const card = (await buildEntityCard(engine, 'default', 'QUCO', { remote: true, includeReferences: true })).card!;
  const pack = await loadSourcePack(engine, 'default');
  const scope = { slug: 'crm/123', sourceId: 'default', referrerSources: ['default'], excludePrivate: true, pack, keepVisibility: ['world' as const] };
  const first = await readReferrerPage(engine as never, scope, { type: 'ticket', limit: 5 });
  const columns = await engine.executeRaw<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'page_aliases' ORDER BY column_name`);
  return {
    mentions: { state: sweep.mentions?.state, remaining: sweep.mentions?.remaining },
    links: links.map(r => `${r.f}->${r.t}`),
    aliases: aliases.map(r => `${r.slug}:${r.origin}:${r.alias_norm}:${r.case_sensitive}`),
    card: { slug: card.entity.slug, count: card.referenced_by_count, groups: card.referenced_by!.map(g => `${g.canonical_type}:${g.total}:${g.rows.length}`),
      coverage: card.coverage!.state },
    page: { total: first.total, truncated: first.truncated, rows: first.rows.map(r => r.slug) },
    columns: columns.map(r => r.column_name),
    siblings: card.identity_siblings?.pages.map(p => `${p.slug}:${p.aka.join('|')}`),
    excerpt: card.identity_excerpt?.map(l => `${l.slug}:${l.line}`),
    fanout: (await searchAliasRequired(engine, 'Copper Fox', ['refund'], { sourceId: 'default', limit: 5 })).map(r => r.slug),
    resolved: (await resolveQueryEntity(engine, 'Quormiro Capital renewal', { sourceId: 'default', excludePrivate: true }))?.pages.map(p => p.slug).sort(),
  };
}

let pglite: PGLiteEngine;
let pgliteSnap: Awaited<ReturnType<typeof snapshot>>;
beforeAll(async () => {
  pglite = new PGLiteEngine();
  await pglite.connect({});
  await pglite.initSchema();
  await seed(pglite);
  pgliteSnap = await snapshot(pglite);
}, 180_000);
afterAll(async () => { await pglite.disconnect(); });

describe('entity mention index (PGLite half)', () => {
  test('the pass, aliases, card and paging produce the expected rows', () => {
    expect(pgliteSnap.mentions).toEqual({ state: 'complete', remaining: 0 });
    expect(pgliteSnap.links).toContain('meetings/m1->crm/124');
    expect(pgliteSnap.links).not.toContain('notes/lower->crm/123');
    expect(pgliteSnap.card).toEqual({ slug: 'crm/123', count: 15, groups: ['note:1:1', 'ticket:14:10'], coverage: 'complete' });
    expect(pgliteSnap.links).toEqual(expect.arrayContaining(['notes/subject-only->crm/123', 'notes/subject-only->accounts/quormiro-capital']));
    expect(pgliteSnap.siblings).toEqual(['accounts/quormiro-capital:Copper Fox|Quormiro Capital']);
    expect(pgliteSnap.excerpt).toContain('accounts/quormiro-capital:Internal nickname: Copper Fox');
    expect(pgliteSnap.fanout).toEqual(['docs/cf1', 'docs/cf2']);
    expect(pgliteSnap.resolved).toEqual(['accounts/quormiro-capital', 'crm/123']);
    expect(pgliteSnap.page).toMatchObject({ total: 14, truncated: true });
    expect(pgliteSnap.columns).toEqual(expect.arrayContaining(['origin', 'case_sensitive', 'alias_text']));
  });
});

describeBoth('entity mention index (Postgres parity)', () => {
  let pgSnap: Awaited<ReturnType<typeof snapshot>>;
  beforeAll(async () => {
    const pg = await setupDB();
    // setupDB truncates page-keyed tables only; alias rows and mention state from earlier files would leak in.
    for (const table of ['page_aliases', 'page_mention_state', 'mention_gazetteer_entries', 'mention_index_status']) await pg.executeRaw(`DELETE FROM ${table}`);
    await seed(pg);
    pgSnap = await snapshot(pg);
  }, 180_000);
  afterAll(async () => { await teardownDB(); });

  test('Postgres produces the same links, alias rows, card and page as PGLite', () => {
    expect(pgSnap).toEqual(pgliteSnap);
  });
});
