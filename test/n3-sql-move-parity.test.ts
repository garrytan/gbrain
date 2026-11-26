/**
 * Before/after parity for the SELECTs that moved behind BrainEngine members in N3 (alias fan-out, belief coverage,
 * search-vector counts, export and page-body reads, jobs health, version trust tiers, withdrawal discovery): the
 * callers' `executeRaw` statements at master (5763c09b5c, test/helpers/n3-master-sql.ts) against the members in
 * src/core/engine-sql/*.ts.
 *
 * Each case seeds two identical fresh brains, runs master's exact text (with master's own run-time text building and
 * row mapping) on the first and the member on the second, and requires the same rows in every column. Every site the
 * move check lists as a removed caller statement is named once below by its master path:line; the last case fails when
 * a site has no case.
 *
 * 1. Protects: the 38 moved read sites answer the same rows on the same data: the filters (deleted pages, source and
 *    type lists, cursors, windows, tier lists), the joins, the casts (bigint to number, text to number), the ordering
 *    the caller relied on, and the empty-input answers.
 * 2. Fails when: a member's text or mapping changes a predicate, a join, a cast, a window, an ORDER BY or a sort the
 *    caller read in.
 * 3. Existing coverage: test/engine-parity/{alias-fanout-reads,cli-reads-export,jobs-health,trust-tier-reads,
 *    withdrawal-discovery-reads}.test.ts compare the engines with each other through the members; none compares a
 *    member with the statement master ran, and the Rust engine has no raw SQL to run master's text.
 * 4. Seam: none. Real engines; rows are written through typed members where one exists, and by plain INSERT for the
 *    tables no member writes (belief ledger, withdrawal ledger, access policy, jobs). Seeds that stamp a time use a
 *    fixed instant, so the two brains hold the same rows; an age or "minutes since" read from the clock is compared
 *    in 10-minute buckets (the seeds sit on whole hours), and a brain's own epoch to within two minutes.
 *
 * Engines: PGLite always; Postgres too when DATABASE_URL is set (listed in test/postgres-unit-arms.txt). The Rust arm
 * does not apply: master's text is SQL. Rust serves only the jobs-health members, which carry no visibility filter, and
 * test/engine-parity/jobs-health.test.ts proves their empty-queue answers on all three arms. No read left in this slice
 * carries a page-visibility filter (the filtered reads stay at their call sites), so no private-row or world-only-caller
 * case applies.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import type { PageInput } from '../src/core/types.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { rowToPage } from '../src/core/utils.ts';
import { COVERAGE_KEY } from '../src/core/belief/keys.ts';
import { renderFactsTable } from '../src/core/facts-fence.ts';
import type { WithdrawalDiscoveryKey } from '../src/core/engine-sql/withdrawal-discovery.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { createSource, restrictFolder } from './engine-parity/harness.ts';
import { flipInput, manifestRow, pageMeta, segmentText, stagingInput } from './helpers/page-body-fixtures.ts';
import { seedJobs, type JobSeed } from './helpers/n3-seed.ts';
import * as M from './helpers/n3-master-sql.ts';

/** Every removed caller statement the move check lists for N3, by master path:line (5763c09b5c). */
const ALL_SITES = [
  'src/core/search/alias-fanout.ts:118', 'src/core/search/alias-fanout.ts:146', 'src/core/search/alias-fanout.ts:161',
  'src/core/verbs/entity-card-identity.ts:141', 'src/core/belief/coverage-report.ts:347', 'src/commands/reindex-search-vector.ts:102',
  'src/commands/export.ts:125', 'src/core/export-snapshot.ts:18', 'src/core/export-snapshot.ts:23', 'src/core/export-snapshot.ts:44', 'src/core/export-snapshot.ts:62',
  'src/core/page-body/read-range.ts:199', 'src/core/page-body/read-range.ts:177', 'src/core/page-body/read-range.ts:253', 'src/core/page-body/read-range.ts:631',
  'src/core/page-body/segment-blocks.ts:166', 'src/core/page-body/body-tiling.ts:35', 'src/commands/doctor/checks/folder-access.ts:30',
  'src/core/ops/admin.ts:266', 'src/core/ops/admin.ts:313', 'src/core/search/transcript-quote.ts:111', 'src/core/facts/withdrawal-discovery.ts:26', 'src/core/facts/withdrawal-discovery.ts:81', 'src/core/facts/withdrawal-discovery.ts:117',
  'src/core/facts/withdrawal-discovery.ts:144', 'src/core/facts/withdrawal-discovery.ts:205',
  'src/commands/doctor/checks/queue-jobs.ts:79', 'src/commands/doctor/checks/queue-jobs.ts:92', 'src/commands/doctor/checks/queue-jobs.ts:103',
  'src/commands/doctor/checks/queue-jobs.ts:112', 'src/commands/doctor/checks/queue-jobs.ts:134', 'src/commands/doctor/checks/queue-jobs.ts:175',
  'src/commands/doctor/checks/queue-jobs.ts:251', 'src/commands/doctor/checks/queue-jobs.ts:281', 'src/commands/doctor/checks/queue-jobs.ts:406',
  'src/commands/doctor/checks/queue-jobs.ts:583', 'src/core/minions/supervisor.ts:295', 'src/core/minions/supervisor.ts:414',
  'src/core/advisor/collect-stalled-jobs.ts:23',
] as const;

// ---------------------------------------------------------------- comparison

interface Fixture { before: BrainEngine; after: BrainEngine; world: World; backend: 'pglite' | 'postgres' }
interface Opts { ordered?: boolean; nonEmpty?: boolean }

const sha = (text: string) => createHash('sha256').update(text).digest('hex');

/** One canonical form for both sides: the casts the members apply (bigint and digit text to number, bytes to hex, dates to ISO), keys sorted. */
function canon(v: unknown, ordered: boolean): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (v instanceof Uint8Array) return Buffer.from(v).toString('hex');
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

/** Whole 10-minute buckets of an age in seconds (the clock-derived reads; seeds sit on whole hours). */
const bucket = (seconds: unknown) => (seconds === null || seconds === undefined ? null : Math.round(Number(seconds) / 600));
const bucketMinutes = (minutes: unknown) => (minutes === null || minutes === undefined ? null : Math.round(Number(minutes) / 10));
const bucketDate = (d: Date | null) => (d === null ? null : Math.round((Date.now() - d.getTime()) / 600_000));

