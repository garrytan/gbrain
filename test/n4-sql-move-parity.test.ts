/**
 * Before/after parity for the SELECTs that moved behind BrainEngine members in N4 (the source, link, timeline and
 * revision reads of the import and extract paths; the company-brain profile reads; the exact-phrase scan's next-page
 * read; the mention pass time and the exact-basename lookup; and the six reads behind `describeJobs`): the callers'
 * `executeRaw` statements at land-s2b-ns2 (eeee2cd11b, test/helpers/n4-master-sql.ts) against the members in
 * src/core/engine-sql/{cli-reads-import,cli-reads-ops,entity-reads,jobs-insight}.ts.
 *
 * Each case seeds two identical fresh brains, runs master's exact text (with the run-time text building and row mapping
 * its call site had) on the first and the member on the second, and requires the same rows in every column. Every site
 * the move check lists as a removed caller statement is named once in ALL_SITES by its master path:line; the last case
 * fails when a site has no case.
 *
 * 1. Protects: the 16 moved read sites answer the same rows on the same data: the deleted-page and source filters, the
 *    order the caller read in, the NULL and empty answers, the 42703 fallback of the source list, the LIMIT of the
 *    basename lookup, and the ahead, holder, child, lock and foreign-token rules of describeJobs.
 * 2. Fails when: a member's text or mapping changes a predicate, a join, a cast, a window, a LIMIT or an ORDER BY the
 *    caller read in. Each site has a mutation that this file kills (test/n4-mutations.md in the move check report).
 * 3. Existing coverage: test/engine-parity/jobs-insight.test.ts compares the engines with each other through the
 *    jobs member; no test compared any member with the statement master ran, and the Rust engine has no raw SQL to run
 *    master's text.
 * 4. Seam: none. Real engines; rows go in through typed members where one exists and by plain INSERT for the tables no
 *    member writes (receipts, mention status, jobs, locks). The clock read is compared by shape and distance, since two
 *    brains never read the same instant.
 *
 * Engines: PGLite always; Postgres too when DATABASE_URL is set (listed in test/postgres-unit-arms.txt). The Rust arm
 * does not apply to master's text (SQL). No read moved by N4 carries a page-visibility or privacy filter (those reads
 * stay at their call sites), so no private-row or world-only-caller case applies; the one Rust-served member,
 * `readJobInsight`, reads job rows that have no visibility filter and is compared on the Rust arm by
 * test/engine-parity/jobs-insight.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import type { PageInput } from '../src/core/types.ts';
import { testBackends } from './helpers/test-backends.ts';
import { createSource } from './engine-parity/harness.ts';
import { makePair, seedInsightJobs } from './helpers/n4-seed.ts';
import * as M from './helpers/n4-master-sql.ts';

/** Every removed caller statement the move check lists for N4, by master path:line (land-s2b-ns2 eeee2cd11b). */
const ALL_SITES = [
  'src/core/sources-load.ts:250', 'src/core/sources-load.ts:260',
  'src/core/company-brain/profile.ts:33', 'src/core/company-brain/profile.ts:34',
  'src/core/wanted-links-store.ts:37', 'src/core/link-reconciliation.ts:25', 'src/core/timeline-extract.ts:305', 'src/commands/extract.ts:150',
  'src/core/search/exact-scan.ts:193', 'src/core/mentions/stale.ts:26', 'src/core/entities/resolve.ts:367',
  'src/core/minions/job-insight.ts:149', 'src/core/minions/job-insight.ts:159', 'src/core/minions/job-insight.ts:165',
  'src/core/minions/job-insight.ts:179', 'src/core/minions/job-insight.ts:193', 'src/core/minions/job-insight.ts:219',
] as const;

// ---------------------------------------------------------------- comparison

interface Fixture { before: BrainEngine; after: BrainEngine; backend: 'pglite' | 'postgres' }
interface Opts { ordered?: boolean; nonEmpty?: boolean }

/** One canonical form for both sides: bigint and digit text to number, dates to ISO, JSON text parsed, keys sorted. */
function canon(v: unknown, ordered: boolean): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
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

