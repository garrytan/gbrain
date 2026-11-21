/**
 * Before/after parity for the reads that moved behind BrainEngine members in N6 (the doctor facts statements, the link
 * and graph reads, the writer-version reads) and for the `sources` reads that now go through typed source members:
 * the callers' `executeRaw` statements at the carry base abefe7f3af (test/helpers/n6-master-sql.ts) against the members
 * in src/core/engine-sql/{facts-doctor,link-reads,writer-versions}.ts and src/core/source-rows.ts.
 *
 * Each case seeds two identical fresh brains, runs master's exact text (with the run-time text building and row
 * mapping its call site had) on the first and the member on the second, and requires the same rows in every column.
 * Every site the move check lists is named once in ALL_SITES by its master path:line; the last case fails when a site
 * has no case.
 *
 * 1. Protects: the moved read sites answer the same rows on the same data: the deleted-page, archived-source and
 *    quarantine filters, the private-row and world-only (excludePrivate) rules of the page, link-origin and referrer
 *    filters, the optional source scope, the order a caller read in, the NULL and empty answers, the fact windows and
 *    the 42P01 shape of a brain without fact_relink_attempts.
 * 2. Fails when: a member's text or mapping changes a predicate, a join, a cast, a window, a LIMIT, or an ORDER BY the
 *    caller read in. the mutation table in the N6 move check report lists a mutation per member (and per named order change) that this file kills.
 * 3. Existing coverage: test/engine-parity/{facts-doctor,link-reads,writer-versions} compare the engines with each
 *    other; no test compared a member with the statement master ran, and the Rust engine has no raw SQL to run
 *    master's text.
 * 4. Seam: none. Real engines; rows go in through typed members where one exists and by plain INSERT for the tables no
 *    member writes (facts, links, fact_relink_attempts, write_gate_holds, persistence requests).
 *
 * Named order changes (test names say "byte order"): the members read `ORDER BY ... COLLATE "C"` where master read the
 * database collation (listOutsideContentFenceCounts, listFactsPageBodies, listUnlinkedConversationSlugs, listPagesTitledIn),
 * and the `sources` reads that were `ORDER BY id` sort in JS by byte order (sortSourcesById). On a "C" collation brain
 * (PGLite, and a Postgres created with C) the rows are master's. On another collation the member's order is the byte
 * order, so those cases compare master's rows as a set and require the member's order to be JS byte order.
 *
 * Engines: PGLite always; Postgres too when DATABASE_URL is set (listed in test/postgres-unit-arms.txt). The Rust arm
 * does not apply to master's text (SQL); every N6 member is `raw_sql` on Rust (src/core/rust-engine/members.ts), which
 * test/engine-parity/coverage.test.ts holds.
 *
 * Privacy: the page-visibility filters (`excludePrivate`) of listLivePageSummaries, listPagesTitledIn,
 * countInboundLinks and readEntityInboundEdges each run with a private row and a world-only caller below, and the
 * quarantine filter of countEntityPages and entityGraphCoverage with a quarantined page.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { PageInput } from '../src/core/types.ts';
import type { WriteTrust } from '../src/core/trust/tier.ts';
import { AUDIT_ROW_SOURCES, NON_EXTRACTABLE_AUDIT_SOURCE, TERMINAL_AUDIT_SOURCE } from '../src/core/facts/audit-sources.ts';
import { CONVERSATION_UNRESOLVED } from '../src/core/facts/relink-reasons.ts';
import { PAID_REEXTRACT } from '../src/core/facts/conversation-memo.ts';
import { resetFtsLanguageCache } from '../src/core/fts-language.ts';
import type { EntityTypeFilter } from '../src/core/schema-pack/entity-types.ts';
import { sortSourcesById, sourceConfigText, sourceRecordsRawConfig } from '../src/core/source-rows.ts';
import { testBackends } from './helpers/test-backends.ts';
import { envForFile, withEnv } from './helpers/with-env.ts';
import { archiveSource, createSource } from './engine-parity/harness.ts';
import { makePair } from './helpers/n4-seed.ts';
import { editRequest, requestFixture } from './helpers/persistence-request-fixture.ts';
import { declarePersistenceProtocol } from '../src/core/persistence/protocol.ts';
import { withCoordinatedWrite, withTrustPromotion, withWriteTrust } from '../src/core/persistence/context.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import * as M from './helpers/n6-master-sql.ts';

/** Every removed or changed caller statement the move check lists for N6, by master path:line (carry base abefe7f3af). */
const ALL_SITES = [
  'src/commands/doctor/checks/conversation-outcomes.ts:27', 'src/commands/doctor/checks/facts-redaction-marker.ts:15',
  'src/commands/doctor/checks/outside-content-fences.ts:26', 'src/commands/doctor/checks/queue-assets.ts:58',
  'src/commands/doctor/checks/trust-release-unpreviewed.ts:21',
  'src/commands/doctor/checks/unlinked-facts.ts:79', 'src/commands/doctor/checks/unlinked-facts.ts:87',
  'src/commands/doctor/checks/unlinked-facts.ts:116', 'src/commands/doctor/checks/unlinked-facts.ts:128',
  'src/commands/doctor/checks/unlinked-facts.ts:144',
  'src/commands/doctor/checks/vector-coverage.ts:46', 'src/core/facts/embedding-identity.ts:42',
  'src/commands/doctor/checks/fence-integrity.ts:192', 'src/commands/doctor/checks/facts-pages.ts:26',
  'src/commands/doctor/checks/graph-embedding.ts:80', 'src/commands/doctor/checks/graph-embedding.ts:92', 'src/commands/doctor/checks/graph-embedding.ts:476',
  'src/commands/doctor/checks/graph-health.ts:48', 'src/commands/doctor/checks/graph-health.ts:61', 'src/commands/doctor/checks/graph-health.ts:183',
  'src/commands/graph-query.ts:133', 'src/commands/orphans.ts:177',
  'src/core/verbs/entity-card.ts:625', 'src/core/verbs/entity-card.ts:639',
  'src/core/persistence/links-preparation.ts:80', 'src/core/search/entity-anchor.ts:82', 'src/core/search/fact-relevance.ts:167',
  'src/core/eligibility/fence-overlay.ts:345', 'src/core/eligibility/fence-overlay.ts:358',
  'src/commands/doctor/checks/writer-version.ts:16', 'src/core/persistence/writer-versions.ts:51', 'src/core/persistence/writer-versions.ts:75',
  'src/commands/orphans.ts:68', 'src/core/google/file-modes.ts:77', 'src/core/ops/loops.ts:config', 'src/core/ops/loops.ts:clock',
  'src/core/ops/loops.ts:157', 'src/commands/status.ts:sources', 'src/core/ops/graph-rank.ts:135', 'src/core/mentions/stale.ts:30',
  'src/commands/doctor/checks/sources-order-by-id',
] as const;

// ---------------------------------------------------------------- comparison

interface Fixture { before: BrainEngine; after: BrainEngine; backend: 'pglite' | 'postgres' }
interface Opts { ordered?: boolean; nonEmpty?: boolean }

/** One canonical form for both sides: bigint and digit text to number, dates to ISO, JSON text parsed, keys sorted. */
function canon(v: unknown, ordered: boolean): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (v instanceof Map) return canon(Object.fromEntries(v), ordered); // a Map answer compares by its entries
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string') {
    if (/^-?\d{1,15}$/.test(v)) return Number(v);
    if (/^[[{]/.test(v)) { try { return canon(JSON.parse(v), ordered); } catch { return v; } }
    return v;
  }
  if (Array.isArray(v)) {
    const items = v.map(x => canon(x, ordered));
    return ordered ? items : items.sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0));
  }
  if (typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, canon(x, ordered)]));
  return v;
}

/** Does the answer carry data: a non-empty list, a non-zero count, a true flag, or any such field. */
function hasData(v: unknown): boolean {
  if (v === null || v === undefined) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return true;
  if (v instanceof Date) return true;
  if (v instanceof Map) return v.size > 0;
  if (typeof v === 'object') return Object.values(v as object).some(hasData);
  return true;
}

/** The sites each case has proved; the last case compares it with ALL_SITES. */
let covered: Set<string>;