/** The sites each describe has proved; the last case compares it with ALL_SITES. */
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

// ---------------------------------------------------------------- seeds (identical on both brains, in the same order)

const page = (type: string, title: string, frontmatter: Record<string, unknown> = {}, compiled_truth = `${title} body`, timeline = ''): PageInput =>
  ({ type: type as never, title, compiled_truth, timeline, frontmatter });
const fence = (claim: string, visibility: 'world' | 'private' = 'world') =>
  renderFactsTable([{ rowNum: 1, claim, visibility, kind: 'fact', confidence: 1, notability: 'medium', active: true }]);
const tokens = (norm: string) => norm.split(' ').filter(Boolean).map(t => `%${t.replace(/[\\%_]/g, '\\$&')}%`);
const key = (norm: string | null, subject = '*', visibility = 'world'): WithdrawalDiscoveryKey =>
  ({ visibility, fact_hash: sha(norm ?? ''), subject, norm, patterns: norm ? tokens(norm) : [] });

const SEGMENTS = [segmentText('# Intro\nfirst segment\n'), segmentText('## Next\nsecond segment\n')];

/** A segmented page published as generation 1 whose segments carry `slots` (facts slots) and `regions`; the second cut is forced. */
async function publishSegmented(e: BrainEngine, slug: string, segments: Array<{ text: string; slots?: unknown[]; region?: 'truth' | 'timeline'; cut?: 'forced' | 'heading' }>) {
  const { id: pageId } = await e.createSegmentedPageShell(slug, pageMeta(slug), { sourceId: 'default' });
  const texts = segments.map(s => segmentText(s.text));
  const occurrences = await e.allocateBodyOccurrenceIds(texts.length);
  const staging = stagingInput({ slug, pageId, mode: 'create' });
  await e.transaction(async (tx) => {
    await tx.openBodyStaging(staging);
    await tx.stageSegmentTexts('default', texts, { stagingId: staging.id });
    let byteStart = 0;
    await tx.stageManifestRows(texts.map((text, seq) => {
      const row = { ...manifestRow({ pageId, occurrenceId: occurrences[seq]!, genFrom: 1, seq, text, byteStart, stagingId: staging.id, region: segments[seq]!.region }),
        factsSlots: segments[seq]!.slots ?? [], cutKind: segments[seq]!.cut ?? 'heading' };
      byteStart += text.body.byteLength;
      return row;
    }));
  });
  await e.transaction(async (tx) => {
    await tx.flipBodyGeneration(flipInput(pageId, 0, staging.id, texts));
    await tx.setBodyStagingState(staging.id, 'committed');
  });
  return { pageId, occurrences };
}

/** Facts inserted in a transaction whose write trust settings declare the operator tier. */
async function insertFacts(e: BrainEngine, rows: Array<{ fact: string; entity: string | null; page: string | null; visibility?: 'world' | 'private' }>, sourceId = 'default') {
  await e.transaction(async (tx) => {
    await tx.applyTransactionSettings(['gbrain.write_trust_tier', 'gbrain.write_trust_promotion', 'gbrain.write_origin'],
      ['operator_curated', 'operator_curated', JSON.stringify({ channel: 'operator_curated' })]);
    await tx.insertFacts(rows.map((r, i) => ({
      fact: r.fact, entity_slug: r.entity, source_markdown_slug: r.page, row_num: i + 1, kind: 'fact',
      visibility: r.visibility ?? 'world', source: 'fence', valid_from: new Date(Date.UTC(2026, 6, 1)),
    })) as never, { source_id: sourceId });
  });
}

const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** One belief ledger row, plain INSERT (no member writes the ledger on its own); every time is a fixed instant. */
async function beliefEvent(e: BrainEngine, ev: { n: number; source?: string; slug: string; lifetime?: string | null; kind: string; subject: string; type: string; visibility?: string;
  claimFp?: string | null; value?: unknown; origin?: string; at: string }) {
  const source = ev.source ?? 'default';
  await e.executeRaw(
    `INSERT INTO belief_events (event_key, source_id, source_incarnation, page_lifetime, slug, subject_kind, subject_key, event_type, origin, trust_tier, visibility,
       publication_id, ord, recorded_at, value, claim_fp, state_hash, cause)
     SELECT decode(md5($1::text), 'hex'), $2, s.incarnation, $3::uuid, $4, $5, $6, $7, $8, 'operator_curated', $9, $10::uuid, 0, $11::timestamptz, $12::text::jsonb, $13, $14, '{}'::jsonb
       FROM sources s WHERE s.id = $2`,
    [`ev-${ev.n}`, source, ev.lifetime ?? null, ev.slug, ev.kind, ev.subject, ev.type, ev.origin ?? 'live', ev.visibility ?? 'world', UUID(1000 + ev.n), ev.at,
      ev.value === undefined ? null : JSON.stringify(ev.value), ev.claimFp ?? null, `h${ev.n}`]);
}

