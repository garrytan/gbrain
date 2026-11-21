/**
 * Before/after parity for the statements N7's callers ran themselves and now read through BrainEngine members and the
 * typed source and config reads: the doctor checks, ghost-pages, chronicle, repair scope, restore target, skills
 * status snapshot, connector holds and status, storage-manifest door, query cache config, the effective-date
 * checkpoint and the doctor entry budget. Master's text is the callers' `executeRaw` statements at the N7 base
 * 4206107ed9 (test/helpers/n7-master-sql.ts); the members are N6's (src/core/engine-sql/{facts-doctor,link-reads,
 * writer-versions}.ts, src/core/source-rows.ts) and the config members (setConfig, unsetConfig, getConfigValues).
 *
 * Each case seeds two identical fresh brains, runs master's exact text (with the run-time text building and row
 * mapping its call site had) on the first and the caller's new path on the second (the real exported function where
 * one exists: resolveRestoreTarget, resolveRepairScope, firstSourceLocalPath, isStorageManifestSource, loadCacheConfig,
 * connectorSourceRows), and requires the same rows in every column. Every moved statement the move check lists, and
 * every one-line `sources` read it cannot, is named once in ALL_SITES by its master path:line; the last case fails when
 * a site has no case, and a static case fails when a moved file still holds master's text.
 *
 * 1. Protects: the live, archived and string-config rules of the `sources` reads, the byte order of the JS sort that
 *    replaced `ORDER BY id`, the `default`-first order of the first local path, the restore target's archived-owner
 *    refusal and unordered `LIMIT 2`, the connector kind filter, the storage role match, the config get/set/unset of the
 *    checkpoint, the query cache keys, and the facts doctor counts N6's members serve.
 * 2. Fails when: a member or a caller changes a predicate, a cast, a sort, a LIMIT or an archived rule. The mutation
 *    table in the N7 report lists a mutation per moved site that this file kills on PGLite and Postgres.
 * 3. Existing coverage: test/n6-sql-move-parity.test.ts (when N6 lands) compares the members; no test compared the N7
 *    callers with the statements master ran. test/status-snapshot-source-scope.test.ts holds the remote scope of the
 *    skills status snapshot; the case below repeats it against this fixture.
 * 4. Seam: none. Real engines; rows go in through typed members where one exists and by plain INSERT for the tables no
 *    member writes.
 *
 * Named order changes: the `sources` reads that were `ORDER BY id` sort in JS by byte order (sortSourcesById). On a "C"
 * collation brain (PGLite, and a Postgres created with C) the rows are master's; on another collation the order is the
 * byte order, so those cases compare master's rows as a set and require the member's order to be JS byte order.
 * `restore-target` reads master's unordered `LIMIT 2` as the first two by byte order; a repo path owned by two live
 * sources refuses in both. `firstSourceLocalPath` takes `listAllSources` order (default first, then id), master's
 * `ORDER BY (id = 'default') DESC, id`.
 *
 * Privacy: no moved statement carries a visibility filter (sources, config and the facts doctor counts read every row,
 * as before); the seed holds private and world facts that both sides count identically. The one remote-caller path, the
 * skills status snapshot's grant filter, stays in JS and is run with a world-only remote caller below.
 *
 * Engines: PGLite always; Postgres too when DATABASE_URL is set (listed in test/postgres-unit-arms.txt). The Rust arm
 * does not apply to master's text (SQL); every member is `raw_sql` on Rust (src/core/rust-engine/members.ts), which
 * test/engine-parity/coverage.test.ts holds.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { BrainEngine } from '../src/core/engine.ts';
import type { PageInput } from '../src/core/types.ts';
import type { WriteTrust } from '../src/core/trust/tier.ts';
import { AUDIT_ROW_SOURCES, NON_EXTRACTABLE_AUDIT_SOURCE, TERMINAL_AUDIT_SOURCE } from '../src/core/facts/audit-sources.ts';
import { CONVERSATION_UNRESOLVED } from '../src/core/facts/relink-reasons.ts';
import { PAID_REEXTRACT } from '../src/core/facts/conversation-memo.ts';
import { sortSourcesById, sourceConfigText, sourceRecordsRawConfig } from '../src/core/source-rows.ts';
import { readConfigRows, readConfigValue } from '../src/core/config-values.ts';
import { RestoreTargetError, resolveRestoreTarget } from '../src/core/restore-target.ts';
import { resolveSourceId } from '../src/core/source-resolver.ts';
import { resolveRepairScope } from '../src/core/repair/core.ts';
import { firstSourceLocalPath, staleExtractionBlocked } from '../src/core/remediation/context.ts';
import { isStorageManifestSource, STORAGE_ROLE } from '../src/core/storage-manifest/door.ts';
import { loadCacheConfig } from '../src/core/search/query-cache.ts';
import { connectorSourceRows } from '../src/core/connectors/item-holds-store.ts';
import { operationsByName } from '../src/core/operations.ts';
import { backfillEffectiveDate } from '../src/core/backfill-effective-date.ts';
import { checkSharedSkillsSources } from '../src/commands/doctor/checks/shared-skills.ts';
import { dbAheadOfGitEntry } from '../src/commands/doctor/checks/db-ahead-of-git.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import type { Check } from '../src/commands/doctor.ts';
import { ENTRY_BUDGET_KEY } from '../src/commands/doctor/budget.ts';
import { testBackends } from './helpers/test-backends.ts';
import { archiveSource, createSource } from './engine-parity/harness.ts';
import { makePair } from './helpers/n4-seed.ts';
import { withCoordinatedWrite, withTrustPromotion, withWriteTrust } from '../src/core/persistence/context.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import * as M from './helpers/n7-master-sql.ts';

const P = 'src/commands/doctor/checks/';

/** Every moved caller statement, by master path:line (N7 base 4206107ed9), and the one-line `sources` reads by file. */
const ALL_SITES = [
  `${P}db-ahead-of-git.ts:67`, `${P}facts-pages.ts:26`, `${P}queue-assets.ts:58`, `${P}trust-release-unpreviewed.ts:21`,
  `${P}unlinked-facts.ts:79`, `${P}unlinked-facts.ts:87`, `${P}unlinked-facts.ts:116`, `${P}unlinked-facts.ts:128`, `${P}unlinked-facts.ts:144`,
  `${P}unlinked-facts.ts:sources`, `${P}writer-version.ts:16`, `${P}registry.ts:607`, 'src/commands/graph-query.ts:133',
  'src/core/backfill-effective-date.ts:112', 'src/core/backfill-effective-date.ts:126', 'src/core/backfill-effective-date.ts:134',
  'src/core/connectors/item-holds-store.ts:78', 'src/core/ops/skills-catalog.ts:364', 'src/core/persistence/connector-status.ts:65',
  'src/core/persistence/connector-status.ts:74', 'src/core/remediation/context.ts:45', 'src/core/repair/core.ts:292',
  'src/core/restore-target.ts:30', 'src/core/search/query-cache.ts:495', 'src/core/storage-manifest/door.ts:36',
  `${P}sources-order-by-id`,
] as const;