// ---------------------------------------------------------------- seeds (identical on both brains, in the same order)

const page = (type: string, title: string, frontmatter: Record<string, unknown> = {}, compiled_truth = `${title} body`, timeline = ''): PageInput =>
  ({ type: type as never, title, compiled_truth, timeline, frontmatter });

const COMPANY_RECEIPT = { id: '00000000-0000-4000-8000-000000000001', revision: 'a'.repeat(40), schema: 'b'.repeat(64) };

async function seedWorld(e: BrainEngine, backend: 'pglite' | 'postgres'): Promise<void> {
  await createSource(e, backend, 'other', { federated: true });
  await createSource(e, backend, 'brand-new');
  // Link metadata and the exact-basename lookup: aliases, a deleted page, a second source, three people that share a basename.
  await e.putPage('people/alice', page('person', 'Alice Example', { aliases: ['Al', 'Ally'] }));
  await e.putPage('people/bob', page('person', 'Bob Example'));
  await e.putPage('companies/acme', page('company', 'Acme', { aliases: ['Acme Inc'] }));
  await e.putPage('notes/gone', page('note', 'Gone'));
  await e.softDeletePage('notes/gone');
  await e.putPage('people/carol', page('person', 'Carol Example'), { sourceId: 'other' });
  await e.putPage('people/dana-lee', page('person', 'Dana Lee'));
  await e.putPage('companies/dana-lee', page('company', 'Dana Lee Co'));
  await e.putPage('projects/dana-lee', page('project', 'Dana Lee Project'));
  await e.putPage('notes/dana-lee', page('note', 'Dana Lee Notes'));
  await e.putPage('meetings/dana-lee', page('meeting', 'Dana Lee Meeting'));
  await e.softDeletePage('meetings/dana-lee');
  await e.putPage('people/erin-ray', page('person', 'Erin Ray'));
  await e.putPage('companies/erin-ray', page('company', 'Erin Ray Co'));
  await e.putPage('people/erin-ray', page('person', 'Erin Ray Other'), { sourceId: 'other' });

  // Timeline rows: two plain rows and one date-index projection of an event page (event_page_id set), which the read leaves out.
  await e.addTimelineEntry('people/alice', { date: '2026-01-02', source: 'crm', summary: 'Met', detail: 'first meeting' });
  await e.addTimelineEntry('people/alice', { date: '2026-02-03', source: '', summary: 'Followed up', detail: '' });
  await e.addTimelineEntry('people/bob', { date: '2026-03-04', source: 'mail', summary: 'Other page', detail: 'x' });
  await e.putPage('events/launch', page('event', 'Launch'));
  await e.executeRaw(
    `INSERT INTO timeline_entries (page_id, date, source, summary, detail, event_page_id)
     SELECT p.id, DATE '2026-04-05', 'proj', 'Launch day', '', ev.id FROM pages p, pages ev WHERE p.slug = 'people/alice' AND ev.slug = 'events/launch'`);

  // Company-brain receipts: one for 'other' (profile company-brain), one for 'default' under another profile.
  await e.executeRaw(
    `INSERT INTO source_ingestion_receipts (id, source_id, source_incarnation, approved_revision, profile, schema_fingerprint, extractor_version)
     SELECT $1::uuid, s.id, s.incarnation, $2, 'company-brain', $3, 'v1' FROM sources s WHERE s.id = 'other'`,
    [COMPANY_RECEIPT.id, COMPANY_RECEIPT.revision, COMPANY_RECEIPT.schema]);
  await e.executeRaw(
    `INSERT INTO source_ingestion_receipts (id, source_id, source_incarnation, approved_revision, profile, schema_fingerprint, extractor_version)
     SELECT '00000000-0000-4000-8000-000000000002'::uuid, s.id, s.incarnation, $1, 'other-profile', $2, 'v1' FROM sources s WHERE s.id = 'default'`,
    [COMPANY_RECEIPT.revision, COMPANY_RECEIPT.schema]);

  // Mention pass status: two sources with a pass time, one without.
  await e.executeRaw(`INSERT INTO mention_index_status (source_id, last_pass_at) VALUES ('default', '2026-02-03T04:05:06.789Z'), ('other', '2026-05-06T07:08:09Z')`);
  await e.executeRaw(`INSERT INTO mention_index_status (source_id) VALUES ('brand-new')`);
}