const JOBS: JobSeed[] = [
  { name: 'stall-a', status: 'active', started: '-3 hours', created: '-4 hours', lockUntil: '1 hour' },
  { name: 'stall-b', status: 'active', started: '-2 hours', created: '-4 hours', lockUntil: '1 hour' },
  { name: 'fresh', status: 'active', started: '-5 minutes', lockUntil: '1 hour' },
  { name: 'lapsed', status: 'active', started: '-10 minutes', lockUntil: '-5 minutes' },
  { name: 'lapsed', status: 'active', started: '-9 minutes', lockUntil: '-4 minutes' },
  { name: 'twice', status: 'active', started: '-10 minutes', lockUntil: '1 hour', stalledCounter: 2 },
  { name: 'sync', status: 'waiting' }, { name: 'sync', status: 'waiting' }, { name: 'sync', status: 'waiting' },
  { name: 'Zed', status: 'waiting' }, { name: 'Zed', status: 'waiting' }, { name: 'alpha', status: 'waiting' }, { name: 'alpha', status: 'waiting' },
  { name: 'sync', status: 'delayed', delayUntil: '1 hour' },
  { name: 'embed-backfill', status: 'waiting', queue: 'q-embed', created: '-3 hours' },
  { name: 'job-a', status: 'dead', finished: '-1 hour', errorText: 'aborted: watchdog' },
  { name: 'job-b', status: 'failed', finished: '-1 hour', errorText: 'aborted: watchdog' },
  { name: 'job-c', status: 'dead', finished: '-30 hours', errorText: 'aborted: watchdog' },
  { name: 'job-d', status: 'failed', finished: '-1 hour', errorText: 'something else' },
  { name: 'subagent', status: 'dead', finished: '-1 hour', errorText: 'prompt_too_long: a', idempotencyKey: 'dream:patterns:one' },
  { name: 'subagent', status: 'dead', finished: '-1 hour', errorText: 'prompt_too_long: b', idempotencyKey: 'dream:synthesize:one' },
  { name: 'subagent', status: 'dead', finished: '-1 hour', errorText: 'prompt_too_long: c', data: { __released_idempotency_key: 'dream:patterns:kept' } },
  { name: 'subagent', status: 'dead', finished: '-1 hour', errorText: 'prompt_too_long: d' },
  { name: 'subagent', status: 'dead', finished: '-1 hour', errorText: 'promptXtooXlong: wildcard', idempotencyKey: 'dream:patterns:wild' },
  { name: 'alpha', status: 'completed', finished: '-2 hours' },
  { name: 'alpha', status: 'cancelled', finished: '-1 hour', errorText: 'waiting_ttl_expired: waited > 1h in queue' },
  { name: 'alpha', status: 'cancelled', finished: '-40 hours', errorText: 'waiting_ttl_expired: waited > 1h in queue' },
  { name: 'alpha', status: 'cancelled', finished: '-1 hour', errorText: 'cancelled by an operator' },
  { name: 'dream-work', status: 'waiting', queue: 'dream-inline-one', created: '-2 hours', data: { source_id: 'src-one' } },
  { name: 'dream-work', status: 'paused', queue: 'dream-inline-one', data: { source_id: 'src-one' } },
];
const TTL = 'waiting_ttl_expired';

interface World {
  ids: Record<string, number>;
  seg: { big: { pageId: number; occurrences: number[] }; a: { pageId: number; occurrences: number[] }; b: { pageId: number; occurrences: number[] } };
  versions: number[];
}