// ---------------------------------------------------------------- comparison (as test/n6-sql-move-parity.test.ts)

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

// ---------------------------------------------------------------- N7 additions to the world

const RESTORE_LIVE = '/tmp/n7-restore-live';
const RESTORE_ARCH = '/tmp/n7-restore-arch';
const RESTORE_DUP = '/tmp/n7-restore-dup';
const SYNC_REPO = '/tmp/n7-sync-repo';
const CHECKPOINT_KEY = 'backfill.effective_date.last_id';
const CACHE_KEYS = ['search.cache.enabled', 'search.cache.similarity_threshold', 'search.cache.ttl_seconds'];

/** Sources and config rows the N7 callers read: a storage-manifest source, a string-config source that names the role, restore paths. */
async function seedN7(e: BrainEngine, backend: 'pglite' | 'postgres'): Promise<void> {
  await createSource(e, backend, 'storage', { role: STORAGE_ROLE });
  await e.executeRaw(`INSERT INTO sources (id, name, config) VALUES ('strrole', 'strrole', to_jsonb($1::text))`, [JSON.stringify({ role: STORAGE_ROLE })]);
  await createSource(e, backend, 'rlive', {}, RESTORE_LIVE);
  await createSource(e, backend, 'rarch', {}, RESTORE_ARCH);
  await createSource(e, backend, 'dup1', {}, RESTORE_DUP);
  await createSource(e, backend, 'dup2', {}, RESTORE_DUP);
  await archiveSource(e, backend, 'rarch');
  for (const [key, value] of [['search.cache.enabled', 'false'], ['search.cache.similarity_threshold', '0.9'], ['search.cache.ttl_seconds', '600'], [ENTRY_BUDGET_KEY, '1234'], ['sync.repo_path', SYNC_REPO]]) {
    await e.executeRaw(`INSERT INTO config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [key!, value!]);
  }
}

const incarnationShape = (rows: Array<{ id?: string; incarnation: string; local_path?: string | null; config?: unknown }>) =>
  rows.map(r => ({ ...(r.id === undefined ? {} : { id: r.id }), has: typeof r.incarnation === 'string' && r.incarnation.length > 8,
    ...(r.local_path === undefined ? {} : { local_path: r.local_path }), ...(r.config === undefined ? {} : { config: r.config }) }));

/** The category of a restore-target refusal, from either side's message. */
function refusal(message: string): string {
  const archived = /belongs to archived source "([^"]+)"/.exec(message);
  if (archived) return `archived ${archived[1]}`;
  if (message.includes('requires one source')) return 'one source';
  if (message.includes('does not identify exactly one source')) return 'not exactly one source';
  if (message.includes('requires --repo')) return 'no repo';
  return `other: ${message}`;
}
const restoreAfter = async (e: BrainEngine, source: string | undefined, repo: string | undefined) => {
  try { return await resolveRestoreTarget(e, source, repo); } catch (err) {
    if (err instanceof RestoreTargetError) return { error: refusal(err.message) };
    throw err;
  }
};
const restoreMaster = (e: BrainEngine, source: string | undefined, repo: string | undefined) =>
  M.resolveRestoreTargetMaster(e, source, repo, x => resolveSourceId(x, undefined));

const MOVED_FILES = [
  'agent-session-facts', 'atom-fence-rows', 'captured-facts', 'db-ahead-of-git', 'entity-duplicates', 'extractor-facts', 'facts-pages',
  'frontmatter-keys', 'maintenance-drift', 'missing-recorded-files', 'ontology-facts', 'persistence-requests', 'queue-assets', 'rows-behind',
  'shared-skills', 'trust-release-unpreviewed', 'uncommitted-sync-deletions', 'unlinked-facts', 'unwithdrawn-facts', 'writer-version',
].map(n => `src/commands/doctor/checks/${n}.ts`).concat([
  'src/commands/doctor/registry.ts', 'src/commands/graph-query.ts', 'src/core/backfill-effective-date.ts', 'src/core/connectors/item-holds-store.ts',
  'src/core/cycle/chronicle.ts', 'src/core/ghost-pages.ts', 'src/core/ops/skills-catalog.ts', 'src/core/persistence/connector-status.ts',
  'src/core/remediation/context.ts', 'src/core/repair/core.ts', 'src/core/restore-target.ts', 'src/core/search/query-cache.ts',
  'src/core/storage-manifest/door.ts',
]);

const AUDIT = [...AUDIT_ROW_SOURCES];
const WINDOW = 100_000;
const SRC_IDS = ['default', 'other', 'gsrc'];
const statusOp = operationsByName.get_status_snapshot!;

for (const kind of testBackends()) {
  describe(`N7 caller statements before and after the move (${kind})`, () => {
    const closers: Array<() => Promise<void>> = [];
    let f: Fixture;
    beforeAll(async () => {
      covered = new Set();
      const engines = await makePair(kind, closers);
      for (const e of engines) { await seedWorld(e, kind); await seedN7(e, kind); }
      f = { before: engines[0]!, after: engines[1]!, backend: kind };
    }, 240_000);
    afterAll(async () => { for (const close of closers) await close(); });

    // -------- sources reads
    test('source ids: live, not archived and all, in byte order (the JS sort that replaced ORDER BY id)', async () => {
      const live = await site(f, `${P}sources-order-by-id`, async e => (await M.liveSourceIdRows(e)).map(r => r.id), async e => sortSourcesById(await e.listAllSources()).map(r => r.id));
      expect(live).not.toContain('arch');
      expect(live).not.toContain('rarch');
      await site(f, `${P}sources-order-by-id`, async e => (await M.notArchivedSourceIdRows(e)).map(r => r.id), async e => sortSourcesById(await e.listAllSources()).map(r => r.id));
      const all = await site(f, `${P}unlinked-facts.ts:sources`, async e => (await M.allSourceIdRows(e)).map(r => r.id), async e => sortSourcesById(await e.listAllSources({ includeArchived: true })).map(r => r.id));
      expect(all).toContain('arch');
      const member = sortSourcesById(await f.after.listAllSources()).map(r => r.id);
      expect(member).toEqual(byteSorted(member)); // master read the database collation; the member is byte order whatever it is
      expect(member.indexOf('a-c')).toBeLessThan(member.indexOf('ab'));
    });

    test('db-ahead-of-git census: live sources with their local path', async () => {
      await site(f, `${P}db-ahead-of-git.ts:67`, async e => rowsOf(await M.sourcePathRows(e)).map(r => ({ id: r.id, local_path: r.local_path })),
        async e => sortSourcesById(await e.listAllSources()).map(r => ({ id: r.id, local_path: r.local_path })));
    });

    test('repair scope: every live source, or one; an archived or unknown source refuses', async () => {
      const masterScope = async (e: BrainEngine, source?: string) => {
        const rows = await M.repairSourceRows(e, source);
        return source && !rows.length ? 'refused' : rows.map(r => r.id);
      };
      const afterScope = async (e: BrainEngine, source?: string) => {
        try { return (await resolveRepairScope(e, source)).source_ids; } catch (err) { if ((err as { code?: string }).code === 'invalid_params') return 'refused'; throw err; }
      };
      await site(f, 'src/core/repair/core.ts:292', e => masterScope(e), e => afterScope(e));
      await site(f, 'src/core/repair/core.ts:292', e => masterScope(e, 'gsrc'), e => afterScope(e, 'gsrc'));
      expect(await site(f, 'src/core/repair/core.ts:292', e => masterScope(e, 'arch'), e => afterScope(e, 'arch'))).toBe('refused');
      expect(await site(f, 'src/core/repair/core.ts:292', e => masterScope(e, 'no-such-source'), e => afterScope(e, 'no-such-source'))).toBe('refused');
    });

    test('skills status snapshot sources: live (or every source on a schema without archived), config as the driver returns it', async () => {
      const map = (rows: Array<{ id: string; name: unknown; local_path: string | null; config: unknown }>) => rows.map(r => ({ id: r.id, name: r.name, local_path: r.local_path, config: r.config ?? {} }));
      const live = await site(f, 'src/core/ops/skills-catalog.ts:364', async e => map(await M.skillsSourceRows(e)), async e => map(sortSourcesById(await sourceRecordsRawConfig(e))));
      expect(rowsOf(live).map(r => r.id)).not.toContain('arch');
      expect(rowsOf(live).find(r => r.id === 'strcfg')!.config).toBe(JSON.stringify({ kind: 'google' })); // a string config stays a string
      const all = await site(f, 'src/core/ops/skills-catalog.ts:364', async e => map(await M.skillsSourceFallbackRows(e)), async e => map(sortSourcesById(await sourceRecordsRawConfig(e, { includeArchived: true }))));
      expect(rowsOf(all).map(r => r.id)).toContain('arch');
    });

    test('skills status snapshot: a remote caller bound to one source sees no other source (world-only grant)', async () => {
      const ctx = (extra: Record<string, unknown>): any => ({ engine: f.after, config: {}, dryRun: false, logger: { info() {}, warn() {}, error() {} }, ...extra });
      const text = JSON.stringify(await statusOp.handler(ctx({ remote: true, auth: { clientId: 'c1', scopes: ['admin'], allowedSources: ['gsrc'] } }), {}));
      expect(text).toContain('/tmp/n6-google-checkout');
      for (const other of [RESTORE_LIVE, RESTORE_DUP, '"strcfg"', '"storage"']) expect(text).not.toContain(other);
      const local = JSON.stringify(await statusOp.handler(ctx({ remote: false }), {}));
      expect(local).toContain(RESTORE_LIVE); // the trusted local CLI keeps every source
    });

    test('connector sources: live connector kinds with their incarnation, local path and config; a string config has no kind', async () => {
      const shape = async (e: BrainEngine, via: 'master' | 'member') => {
        const rows = via === 'master' ? rowsOf(await M.connectorSourceRows(e)) : (await connectorSourceRows(e)) as unknown as Array<Record<string, unknown>>;
        return rows.map(r => ({ id: r.id, has: typeof r.incarnation === 'string' && r.incarnation.length > 8, local_path: r.local_path, config: r.config }));
      };
      const rows = rowsOf(await site(f, 'src/core/connectors/item-holds-store.ts:78', e => shape(e, 'master'), e => shape(e, 'member')));
      const ids = rows.map(r => r.id as string);
      expect(ids).toContain('gsrc');
      expect(ids).not.toContain('arch'); // archived
      expect(ids).not.toContain('strcfg'); // config->>'kind' of a string config is NULL
      expect(ids).toEqual(byteSorted(ids));
    });

    test('connector status reads: one source by id, or the listed ones; archived, string-config and non-connector sources are absent', async () => {
      for (const id of ['gsrc', 'ghsrc', 'arch', 'strcfg', 'default', 'no-such-source']) {
        await site(f, 'src/core/persistence/connector-status.ts:65', async e => incarnationShape(await M.connectorIncarnationRows(e, id)),
          async e => incarnationShape((await connectorSourceRows(e, [id])).map(r => ({ incarnation: r.incarnation }))), { nonEmpty: id === 'gsrc' || id === 'ghsrc' });
      }
      const idsOf = (rows: Array<{ id: string }>) => rows.map(r => r.id);
      const all = await site(f, 'src/core/persistence/connector-status.ts:74', async e => idsOf(await M.connectorStatusSourceRows(e)), async e => idsOf(await connectorSourceRows(e)));
      expect(all).toContain('gsrc');
      await site(f, 'src/core/persistence/connector-status.ts:74', async e => idsOf(await M.connectorStatusSourceRows(e, ['gsrc', 'arch', 'default', 'ghsrc'])),
        async e => idsOf(await connectorSourceRows(e, ['gsrc', 'arch', 'default', 'ghsrc'])));
      await site(f, 'src/core/persistence/connector-status.ts:74', async e => idsOf(await M.connectorStatusSourceRows(e, [])), async e => idsOf(await connectorSourceRows(e, [])), { nonEmpty: false });
    });

    test('storage manifest source: config role text; a string config has no role', async () => {
      for (const id of ['storage', 'strrole', 'gsrc', 'default', 'no-such-source']) {
        const yes = await site(f, 'src/core/storage-manifest/door.ts:36', async e => (await M.storageRoleRows(e, id)).length > 0, e => isStorageManifestSource(e, id), { nonEmpty: id === 'storage' });
        expect(yes).toBe(id === 'storage');
      }
    });

    test('restore target: the live source at the repo path, the archived owner refusal, the unique live source, the source local path or the sync repo path', async () => {
      const cases: Array<[string | undefined, string | undefined, string]> = [
        [undefined, RESTORE_LIVE, 'rlive'], [undefined, RESTORE_ARCH, 'archived rarch'], [undefined, RESTORE_DUP, 'not exactly one source'],
        [undefined, '/tmp/n7-nowhere', 'not exactly one source'], ['gsrc', undefined, 'gsrc'], ['default', undefined, 'default'],
        ['ab', undefined, 'no repo'], [undefined, undefined, 'default'], ['__all__', undefined, 'one source'], ['ab', '/tmp/n7-given', 'ab'],
      ];
      for (const [source, repo, expected] of cases) {
        const got = await site(f, 'src/core/restore-target.ts:30', e => restoreMaster(e, source, repo), e => restoreAfter(e, source, repo));
        const label = 'error' in (got as object) ? (got as { error: string }).error : (got as { source: string }).source;
        expect(label).toBe(expected);
      }
      expect((await restoreAfter(f.after, 'default', undefined) as { repo: string }).repo).toBe(SYNC_REPO);
      expect((await restoreAfter(f.after, 'gsrc', undefined) as { repo: string }).repo).toBe('/tmp/n6-google-checkout');
    });

    test('restore target on a brain with one live source: that source owns any repo; an archived-only path still refuses', async () => {
      const pair = await makePair(kind, closers);
      for (const e of pair) {
        await createSource(e, kind, 'solo', {}, '/tmp/n7-solo');
        await createSource(e, kind, 'gone', {}, '/tmp/n7-gone');
        await archiveSource(e, kind, 'gone');
        await archiveSource(e, kind, 'default');
      }
      const g: Fixture = { before: pair[0]!, after: pair[1]!, backend: kind };
      expect(await site(g, 'src/core/restore-target.ts:30', e => restoreMaster(e, undefined, '/tmp/n7-elsewhere'), e => restoreAfter(e, undefined, '/tmp/n7-elsewhere')))
        .toEqual({ source: 'solo', repo: '/tmp/n7-elsewhere' });
      await site(g, 'src/core/restore-target.ts:30', e => restoreMaster(e, undefined, '/tmp/n7-gone'), e => restoreAfter(e, undefined, '/tmp/n7-gone'));
      await site(g, 'src/core/restore-target.ts:30', e => restoreMaster(e, 'solo', undefined), e => restoreAfter(e, 'solo', undefined));
    }, 240_000);

    // -------- config reads and writes
    test('query cache config: the three cache keys', async () => {
      const rows = await site(f, 'src/core/search/query-cache.ts:495', async e => rowsOf(await M.configKeyRows(e, CACHE_KEYS)), async e => await readConfigRows(e, CACHE_KEYS));
      expect(rowsOf(rows).length).toBe(3);
      expect(await loadCacheConfig(f.after)).toEqual({ enabled: false, similarityThreshold: 0.9, ttlSeconds: 600 });
      await site(f, 'src/core/search/query-cache.ts:495', async e => rowsOf(await M.configKeyRows(e, ['no.such.key'])), async e => await readConfigRows(e, ['no.such.key']), { nonEmpty: false });
    });

    test('doctor entry budget: one config value, undefined when unset', async () => {
      const got = await site(f, `${P}registry.ts:607`, async e => (await M.configValueRows(e, ENTRY_BUDGET_KEY))[0]?.value, e => readConfigValue(e, ENTRY_BUDGET_KEY));
      expect(got).toBe('1234');
      await site(f, `${P}registry.ts:607`, async e => (await M.configValueRows(e, 'no.such.key'))[0]?.value, e => readConfigValue(e, 'no.such.key'), { nonEmpty: false });
    });

    test('effective-date checkpoint: read, write, overwrite and clear', async () => {
      const read = (e: BrainEngine, via: 'master' | 'member') => via === 'master' ? M.checkpointReadRows(e, CHECKPOINT_KEY).then(r => r[0]?.value) : readConfigValue(e, CHECKPOINT_KEY);
      const table = async (e: BrainEngine) => rowsOf(await M.configKeyRows(e, [CHECKPOINT_KEY]));
      await site(f, 'src/core/backfill-effective-date.ts:112', e => read(e, 'master'), e => read(e, 'member'), { nonEmpty: false });
      await M.checkpointWrite(f.before, CHECKPOINT_KEY, '42');
      await f.after.setConfig(CHECKPOINT_KEY, '42');
      expect(await site(f, ['src/core/backfill-effective-date.ts:112', 'src/core/backfill-effective-date.ts:126'], e => read(e, 'master'), e => read(e, 'member'))).toBe('42');
      await M.checkpointWrite(f.before, CHECKPOINT_KEY, '77');
      await f.after.setConfig(CHECKPOINT_KEY, '77');
      expect(await site(f, 'src/core/backfill-effective-date.ts:126', e => table(e), e => table(e))).toEqual([{ key: CHECKPOINT_KEY, value: '77' }]);
      await M.checkpointDelete(f.before, CHECKPOINT_KEY);
      await f.after.unsetConfig(CHECKPOINT_KEY);
      await site(f, 'src/core/backfill-effective-date.ts:134', e => table(e), e => table(e), { nonEmpty: false });
      await site(f, 'src/core/backfill-effective-date.ts:112', e => read(e, 'master'), e => read(e, 'member'), { nonEmpty: false });
    });

    // -------- doctor facts statements and the graph read (members of N6)
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
      test(`unlinked facts by origin, stats, outcomes and slugs (relink memo ${hasAttempts ? 'present' : 'absent'}); private and world facts both count`, async () => {
        const origin = await site(f, `${P}unlinked-facts.ts:87`, async e => rowsOf(await M.unlinkedOriginRows(e, SRC_IDS, AUDIT, WINDOW, hasAttempts)),
          e => e.countUnlinkedFactsByOrigin({ sourceIds: SRC_IDS, auditSources: AUDIT, windowPerSource: WINDOW, hasAttempts }));
        expect(rowsOf(origin).some(r => r.origin === 'conversation')).toBe(true);
        expect(rowsOf(origin).some(r => r.origin === 'mcp:put_page')).toBe(true); // the world-visibility fact and the private ones are counted alike
        await site(f, `${P}unlinked-facts.ts:87`, async e => rowsOf(await M.unlinkedOriginRows(e, SRC_IDS, AUDIT, 2, hasAttempts)),
          e => e.countUnlinkedFactsByOrigin({ sourceIds: SRC_IDS, auditSources: AUDIT, windowPerSource: 2, hasAttempts }));
        const stats = await site(f, `${P}unlinked-facts.ts:116`, async e => (await M.unlinkedFactStatRows(e, SRC_IDS, AUDIT, hasAttempts))[0] ?? null,
          e => e.countUnlinkedFactStats({ sourceIds: SRC_IDS, auditSources: AUDIT, hasAttempts }));
        expect(Number((stats as { facts: number }).facts)).toBeGreaterThan(0);
        for (const fix of ['relink', 'reextract', 'manual'] as const) {
          await site(f, `${P}unlinked-facts.ts:144`, async e => rowsOf(await M.unlinkedConversationSlugRows(e, 'default', AUDIT, WINDOW, fix, hasAttempts)),
            e => e.listUnlinkedConversationSlugs({ sourceId: 'default', auditSources: AUDIT, windowPerSource: WINDOW, fix, hasAttempts }), { nonEmpty: fix === 'relink' || hasAttempts });
        }
        if (hasAttempts) await site(f, `${P}unlinked-facts.ts:128`, async e => rowsOf(await M.factRelinkOutcomeRows(e, SRC_IDS)), e => e.countFactRelinkOutcomes(SRC_IDS));
      });
    }

    test('unlinked conversation slugs: most facts first, then slug by byte order', async () => {
      const tie = (await f.after.listUnlinkedConversationSlugs({ sourceId: 'default', auditSources: AUDIT, windowPerSource: WINDOW, fix: 'relink', hasAttempts: false })).map(r => r.slug);
      expect(tie).toEqual(['conv/a', 'conv/b', 'conv/c-z', 'conv/cc', 'conv/paid'].filter(s => tie.includes(s))); // an en_US sort puts cc before c-z
    });

    test('facts pages: bounded body of each live facts page, by source then slug (byte order)', async () => {
      const rows = rowsOf(await site(f, `${P}facts-pages.ts:26`, async e => rowsOf(await M.factsPageBodyRows(e)), e => e.listFactsPageBodies()));
      expect(rows.length).toBe(6); // the deleted facts page is out
      const keys = (await f.after.listFactsPageBodies()).map(r => `${r.source_id}\n${r.slug}`);
      expect(keys).toEqual(byteSorted(keys));
    });

    test('foreign edges: links of a page to another source, in, out and both', async () => {
      for (const dir of ['in', 'out', 'both'] as const) {
        await site(f, 'src/commands/graph-query.ts:133', async e => M.foreignEdgeRows(e, 'people/alice', dir, 'default'), e => e.countForeignEdges('people/alice', 'default', dir));
      }
      await site(f, 'src/commands/graph-query.ts:133', async e => M.foreignEdgeRows(e, 'people/bob', 'in', 'default'), e => e.countForeignEdges('people/bob', 'default', 'in'), { nonEmpty: false });
    });

    test('writer-version cutoff: the brain start of stamping is recorded on both texts', async () => {
      const cutoff = await f.after.readWriterVersionCutoff();
      expect(typeof cutoff).toBe('string');
      const master = (await M.writerVersionCutoffRows(f.before))[0]!;
      const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));
      expect(Math.abs(Date.parse(iso(master.cutoff)) - Date.parse(cutoff!))).toBeLessThan(60_000);
      covered.add(`${P}writer-version.ts:16`);
    });

    // -------- the moved files and the sites
    test('first source local path: live sources with a path, default first, then by id', async () => {
      const master = async (e: BrainEngine) => (await M.firstSourceLocalPathRows(e))[0]?.local_path ?? null;
      expect(await site(f, 'src/core/remediation/context.ts:45', master, e => firstSourceLocalPath(e))).toBe('/tmp/n7-restore-dup'); // dup1 sorts first by id among the live sources with a path; default has none
      for (const e of [f.before, f.after]) await e.executeRaw(`UPDATE sources SET local_path = '' WHERE id = 'default'`);
      await site(f, 'src/core/remediation/context.ts:45', master, e => firstSourceLocalPath(e)); // an empty path is skipped
      for (const e of [f.before, f.after]) await e.executeRaw(`UPDATE sources SET local_path = '/tmp/n7-default' WHERE id = 'default'`);
      expect(await site(f, 'src/core/remediation/context.ts:45', master, e => firstSourceLocalPath(e))).toBe('/tmp/n7-default'); // default first
      for (const e of [f.before, f.after]) await e.executeRaw(`UPDATE sources SET local_path = NULL WHERE id = 'default'`);
      for (const e of [f.before, f.after]) await e.executeRaw(`UPDATE sources SET archived = true WHERE id IN ('gsrc', 'rlive', 'dup1', 'dup2')`);
      await site(f, 'src/core/remediation/context.ts:45', master, e => firstSourceLocalPath(e), { nonEmpty: false }); // every pathed source archived or without a path
    });

    test('a brain without the relink memo table reports no attempts table and the memo-free counts', async () => {
      const pair = await makePair(kind, closers);
      for (const e of pair) { await seedWorld(e, kind); await e.executeRaw('DROP TABLE fact_relink_attempts'); }
      const g: Fixture = { before: pair[0]!, after: pair[1]!, backend: kind };
      const row = await site(g, `${P}unlinked-facts.ts:79`, async e => (await M.factTableCatalogRows(e))[0] ?? null, e => e.readFactTableCatalog()) as { attempts: string | null };
      expect(row.attempts).toBeNull();
      await site(g, `${P}unlinked-facts.ts:87`, async e => rowsOf(await M.unlinkedOriginRows(e, SRC_IDS, AUDIT, WINDOW, false)),
        e => e.countUnlinkedFactsByOrigin({ sourceIds: SRC_IDS, auditSources: AUDIT, windowPerSource: WINDOW, hasAttempts: false }));
    }, 240_000);

    // The cases above compare master's statement with the member; these run the moved callers themselves on a brain that
    // holds an archived source and a source that sorts before `default`, so a caller that reads archived rows or loses
    // the order fails here (mutation-checked, mut/results.tsv).
    test('callers: archived sources stay out of the skills snapshot, the shared-skills check, the git-gap census and the stale-extraction walk; default owns the first path', async () => {
      const [e] = await makePair(kind, closers);
      await createSource(e!, kind, 'aaa', {}, '/tmp/n7-caller-a');
      await createSource(e!, kind, 'zarch', { shared_skills: false }, '/tmp/n7-caller-z');
      await archiveSource(e!, kind, 'zarch');
      await e!.executeRaw(`UPDATE sources SET local_path = '/tmp/n7-caller-d' WHERE id = 'default'`);
      expect(await firstSourceLocalPath(e!)).toBe('/tmp/n7-caller-d'); // master: default first, then by id
      await e!.executeRaw(`INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline, frontmatter) VALUES ('n7/stale-archived', 'zarch', 'note', 'stale', 'b', '', '{}'::jsonb)`);
      expect(await staleExtractionBlocked(e!)).toBeUndefined(); // an archived source's stale page never blocks the walk
      expect(await checkSharedSkillsSources(e!)).toBeNull(); // the archived opt-out is not reported
      const ctx = { engine: e!, progress: { heartbeat() {} } } as unknown as DoctorContext;
      const [census] = await dbAheadOfGitEntry.run(ctx) as Check[];
      expect((census!.details as { sources_without_git_checkout: number }).sources_without_git_checkout).toBe(2); // default and aaa; the archived one is not counted
      const snapshot = JSON.stringify(await statusOp.handler({ engine: e!, config: {}, dryRun: false, remote: false, logger: { info() {}, warn() {}, error() {} } } as never, {}));
      expect(snapshot).toContain('/tmp/n7-caller-a');
      expect(snapshot).not.toContain('/tmp/n7-caller-z');
    });

    test('callers: the effective-date backfill reads, advances and clears its checkpoint', async () => {
      const [e] = await makePair(kind, closers);
      for (const slug of ['n7bf/one', 'n7bf/two', 'n7bf/three']) {
        await e!.executeRaw(`INSERT INTO pages (slug, type, title, compiled_truth, timeline, frontmatter) VALUES ($1, 'note', $1, 'b', '', '{}'::jsonb)`, [slug]);
      }
      const ids = (await e!.executeRaw<{ id: number }>(`SELECT id FROM pages WHERE slug LIKE 'n7bf/%' ORDER BY id`)).map(r => Number(r.id));
      // A walk that stops after its first batch (the callback throws) leaves the checkpoint where the batch ended.
      await expect(backfillEffectiveDate(e!, { maxRows: 1, onBatch: () => { throw new Error('stop after one batch'); } })).rejects.toThrow('stop after one batch');
      expect(await readConfigValue(e!, CHECKPOINT_KEY)).toBe(String(ids[0]));
      const first = await backfillEffectiveDate(e!, { maxRows: 1 }); // resumes after that page, and a finished walk clears the checkpoint
      expect(first.examined).toBe(1);
      expect(first.lastId).toBe(ids[1]);
      expect(await readConfigValue(e!, CHECKPOINT_KEY)).toBeUndefined();
      await e!.setConfig(CHECKPOINT_KEY, String(ids[0]));
      const resumed = await backfillEffectiveDate(e!, { maxRows: 5 });
      expect(resumed.examined).toBe(2); // resumes after the recorded page
      expect(await readConfigValue(e!, CHECKPOINT_KEY)).toBeUndefined();
    });

    test('no moved caller file still holds the statements master ran', () => {
      const stillThere = MOVED_FILES.filter(file => /\bFROM sources\b|\bFROM config\b|INTO config\b|writer_version_cutoff|FROM fact_relink_attempts|LIKE 'atoms|JOIN LATERAL/.test(readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')));
      expect(stillThere).toEqual([]);
    });

    test('every moved statement of the N7 callers has a case', () => {
      expect([...covered].sort()).toEqual([...ALL_SITES].sort());
    });
  });
}