/** The knowledge revision of each listed slug in the brain, as the extract paths read it. */
async function revisions(e: BrainEngine, keys: Array<[string, string]>): Promise<string[][]> {
  const out: string[][] = [];
  for (const [source, slug] of keys) {
    const [row] = await e.executeRaw<{ r: string }>('SELECT knowledge_revision::text AS r FROM pages WHERE source_id = $1 AND slug = $2', [source, slug]);
    out.push([source, slug, row!.r]);
  }
  return out;
}

for (const kind of testBackends()) {
  describe(`N4 read statements before and after the move (${kind})`, () => {
    const closers: Array<() => Promise<void>> = [];
    let f: Fixture;
    beforeAll(async () => {
      covered = new Set();
      const engines = await makePair(kind, closers);
      for (const e of engines) await seedWorld(e, kind);
      f = { before: engines[0]!, after: engines[1]!, backend: kind };
    }, 240_000);
    afterAll(async () => { for (const close of closers) await close(); });

    // -------- sources-load.ts:250 (the current columns)
    test('source list: every source, default first, with the columns loadAllSources reads', async () => {
      const rows = await site(f, 'src/core/sources-load.ts:250', async e => without(rowsOf(await M.sourcesLoadRows(e)), 'created_at'), async e => without(rowsOf(await e.listSourceRecords()), 'created_at'), { ordered: true });
      expect(rowsOf(rows).map(r => r.id)).toEqual(['default', 'brand-new', 'other']);
      expect(rowsOf(rows)[0]).toHaveProperty('archived');
      expect(rowsOf(rows)[0]).toHaveProperty('newest_content_at');
    });

    // -------- sources-load.ts:260 (a schema without archived and newest_content_at: 42703, then the minimal columns)
    test('source list on a schema behind archived and newest_content_at: the minimal columns', async () => {
      const pair = await makePair(kind, closers);
      for (const e of pair) {
        await createSource(e, kind, 'zeta');
        await e.executeRaw('ALTER TABLE sources DROP COLUMN IF EXISTS archived CASCADE');
        await e.executeRaw('ALTER TABLE sources DROP COLUMN IF EXISTS newest_content_at CASCADE');
      }
      const g: Fixture = { before: pair[0]!, after: pair[1]!, backend: kind };
      const rows = await site(g, 'src/core/sources-load.ts:260', async e => without(rowsOf(await M.sourcesLoadRows(e)), 'created_at'), async e => without(rowsOf(await e.listSourceRecords()), 'created_at'), { ordered: true });
      expect(rowsOf(rows).map(r => r.id)).toEqual(['default', 'zeta']);
      expect(rowsOf(rows)[0]).not.toHaveProperty('archived');
    }, 120_000);

    // -------- profile.ts:33 and :34
    test('company-brain profile reads: a source row, an unknown id, and the receipt of the current incarnation', async () => {
      for (const id of ['other', 'default', 'no-such-source']) {
        await site(f, 'src/core/company-brain/profile.ts:33',
          async e => { const [row] = await M.sourceIncarnationRows(e, id); return row === undefined ? null : { config: row.config, has: typeof row.incarnation === 'string' }; },
          async e => { const row = await e.readSourceIncarnation(id); return row === null ? null : { config: row.config, has: typeof row.incarnation === 'string' }; },
          { nonEmpty: id !== 'no-such-source' });
      }
      const receipt = async (id: string) => (await site(f, 'src/core/company-brain/profile.ts:34', async e => (await M.companyReceiptRows(e, id)).length > 0, e => e.hasCompanyBrainReceipt(id), { nonEmpty: false })) as boolean;
      expect(await receipt('other')).toBe(true); // a company-brain receipt of the current incarnation
      expect(await receipt('default')).toBe(false); // a receipt under another profile does not count
      expect(await receipt('brand-new')).toBe(false);
      expect(await receipt('no-such-source')).toBe(false);
    });

    // -------- wanted-links-store.ts:37
    test('database clock: a UTC ISO text with microseconds, within a minute of the other brain', async () => {
      const iso = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/;
      const before = await M.wantedReadAt(f.before);
      const after = await f.after.readDatabaseClock();
      expect(before).toMatch(iso);
      expect(after).toMatch(iso);
      expect(Math.abs(Date.parse(after) - Date.parse(before))).toBeLessThan(60_000);
      expect(Math.abs(Date.parse(after) - Date.now())).toBeLessThan(5 * 60_000);
      covered.add('src/core/wanted-links-store.ts:37');
    });

    // -------- link-reconciliation.ts:25
    test('link page metadata: live pages with aliases and revision, by source then slug, for one source or all', async () => {
      const view = (rows: Array<Record<string, unknown>>) => without(rows, 'knowledge_revision').map(r => ({ ...r, has_revision: true }));
      const all = await site(f, 'src/core/link-reconciliation.ts:25', async e => view(rowsOf(await M.linkPageMetadata(e))), async e => view(rowsOf(await e.listLinkPageMetadata())), { ordered: true });
      expect(rowsOf(all).some(r => r.slug === 'notes/gone')).toBe(false); // a soft-deleted page is left out
      expect(rowsOf(all).map(r => r.source_id)).toEqual([...rowsOf(all).map(r => String(r.source_id))].sort());
      const aliases = rowsOf(all).find(r => r.slug === 'people/alice')!.aliases;
      expect(canon(aliases, true)).toEqual(['Al', 'Ally']);
      const one = await site(f, 'src/core/link-reconciliation.ts:25', async e => view(rowsOf(await M.linkPageMetadata(e, 'other'))), async e => view(rowsOf(await e.listLinkPageMetadata('other'))), { ordered: true });
      expect(rowsOf(one).every(r => r.source_id === 'other')).toBe(true);
      await site(f, 'src/core/link-reconciliation.ts:25', async e => view(rowsOf(await M.linkPageMetadata(e, 'brand-new'))), async e => view(rowsOf(await e.listLinkPageMetadata('brand-new'))), { nonEmpty: false });
      // The revision column is the page's own knowledge revision.
      const [rev] = await f.after.executeRaw<{ r: string }>(`SELECT knowledge_revision::text AS r FROM pages WHERE slug = 'people/alice' AND source_id = 'default'`);
      const member = await f.after.listLinkPageMetadata('default');
      expect(String(member.find(r => r.slug === 'people/alice')!.knowledge_revision)).toBe(rev!.r);
    });

    // -------- timeline-extract.ts:305
    test('stored timeline rows: the non-event rows of one page, the date as text', async () => {
      const view = (rows: Array<Record<string, unknown>>) => without(rows, 'id');
      const alice = await site(f, 'src/core/timeline-extract.ts:305', async e => view(rowsOf(await M.storedTimelineRows(e, 'default', 'people/alice'))), async e => view(rowsOf(await e.listStoredTimelineRows('default', 'people/alice'))));
      expect(rowsOf(alice).map(r => r.date).sort()).toEqual(['2026-01-02', '2026-02-03']); // the event projection (2026-04-05) is not stored timeline
      await site(f, 'src/core/timeline-extract.ts:305', async e => view(rowsOf(await M.storedTimelineRows(e, 'default', 'people/bob'))), async e => view(rowsOf(await e.listStoredTimelineRows('default', 'people/bob'))));
      await site(f, 'src/core/timeline-extract.ts:305', async e => view(rowsOf(await M.storedTimelineRows(e, 'other', 'people/alice'))), async e => view(rowsOf(await e.listStoredTimelineRows('other', 'people/alice'))), { nonEmpty: false });
      // Ids come back as integers on both.
      const raw = await f.after.listStoredTimelineRows('default', 'people/alice');
      expect(raw.every(r => Number.isInteger(Number(r.id)))).toBe(true);
    });

    // -------- extract.ts:150
    test('pages at revision: the live pages still at the revision each names', async () => {
      const keys: Array<[string, string]> = [['default', 'people/alice'], ['default', 'people/bob'], ['other', 'people/carol'], ['default', 'notes/gone']];
      const fresh = async (e: BrainEngine) => {
        const triples = await revisions(e, keys);
        return [...triples, ['default', 'people/dana-lee', '00000000-0000-4000-8000-0000000000ff'], ['default', 'no/such', '00000000-0000-4000-8000-0000000000fe']];
      };
      const live = await site(f, 'src/commands/extract.ts:150',
        async e => rowsOf(await M.pagesAtRevision(e, await fresh(e))),
        async e => e.filterPagesAtRevision((await fresh(e)).map(k => ({ source_id: k[0]!, slug: k[1]!, revision: k[2]! }))));
      expect(rowsOf(live).map(r => `${r.source_id}:${r.slug}`).sort()).toEqual(['default:people/alice', 'default:people/bob', 'other:people/carol']); // the deleted page and the two stale ones are out
      await site(f, 'src/commands/extract.ts:150', async e => rowsOf(await M.pagesAtRevision(e, [])), e => e.filterPagesAtRevision([]), { nonEmpty: false });
    });

    // -------- exact-scan.ts:193
    test('next live page after an id: the first live page by id in any source, or none', async () => {
      const ids = (await f.after.executeRaw<{ id: number }>('SELECT id FROM pages WHERE deleted_at IS NULL ORDER BY id')).map(r => Number(r.id));
      const gone = Number((await f.after.executeRaw<{ id: number }>(`SELECT id FROM pages WHERE slug = 'notes/gone'`))[0]!.id);
      for (const after of [0, ids[0]!, ids[2]!, gone - 1, gone, ids[ids.length - 1]!]) {
        await site(f, 'src/core/search/exact-scan.ts:193', async e => (await M.nextLivePage(e, after)) ?? null, e => e.nextLivePageAfter(after), { nonEmpty: after !== ids[ids.length - 1] });
      }
      const next = await f.after.nextLivePageAfter(gone - 1);
      expect(next!.id).toBeGreaterThan(gone); // the soft-deleted page is skipped
      expect(await f.after.nextLivePageAfter(ids[ids.length - 1]!)).toBeNull();
    });

    // -------- stale.ts:26
    test('mention pass time: the newest pass over every source or one, whole seconds, UTC', async () => {
      const all = await site(f, 'src/core/mentions/stale.ts:26', async e => (await M.mentionLastPass(e))[0]?.last ?? null, e => e.readMentionLastPass());
      expect(all).toBe('2026-05-06T07:08:09Z');
      expect(await site(f, 'src/core/mentions/stale.ts:26', async e => (await M.mentionLastPass(e, 'default'))[0]?.last ?? null, e => e.readMentionLastPass('default'))).toBe('2026-02-03T04:05:06Z');
      await site(f, 'src/core/mentions/stale.ts:26', async e => (await M.mentionLastPass(e, 'brand-new'))[0]?.last ?? null, e => e.readMentionLastPass('brand-new'), { nonEmpty: false });
      await site(f, 'src/core/mentions/stale.ts:26', async e => (await M.mentionLastPass(e, 'no-such'))[0]?.last ?? null, e => e.readMentionLastPass('no-such'), { nonEmpty: false });
      expect(await f.after.readMentionLastPass(null)).toBe('2026-05-06T07:08:09Z'); // null reads like omitted
    });

    // -------- resolve.ts:367
    test('exact basename candidates: live pages of the source among the slugs, at most two', async () => {
      const dirs = ['people', 'companies', 'projects', 'notes', 'meetings'];
      const list = (token: string) => dirs.map(d => `${d}/${token}`);
      const set = async (e: BrainEngine, token: string, via: 'master' | 'member') =>
        (via === 'master' ? (await M.exactBasenameRows(e, 'default', list(token))).map(r => r.slug) : await e.findExactBasenameCandidates('default', list(token)));
      // Five slugs for 'dana-lee', one soft-deleted: four live, so two come back, whichever two the plan reaches first (the same on the same data).
      const b = await set(f.before, 'dana-lee', 'master');
      const a = await set(f.after, 'dana-lee', 'member');
      expect(a.length).toBe(2);
      expect(b.length).toBe(2);
      expect(new Set(a).size).toBe(2);
      expect(a.every(s => list('dana-lee').includes(s) && s !== 'meetings/dana-lee')).toBe(true);
      expect([...a].sort()).toEqual([...b].sort());
      // Two live slugs, a deleted one and another source's page: exactly the live pair, only from the source asked.
      await site(f, 'src/core/entities/resolve.ts:367', async e => (await set(e, 'erin-ray', 'master')).sort(), async e => (await set(e, 'erin-ray', 'member')).sort());
      expect((await set(f.after, 'erin-ray', 'member')).sort()).toEqual(['companies/erin-ray', 'people/erin-ray']);
      await site(f, 'src/core/entities/resolve.ts:367', async e => (await M.exactBasenameRows(e, 'other', list('erin-ray'))).map(r => r.slug), e => e.findExactBasenameCandidates('other', list('erin-ray')));
      await site(f, 'src/core/entities/resolve.ts:367', async e => (await set(e, 'nobody-here', 'master')), async e => (await set(e, 'nobody-here', 'member')), { nonEmpty: false });
      await site(f, 'src/core/entities/resolve.ts:367', async e => (await M.exactBasenameRows(e, 'default', [])).map(r => r.slug), e => e.findExactBasenameCandidates('default', []), { nonEmpty: false });
    });
  });

  // ---------------------------------------------------------------- describeJobs reads (their own pair: the seed is jobs only)
  describe(`N4 describeJobs reads before and after the move (${kind})`, () => {
    const closers: Array<() => Promise<void>> = [];
    let f: Fixture;
    let ids: Awaited<ReturnType<typeof seedInsightJobs>>;
    beforeAll(async () => {
      const engines = await makePair(kind, closers);
      const seeded = [];
      for (const e of engines) seeded.push(await seedInsightJobs(e));
      expect(seeded[1]).toEqual(seeded[0]); // same job ids on both brains
      ids = seeded[0]!;
      f = { before: engines[0]!, after: engines[1]!, backend: kind };
    }, 240_000);
    afterAll(async () => { for (const close of closers) await close(); });

    const SPEC = (over: Partial<Parameters<BrainEngine['readJobInsight']>[0]> = {}) => ({
      jobIds: ids.all, waitingIds: ids.waiting, waitingQueues: ['default', 'q2'], parentIds: [ids.parent], lockIds: ids.lockIds,
      holderQueue: 'gbrain-drain-lease', owner: 'o1' as string | null, ...over,
    });

    test('submitter and parent owner of each described job', async () => {
      const meta = await site(f, 'src/core/minions/job-insight.ts:149', async e => rowsOf(await M.insightMeta(e, ids.all)), async e => (await e.readJobInsight(SPEC())).meta);
      const byId = new Map(rowsOf(meta).map(r => [Number(r.id), r]));
      expect(byId.get(ids.byName.submitted)!.submitter).toBe('cli:import'); // an application job names its submitter
      expect(byId.get(ids.byName.principal)!.submitter).toBeNull(); // another authority kind does not
      expect(byId.get(ids.byName.child1)!.parent_owner).toBe('o1');
      await site(f, 'src/core/minions/job-insight.ts:149', async e => rowsOf(await M.insightMeta(e, [999_999])), async e => (await e.readJobInsight(SPEC({ jobIds: [999_999], waitingIds: [], parentIds: [], lockIds: [], owner: null }))).meta, { nonEmpty: false });
    });

    test('waiting jobs ahead of each waiting job: priority, then age, then id; and the active slot holders of its queues', async () => {
      const ahead = await site(f, 'src/core/minions/job-insight.ts:159', async e => rowsOf(await M.insightAhead(e, ids.waiting)), async e => (await e.readJobInsight(SPEC())).ahead);
      const aheadOf = new Map(rowsOf(ahead).map(r => [Number(r.id), Number(r.ahead)]));
      expect(aheadOf.get(ids.byName.w3)).toBe(0); // priority 1 sorts before priority 5
      expect(aheadOf.get(ids.byName.w1)).toBe(1);
      expect(aheadOf.get(ids.byName.w2)).toBe(2);
      const holders = await site(f, 'src/core/minions/job-insight.ts:165', async e => rowsOf(await M.insightHolders(e, ['default', 'q2'], 'gbrain-drain-lease')), async e => (await e.readJobInsight(SPEC())).holders, { ordered: true });
      // Oldest start first, no start last, the drain-lease queue never listed.
      expect(rowsOf(holders).map(r => Number(r.id))).toEqual([ids.byName.act1, ids.byName.act4, ids.byName.act2, ids.byName.act3]);
      expect(rowsOf(holders).some(r => r.queue === 'gbrain-drain-lease')).toBe(false);
      // Nothing waiting: neither read runs.
      expect((await f.after.readJobInsight(SPEC({ waitingIds: [], waitingQueues: [] }))).holders).toEqual([]);
      expect((await f.after.readJobInsight(SPEC({ waitingIds: [], waitingQueues: [] }))).ahead).toEqual([]);
    });

    test('live children of a waiting-children parent, by id', async () => {
      const kids = await site(f, 'src/core/minions/job-insight.ts:179', async e => rowsOf(await M.insightChildren(e, [ids.parent])), async e => (await e.readJobInsight(SPEC())).children, { ordered: true });
      expect(rowsOf(kids).map(r => Number(r.id))).toEqual([ids.byName.child1, ids.byName.child2]); // completed, dead and cancelled children are not live
      expect((await f.after.readJobInsight(SPEC({ parentIds: [] }))).children).toEqual([]);
    });

    test('unexpired leases among the lock ids with the drain-lease beacon and the owner of the job it names', async () => {
      const locks = await site(f, 'src/core/minions/job-insight.ts:193',
        async e => without(rowsOf(await M.insightLocks(e, ids.lockIds, 'gbrain-drain-lease')), 'acquired_at', 'ttl_expires_at'),
        async e => without((await e.readJobInsight(SPEC())).locks as unknown as Array<Record<string, unknown>>, 'acquired_at', 'ttl_expires_at'));
      const byId = new Map(rowsOf(locks).map(r => [String(r.id), r]));
      expect([...byId.keys()].sort()).toEqual(['lock-live-beacon', 'lock-live-plain']); // the lapsed lease is not listed
      expect(byId.get('lock-live-beacon')!.holder_owner).toBe('o1');
      expect(byId.get('lock-live-plain')!.beacon).toBeNull();
      // The lease times come back as dates, as the driver returns them.
      const raw = (await f.after.readJobInsight(SPEC())).locks;
      expect(raw.every(l => l.acquired_at instanceof Date && l.ttl_expires_at instanceof Date)).toBe(true);
      expect((await f.after.readJobInsight(SPEC({ lockIds: [] }))).locks).toEqual([]);
    });

    test('tokens of completed children another owner (or none) submitted, only for an owner-fenced caller', async () => {
      const tokens = await site(f, 'src/core/minions/job-insight.ts:219', async e => rowsOf(await M.insightForeignTokens(e, ids.all, 'o1')), async e => (await e.readJobInsight(SPEC({ owner: 'o1' }))).foreign_tokens);
      expect(rowsOf(tokens).map(r => ({ p: Number(r.parent_job_id), i: Number(r.i), o: Number(r.o), c: Number(r.c) })))
        .toEqual([{ p: ids.parent, i: 15, o: 25, c: 35 }]); // o2's 10/20/30 plus the ownerless child's 5/5/5; o1's own child is left out
      expect((await f.after.readJobInsight(SPEC({ owner: null }))).foreign_tokens).toEqual([]);
    });

    test('every moved read site has a case', () => {
      expect([...covered].sort()).toEqual([...ALL_SITES].sort());
    });
  });
}