async function seedWorld(e: BrainEngine, backend: 'pglite' | 'postgres'): Promise<World> {
  await createSource(e, backend, 'other');
  await createSource(e, backend, 'reborn');
  // Titles and aliases: out of byte order, with a deleted page and a second source.
  await e.putPage('people/acme-b', page('person', 'Acme Example'), { sourceId: 'other' });
  await e.putPage('people/acme-b', page('person', 'Acme Example'));
  await e.putPage('people/acme-a', page('person', 'ACME example'));
  await e.putPage('people/acme-gone', page('person', 'Acme Example'));
  await e.softDeletePage('people/acme-gone');
  await e.putPage('notes/acme', page('note', 'Acme Example'));
  await e.putPage('companies/widget-co', page('company', 'Widget Co'));
  await e.putPage('people/alice-example', page('person', 'Alice Example'));
  await e.setPageAliases('people/alice-example', 'default', ['ae']);
  await e.replaceDerivedAliases('people/alice-example', 'default', [
    { alias_norm: 'ae', origin: 'subject', case_sensitive: true, alias_text: 'AE' },
    { alias_norm: 'ae', origin: 'declared', case_sensitive: true, alias_text: 'AE' },
    { alias_norm: 'alice', origin: 'declared', case_sensitive: false, alias_text: 'Alice' },
  ]);
  await e.replaceDerivedAliases('people/a-founder', 'default', [{ alias_norm: 'ae', origin: 'declared', case_sensitive: true, alias_text: 'aE' }]);
  await e.replaceDerivedAliases('people/alice-example', 'other', [{ alias_norm: 'ae', origin: 'declared', case_sensitive: true, alias_text: 'A.E.' }]);

  // Export: payloads, tags, a timeline, versions, a segmented page with a forced cut, folder rules.
  await e.putPage('export/a', page('note', 'A', { status: 'v', nested: { bb: 1, a: 2 }, n: 2 }, 'alpha body', '- 2026: one'));
  await e.putPage('export/b', page('person', 'Bee', {}, 'beta'));
  await e.putPage('export/gone', page('note', 'Gone', {}, 'deleted'));
  await e.putPage('other/c', page('note', 'C', {}, 'gamma'));
  await e.putRawData('export/a', 'crm', { id: 7, name: 'x' });
  await e.putRawData('export/a', 'mail', { n: 1 });
  await e.addTag('export/a', 'zeta');
  await e.addTag('export/a', 'alpha');
  await e.addTag('export/b', 'friend');
  await e.upsertChunks('export/a', [{ chunk_index: 0, chunk_text: 'alpha body chunk', chunk_source: 'compiled_truth' }]);
  await e.upsertChunks('export/b', [{ chunk_index: 0, chunk_text: 'beta body chunk', chunk_source: 'compiled_truth' }]);
  await e.executeRaw(`UPDATE content_chunks SET search_vector = NULL WHERE chunk_text = 'beta body chunk'`);
  await e.executeRaw(`UPDATE pages SET search_vector = NULL WHERE slug = 'notes/acme'`);
  await e.softDeletePage('export/gone');
  await e.createVersion('export/a');
  await e.putPage('export/a', page('note', 'A2', { status: 'w' }, 'alpha body changed', '- 2026: one'));
  await e.createVersion('export/a');
  const big = await publishSegmented(e, 'notes/big', [
    { text: '# Intro\nfirst segment\n', cut: 'heading' }, { text: '## Next\nsecond segment\n', cut: 'forced' },
  ]);
  await e.createVersion('notes/big');
  await restrictFolder(e, backend, 'other', 'private/', 'rule');
  await restrictFolder(e, backend, 'default', 'queued/', 'pending');

  // Withdrawal discovery: fenced pages, facts, segmented pages with facts slots, and the withdrawal ledger.
  for (const slug of ['notes/open', 'notes/second', 'people/e-example', 'memory/members/alice-example']) await e.putPage(slug, page('note', slug, {}, 'x'));
  await e.putPage('notes/other', page('note', 'other', {}, 'x'), { sourceId: 'other' });
  await insertFacts(e, [
    { fact: 'Alice keeps bees!', entity: null, page: 'notes/open' },
    { fact: 'Alice keeps bees', entity: 'people/e-example', page: null },
    { fact: 'Alice keeps bees', entity: 'people/e-example', page: 'notes/second', visibility: 'private' },
    { fact: 'Alice keeps bees', entity: 'people/z-example', page: 'memory/members/alice-example' },
    { fact: 'Bob bakes bread', entity: 'people/e-example', page: 'notes/never-written' },
  ]);
  await insertFacts(e, [{ fact: 'Alice keeps bees', entity: null, page: 'notes/other' }, { fact: 'Carol cooks rice', entity: null, page: 'notes/other' }], 'other');
  const lead = 'Intro line\n';
  const bees = fence('Alice keeps bees');
  const bread = fence('Bob bakes bread');
  const a = await publishSegmented(e, 'notes/seg-a', [
    { text: `${lead}${bees}`, slots: [{ start: Buffer.byteLength(lead), end: Buffer.byteLength(lead + bees) }] },
    { text: 'no fence here\n', slots: [] },
    { text: `${bread}tail\n`, slots: [{ start: 0, end: Buffer.byteLength(bread) }, { start: 0, end: 10, open_start: 4 }] },
    { text: 'more of the split fence\n', slots: [{ start: 0, end: 7, open_start: 4 }], region: 'timeline' },
  ]);
  const b = await publishSegmented(e, 'notes/seg-b', [{ text: `${bees}`, slots: [{ start: 0, end: Buffer.byteLength(bees) }, { start: 2, end: 5, open_start: 0 }] }]);
  const at = '2026-03-01T00:00:00Z';
  await e.executeRaw(`INSERT INTO fact_withdrawals (source_id, visibility, subject, fact_hash, withdrawn_at) VALUES
    ('default', 'world', 'core/open', $1, $4::timestamptz), ('default', 'private', 'people/e-example', $2, $4::timestamptz), ('other', 'world', '*', $3, $4::timestamptz)`,
  [sha('alice keeps bees'), sha('bob bakes bread'), sha('nobody'), at]);
  await e.executeRaw(`INSERT INTO fact_purges (source_id, visibility, subject, fact_hash, purged_at) VALUES ('default', 'world', '*', $1, $2::timestamptz)`, [sha('purged'), at]);

  const ids: Record<string, number> = {};
  for (const [slug, source] of [['export/a', 'default'], ['export/b', 'default'], ['export/gone', 'default'], ['other/c', 'default'], ['notes/open', 'default'],
    ['notes/second', 'default'], ['memory/members/alice-example', 'default'],
    ['people/alice-example', 'default'], ['people/acme-a', 'default'], ['people/acme-gone', 'default'], ['notes/other', 'other']] as const) {
    ids[`${source}:${slug}`] = Number((await e.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id = $1 AND slug = $2', [source, slug]))[0]!.id);
  }

  // Belief ledger: coverage in two sources (the page streams and their visibility reads stay at their call sites in this slice).
  await beliefEvent(e, { n: 1, slug: '', kind: 'coverage', subject: COVERAGE_KEY, type: 'coverage.started', at: '2026-01-01T00:00:01Z' });
  await beliefEvent(e, { n: 12, source: 'other', slug: '', kind: 'coverage', subject: COVERAGE_KEY, type: 'coverage.started', at: '2026-01-01T00:00:11Z' });

  // A source whose coverage event belongs to an earlier incarnation: it is not covered now.
  await beliefEvent(e, { n: 13, source: 'reborn', slug: '', kind: 'coverage', subject: COVERAGE_KEY, type: 'coverage.started', at: '2026-01-01T00:00:12Z' });
  await e.executeRaw(`UPDATE sources SET incarnation = gen_random_uuid() WHERE id = 'reborn'`);

  // A version whose tier is stamped.
  const versions = (await e.getVersions('export/a')).map(v => Number(v.id));
  versions.push(...(await e.getVersions('notes/big')).map(v => Number(v.id)));
  await e.executeRaw(`UPDATE page_versions SET trust_tier = 'operator_curated' WHERE id = $1`, [versions[0]]);
  await seedJobs(e, JOBS);
  return { ids, seg: { big, a, b }, versions };
}

// ---------------------------------------------------------------- cases

/** The fields a page row carries that differ between two brains by construction (stamps, the revision uuid). */
const stripStamps = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([k]) => !/(_at|revision)$/.test(k)));
const head = (r: Record<string, unknown> | undefined) => (r ? { ...r, revision: typeof r.revision === 'string' && /^[0-9a-f-]{36}$/.test(r.revision) } : null);