/** Run master's text on the before brain and the member on the after brain; require the same rows. */
async function site(f: Fixture, keys: string | string[], before: (e: BrainEngine) => Promise<unknown>, after: (e: BrainEngine) => Promise<unknown>, o: Opts = {}): Promise<unknown> {
  const b = await before(f.before);
  const a = await after(f.after);
  expect(canon(a, o.ordered ?? false)).toEqual(canon(b, o.ordered ?? false));
  if (o.nonEmpty !== false) expect(hasData(b)).toBe(true);
  for (const k of Array.isArray(keys) ? keys : [keys]) covered.add(k);
  return b;
}

const rowsOf = (v: unknown) => v as Array<Record<string, unknown>>;
const without = (rows: Array<Record<string, unknown>>, ...drop: string[]) => rows.map(r => Object.fromEntries(Object.entries(r).filter(([k]) => !drop.includes(k))));
const byteSorted = (xs: string[]) => [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
const P = 'src/commands/doctor/checks/';

// ---------------------------------------------------------------- seeds (identical on both brains, in the same order)

const page = (type: string, title: string, frontmatter: Record<string, unknown> = {}, compiled_truth = `${title} body`): PageInput =>
  ({ type: type as never, title, compiled_truth, timeline: '', frontmatter });

async function link(e: BrainEngine, from: [string, string], to: [string, string], type: string, context: string, linkSource: string | null = null, origin: [string, string] | null = null, field: string | null = null) {
  await e.executeRaw(
    `INSERT INTO links (from_page_id, to_page_id, link_type, context, link_source, origin_page_id, origin_field)
     SELECT f.id, t.id, $5, $6, $7, o.id, $10 FROM pages f JOIN pages t ON t.source_id = $3 AND t.slug = $4
       LEFT JOIN pages o ON o.source_id = $8 AND o.slug = $9 WHERE f.source_id = $1 AND f.slug = $2`,
    [from[0], from[1], to[0], to[1], type, context, linkSource, origin?.[0] ?? null, origin?.[1] ?? null, field]);
}

const LONG_FACT = 'a'.repeat(8001);
const PAID_SLUG = 'conv/paid';

/** Raw fact insert: the columns the doctor statements read. */
async function fact(e: BrainEngine, f: { source?: string; slug?: string | null; entity?: string | null; text: string; src?: string; context?: string | null; rowNum?: number | null; embedded?: 'none' | 'ok' | 'old'; expired?: boolean; attributed?: string | null; created?: string; visibility?: string }): Promise<number> {
  const [row] = await e.executeRaw<{ id: number | string }>(
    `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source, source_markdown_slug, context, row_num, expired_at, attributed_to, created_at,
       embedding, embedding_model, embedded_text_hash)
     VALUES ($1, $2, $3, 'fact', $4, $5, $6, $7, $8, CASE WHEN $9::boolean THEN now() ELSE NULL END, $10, COALESCE($11::timestamptz, now()),
       CASE WHEN $12 = 'none' THEN NULL ELSE (SELECT array_fill(0.1::real, ARRAY[1536])::vector) END,
       CASE WHEN $12 = 'none' THEN NULL WHEN $12 = 'old' THEN 'old-model' ELSE 'm1' END,
       CASE WHEN $12 = 'none' THEN NULL ELSE md5($3) END) RETURNING id`,
    [f.source ?? 'default', f.entity ?? null, f.text, f.visibility ?? 'private', f.src ?? 'mcp:put_page', f.slug ?? null, f.context ?? null, f.rowNum ?? null,
      f.expired === true, f.attributed ?? null, f.created ?? null, f.embedded ?? 'none']);
  return Number(row!.id);
}

async function seedWorld(e: BrainEngine, backend: 'pglite' | 'postgres'): Promise<void> {
  // Sources: a federated one, live and archived ones, a google and a github connector, a string-config source, ids that sort differently by byte and by locale.
  await createSource(e, backend, 'other', { federated: true });
  await createSource(e, backend, 'gsrc', { kind: 'google' }, '/tmp/n6-google-checkout');
  await createSource(e, backend, 'ghsrc', { kind: 'github' });
  await createSource(e, backend, 'arch', { kind: 'google' });
  await createSource(e, backend, 'ab', { note: 'sorts after a-c by byte order' });
  await createSource(e, backend, 'a-c', { kind: 'slack' });
  await e.executeRaw(`INSERT INTO sources (id, name, config) VALUES ('strcfg', 'strcfg', to_jsonb($1::text))`, [JSON.stringify({ kind: 'google' })]);
  await e.executeRaw(`UPDATE sources SET last_sync_at = '2026-03-04T05:06:07Z' WHERE id IN ('gsrc', 'other')`);

  // Pages: an entity set with a private, a quarantined and a deleted page; slugs whose byte and locale order differ; a second source.
  await e.putPage('people/alice', page('person', 'Alice Example'));
  await e.putPage('people/bob', page('person', 'Bob Example', { visibility: 'private' }));
  await e.putPage('people/carol', page('person', 'Carol Example', { quarantine: { reason: 'n6 fixture' } }));
  await e.putPage('companies/acme', page('company', 'Acme'));
  await e.putPage('notes/n1', page('note', 'Launch Plan'));
  await e.putPage('notes/gone', page('note', 'Gone Page'));
  for (const slug of ['x/a-b', 'x/a_b', 'x/ab']) await e.putPage(slug, page('note', `Slug ${slug}`));
  await e.putPage('hub/h1', page('note', 'Hub One'));
  await e.putPage('transcripts/t1', page('note', 'Transcript', { transcript_import: true }));
  await e.putPage('people/alice', page('person', 'Alice Example'), { sourceId: 'other' });
  await e.putPage('companies/acme', page('company', 'Acme'), { sourceId: 'other' });
  await e.putPage('companies/acme', page('company', 'Acme'), { sourceId: 'arch' });
  await e.putPage('hub/h1', page('note', 'Hub One', { google_contact_id: 'c1' }), { sourceId: 'gsrc' });
  // Imported pages the outside-content-fence read lists: email and meeting pages in a google source, a github page; slugs in byte and locale order.
  for (const slug of ['mail/m-1', 'mail/m_1', 'mail/m1']) await e.putPage(slug, page('email', `Mail ${slug}`), { sourceId: 'gsrc' });
  await e.putPage('docs/readme', page('doc', 'Readme'), { sourceId: 'ghsrc' });
  await e.putPage('facts/b', page('facts', 'Facts B', {}, 'b-body'));
  await e.putPage('facts/a-b', page('facts', 'Facts A-B', {}, 'ab-body'));
  await e.putPage('facts/a_b', page('facts', 'Facts A_B', {}, 'a_b-body'));
  await e.putPage('facts/ab', page('facts', 'Facts AB', {}, 'ab2-body'), { sourceId: 'other' });
  // Slugs whose byte order and locale order differ ('-' is skipped by an en_US sort: a-z comes after aa there, before it by byte), a deleted facts page, a person template, short titles.
  await e.putPage('facts/a-z', page('facts', 'Facts A-Z', {}, 'a-z-body'));
  await e.putPage('facts/aa', page('facts', 'Facts AA', {}, 'aa-body'));
  await e.putPage('facts/gone', page('facts', 'Facts Gone', {}, 'gone-body'));
  await e.putPage('templates/new-person', page('person', 'Person Template'));
  await e.putPage('zed/z-b', page('note', 'Zed'));
  await e.putPage('zed/za', page('note', 'Zed'));
  await e.putPage('zed/ox', page('note', 'Ox'));
  for (const slug of ['mail/m-z', 'mail/ma']) await e.putPage(slug, page('email', `Mail ${slug}`), { sourceId: 'gsrc' });
  await e.putPage(PAID_SLUG, page('note', 'Paid conversation'));
  await e.softDeletePage('notes/gone');
  await e.softDeletePage('facts/gone');
  await archiveSource(e, backend, 'arch');

  // Timeline for the coverage read.
  await e.addTimelineEntry('people/alice', { date: '2026-01-02', source: 'crm', summary: 'Met', detail: 'first meeting' });

  // Links to people/alice: every row of the origin and privacy matrix (see the inbound cases).
  const alice: [string, string] = ['default', 'people/alice'];
  await link(e, ['default', 'notes/n1'], alice, 'mentions_x', 'Alice works at Acme');
  await link(e, ['default', 'x/a-b'], alice, 'mentions_x', 'private origin', null, ['default', 'people/bob'], 'links_fence');
  await link(e, ['default', 'x/a_b'], alice, 'mentions_x', 'deleted origin', null, ['default', 'notes/gone']);
  await link(e, ['default', 'x/ab'], alice, 'mentions_x', 'foreign origin', null, ['other', 'people/alice']);
  await link(e, ['default', 'people/bob'], alice, 'mentions_x', 'private referrer');
  await link(e, ['default', 'companies/acme'], alice, 'mentions_x', 'body mention', 'mentions');
  await link(e, alice, ['other', 'companies/acme'], 'works_at', 'cross-source out');
  await link(e, ['other', 'people/alice'], alice, 'same_as', 'cross-source in');
  // Hub edges: more than three link ends on two pages that share a slug.
  for (const to of [['default', 'people/alice'], ['default', 'companies/acme'], ['default', 'notes/n1'], ['default', 'people/bob']] as Array<[string, string]>) {
    await link(e, ['default', 'hub/h1'], to, 'lists', `hub to ${to[1]}`);
  }
  for (const to of [['default', 'people/alice'], ['default', 'companies/acme'], ['default', 'notes/n1'], ['default', 'people/bob']] as Array<[string, string]>) {
    await link(e, ['gsrc', 'hub/h1'], to, 'lists', `gsrc hub to ${to[1]}`);
  }
  // Fence-indexed edges and facts on the imported pages.
  await link(e, ['gsrc', 'mail/m-1'], alice, 'fence', 'fence link', null, ['gsrc', 'mail/m-1'], 'links_fence');
  await link(e, ['gsrc', 'mail/m_1'], alice, 'fence', 'fence link 2', null, ['gsrc', 'mail/m_1'], 'links_fence');
  await link(e, ['gsrc', 'mail/m-z'], alice, 'fence', 'fence link 3', null, ['gsrc', 'mail/m-z'], 'links_fence');
  await link(e, ['gsrc', 'mail/ma'], alice, 'fence', 'fence link 4', null, ['gsrc', 'mail/ma'], 'links_fence');
  // A link to a deleted page: the linked-page count skips it.
  await link(e, ['default', 'x/ab'], ['default', 'notes/gone'], 'mentions_x', 'link to a deleted page');
  const acme: [string, string] = ['default', 'companies/acme'];
  await link(e, ['ghsrc', 'docs/readme'], acme, 'fence', 'github fence link', null, ['ghsrc', 'docs/readme'], 'links_fence');
  await link(e, ['default', 'transcripts/t1'], acme, 'fence', 'transcript fence link', null, ['default', 'transcripts/t1'], 'links_fence');
  // Takes on the github page: one active, one retired (only the active one is counted).
  await e.executeRaw(`INSERT INTO takes (page_id, row_num, claim, kind, holder, weight, active)
    SELECT id, n.row_num, n.claim, 'take', 'brain', 0.5, n.active FROM pages, (VALUES (1, 'github take', true), (2, 'retired github take', false)) AS n(row_num, claim, active)
    WHERE source_id = 'ghsrc' AND slug = 'docs/readme'`);

  // Facts: derived (conversation) rows with and without entity, tried and paid memo rows, audit rows, redaction marker, atoms, embeddings.
  const derived = 'cli:extract-conversation-facts:v1';
  const f1 = await fact(e, { slug: 'conv/a', text: 'conversation fact one', src: derived, created: '2026-01-01T00:00:00Z' });
  const f2 = await fact(e, { slug: 'conv/a', text: 'conversation fact two', src: derived, created: '2026-01-02T00:00:00Z' });
  const f3 = await fact(e, { slug: 'conv/b', text: 'conversation fact three', src: derived, created: '2026-01-03T00:00:00Z' });
  const f4 = await fact(e, { slug: PAID_SLUG, text: 'conversation fact paid', src: derived, created: '2026-01-04T00:00:00Z' });
  await fact(e, { slug: 'conv/a', entity: 'people/alice', text: 'linked conversation fact', src: derived });
  const daysAgo = (d: number) => new Date(Date.now() - d * 86400_000).toISOString();
  await fact(e, { slug: 'conv/a', text: 'conversation fact from 15 days ago', src: derived, created: daysAgo(15) }); // inside a 30 day window, outside a 7 day one
  await fact(e, { slug: 'conv/c-z', text: 'conversation fact c-z', src: derived, created: '2026-01-05T00:00:00Z' });
  await fact(e, { slug: 'conv/cc', text: 'conversation fact cc', src: derived, created: '2026-01-06T00:00:00Z' });
  await fact(e, { slug: 'people/alice', text: 'put page fact [redacted by policy]', src: 'mcp:put_page', rowNum: 1, visibility: 'world' });
  await fact(e, { slug: 'people/alice', text: 'extraction fact', src: 'sync:import', context: 'entity inferred from page', rowNum: 2 });
  await fact(e, { text: 'remembered fact', src: 'cli:remember', context: 'x — entity inferred from mention' });
  await fact(e, { slug: 'atoms/a1', text: 'atom fact', src: 'cli:remember' });
  await fact(e, { text: 'context atom fact', src: 'cli:remember', context: 'atoms/zz' });
  await fact(e, { slug: 'conv/a', text: 'audit outcome', src: TERMINAL_AUDIT_SOURCE });
  await fact(e, { slug: 'conv/b', text: 'audit outcome two', src: TERMINAL_AUDIT_SOURCE, context: 'second' });
  await fact(e, { slug: PAID_SLUG, text: 'audit outcome three', src: NON_EXTRACTABLE_AUDIT_SOURCE, context: 'third' });
  await fact(e, { slug: 'conv/a', text: 'audit outcome expired', src: TERMINAL_AUDIT_SOURCE, expired: true });
  await fact(e, { source: 'other', slug: 'people/alice', text: 'other source redacted [redacted]', src: 'mcp:put_page', rowNum: 1 });
  await fact(e, { source: 'arch', slug: 'companies/acme', text: 'archived source fact [redacted]', src: 'mcp:put_page', rowNum: 1 });
  await fact(e, { slug: 'notes/gone', text: 'fact on a deleted page', src: 'mcp:put_page', embedded: 'ok' });
  await fact(e, { slug: 'people/alice', text: 'fact with a current embedding', src: 'mcp:put_page', embedded: 'ok' });
  await fact(e, { slug: 'people/alice', text: 'fact with an old embedding', src: 'mcp:put_page', embedded: 'old' });
  await fact(e, { slug: 'people/alice', text: LONG_FACT, src: 'mcp:put_page', embedded: 'ok' });
  await fact(e, { source: 'other', slug: 'people/alice', text: 'other source stale embedding', src: 'mcp:put_page', embedded: 'old' });
  await fact(e, { slug: 'people/alice', text: 'expired fact', src: 'mcp:put_page', expired: true });
  await fact(e, { slug: 'people/alice', text: 'assistant attributed fact', src: 'mcp:put_page', attributed: 'assistant' });
  // Memo rows: f1 tried (memoized reason), f4 tried and paid (its page's content hash), f2 relinked, f3 judged no_subject.
  await e.executeRaw(`INSERT INTO fact_relink_attempts (source_id, fact_id, outcome, reason, tier) VALUES ('default', $1, $2, 'ambiguous', NULL)`, [f1, CONVERSATION_UNRESOLVED]);
  await e.executeRaw(`INSERT INTO fact_relink_attempts (source_id, fact_id, outcome, reason, tier) VALUES ('default', $1, $2, 'ambiguous', NULL)`, [f4, CONVERSATION_UNRESOLVED]);
  await e.executeRaw(
    `INSERT INTO fact_relink_attempts (source_id, fact_id, outcome, reason, tier, target_slug)
     SELECT 'default', 9000001, 'extracted', COALESCE(p.content_hash, ''), $1, p.slug FROM pages p WHERE p.source_id = 'default' AND p.slug = $2`, [PAID_REEXTRACT, PAID_SLUG]);
  await e.executeRaw(`INSERT INTO fact_relink_attempts (source_id, fact_id, outcome, reason, tier) VALUES ('default', $1, 'linked', NULL, 'free')`, [f2]);
  await e.executeRaw(`INSERT INTO fact_relink_attempts (source_id, fact_id, outcome, reason, tier) VALUES ('default', $1, 'no_subject', 'no_subject', 'free')`, [f3]);
  // Linked outcomes 3 and 10 days old: the first is inside the 7 day window, the second outside it.
  await e.executeRaw(`INSERT INTO fact_relink_attempts (source_id, fact_id, outcome, reason, tier, attempted_at) VALUES ('default', 9000002, 'linked', NULL, 'free', now() - interval '3 days')`);
  await e.executeRaw(`INSERT INTO fact_relink_attempts (source_id, fact_id, outcome, reason, tier, attempted_at) VALUES ('default', 9000003, 'linked', NULL, 'free', now() - interval '10 days')`);

  // A released trust hold for one user-confirmed fact without a preview, and one with a preview.
  const trust = async (rowNum: number, previewed: boolean) => {
    // The tier trigger stamps the tier and origin of an ordinary write; a release row is written under its declared trust.
    const origin = { channel: 'trust_release', request_id: `req-${rowNum}`, ...(previewed ? { fields_previewed: ['fact'] } : {}) } as unknown as WriteTrust['origin'];
    await e.transaction(tx => withCoordinatedWrite(tx, ['default'], () => withTrustPromotion(tx, 'user_confirmed', () => withWriteTrust(tx, { tier: 'user_confirmed', origin }, async () => {
      await tx.executeRaw(
        `INSERT INTO facts (source_id, entity_slug, fact, kind, visibility, source, source_markdown_slug, row_num)
         VALUES ('default', 'people/alice', $1, 'fact', 'private', 'mcp:put_page', 'people/alice', $2)`,
        [`trust released ${rowNum}`, rowNum]);
    })), TEST_WRITE_ATTRIBUTION));
    await e.executeRaw(
      `INSERT INTO write_gate_holds (kind, source_id, slug, fingerprint, detector_version, tier, payload, request_id, status)
       VALUES ('fact', 'default', 'people/alice', $1, 1, 'review', $2::text::jsonb, $3, 'released')`, [`fp-${rowNum}`, JSON.stringify({ row_num: rowNum }), `req-${rowNum}`]);
  };
  await trust(31, false);
  await trust(32, true);
  await trust(33, false);
}

const PERSON_COMPANY: EntityTypeFilter = { types: ['person', 'company'], per_source: [] };
const PER_SOURCE: EntityTypeFilter = { types: ['person'], per_source: [{ source_id: 'other', types: ['company'] }] };
const NO_TYPES: EntityTypeFilter = { types: [], per_source: [] };
const AUDIT = [...AUDIT_ROW_SOURCES];
const WINDOW = 100_000;
const SRC_IDS = ['default', 'other', 'gsrc'];

for (const kind of testBackends()) {
  describe(`N6 read statements before and after the move (${kind})`, () => {
    const closers: Array<() => Promise<void>> = [];
    let f: Fixture;
    beforeAll(async () => {
      covered = new Set();
      const engines = await makePair(kind, closers);
      for (const e of engines) await seedWorld(e, kind);
      f = { before: engines[0]!, after: engines[1]!, backend: kind };
    }, 240_000);
    afterAll(async () => { for (const close of closers) await close(); });

    // -------- doctor facts statements
    test('conversation outcome rows: newest first, terminal and non-extractable audit rows only, at most limit', async () => {
      const rows = await site(f, `${P}conversation-outcomes.ts:27`, async e => rowsOf(await M.conversationOutcomeRows(e, SRC_IDS, 2)), async e => e.listConversationFactRows(SRC_IDS, 2), { ordered: true });
      expect(rowsOf(rows).map(r => r.context)).toEqual(['third', 'second']); // newest first, the limit cuts the oldest, the expired row never counts
      await site(f, `${P}conversation-outcomes.ts:27`, async e => rowsOf(await M.conversationOutcomeRows(e, SRC_IDS, 50)), async e => e.listConversationFactRows(SRC_IDS, 50), { ordered: true });
      await site(f, `${P}conversation-outcomes.ts:27`, async e => rowsOf(await M.conversationOutcomeRows(e, ['arch'], 2)), e => e.listConversationFactRows(['arch'], 2), { nonEmpty: false });
    });

    test('redacted facts: live sources only, one source or all', async () => {
      const all = await site(f, `${P}facts-redaction-marker.ts:15`, async e => Number(((await M.redactedFactRows(e))[0])!.n), e => e.countRedactedFacts());
      expect(all).toBe(2); // the archived source's marker is not counted
      await site(f, `${P}facts-redaction-marker.ts:15`, async e => Number(((await M.redactedFactRows(e, ['other']))[0])!.n), e => e.countRedactedFacts(['other']));
      await site(f, `${P}facts-redaction-marker.ts:15`, async e => Number(((await M.redactedFactRows(e, ['arch']))[0])!.n), e => e.countRedactedFacts(['arch']), { nonEmpty: false });
    });

    test('outside-content fences: per imported page, the fact and link rows from its fences, by source then slug (byte order)', async () => {
      const rows = rowsOf(await site(f, `${P}outside-content-fences.ts:26`, async e => rowsOf(await M.outsideContentFenceRows(e)), e => e.listOutsideContentFenceCounts())); // master's rows as a set: its order follows the brain's collation
      const mail = (await f.after.listOutsideContentFenceCounts()).filter(r => r.source_id === 'gsrc').map(r => String(r.slug));
      expect(mail).toEqual(byteSorted(mail)); // m-z before ma by byte order whatever the locale of the brain (an en_US sort skips the '-')
      expect(rows.some(r => r.source_id === 'ghsrc' && r.slug === 'docs/readme')).toBe(true); // a github page
      expect(rows.some(r => r.slug === 'transcripts/t1')).toBe(true); // a transcript import
      expect(rows.find(r => r.slug === 'docs/readme')!.takes).toBe(1); // the retired take is not counted
      const ordered = (await f.after.listOutsideContentFenceCounts()).map(r => `${r.source_id}\n${r.slug}`);
      expect(ordered).toEqual(byteSorted(ordered));
    });

    test('atom facts: unexpired rows on an atoms page or with an atoms context', async () => {
      expect(await site(f, `${P}queue-assets.ts:58`, async e => Number((await M.atomFactRows(e))[0]!.n), e => e.countAtomFacts())).toBe(2);
    });

    test('unpreviewed trust releases: released holds whose fact carries no preview, by id, with the total', async () => {
      const rows = rowsOf(await site(f, `${P}trust-release-unpreviewed.ts:21`, async e => without(rowsOf(await M.unpreviewedTrustRows(e, 50)), 'id', 'hold_id'), async e => without(rowsOf(await e.listUnpreviewedTrustFacts(50)), 'id', 'hold_id'), { ordered: true }));
      expect(rows.map(r => Number(r.row_num))).toEqual([31, 33]); // row 32 was previewed
      expect(Number(rows[0]!.total)).toBe(2);
      await site(f, `${P}trust-release-unpreviewed.ts:21`, async e => without(rowsOf(await M.unpreviewedTrustRows(e, 1)), 'id', 'hold_id'), async e => without(rowsOf(await e.listUnpreviewedTrustFacts(1)), 'id', 'hold_id'), { ordered: true });
    });

    test('fact table catalog: facts and fact_relink_attempts regclass text', async () => {
      const row = await site(f, `${P}unlinked-facts.ts:79`, async e => (await M.factTableCatalogRows(e))[0] ?? null, e => e.readFactTableCatalog()) as { facts: string; attempts: string };
      expect(row.facts).toBe('facts');
      expect(row.attempts).toBe('fact_relink_attempts');
    });

    for (const hasAttempts of [true, false]) {
      test(`unlinked facts by origin, stats and outcomes (relink memo ${hasAttempts ? 'present' : 'absent'})`, async () => {
        const origin = await site(f, `${P}unlinked-facts.ts:87`, async e => rowsOf(await M.unlinkedOriginRows(e, SRC_IDS, AUDIT, WINDOW, hasAttempts)),
          e => e.countUnlinkedFactsByOrigin({ sourceIds: SRC_IDS, auditSources: AUDIT, windowPerSource: WINDOW, hasAttempts }));
        expect(rowsOf(origin).some(r => r.origin === 'conversation')).toBe(true);
        await site(f, `${P}unlinked-facts.ts:87`, async e => rowsOf(await M.unlinkedOriginRows(e, SRC_IDS, AUDIT, 2, hasAttempts)),
          e => e.countUnlinkedFactsByOrigin({ sourceIds: SRC_IDS, auditSources: AUDIT, windowPerSource: 2, hasAttempts })); // the newest two facts per source only
        const stats = await site(f, `${P}unlinked-facts.ts:116`, async e => (await M.unlinkedFactStatRows(e, SRC_IDS, AUDIT, hasAttempts))[0] ?? null,
          e => e.countUnlinkedFactStats({ sourceIds: SRC_IDS, auditSources: AUDIT, hasAttempts }));
        expect(Number((stats as { facts: number }).facts)).toBeGreaterThan(0);
        for (const fix of ['relink', 'reextract', 'manual'] as const) {
          await site(f, `${P}unlinked-facts.ts:144`, async e => rowsOf(await M.unlinkedConversationSlugRows(e, 'default', AUDIT, WINDOW, fix, hasAttempts)),
            e => e.listUnlinkedConversationSlugs({ sourceId: 'default', auditSources: AUDIT, windowPerSource: WINDOW, fix, hasAttempts }), { ordered: false, nonEmpty: fix === 'relink' || hasAttempts }); // a set: the tie order is asserted below
        }
      });
    }

    test('unlinked conversation slugs: most facts first, then slug by byte order', async () => {
      const slugs = (await f.after.listUnlinkedConversationSlugs({ sourceId: 'default', auditSources: AUDIT, windowPerSource: WINDOW, fix: 'relink', hasAttempts: true })).map(r => r.slug);
      expect(slugs[0]).toBe('conv/a'); // two unlinked facts (one tried, so not a relink hit: see below)
      expect(slugs.length).toBeGreaterThan(0);
      const tieSlugs = (await f.after.listUnlinkedConversationSlugs({ sourceId: 'default', auditSources: AUDIT, windowPerSource: WINDOW, fix: 'relink', hasAttempts: false })).map(r => r.slug);
      expect(tieSlugs).toEqual(['conv/a', 'conv/b', 'conv/c-z', 'conv/cc', PAID_SLUG].filter(s => tieSlugs.includes(s))); // conv/a has the most; the rest with one each sort by byte: c-z before cc before paid (an en_US sort puts cc before c-z)
    });

    test('fact relink outcomes: no_subject and recent linked rows by outcome and tier', async () => {
      await site(f, `${P}unlinked-facts.ts:128`, async e => rowsOf(await M.factRelinkOutcomeRows(e, SRC_IDS)), e => e.countFactRelinkOutcomes(SRC_IDS));
    });

    test('fact embedding coverage and stale count: missing, stale and partial rows of eligible facts, one source or all', async () => {
      const all = rowsOf(await site(f, `${P}vector-coverage.ts:46`, async e => rowsOf(await M.factEmbeddingCoverageRows(e, null, 'm1', 1536)), e => e.countFactEmbeddingCoverage({ model: 'm1', dims: 1536 })));
      const def = all.find(r => r.source_id === 'default')!;
      expect(Number(def.missing)).toBeGreaterThan(0);
      expect(Number(def.stale)).toBeGreaterThan(0);
      expect(Number(def.partial)).toBe(1); // the 8001-byte fact
      expect(all.some(r => r.source_id === 'arch')).toBe(false); // an archived source is not eligible
      await site(f, `${P}vector-coverage.ts:46`, async e => rowsOf(await M.factEmbeddingCoverageRows(e, 'other', 'm1', 1536)), e => e.countFactEmbeddingCoverage({ sourceId: 'other', model: 'm1', dims: 1536 }));
      await site(f, 'src/core/facts/embedding-identity.ts:42', async e => M.staleFactEmbeddingCount(e, 'm1', 1536), e => e.countStaleFactEmbeddings({ model: 'm1', dims: 1536 }));
      await site(f, 'src/core/facts/embedding-identity.ts:42', async e => M.staleFactEmbeddingCount(e, 'm1', 1536, 'other'), e => e.countStaleFactEmbeddings({ model: 'm1', dims: 1536, sourceId: 'other' }));
      await site(f, 'src/core/facts/embedding-identity.ts:42', async e => M.staleFactEmbeddingCount(e, 'other-model', 1536), e => e.countStaleFactEmbeddings({ model: 'other-model', dims: 1536 }));
    });

    test('segmented census: live segmented markdown pages of the sources, not in a checked-out source', async () => {
      for (const e of [f.before, f.after]) {
        await e.executeRaw(`UPDATE pages SET body_storage = 'segmented', compiled_truth = NULL, timeline = NULL, body_bytes = 1 WHERE source_id = 'default' AND slug IN ('x/ab', 'x/a-b')`);
        await e.executeRaw(`UPDATE pages SET source_path = 'x/ab.md' WHERE source_id = 'default' AND slug = 'x/ab'`);
      }
      const n = await site(f, `${P}fence-integrity.ts:192`, async e => ({ n: Number((await M.segmentedCensusRows(e, ['default'], []))[0]!.n) }), e => e.countSegmentedCensusPages(['default'], []));
      expect((n as { n: number }).n).toBe(2);
      const some = await site(f, `${P}fence-integrity.ts:192`, async e => ({ n: Number((await M.segmentedCensusRows(e, ['default'], ['default']))[0]!.n) }), e => e.countSegmentedCensusPages(['default'], ['default']));
      expect((some as { n: number }).n).toBe(1); // the checked-out source keeps only a page without a source path
    });

    test('facts pages: bounded body of each live facts page, by source then slug (byte order)', async () => {
      const rows = rowsOf(await site(f, `${P}facts-pages.ts:26`, async e => rowsOf(await M.factsPageBodyRows(e)), e => e.listFactsPageBodies()));
      expect(rows.length).toBe(6); // the deleted facts page is out
      const keys = (await f.after.listFactsPageBodies()).map(r => `${r.source_id}\n${r.slug}`);
      expect(keys).toEqual(byteSorted(keys));
    });

    // -------- link and graph reads
    test('inbound link coverage: live pages and live pages with an inbound link, all sources or some', async () => {
      await site(f, [`${P}graph-embedding.ts:80`, `${P}graph-embedding.ts:92`], async e => M.inboundCoverageRows(e), e => e.inboundLinkCoverage());
      await site(f, `${P}graph-embedding.ts:80`, async e => M.inboundCoverageRows(e, { sourceIds: ['other'] }), e => e.inboundLinkCoverage({ sourceIds: ['other'] }));
      await site(f, `${P}graph-embedding.ts:80`, async e => M.inboundCoverageRows(e, { sourceIds: ['nowhere'] }), e => e.inboundLinkCoverage({ sourceIds: ['nowhere'] }), { nonEmpty: false });
    });

    test('junk entity hubs: link-end counts over every link, chunk cap, exempt flag, canonical twin outside connector sources', async () => {
      const hubs = rowsOf(await site(f, `${P}graph-embedding.ts:476`, async e => rowsOf(await M.junkEntityHubRows(e, 3, 5, 11)), e => e.listJunkEntityHubs({ edgeThreshold: 3, maxChunks: 5, limit: 11 }), { ordered: false }));
      expect(hubs.map(h => h.slug)).toContain('hub/h1');
      const google = hubs.find(h => h.source_id === 'gsrc')!;
      expect(google.connector_page).toBe(true);
      expect(google.canonical_twin_source).toBe('default'); // the twin is the non-connector page of the same slug
      await site(f, `${P}graph-embedding.ts:476`, async e => rowsOf(await M.junkEntityHubRows(e, 3, 5, 1)), e => e.listJunkEntityHubs({ edgeThreshold: 3, maxChunks: 5, limit: 1 }));
      await site(f, `${P}graph-embedding.ts:476`, async e => rowsOf(await M.junkEntityHubRows(e, 100, 5, 11)), e => e.listJunkEntityHubs({ edgeThreshold: 100, maxChunks: 5, limit: 11 }), { nonEmpty: false });
    });

    for (const [name, filter] of [['one type list', PERSON_COMPANY], ['a per-source list', PER_SOURCE], ['no types', NO_TYPES]] as const) {
      test(`entity page counts and coverage, quarantine filter (${name})`, async () => {
        const quarantined = await site(f, `${P}graph-health.ts:183`, async e => M.entityCountRows(e, filter, { excludeQuarantined: true }), e => e.countEntityPages(filter, { excludeQuarantined: true }), { nonEmpty: filter !== NO_TYPES });
        const plain = await site(f, `${P}graph-health.ts:48`, async e => M.entityCountRows(e, filter), e => e.countEntityPages(filter), { nonEmpty: filter !== NO_TYPES });
        await site(f, `${P}graph-health.ts:48`, async e => M.entityCountRows(e, filter, { sourceId: 'default' }), e => e.countEntityPages(filter, { sourceId: 'default' }), { nonEmpty: filter !== NO_TYPES });
        if (filter === PERSON_COMPANY) {
          expect(Number(plain) - Number(quarantined)).toBe(1); // the quarantined person; the private person counts in both
        }
        const cov = await site(f, `${P}graph-health.ts:61`, async e => M.entityGraphCoverageRows(e, filter), e => e.entityGraphCoverage(filter), { nonEmpty: filter !== NO_TYPES });
        if (filter === PERSON_COMPANY) {
          expect((cov as { entities: number }).entities).toBe(Number(quarantined) - 1); // the same eligible pages less the person template: the quarantined page is out of both
        }
      });
    }

    test('foreign edges: links of a page to another source, in, out and both', async () => {
      for (const dir of ['in', 'out', 'both'] as const) {
        await site(f, 'src/commands/graph-query.ts:133', async e => M.foreignEdgeRows(e, 'people/alice', dir, 'default'), e => e.countForeignEdges('people/alice', 'default', dir));
      }
      await site(f, 'src/commands/graph-query.ts:133', async e => M.foreignEdgeRows(e, 'people/bob', 'in', 'default'), e => e.countForeignEdges('people/bob', 'default', 'in'), { nonEmpty: false });
    });

    test('live page summaries: scope, private rows hidden from a world-only caller, quarantined flag', async () => {
      const scopes = [undefined, { sourceId: 'default' }, { sourceIds: ['default', 'other'] }, { excludePrivate: true }, { excludePrivate: true, sourceId: 'default' }];
      for (const scope of scopes) {
        await site(f, 'src/commands/orphans.ts:177', async e => rowsOf(await M.livePageRows(e, scope ?? {})), async e => e.listLivePageSummaries(scope));
      }
      const all = await f.after.listLivePageSummaries();
      expect(all.find(p => p.slug === 'people/carol')!.quarantined).toBe(true);
      expect(all.some(p => p.slug === 'notes/gone')).toBe(false);
      expect(all.some(p => p.slug === 'people/bob')).toBe(true); // a local caller sees the private page
      const world = await f.after.listLivePageSummaries({ excludePrivate: true, sourceId: 'default' });
      expect(world.some(p => p.slug === 'people/bob')).toBe(false); // a world-only caller does not
      expect(world.some(p => p.slug === 'people/alice')).toBe(true);
    });

    for (const excludePrivate of [false, true]) {
      for (const originSameSource of [false, true]) {
        test(`inbound links of an entity: excludePrivate ${excludePrivate}, origin in the same source ${originSameSource}`, async () => {
          const count = await site(f, 'src/core/verbs/entity-card.ts:639', async e => Number((await M.inboundCountRows(e, 'people/alice', 'default', excludePrivate, originSameSource))[0]!.n),
            e => e.countInboundLinks('people/alice', 'default', { excludePrivate, originSameSource }));
          // n1 (no origin), x/a-b (private origin), x/ab (foreign origin), bob (private referrer), hub/h1 (another source); x/a_b (deleted origin) and the body mention never count.
          expect(count).toBe(excludePrivate ? (originSameSource ? 2 : 3) : (originSameSource ? 4 : 5));
          const edges = rowsOf(await site(f, 'src/core/verbs/entity-card.ts:625', async e => without(rowsOf(await M.inboundEdgeRows(e, 'people/alice', 'default', excludePrivate, originSameSource)), 'temporal_recorded_at', 'temporal_retired_at'),
            async e => without(rowsOf(await e.readEntityInboundEdges('people/alice', 'default', { excludePrivate, originSameSource })), 'temporal_recorded_at', 'temporal_retired_at'), { ordered: true }));
          expect(edges.length).toBe(Number(count));
          const froms = edges.map(r => r.from_slug);
          expect(froms.includes('people/bob')).toBe(!excludePrivate); // the private referrer reaches only a local caller
          expect(froms.includes('x/ab')).toBe(!originSameSource);
          expect(froms.includes('x/a_b')).toBe(false);
        });
      }
    }

    test('link endpoint pages: the origin source rows first, other sources only for the slugs asked', async () => {
      const slugs = ['people/alice', 'companies/acme', 'nope/none', 'notes/gone'];
      await site(f, 'src/core/persistence/links-preparation.ts:80', async e => rowsOf(await M.linkEndpointRows(e, 'default', slugs, ['companies/acme'])).map(r => ({ ...r, knowledge_revision: 'x' })),
        async e => (await e.listLinkEndpointPages('default', slugs, ['companies/acme'])).map(r => ({ ...r, knowledge_revision: 'x' })), { ordered: true });
      await site(f, 'src/core/persistence/links-preparation.ts:80', async e => rowsOf(await M.linkEndpointRows(e, 'other', slugs, [])).map(r => ({ ...r, knowledge_revision: 'x' })),
        async e => (await e.listLinkEndpointPages('other', slugs, [])).map(r => ({ ...r, knowledge_revision: 'x' })), { ordered: true });
      await site(f, 'src/core/persistence/links-preparation.ts:80', async e => rowsOf(await M.linkEndpointRows(e, 'default', [], [])), e => e.listLinkEndpointPages('default', [], []), { nonEmpty: false });
    });

    test('pages titled in a query: live, readable, in scope, by source then slug (byte order); private and quarantined pages hidden from a world-only caller', async () => {
      const query = 'tell me about alice example, acme, launch plan, bob example, carol example and gone page and hub one, zed and ox';
      const scopes = [{}, { sourceId: 'default' }, { sourceIds: ['default', 'other'] }, { excludePrivate: true }, { excludePrivate: true, sourceId: 'default' }, { sourceId: 'arch' }];
      for (const scope of scopes) {
        await site(f, 'src/core/search/entity-anchor.ts:82', async e => rowsOf(await M.titledPageRows(e, query, scope)).map(r => ({ ...r, id: 0 })), async e => (await e.listPagesTitledIn(query, scope)).map(r => ({ ...r, id: 0 })), { nonEmpty: scope.sourceId !== 'arch' });
      }
      const local = (await f.after.listPagesTitledIn(query, { sourceId: 'default' })).map(r => r.slug);
      expect(local).toContain('people/bob'); // a local caller reads the private page
      expect(local).not.toContain('people/carol'); // quarantined
      expect(local).not.toContain('notes/gone'); // deleted
      const world = (await f.after.listPagesTitledIn(query, { sourceId: 'default', excludePrivate: true })).map(r => r.slug);
      expect(world).not.toContain('people/bob');
      expect(world).toContain('people/alice');
      expect(await f.after.listPagesTitledIn(query, { sourceId: 'arch' })).toEqual([]); // an archived source is not read
      const all = await f.after.listPagesTitledIn(query, {});
      const keys = all.map(r => `${r.source_id}\n${r.slug}`);
      expect(keys).toEqual(byteSorted(keys));
    });

    test('word lexemes: to_tsvector of each word under the default and a non-default full-text language', async () => {
      const words = ['running', 'Dogs', 'the', 'quickly', 'a'];
      const view = (rows: Array<Record<string, unknown>>) => new Map(rows.map(r => [String(r.w), Array.isArray(r.lexemes) ? r.lexemes : String(r.lexemes ?? '').replace(/^\{|\}$/g, '').split(',').filter(Boolean)]));
      await site(f, 'src/core/search/fact-relevance.ts:167', async e => view(rowsOf(await M.wordLexemeRows(e, words))), e => e.wordLexemes(words));
      try {
        await withEnv({ GBRAIN_FTS_LANGUAGE: 'simple' }, async () => {
          resetFtsLanguageCache();
          const simple = await site(f, 'src/core/search/fact-relevance.ts:167', async e => view(rowsOf(await M.wordLexemeRows(e, words))), e => e.wordLexemes(words)) as Map<string, string[]>;
          expect(simple.get('running')).toEqual(['running']); // simple does not stem
        });
      } finally {
        resetFtsLanguageCache();
      }
    });

    test('link contexts for world-only callers: matching edges and their origin pages, a truncated context, a deleted origin', async () => {
      const alice = async (e: BrainEngine) => (await e.executeRaw<{ id: number }>(`SELECT id FROM pages WHERE source_id = 'default' AND slug = 'people/alice'`))[0]!.id;
      expect(await alice(f.before)).toBe(await alice(f.after));
      const asks = [
        { i: 0, fromSourceId: 'default', fromSlug: 'notes/n1', toSourceId: 'default', toSlug: 'people/alice', linkType: 'mentions_x', context: 'Alice works at Acme' },
        { i: 1, fromSourceId: 'default', fromSlug: 'notes/n1', toSourceId: 'default', toSlug: 'people/alice', linkType: 'mentions_x', context: 'Alice works…' }, // a truncated context
        { i: 2, fromSourceId: 'default', fromSlug: 'x/a-b', toSourceId: 'default', toSlug: 'people/alice', linkType: 'mentions_x', context: 'private origin' },
        { i: 3, fromSourceId: 'default', fromSlug: 'x/a_b', toSourceId: 'default', toSlug: 'people/alice', linkType: 'mentions_x', context: 'deleted origin' }, // the origin is deleted: no page row
        { i: 4, fromSourceId: 'default', fromSlug: 'notes/n1', toSourceId: 'default', toSlug: 'people/alice', linkType: 'mentions_x', context: 'no such context' },
      ];
      const matches = rowsOf(await site(f, 'src/core/eligibility/fence-overlay.ts:345', async e => rowsOf(await M.linkContextMatchRows(e, asks)), e => e.readLinkContextMatches(asks), { ordered: false }));
      expect(matches.map(m => Number(m.i)).sort()).toEqual([0, 1, 2, 3]);
      expect(matches.find(m => Number(m.i) === 3)!.page_id).toBeNull();
      const ids = matches.map(m => Number(m.page_id)).filter(n => n > 0);
      await site(f, 'src/core/eligibility/fence-overlay.ts:358', async e => rowsOf(await M.linkContextOriginRows(e, ids)), e => e.readLinkContextOriginPages(ids));
      await site(f, 'src/core/eligibility/fence-overlay.ts:358', async e => rowsOf(await M.linkContextOriginRows(e, [])), e => e.readLinkContextOriginPages([]), { nonEmpty: false });
      expect(await f.after.readLinkContextMatches([])).toEqual([]);
      // A segmented origin page is never returned.
      const segmented = (await f.after.executeRaw<{ id: number }>(`SELECT id FROM pages WHERE source_id = 'default' AND slug = 'x/ab'`))[0]!.id;
      expect((await f.after.readLinkContextOriginPages([Number(segmented)])).length).toBe(0);
    });

    // -------- sources reads that moved to typed members
    test('source ids: live, all and not archived, in byte order (the JS sort that replaced ORDER BY id)', async () => {
      const sites = `${P}sources-order-by-id`;
      const live = await site(f, sites, async e => (await M.liveSourceIdRows(e)).map(r => r.id), async e => sortSourcesById(await e.listAllSources()).map(r => r.id));
      expect(live).not.toContain('arch');
      // Master's rows come in the collation of the brain's database; the member's in byte order, whatever that collation.
      const memberLive = sortSourcesById(await f.after.listAllSources()).map(r => r.id);
      expect(memberLive).toEqual(byteSorted(memberLive));
      const all = await site(f, ['src/core/mentions/stale.ts:30'], async e => (await M.allSourceIdRows(e)).map(r => r.id), async e => sortSourcesById(await e.listAllSources({ includeArchived: true })).map(r => r.id));
      expect(all).toContain('arch');
      await site(f, 'src/core/ops/graph-rank.ts:135', async e => (await M.notArchivedSourceIdRows(e)).map(r => r.id), async e => (await e.listAllSources()).map(r => r.id).sort());
      // Byte order: 'a-c' before 'ab' ('-' 0x2d is below 'b' 0x62), whatever the collation of the brain's database.
      expect(memberLive.indexOf('a-c')).toBeLessThan(memberLive.indexOf('ab'));
    });

    test('connector kinds, google sources and sync clocks read from source records (string-config sources included)', async () => {
      const kinds = await site(f, 'src/commands/orphans.ts:68', async e => rowsOf(await M.connectorKindRows(e)).map(r => ({ id: r.id, kind: r.kind })),
        async e => (await sourceRecordsRawConfig(e, { includeArchived: true })).map(r => ({ id: r.id, kind: sourceConfigText(r.config, 'kind') })));
      // A non-text top-level value (the federated flag is a JSON boolean): config->>'federated' gives its JSON text, as sourceConfigText does.
      const flags = await site(f, 'src/commands/orphans.ts:68', async e => rowsOf(await e.executeRaw<{ id: string; v: string | null }>(`SELECT id, config->>'federated' AS v FROM sources`)).map(r => ({ id: r.id, v: r.v })),
        async e => (await sourceRecordsRawConfig(e, { includeArchived: true })).map(r => ({ id: r.id, v: sourceConfigText(r.config, 'federated') })));
      expect(rowsOf(flags).find(r => r.id === 'other')!.v).toBe('true');
      expect(rowsOf(kinds).find(r => r.id === 'strcfg')!.kind).toBeNull(); // a string config has no key, as config->>'kind' read
      expect(rowsOf(kinds).find(r => r.id === 'arch')!.kind).toBe('google'); // archived sources count here
      const google = await site(f, 'src/core/google/file-modes.ts:77', async e => rowsOf(await M.googleSourceRows(e)).map(r => ({ id: r.id, local_path: r.local_path, config: r.config })),
        async e => sortSourcesById(await sourceRecordsRawConfig(e)).filter(s => sourceConfigText(s.config, 'kind') === 'google').map(s => ({ id: s.id, local_path: s.local_path, config: s.config })), { ordered: true });
      expect(rowsOf(google).map(r => r.id)).toEqual(['gsrc']); // not the archived google source, not the string-config one
      const clocks = (e: BrainEngine, via: 'master' | 'member') => via === 'master'
        ? M.liveSourceClockRows(e).then(rows => rows.map(r => ({ id: r.id, last_sync_at: r.last_sync_at == null ? null : new Date(r.last_sync_at).toISOString(), config: r.config })))
        : sourceRecordsRawConfig(e).then(rows => rows.map(r => ({ id: r.id, last_sync_at: r.last_sync_at == null ? null : new Date(r.last_sync_at).toISOString(), config: r.config as unknown })));
      await site(f, 'src/core/ops/loops.ts:clock', e => clocks(e, 'master'), e => clocks(e, 'member'));
      for (const id of ['gsrc', 'strcfg', 'default', 'no-such-source']) {
        await site(f, 'src/core/ops/loops.ts:config', async e => (await M.sourceConfigRows(e, id))[0]?.config, async e => (await e.getSource(id))?.config, { nonEmpty: id !== 'no-such-source' });
      }
      const status = await site(f, 'src/commands/status.ts:sources', async e => rowsOf(await M.statusSourceRows(e)).map(r => ({ id: r.id, name: r.name, local_path: r.local_path, config: r.config })),
        async e => sortSourcesById(await sourceRecordsRawConfig(e, { includeArchived: true })).map(r => ({ id: r.id, name: r.name, local_path: r.local_path, config: r.config })));
      expect(rowsOf(status).length).toBeGreaterThan(5);
      const statusIds = sortSourcesById(await sourceRecordsRawConfig(f.after, { includeArchived: true })).map(r => r.id);
      expect(statusIds).toEqual(byteSorted(statusIds)); // the JS sort, not the brain's collation, orders the status sources
    });

    test('source incarnations of the listed sources: the incarnation, local path and config', async () => {
      const ids = ['gsrc', 'strcfg', 'other', 'default'];
      const shape = (rows: Array<{ id: string; incarnation: string; local_path: string | null; config: unknown }>) => rows.map(r => ({ id: r.id, has: typeof r.incarnation === 'string' && r.incarnation.length > 8, local_path: r.local_path, config: r.config }));
      await site(f, 'src/core/ops/loops.ts:157', async e => shape(await M.sourceIncarnationRows(e, ids)), async e => {
        const wanted = new Set(ids);
        const rows: Array<{ id: string; incarnation: string; local_path: string | null; config: unknown }> = [];
        for (const source of await e.listSourceRecords()) {
          if (!wanted.has(source.id)) continue;
          const row = await e.readSourceIncarnation(source.id);
          if (row) rows.push({ id: source.id, incarnation: row.incarnation, local_path: source.local_path, config: row.config });
        }
        return shape(rows);
      });
    });

    test('unknown schema: a brain without fact_relink_attempts reports no attempts table and the memo-free counts', async () => {
      const pair = await makePair(kind, closers);
      for (const e of pair) {
        await seedWorld(e, kind);
        await e.executeRaw('DROP TABLE fact_relink_attempts');
      }
      const g: Fixture = { before: pair[0]!, after: pair[1]!, backend: kind };
      const row = await site(g, `${P}unlinked-facts.ts:79`, async e => (await M.factTableCatalogRows(e))[0] ?? null, e => e.readFactTableCatalog()) as { attempts: string | null };
      expect(row.attempts).toBeNull();
      await site(g, `${P}unlinked-facts.ts:87`, async e => rowsOf(await M.unlinkedOriginRows(e, SRC_IDS, AUDIT, WINDOW, false)),
        e => e.countUnlinkedFactsByOrigin({ sourceIds: SRC_IDS, auditSources: AUDIT, windowPerSource: WINDOW, hasAttempts: false }));
    }, 240_000);

    test('every moved read site of the doctor, link and source members has a case', () => {
      const writerSites = new Set(['src/commands/doctor/checks/writer-version.ts:16', 'src/core/persistence/writer-versions.ts:51', 'src/core/persistence/writer-versions.ts:75']);
      expect([...covered].sort()).toEqual([...ALL_SITES].filter(s => !writerSites.has(s)).sort());
    });
  });

  // ---------------------------------------------------------------- writer-version reads (their own pair: the seed is persistence requests)
  describe(`N6 writer-version reads before and after the move (${kind})`, () => {
    const closers: Array<() => Promise<void>> = [];
    const home = mkdtempSync(join(tmpdir(), 'gbrain-n6-writer-'));
    envForFile({ GBRAIN_HOME: home });
    let f: Fixture;
    const HOSTS = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'];
    const seen = new Set<string>();

    async function seedRequests(e: BrainEngine): Promise<void> {
      const requests = await requestFixture(e, 'writer-src');
      const ids: string[] = [];
      for (const slug of ['p1', 'p2', 'p3']) ids.push((await requests.publish(await requests.admit(slug))).id);
      await requests.admit('queued-only'); // admitted, never published
      // Fixed stamps and times, so the two brains answer the same rows.
      const set = (id: string, version: string, adm: string, cons: string, created: string, published: string) =>
        editRequest(e, id, `admitter_version=$2, admitter_host_id=$3::uuid, consumer_version=$4, consumer_host_id=$5::uuid, created_at=$6::timestamptz, published_at=$7::timestamptz, completed_at=$7::timestamptz`,
          [version, adm, version, cons, created, published]);
      await set(ids[0]!, '0.60.1.0', HOSTS[0]!, HOSTS[0]!, new Date(Date.now() - 5 * 86400_000).toISOString(), new Date(Date.now() - 4 * 86400_000).toISOString());
      await set(ids[1]!, '0.60.2.0', HOSTS[1]!, HOSTS[0]!, new Date(Date.now() - 2 * 86400_000).toISOString(), new Date(Date.now() - 1 * 86400_000).toISOString());
      await set(ids[2]!, '0.60.2.0', HOSTS[1]!, HOSTS[1]!, new Date(Date.now() - 3600_000).toISOString(), new Date(Date.now() - 1800_000).toISOString());
      await e.transaction(async tx => {
        await declarePersistenceProtocol(tx);
        await tx.executeRaw(`UPDATE persistence_brain SET writer_version_cutoff = now() - interval '3 days' WHERE singleton = 1`);
      });
    }

    beforeAll(async () => {
      const engines = await makePair(kind, closers);
      // The two brains are seeded one after the other; times are offsets from now, compared to the minute below.
      for (const e of engines) await seedRequests(e);
      f = { before: engines[0]!, after: engines[1]!, backend: kind };
    }, 240_000);
    afterAll(async () => {
      for (const close of closers) await close();
      rmSync(home, { recursive: true, force: true });
    });

    /** Rows with their times cut to the minute (the brains were seeded a moment apart) and the random per-brain id of a principal dropped. */
    const minute = (rows: Array<Record<string, unknown>>) => rows.map(r => ({ ...r, principal: String(r.principal).replace(/:.*/, ':*'), last_seen: r.last_seen == null ? null : new Date(r.last_seen as string).toISOString().slice(0, 15) }));
    const iso = (v: unknown) => (v == null ? null : new Date(v as string).toISOString());

    test('writer-version cutoff: the brain start of stamping as ISO text', async () => {
      const cutoff = await f.after.readWriterVersionCutoff();
      expect(typeof cutoff).toBe('string');
      expect(Math.abs(Date.parse(cutoff!) - (Date.now() - 3 * 86400_000))).toBeLessThan(5 * 60_000);
      const master = (await M.writerVersionCutoffRows(f.before))[0]!;
      expect(Math.abs(Date.parse(iso(master.cutoff)!) - Date.parse(cutoff!))).toBeLessThan(60_000);
      seen.add('src/commands/doctor/checks/writer-version.ts:16');
      // A brain that has only just started stamping reads its own recent start, the same instant on both texts.
      const fresh = await makePair(kind, closers);
      const freshCutoff = await fresh[1]!.readWriterVersionCutoff();
      expect(typeof freshCutoff).toBe('string');
      expect(Math.abs(Date.parse(iso((await M.writerVersionCutoffRows(fresh[0]!))[0]!.cutoff)!) - Date.parse(freshCutoff!))).toBeLessThan(60_000);
    });

    test('writer versions: the latest admitter and consumer version per host and principal, newest first, at most limit', async () => {
      const before = minute(rowsOf(await M.writerVersionRows(f.before, 50)).map(r => ({ role: r.role, host_id: r.host_id ?? null, principal: r.principal, version: r.version ?? null, last_seen: iso(r.last_seen) })));
      const after = minute((await f.after.listWriterVersions(50)) as unknown as Array<Record<string, unknown>>);
      expect(after).toEqual(before);
      expect(after.length).toBeGreaterThan(3);
      expect(after.map(r => (r as Record<string, unknown>).role)).toContain('consumer');
      expect((await f.after.listWriterVersions(2)).length).toBe(2);
      expect(minute(rowsOf(await M.writerVersionRows(f.before, 2)).map(r => ({ role: r.role, host_id: r.host_id ?? null, principal: r.principal, version: r.version ?? null, last_seen: iso(r.last_seen) })))).toEqual(minute((await f.after.listWriterVersions(2)) as unknown as Array<Record<string, unknown>>));
      const lastSeen = (await f.after.listWriterVersions(50)).map(r => r.last_seen!);
      expect(lastSeen).toEqual([...lastSeen].sort().reverse());
      seen.add('src/core/persistence/writer-versions.ts:51');
    });

    test('recent writer versions: committed requests in the window, admitters after the cutoff, consumers after it, with request counts', async () => {
      for (const days of [7, 2, 0.01]) {
        const before = minute(rowsOf(await M.recentWriterVersionRows(f.before, days)).map(r => ({ role: r.role, host_id: r.host_id ?? null, principal: r.principal, version: r.version ?? null, last_seen: iso(r.last_seen), requests: Number(r.requests) })));
        const after = minute((await f.after.recentWriterVersions(days)) as unknown as Array<Record<string, unknown>>);
        expect(after).toEqual(before);
        if (days === 7) expect(after.length).toBeGreaterThan(2);
      }
      seen.add('src/core/persistence/writer-versions.ts:75');
    });

    test('every writer-version site has a case', () => {
      expect([...seen].sort()).toEqual(['src/commands/doctor/checks/writer-version.ts:16', 'src/core/persistence/writer-versions.ts:51', 'src/core/persistence/writer-versions.ts:75']);
    });
  });
}