for (const kind of testBackends()) {
  describe(`N3 read statements before and after the move (${kind})`, () => {
    let f: Fixture;
    const closers: Array<() => Promise<void>> = [];

    beforeAll(async () => {
      covered = new Set();
      const engines: BrainEngine[] = [];
      for (let i = 0; i < 2; i++) { // two identical fresh brains: master's statements run on the first, the members on the second
        if (kind === 'postgres') {
          const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!, 'instance', 2);
          engines.push(pg.engine);
          closers.push(pg.close);
        } else {
          const engine = new PGLiteEngine();
          await engine.connect({ engine: 'pglite' } as never);
          await engine.initSchema();
          engines.push(engine);
          closers.push(() => engine.disconnect());
        }
      }
      const [a, b] = [await seedWorld(engines[0]!, kind), await seedWorld(engines[1]!, kind)];
      expect(b).toEqual(a); // same ids on both brains: page ids, occurrence ids, version ids
      f = { before: engines[0]!, after: engines[1]!, world: a, backend: kind };
    }, 240_000);
    afterAll(async () => { for (const close of closers) await close(); });

    // -------- alias-fanout.ts:118, :146, :161 and entity-card-identity.ts:141
    test('alias fan-out reads: case-sensitive aliases, a title, alias names, sibling aliases', async () => {
      await site(f, 'src/core/search/alias-fanout.ts:118', e => M.caseAliasRead(e, ['ae', 'alice'], ['default', 'other']), e => e.resolveCaseSensitiveAliases(['ae', 'alice'], ['default', 'other']));
      await site(f, 'src/core/search/alias-fanout.ts:118', e => M.caseAliasRead(e, [], ['default']), e => e.resolveCaseSensitiveAliases([], ['default']), { nonEmpty: false });

      const byteSorted = <T>(rows: T[], ...fields: Array<keyof T>) => {
        const k = (r: T) => fields.map(x => String(r[x])).join('\u0000');
        expect(rows.map(k)).toEqual(rows.map(k).sort());
      };
      const cased = await f.after.resolveCaseSensitiveAliases(['ae', 'alice'], ['default', 'other']);
      expect(cased.length).toBeGreaterThan(2);
      byteSorted(cased, 'slug', 'alias_norm', 'alias_text');

      for (const [source, slug] of [['default', 'people/acme-a'], ['default', 'people/acme-gone'], ['other', 'people/acme-b']] as const) {
        const title = await site(f, 'src/core/search/alias-fanout.ts:146', async e => (await M.titleOf(e, source, slug))[0]?.title ?? null, e => e.readPageTitle(source, slug));
        expect(typeof title).toBe('string');
      }
      await site(f, 'src/core/search/alias-fanout.ts:146', async e => (await M.titleOf(e, 'default', 'no/such'))[0]?.title ?? null, e => e.readPageTitle('default', 'no/such'), { nonEmpty: false });

      const names = ['people/alice-example', 'people/a-founder'];
      await site(f, 'src/core/search/alias-fanout.ts:161', e => M.namesOf(e, ['default', 'other'], names), e => e.readPageAliasRows(['default', 'other'], names));
      await site(f, 'src/core/search/alias-fanout.ts:161', e => M.namesOf(e, [], names), e => e.readPageAliasRows([], names), { nonEmpty: false });
      await site(f, 'src/core/verbs/entity-card-identity.ts:141', e => M.siblingAliases(e, 'default', names), e => e.readEntityAliasRows('default', names));
      byteSorted(await f.after.readPageAliasRows(['default', 'other'], names), 'source_id', 'slug', 'alias_norm', 'origin');
      await site(f, 'src/core/verbs/entity-card-identity.ts:141', e => M.siblingAliases(e, 'default', []), e => e.readEntityAliasRows('default', []), { nonEmpty: false });
    });

    // -------- coverage-report.ts:347 and reindex-search-vector.ts:102
    test('belief coverage sources and the search-vector row counts', async () => {
      const sources = await site(f, 'src/core/belief/coverage-report.ts:347', async e => rowsOf(await M.coveredSources(e, COVERAGE_KEY)).map(r => r.id), e => e.listCoveredSources(COVERAGE_KEY), { ordered: true });
      expect(sources).toEqual(['default', 'other']);
      await site(f, 'src/core/belief/coverage-report.ts:347', async e => rowsOf(await M.coveredSources(e, '["other"]')).map(r => r.id), e => e.listCoveredSources('["other"]'), { nonEmpty: false });
      const counts = await site(f, 'src/commands/reindex-search-vector.ts:102', async e => rowsOf(await M.searchVectorCounts(e))[0], e => e.countSearchVectorRows());
      expect(Number((counts as { pages: unknown }).pages)).toBeGreaterThan(0);
      // Rows with no keyword vector are not counted (the seed clears one page's and one chunk's).
      const [total] = rowsOf(await f.after.executeRaw('SELECT (SELECT COUNT(*)::int FROM pages) AS pages, (SELECT COUNT(*)::int FROM content_chunks) AS chunks'));
      expect(Number((counts as { pages: unknown }).pages)).toBeLessThan(Number(total!.pages));
      expect(Number((counts as { chunks: unknown }).chunks)).toBeLessThan(Number(total!.chunks));
      expect(Number((counts as { chunks: unknown }).chunks)).toBeGreaterThan(0);
    });

    // -------- export.ts:125, export-snapshot.ts:18, :23, :44, :62
    test('export reads: page keys under each filter, ledger size, withdrawals, page rows with tags, normalized fence lines', async () => {
      const q = { afterId: '0', sourceId: null as string | null, type: null as string | null, slugPrefix: null as string | null };
      const keys = (o: Partial<typeof q>, nonEmpty = true) => site(f, 'src/commands/export.ts:125',
        e => M.exportPageKeys(e, o.afterId ?? q.afterId, o.sourceId ?? null, o.type ?? null, o.slugPrefix ?? null),
        e => e.listExportPageKeys({ ...q, ...o }), { ordered: true, nonEmpty });
      const all = rowsOf(await keys({}));
      expect(all.map(r => r.slug)).not.toContain('export/gone');
      await keys({ afterId: String(all[0]!.id) });
      await keys({ type: 'person' });
      await keys({ slugPrefix: 'export/' });
      await keys({ sourceId: 'other' });
      await keys({ sourceId: 'nowhere' }, false);

      expect(await site(f, 'src/core/export-snapshot.ts:18', async e => Number(rowsOf(await M.ledgerBytes(e, 'default'))[0]!.bytes), e => e.readExportWithdrawalLedgerBytes('default'))).toBeGreaterThan(2);
      await site(f, 'src/core/export-snapshot.ts:18', async e => Number(rowsOf(await M.ledgerBytes(e, 'nowhere'))[0]!.bytes), e => e.readExportWithdrawalLedgerBytes('nowhere'));
      const withdrawals = rowsOf(await site(f, 'src/core/export-snapshot.ts:23', e => M.exportWithdrawals(e, 'default'), e => e.listExportWithdrawals('default'), { ordered: true }));
      expect(withdrawals.map(r => r.purged)).toContain(true);
      await site(f, 'src/core/export-snapshot.ts:23', e => M.exportWithdrawals(e, 'nowhere'), e => e.listExportWithdrawals('nowhere'), { nonEmpty: false });

      const ids = ['default:export/a', 'default:export/b', 'default:export/gone', 'default:other/c'].map(k => String(f.world.ids[k]));
      const pages = rowsOf(await site(f, 'src/core/export-snapshot.ts:44',
        async e => (await M.exportPageRows(e, ids)).map(r => ({ page: stripStamps(rowToPage(r) as unknown as Record<string, unknown>), tags: r.export_tags })),
        async e => (await e.readExportPageRows(ids)).map(r => ({ page: stripStamps(r.page as unknown as Record<string, unknown>), tags: r.tags }))));
      expect(pages.length).toBe(3);
      expect(pages.map(r => r.tags)).toContainEqual(['alpha', 'zeta']);
      await site(f, 'src/core/export-snapshot.ts:44', e => M.exportPageRows(e, []), e => e.readExportPageRows([]), { nonEmpty: false });

      const bodies = ['MiXeD\t  Claim\r\nSecond   LINE\n', '', 'Ünïcode x\u00a0y\u2003z', 'one'];
      const timelines = ['', 'A\n\nB', 'x', ''];
      await site(f, 'src/core/export-snapshot.ts:62', e => M.normalizedLines(e, bodies, timelines), e => e.normalizeFenceLines(bodies, timelines));
    });

    // -------- read-range.ts:199, :177, :253, :631, segment-blocks.ts:166, body-tiling.ts:35, folder-access.ts:30
    test('page-body reads: head, manifest rows, meta, outline, forced cuts, version bytes, folder-rule sources', async () => {
      const { big, a } = f.world.seg;
      const small = f.world.ids['default:other/c']!;
      const gone = f.world.ids['default:export/gone']!;
      for (const id of [big.pageId, small, gone]) {
        await site(f, 'src/core/page-body/read-range.ts:199', async e => head(rowsOf(await M.pageHead(e, id))[0]), async e => head(await e.readSegmentedPageHead(id) as never));
      }
      await site(f, 'src/core/page-body/read-range.ts:199', async e => head(rowsOf(await M.pageHead(e, 999_999))[0]), async e => head(await e.readSegmentedPageHead(999_999) as never), { nonEmpty: false });
      for (const [pageId, generation, nonEmpty] of [[big.pageId, null, true], [big.pageId, 1, true], [a.pageId, 1, true], [big.pageId, 0, false], [999_999, null, false]] as const) {
        await site(f, 'src/core/page-body/read-range.ts:177', e => M.manifestRows(e, pageId, generation), e => e.readBodyManifestRows(pageId, generation), { ordered: true, nonEmpty });
      }
      for (const [pageId, occ, generation, nonEmpty] of [[a.pageId, a.occurrences, 1, true], [a.pageId, [a.occurrences[2]!], 1, true], [a.pageId, [], 1, false],
        [a.pageId, a.occurrences, 0, false], [999_999, a.occurrences, 1, false]] as const) {
        await site(f, 'src/core/page-body/read-range.ts:253', e => M.manifestMeta(e, pageId, [...occ], generation), e => e.readBodyManifestMeta(pageId, occ, generation), { nonEmpty });
        await site(f, 'src/core/page-body/read-range.ts:631', e => M.manifestOutline(e, pageId, [...occ], generation), e => e.readBodyManifestOutline(pageId, occ, generation), { nonEmpty });
      }
      expect(await site(f, 'src/core/page-body/segment-blocks.ts:166', async e => rowsOf(await M.forcedCuts(e, big.pageId, 1)).map(r => Number(r.seq)).sort((x, y) => x - y),
        e => e.listForcedCutSeqs(big.pageId, 1), { ordered: true })).toEqual([1]);
      await site(f, 'src/core/page-body/segment-blocks.ts:166', async e => rowsOf(await M.forcedCuts(e, a.pageId, 1)).map(r => Number(r.seq)), e => e.listForcedCutSeqs(a.pageId, 1), { nonEmpty: false });
      const bytes = (id: number, generation: number) => site(f, 'src/core/page-body/body-tiling.ts:35',
        async e => { const r = rowsOf(await M.versionBodyBytes(e, id, generation))[0]; return r ? Number(r.body_bytes) : null; }, e => e.readSegmentedVersionBodyBytes(id, generation), { nonEmpty: false });
      expect(await bytes(big.pageId, 1)).toBe(SEGMENTS.reduce((n, t) => n + t.body.byteLength, 0));
      expect(await bytes(big.pageId, 2)).toBeNull();
      expect(await bytes(small, 1)).toBeNull();
      expect(await site(f, 'src/commands/doctor/checks/folder-access.ts:30', async e => rowsOf(await M.accessPolicySources(e)).map(r => r.source_id), e => e.listAccessPolicySourceIds(), { ordered: true })).toEqual(['default', 'other']);
    });

    // -------- admin.ts:266, :313, transcript-quote.ts:111
    test('version tiers, replacing writers and page types', async () => {
      const versions = f.world.versions;
      const tiers = rowsOf(await site(f, 'src/core/ops/admin.ts:266', e => M.versionTiers(e, versions), e => e.listVersionTrustTiers(versions)));
      expect(tiers.some(r => r.trust_tier === 'operator_curated')).toBe(true);
      await site(f, 'src/core/ops/admin.ts:266', e => M.versionTiers(e, []), e => e.listVersionTrustTiers([]), { nonEmpty: false });
      await site(f, 'src/core/ops/admin.ts:313', e => M.versionWriters(e, versions), e => e.listVersionReasonWriters(versions));
      await site(f, 'src/core/ops/admin.ts:313', e => M.versionWriters(e, []), e => e.listVersionReasonWriters([]), { nonEmpty: false });
      const typed = ['default:export/a', 'default:export/b', 'default:export/gone', 'default:people/alice-example'].map(k => f.world.ids[k]!);
      await site(f, 'src/core/search/transcript-quote.ts:111', e => M.pageTypes(e, [...typed, typed[0]!, 999_999]), e => e.listPageTypesByIds([...typed, typed[0]!, 999_999]));
      await site(f, 'src/core/search/transcript-quote.ts:111', async e => rowsOf(await M.pageTypes(e, [])), async e => e.listPageTypesByIds([]), { nonEmpty: false });
    });

    // -------- withdrawal-discovery.ts:26, :81, :117, :144, :205
    test('withdrawal discovery: the five reads that moved', async () => {
      const W = f.world;
      const ids = [...Object.values(W.ids), 999_999];
      await site(f, 'src/core/facts/withdrawal-discovery.ts:26', e => M.sampleSlugs(e, 'default', ids), e => e.readWithdrawalDiscovery({ kind: 'sample_slugs', sourceId: 'default', ids }), { ordered: true });
      await site(f, 'src/core/facts/withdrawal-discovery.ts:26', e => M.sampleSlugs(e, 'default', []), e => e.readWithdrawalDiscovery({ kind: 'sample_slugs', sourceId: 'default', ids: [] }), { nonEmpty: false });
      await site(f, 'src/core/facts/withdrawal-discovery.ts:205', async e => (await M.targetPages(e, 'default', ids)).map(r => ({ ...r, revision: typeof r.revision === 'string' })),
        async e => (await e.readWithdrawalDiscovery({ kind: 'target_pages', sourceId: 'default', ids })).map(r => ({ ...r, revision: typeof r.revision === 'string' })));

      const claims = [
        { visibility: 'world', fact_hash: sha('alice keeps bees'), subject: '*', claim: '  ALICE, keeps   bees. ' },
        { visibility: 'world', fact_hash: sha('alice keeps bees'), subject: 'people/e-example', claim: null },
        { visibility: 'world', fact_hash: sha('alice keeps bees!'), subject: null as never, claim: null },
        { visibility: 'private', fact_hash: sha('alice keeps bees'), subject: '*', claim: null },
        { visibility: 'world', fact_hash: sha('nobody'), subject: '*', claim: null },
        // The only fact with this text lives in another source: the claim's text is not found for this one.
        { visibility: 'world', fact_hash: sha('carol cooks rice'), subject: '*', claim: null },
      ];
      await site(f, 'src/core/facts/withdrawal-discovery.ts:117', e => M.claimKeys(e, 'default', JSON.stringify(claims)), e => e.readWithdrawalDiscovery({ kind: 'claim_keys', sourceId: 'default', claims }));

      const incoming = [
        { id: 1, slug: 'notes/a', claim: 'Alice keeps bees', visibility: 'world', ambiguous: false },
        { id: 2, slug: 'notes/b', claim: 'ALICE keeps bees!', visibility: null, ambiguous: true },
        { id: 3, slug: 'notes/c', claim: 'Alice keeps bees', visibility: 'private', ambiguous: false },
        { id: 4, slug: 'notes/d', claim: 'Alice keeps wasps', visibility: 'world', ambiguous: false },
        { id: 5, slug: 'notes/e', claim: 'alice keeps bees!', visibility: 'world', ambiguous: false },
      ];
      for (const keys of [[key('alice keeps bees')], [key('alice keeps bees', 'notes/b')], [{ ...key('alice keeps bees'), fact_hash: sha('alice keeps bees!') }], [key('alice keeps bees', '*', 'private')]]) {
        await site(f, 'src/core/facts/withdrawal-discovery.ts:144', e => M.claimMatches(e, JSON.stringify(incoming), JSON.stringify(keys)), e => e.readWithdrawalDiscovery({ kind: 'claim_matches', incoming, keys }));
      }
      await site(f, 'src/core/facts/withdrawal-discovery.ts:144', e => M.claimMatches(e, '[]', JSON.stringify([key('alice keeps bees')])), e => e.readWithdrawalDiscovery({ kind: 'claim_matches', incoming: [], keys: [key('alice keeps bees')] }), { nonEmpty: false });

      const split = (o: { after?: [number, string, number]; limit?: number; subjects?: string[] | null } = {}, nonEmpty = true) => site(f, 'src/core/facts/withdrawal-discovery.ts:81',
        e => M.splitFenceSlots(e, 'default', o.subjects ?? null, o.after ?? [0, '', -1], o.limit ?? 128),
        e => e.readWithdrawalDiscovery({ kind: 'split_fence_slots', sourceId: 'default', subjects: o.subjects ?? null, after: o.after ?? [0, '', -1], limit: o.limit ?? 128 }), { ordered: true, nonEmpty });
      expect(rowsOf(await split()).length).toBe(3);
      await split({ after: [W.seg.a.pageId, 'timeline', 4] });
      await split({ limit: 1 });
      await split({ subjects: ['notes/seg-b'] });
      await split({ after: [W.seg.b.pageId, 'truth', 0] }, false);
    });

    // -------- queue-jobs.ts, supervisor.ts, collect-stalled-jobs.ts
    test('jobs health reads: every signal, window, status and lock the queue checks read', async () => {
      const spec = { waitingThreshold: 1, oldWaitingHours: 1, windowHours: 24, stalledAfterHours: 1 };
      const signals = () => f.after.readQueueHealthSignals(spec);
      const Q = 'src/commands/doctor/checks/queue-jobs.ts';
      const stalled = await site(f, `${Q}:79`, async e => rowsOf(await M.queueStalled(e)).map(r => ({ id: Number(r.id), name: r.name, total: Number(r.total) })), async () => (await signals()).stalled, { ordered: true });
      expect(rowsOf(stalled).map(r => r.name)).toEqual(['stall-a', 'stall-b']);
      const depth = await site(f, `${Q}:92`, async e => rowsOf(await M.queueDepth(e, 1)).map(r => ({ name: r.name, queue: r.queue, depth: Number(r.depth) })), async () => (await signals()).depth);
      expect(rowsOf(depth).map(r => r.depth).sort()).toEqual([2, 2, 3]);
      const kills = await site(f, `${Q}:103`, async e => Number(rowsOf(await M.queueRssKills(e))[0]!.cnt), async () => (await signals()).rss_kills);
      expect(kills).toBe(2);
      const phases = await site(f, `${Q}:112`, async e => rowsOf(await M.queuePromptTooLong(e)).map(r => ({ phase: r.phase, cnt: Number(r.cnt) })), async () => (await signals()).prompt_too_long);
      expect(phases).toEqual(expect.arrayContaining([{ phase: 'patterns', cnt: 3 }, { phase: 'synthesize', cnt: 1 }, { phase: 'other', cnt: 1 }]));
      await site(f, `${Q}:134`, async e => rowsOf(await M.queueOldBackfill(e, 1)).map(r => ({ name: r.name, queue: r.queue, depth: Number(r.depth), age: bucket(r.oldest_age_seconds) })),
        async () => (await signals()).old_embed_backfill.map(r => ({ name: r.name, queue: r.queue, depth: r.depth, age: bucket(r.oldest_age_seconds) })));
      await site(f, `${Q}:134`, async e => rowsOf(await M.queueOldBackfill(e, 1)).length, async () => (await signals()).old_embed_backfill.length);

      await site(f, `${Q}:175`, async e => rowsOf(await M.queueWaiting(e)).map(r => ({ queue: r.queue, depth: Number(r.depth), age: bucket(r.oldest_age_seconds) })),
        async e => (await f.after.listWaitingByQueue()).map(r => ({ queue: r.queue, depth: r.depth, age: bucket(r.oldest_age_seconds) })));

      const divergence = await site(f, `${Q}:251`, async e => rowsOf(await M.queueDivergence(e)).map(r => ({ name: r.name, intake: parseInt(String(r.intake), 10), completed: parseInt(String(r.completed), 10), waiting: parseInt(String(r.waiting), 10) })),
        async () => (await f.after.readQueueDivergence({ windowHours: 24, ttlReasonPrefix: TTL })).divergence);
      expect(rowsOf(divergence).find(r => r.name === 'alpha')).toEqual({ name: 'alpha', intake: 6, completed: 1, waiting: 2 });
      expect(await site(f, `${Q}:281`, async e => rowsOf(await M.queueTtlCancelled(e, TTL)).map(r => ({ name: r.name, count: parseInt(String(r.count), 10) })),
        async () => (await f.after.readQueueDivergence({ windowHours: 24, ttlReasonPrefix: TTL })).ttl_cancelled)).toEqual([{ name: 'alpha', count: 1 }]);

      const wedge = await site(f, `${Q}:406`, async e => rowsOf(await M.queueWedgeCounts(e)).map(r => ({ queue: r.queue, active_healthy: Number(r.active_healthy), waiting: Number(r.waiting), mins: bucketMinutes(r.mins_since_completion) })),
        async () => (await f.after.listQueueWedgeCounts()).map(r => ({ queue: r.queue, active_healthy: r.active_healthy, waiting: r.waiting, mins: bucketMinutes(r.mins_since_completion) })));
      expect(rowsOf(wedge).map(r => r.queue)).toEqual(expect.arrayContaining(['default', 'q-embed']));
      expect(rowsOf(wedge).map(r => r.queue)).not.toContain('dream-inline-one'); // a private dream queue stays out of the wedge counts

      const view = (r: Record<string, unknown>) => ({ queue: r.queue, source_id: r.source_id ?? null, active_healthy: Number(r.active_healthy), waiting: Number(r.waiting), paused: Number(r.paused),
        age: bucketMinutes(r.oldest_waiting_minutes) });
      const privateBefore = rowsOf(await M.queuePrivateHealth(f.before));
      const privateAfter = await f.after.listPrivateQueueHealth();
      await site(f, `${Q}:583`, async () => privateBefore.map(view), async () => privateAfter.map(r => view(r as never)), { ordered: true });
      expect(Math.abs(Number(privateBefore[0]!.birth_epoch_ms) - Number(privateAfter[0]!.birth_epoch_ms))).toBeLessThan(120_000);

      const handled = ['sync', 'alpha'];
      const wedgeView = (r: Record<string, unknown>) => ({ stalled: Number(r.stalled), activeHealthy: Number(r.active_healthy), waiting: Number(r.waiting), waitingClaimable: Number(r.waiting_claimable),
        last: bucketDate(r.last_completed ? new Date(String(r.last_completed)) : null), lastClaimable: bucketDate(r.last_completed_claimable ? new Date(String(r.last_completed_claimable)) : null) });
      const wedgeAfter = ({ lastCompleted, lastCompletedClaimable, ...rest }: Awaited<ReturnType<typeof f.after.readWedgeSignals>>) => ({ ...rest, last: bucketDate(lastCompleted), lastClaimable: bucketDate(lastCompletedClaimable) });
      const signalsOf = await site(f, 'src/core/minions/supervisor.ts:295', async e => wedgeView(rowsOf(await M.queueWedgeSignals(e, 'default', handled))[0]!),
        async e => { const r = await f.after.readWedgeSignals('default', handled); return wedgeAfter(r); });
      expect(signalsOf).toMatchObject({ stalled: 2, activeHealthy: 4, waiting: 7, waitingClaimable: 5 });
      await site(f, 'src/core/minions/supervisor.ts:295', async e => wedgeView(rowsOf(await M.queueWedgeSignals(e, 'nowhere', handled))[0]!),
        async () => { const r = await f.after.readWedgeSignals('nowhere', handled); return wedgeAfter(r); }, { nonEmpty: false });
      const oldest = (queue: string) => site(f, 'src/core/minions/supervisor.ts:414', async e => bucket(rowsOf(await M.queueOldestWaiting(e, queue))[0]?.age), async () => bucket(await f.after.readOldestWaitingAge(queue)), { nonEmpty: false });
      expect(await oldest('q-embed')).toBe(18);
      expect(await oldest('default')).toBe(0);
      expect(await oldest('nowhere')).toBeNull();
      expect(await site(f, 'src/core/advisor/collect-stalled-jobs.ts:23', async e => rowsOf(await M.queueStuck(e)).map(r => ({ name: r.name, n: Number(r.n) })), async () => f.after.listStuckActiveJobsByName()))
        .toEqual(expect.arrayContaining([{ name: 'lapsed', n: 2 }, { name: 'twice', n: 1 }]));
      // Most first (the member sorts what the statement leaves to `ORDER BY n DESC`).
      expect((await f.after.listStuckActiveJobsByName()).map(r => r.name)).toEqual(['lapsed', 'twice']);
    });

    test('every moved read site has a case', () => {
      expect([...covered].sort()).toEqual([...ALL_SITES].sort());
    });
  });
}
