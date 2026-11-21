/**
 * Before/after parity for the statements N8's callers ran themselves and now read through BrainEngine members: the
 * OAuth client reads (access check, credential scope, client inspection, reissue), the client secret rotation, the
 * oversized-embed-skip count, the recursive code walk's qualified names, the `get_usage` window, the segmented embed
 * page, the managed-root reads of the filesystem guard, the page size read of a page append and the worktree refresh
 * resume reads. Master's text is the callers' `executeRaw` statements at the N8 base ff952b0e57
 * (test/helpers/n8-master-sql.ts); the members are N8's (src/core/engine-sql/{oauth-clients,chunk-reads,chat-usage,
 * page-body,connect-gate,persistence-owner-scans}.ts).
 *
 * Each case seeds two identical fresh brains, runs master's exact text (with the run-time text building and row
 * mapping its call site had) on the first and the caller's new path on the second (the real exported function where
 * one exists: rotateClientSecret, readSegmentedEmbedPage), and requires the same rows in every column. Every moved
 * statement the move check lists is named once in ALL_SITES by its master path:line; the last case fails when a site
 * has no case, and a static case fails when a moved file still holds master's text.
 *
 * 1. Protects: the whole-row client read the three callers pick columns from (deleted clients, absent clients, the
 *    reads_unscoped opt-out), the `deleted_at IS NULL` rule of the credential scope, the window and ordering of the
 *    usage sums, the sealed-live-segmented-and-live-source rule of the embed page, the visibility rules of the code
 *    walk (an unsealed and a deleted page stay out, and a world-only caller reads what an unscoped one does (the walk passes no scope)), the UNION of the managed roots, the
 *    refresh resume's state, staleness and order rules, and the compare-and-set of the secret rotation.
 * 2. Fails when: a member or a caller changes a predicate, a cast, a sort, a LIMIT, an archived or deleted rule or a
 *    privacy filter. The mutation table in the N8 report lists a mutation per moved site that this file kills on
 *    PGLite and Postgres.
 * 3. Existing coverage: test/engine-parity/{oauth-clients,chunk-reads,segmented-body,owner-recovery-scans,
 *    connect-gate}.test.ts and test/chat-usage-typed-members.test.ts compare the members across engines; none compared
 *    the callers with the statements master ran.
 * 4. Seam: none. Real engines; rows go in through typed members where one exists and by plain INSERT for the tables no
 *    member writes.
 *
 * Named changes (each pinned below):
 *  - The qualified-name reads (recursive-walk) were an unordered `SELECT DISTINCT ... LIMIT n`; the member orders by
 *    byte order (`COLLATE "C"`) before the LIMIT. Under the limit the sets are master's; over it master's rows were
 *    whichever the plan returned and the member's are the first n in byte order.
 *  - The usage window's `ORDER BY sum(cost_usd) DESC NULLS LAST` gains a tie order (model, then phase, byte order, null phase
 *    first); master left tied groups to the plan.
 *  - `rotateClientSecret` was an advisory lock plus a transaction around an unconditional UPDATE; it is one
 *    compare-and-set (`patchOauthClient` with `client_secret_hash_is`). Of two reissues that read the same secret one
 *    wins and the other fails `reissue_conflict`; master let the second replace the first's secret.
 *  - The reissue read takes the whole row (`readOauthClient`) where master named columns; the four columns the caller
 *    needs are checked and a brain without one fails with the undefined-column error (42703) as master's SELECT did.
 *
 * Privacy: the code walk's reads run as a world-only caller (hidePrivate) as well as unscoped, and the seed holds a
 * private code page and an owner-visible one; every other moved statement reads rows no visibility rule covers
 * (oauth_clients, chat_usage_log, persistence tables), and the embed page is compared with a private segmented page.
 *
 * Engines: PGLite always; Postgres too when DATABASE_URL is set (listed in test/postgres-unit-arms.txt). The Rust arm
 * does not apply to master's text (SQL); every member is `raw_sql` or `persistence_journal` on Rust
 * (src/core/rust-engine/members.ts), which test/engine-parity/coverage.test.ts holds.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { BrainEngine } from '../src/core/engine.ts';
import type { ChunkInput, PageInput } from '../src/core/types.ts';
import { insertOauthClient, requireOauthClientColumns } from '../src/core/engine-sql/oauth-clients.ts';
import { RegisterError, rotateClientSecret } from '../src/commands/agent-register.ts';
import { readSegmentedEmbedPage } from '../src/core/page-body/segmented-embedding.ts';
import { withCallerAccess } from '../src/core/search/private-visibility.ts';
import { hashToken } from '../src/core/utils.ts';
import { testBackends } from './helpers/test-backends.ts';
import { archiveSource, createSource } from './engine-parity/harness.ts';
import { chunk, installChunks } from './engine-parity/chunk-fixtures.ts';
import { segmentText, publishSegmentedPage } from './helpers/page-body-fixtures.ts';
import { makePair } from './helpers/n4-seed.ts';
import * as M from './helpers/n8-master-sql.ts';

/** Every moved caller statement, by master path:line (N8 base ff952b0e57). */
const ALL_SITES = [
  'src/commands/access.ts:280', 'src/commands/agent-register.ts:760', 'src/commands/agent-register.ts:819', 'src/commands/agent-register.ts:821',
  'src/commands/doctor/checks/content-quality.ts:77', 'src/core/access/requester-scope.ts:209', 'src/core/code-intel/recursive-walk.ts:91',
  'src/core/code-intel/recursive-walk.ts:106', 'src/core/harness/client-setup.ts:20', 'src/core/ops/usage.ts:55', 'src/core/ops/usage.ts:71',
  'src/core/page-body/segmented-embedding.ts:61', 'src/core/persistence/filesystem-guard.ts:18', 'src/core/persistence/filesystem-guard.ts:30',
  'src/core/persistence/page-append.ts:437', 'src/core/persistence/worktree-refresh.ts:1226', 'src/core/persistence/worktree-refresh.ts:1237',
] as const;

// ---------------------------------------------------------------- comparison (as test/n7-sql-move-parity.test.ts)

interface Fixture { before: BrainEngine; after: BrainEngine; backend: 'pglite' | 'postgres' }
/** `mask`: columns each brain generates on its own (a source's incarnation uuid); only their presence is compared. */
interface Opts { ordered?: boolean; nonEmpty?: boolean; mask?: readonly string[] }
const masked = (v: unknown, keys: readonly string[] | undefined): unknown => !keys ? v : Array.isArray(v) ? v.map(x => masked(x, keys))
  : v && typeof v === 'object' && !(v instanceof Date) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, keys.includes(k) ? (x == null ? null : '<set>') : x])) : v;

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

/** Both brains are seeded with the same clock: the rows' own timestamps are compared too. */
const OAUTH_AT = new Date('2026-01-01T00:00:00Z');
const NOW0 = Date.now();

/** The sites each case has proved; the last case compares it with ALL_SITES. */
let covered: Set<string>;

/** Run master's text on the before brain and the member on the after brain; require the same rows. */
async function site(f: Fixture, keys: string | string[], before: (e: BrainEngine) => Promise<unknown>, after: (e: BrainEngine) => Promise<unknown>, o: Opts = {}): Promise<unknown> {
  const b = await before(f.before);
  const a = await after(f.after);
  expect(canon(masked(a, o.mask), o.ordered ?? false)).toEqual(canon(masked(b, o.mask), o.ordered ?? false));
  if (o.nonEmpty !== false && !hasData(b)) throw new Error(`master's text read nothing at ${[keys].flat().join(', ')}: ${JSON.stringify(b)}; the case would compare empty with empty`);
  for (const k of Array.isArray(keys) ? keys : [keys]) covered.add(k);
  return b;
}

const pick = (row: object | null | undefined, keys: readonly string[]) => (row ? Object.fromEntries(keys.map(k => [k, (row as Record<string, unknown>)[k] ?? null])) : null);
const byteSorted = (xs: string[]) => [...xs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

// ---------------------------------------------------------------- seeds (identical on both brains, in the same order)

const HOST = 'a8000000-0000-4000-8000-0000000000a1';
const OTHER_HOST = 'a8000000-0000-4000-8000-0000000000a2';
const WT = (n: number) => `a8000000-0000-4000-8000-00000000010${n}`;
const REFRESH = (n: number) => `a8000000-0000-4000-8000-00000000020${n}`;
const READER = { identity: ['member:alice-example'], hidePrivate: true };
const OLD_HASH = hashToken('gbrain_cs_old-secret');

const codePage = (slug: string, extra: Partial<PageInput> = {}): PageInput =>
  ({ type: 'code', page_kind: 'code', title: slug, compiled_truth: `${slug} source`, timeline: '', frontmatter: { file: `${slug}.ts` }, ...extra });
const sym = (i: number, text: string, name: string, extra: Partial<ChunkInput> = {}): ChunkInput =>
  chunk(i, text, { language: 'typescript', symbol_name: name, symbol_type: 'function', symbol_name_qualified: `mod.${name}`, start_line: 10 * (i + 1), end_line: 10 * (i + 1) + 5, ...extra } as Partial<ChunkInput>);

async function sealedCode(e: BrainEngine, slug: string, chunks: ChunkInput[], sourceId?: string, extra: Partial<PageInput> = {}) {
  const opts = sourceId ? { sourceId } : undefined;
  await e.putPage(slug, codePage(slug, extra), opts);
  await installChunks(e, slug, chunks, opts);
}

async function seedWorld(e: BrainEngine, backend: 'pglite' | 'postgres'): Promise<void> {
  await createSource(e, backend, 'other', {}, '/tmp/n8-other');
  await createSource(e, backend, 'arch', {}, '/tmp/n8-arch');
  await createSource(e, backend, 'plain');

  // OAuth clients: a live agent client with a member and an opt-out, a plain client, a deleted client, a public client.
  await insertOauthClient(e, { client_id: 'cli-live', client_name: 'live', client_secret_hash: OLD_HASH, grant_types: ['client_credentials'], scope: 'read',
    created_at: OAUTH_AT, client_id_issued_at: 1_700_000_000, member_id: 'member:alice-example', may_act_for: ['member:bob-example'], reads_unscoped: new Date('2026-02-03T04:05:06Z'), token_ttl: 3600 });
  await insertOauthClient(e, { client_id: 'cli-plain', client_name: 'plain', client_secret_hash: hashToken('gbrain_cs_plain'), grant_types: ['client_credentials'], created_at: OAUTH_AT, client_id_issued_at: 1_700_000_100 });
  await insertOauthClient(e, { client_id: 'cli-deleted', client_name: 'deleted', client_secret_hash: hashToken('gbrain_cs_deleted'), grant_types: ['client_credentials'],
    created_at: OAUTH_AT, client_id_issued_at: 1_700_000_200, reads_unscoped: new Date('2026-03-03T00:00:00Z'), deleted_at: new Date('2026-04-01T00:00:00Z') });
  await insertOauthClient(e, { client_id: 'cli-public', client_name: 'public', client_secret_hash: null, grant_types: ['authorization_code'], created_at: OAUTH_AT, client_id_issued_at: 1_700_000_300 });

  // Code pages: served ones in two sources, a private one, an unsealed one, a deleted one, a markdown page that is not code.
  await sealedCode(e, 'src/a', [sym(0, 'function run() {}', 'run'), sym(1, 'function runner() {}', 'runner'), sym(2, 'function runtime() {}', 'runtime')]);
  await sealedCode(e, 'src/b', [sym(0, 'function run() {}', 'run', { symbol_name_qualified: 'zed.run' }), sym(1, 'function Run2() {}', 'Run2')]);
  await sealedCode(e, 'src/c', [sym(0, 'function run() {}', 'run', { symbol_name_qualified: 'other.run' })], 'other');
  await sealedCode(e, 'src/private', [sym(0, 'function run() {}', 'run', { symbol_name_qualified: 'priv.run' }), sym(1, 'function secret() {}', 'secret_run')], undefined, { frontmatter: { file: 'src/private.ts', visibility: 'private' } });
  await sealedCode(e, 'src/gone', [sym(0, 'function run() {}', 'run', { symbol_name_qualified: 'gone.run' })]);
  await e.softDeletePage('src/gone');
  await e.putPage('src/unsealed', codePage('src/unsealed'));
  await e.upsertChunks('src/unsealed', [sym(0, 'function run() {}', 'run', { symbol_name_qualified: 'unsealed.run' })]);
  // Enough qualified names under one prefix to pass the walk's two limits (25 exact is out of reach; 5 for the fuzzy read).
  await sealedCode(e, 'src/many', ['m', 'k', 'z', 'b', 'a', 'q', 'c'].map((s, i) => sym(i, `function fuzz_${s}() {}`, `fuzz_${s}`, { symbol_name_qualified: `many.fuzz_${s}` })));

  // Pages for the embed-skip count: oversized-marked pages with and without chunks, a deleted one, a too-big one, one marked for another reason.
  const marked = (reason: string) => ({ embed_skip: { reason } });
  await e.putPage('skip/chunked', { type: 'note', title: 'chunked', compiled_truth: 'a'.repeat(200), timeline: 't', frontmatter: marked('oversized') });
  await installChunks(e, 'skip/chunked', [chunk(0, 'chunk of a skipped page')]);
  await e.putPage('skip/chunkless', { type: 'note', title: 'chunkless', compiled_truth: 'b'.repeat(300), timeline: '', frontmatter: marked('oversized') });
  await e.putPage('skip/chunkless2', { type: 'note', title: 'chunkless2', compiled_truth: 'c'.repeat(50), timeline: 'tl', frontmatter: marked('oversized') });
  await e.putPage('skip/deleted', { type: 'note', title: 'deleted', compiled_truth: 'd'.repeat(100), timeline: '', frontmatter: marked('oversized') });
  await e.softDeletePage('skip/deleted');
  await e.putPage('skip/toobig', { type: 'note', title: 'toobig', compiled_truth: 'e'.repeat(5000), timeline: '', frontmatter: marked('oversized') });
  await e.putPage('skip/other', { type: 'note', title: 'other', compiled_truth: 'f'.repeat(80), timeline: '', frontmatter: marked('binary') });

  // The chat usage ledger: priced, unpriced and null-phase rows in the window, one 40 days old, one with a larger cost.
  const row = (model: string, phase: string | null, cost: number | null, ageDays = 0, tokens = 10) => e.logChatUsage({ model, provider: 'p', phase, input_tokens: tokens, output_tokens: tokens * 2,
    cache_read_tokens: tokens + 1, cache_write_tokens: tokens + 2, cost_usd: cost, created_at: new Date(NOW0 - ageDays * 86_400_000 - 1000) });
  await row('m-a', 'synth', 0.5);
  await row('m-a', 'synth', 0.25, 1, 20);
  await row('m-a', null, 0.8, 2);
  await row('m-b', 'expand', null, 3);
  await row('m-b', 'expand', 1.5, 3);
  await row('m-c', 'synth', 0.01, 40, 5);
  await row('m-d', null, null, 4);
  await row('m-f', 'x', 0.3, 5); // three groups with the same cost: master left their order to the plan, the member breaks the tie by model then phase
  await row('m-e', 'x', 0.3, 5);
  await row('m-e', null, 0.3, 5);

  // A segmented page: sealed live in the default source, an unsealed one, a private sealed one, one in an archived source, an inline page.
  const texts = [segmentText('# Intro\nfirst segment of the page\n'), segmentText('## Middle\nsecond segment\n')];
  const sealed = await publishSegmentedPage(e, 'seg/sealed', texts);
  await e.sealSegmentedPage(sealed.pageId);
  await publishSegmentedPage(e, 'seg/unsealed', texts);
  const priv = await publishSegmentedPage(e, 'seg/private', texts);
  await e.executeRaw(`UPDATE pages SET frontmatter = frontmatter || '{"visibility":"private"}'::jsonb WHERE slug = 'seg/private'`);
  await e.sealSegmentedPage(priv.pageId); // sealed after the edit: a later edit would move the revision and leave the projection not current
  await createSource(e, backend, 'segarch');
  const arch = await publishSegmentedPage(e, 'seg/arch', texts, { sourceId: 'segarch' });
  await e.sealSegmentedPage(arch.pageId);
  await archiveSource(e, backend, 'segarch');
  await e.putPage('seg/inline', { type: 'note', title: 'Inline', compiled_truth: 'an inline body', timeline: 'a timeline' });

  // Persistence rows: two worktrees, host bindings for this host and another, source bindings, and refreshes in every state.
  for (const [n, owner] of [[1, HOST], [2, HOST], [3, HOST], [4, HOST], [5, OTHER_HOST]] as const) {
    await e.executeRaw('INSERT INTO persistence_worktrees (id, owner_host_id) VALUES ($1::uuid, $2::uuid)', [WT(n), owner]);
  }
  await e.executeRaw(`INSERT INTO persistence_host_bindings (worktree_id, host_id, local_path, coordination_path) VALUES
    ($1::uuid, $3::uuid, '/tmp/n8-wt-1', '/tmp/n8-co-1'), ($2::uuid, $3::uuid, '/tmp/n8-wt-2', '/tmp/n8-co-2'), ($2::uuid, $4::uuid, '/tmp/n8-wt-2-other', '/tmp/n8-co-2o')`, [WT(1), WT(2), HOST, OTHER_HOST]);
  await e.executeRaw(`INSERT INTO persistence_source_bindings (source_id, source_incarnation, worktree_id) VALUES
    ('wt-src-1', gen_random_uuid(), $1::uuid), ('wt-src-2', gen_random_uuid(), $2::uuid)`, [WT(1), WT(2)]);
  await e.executeRaw(`UPDATE sources SET last_commit = 'c-other' WHERE id = 'other'`);
  await e.executeRaw(`UPDATE sources SET last_commit = 'c-default' WHERE id = 'default'`);
  const refresh = (n: number, wt: number, state: string, sources: string[], oldHead: string, ageSeconds: number, updatedAgeSeconds = ageSeconds) => e.executeRaw(
    `INSERT INTO persistence_worktree_refreshes (id, worktree_id, source_ids, principal_id, owner_epoch, topology_generation, state, old_head, target_head, upstream_ref, created_at, updated_at)
     VALUES ($1::uuid, $2::uuid, $3::text[], gen_random_uuid(), 0, 1, $4, $5, 'target', 'origin/main', now() - ($6::integer * interval '1 second'), now() - ($7::integer * interval '1 second'))`,
    [REFRESH(n), WT(wt), sources, state, oldHead, ageSeconds, updatedAgeSeconds]);
  await refresh(1, 1, 'draining', ['default'], 'x', 100); // newer than the syncing ones: draining still lists first
  await refresh(2, 2, 'syncing', ['other'], 'c-other', 400, 5); // syncing, fresh, a source still at the old head: lagging, not listed
  await refresh(3, 3, 'syncing', ['other', 'default'], 'old', 300, 5); // syncing, fresh, every source moved off the old head: listed
  await refresh(4, 4, 'syncing', ['other'], 'c-other', 200, 90_000); // syncing, a source at the old head but no movement for 90000 s: stale, listed
  await refresh(5, 5, 'draining', ['default'], 'x', 90); // another host's worktree
  await e.executeRaw(`UPDATE persistence_worktree_refreshes SET state = 'completed', completed_at = now() WHERE id = $1::uuid`, [REFRESH(5)]);
}

// ---------------------------------------------------------------- the cases

const CLIENT_ID = 'cli-live';
const CLIENT_COLUMNS = ['member_id', 'may_act_for', 'reads_unscoped'] as const;

for (const kind of testBackends()) {
  describe(`N8 caller statements before and after the move (${kind})`, () => {
    const closers: Array<() => Promise<void>> = [];
    let f: Fixture;
    beforeAll(async () => {
      covered = new Set();
      const engines = await makePair(kind, closers);
      for (const e of engines) await seedWorld(e, kind);
      f = { before: engines[0]!, after: engines[1]!, backend: kind };
    }, 240_000);
    afterAll(async () => { for (const close of closers) await close(); });

    // -------- oauth client reads
    test('access check: the member, delegation and opt-out of a live client; a deleted client reads as master did; no client reads nothing', async () => {
      for (const id of [CLIENT_ID, 'cli-plain', 'cli-deleted', 'cli-public']) {
        await site(f, 'src/commands/access.ts:280', e => M.accessClientRow(e, id), async e => pick(await e.readOauthClient(id), CLIENT_COLUMNS), { nonEmpty: false });
      }
      const live = await site(f, 'src/commands/access.ts:280', e => M.accessClientRow(e, CLIENT_ID), async e => pick(await e.readOauthClient(CLIENT_ID), CLIENT_COLUMNS)) as Record<string, unknown>;
      expect(live.member_id).toBe('member:alice-example');
      expect(live.may_act_for).toEqual(['member:bob-example']);
      expect(await M.accessClientRow(f.before, 'cli-missing')).toBeNull();
      expect(await f.after.readOauthClient('cli-missing')).toBeNull();
    });

    test('credential scope: a live client reports its opt-out and issue time, a deleted or unknown client reports none', async () => {
      const after = async (e: BrainEngine, id: string) => {
        const found = await e.readOauthClient(id);
        const row = found && found.deleted_at == null ? requireOauthClientColumns(found, ['reads_unscoped', 'client_id_issued_at']) : undefined;
        return row ? pick(row as unknown as Record<string, unknown>, ['reads_unscoped', 'client_id_issued_at']) : null;
      };
      const masterRow = async (e: BrainEngine, id: string) => pick((await M.credentialScopeRow(e, id)) as Record<string, unknown> | undefined, ['reads_unscoped', 'client_id_issued_at']);
      const live = await site(f, 'src/core/access/requester-scope.ts:209', e => masterRow(e, CLIENT_ID), e => after(e, CLIENT_ID)) as Record<string, unknown>;
      expect(Number(live.client_id_issued_at)).toBe(1_700_000_000);
      await site(f, 'src/core/access/requester-scope.ts:209', e => masterRow(e, 'cli-plain'), e => after(e, 'cli-plain'), { nonEmpty: false });
      expect(await site(f, 'src/core/access/requester-scope.ts:209', e => masterRow(e, 'cli-deleted'), e => after(e, 'cli-deleted'), { nonEmpty: false })).toBeNull(); // opted out, but deleted
      expect(await site(f, 'src/core/access/requester-scope.ts:209', e => masterRow(e, 'cli-missing'), e => after(e, 'cli-missing'), { nonEmpty: false })).toBeNull();
    });

    test('client inspection: the whole inspected column set of a client, deleted and public clients included', async () => {
      const { CLIENT_INSPECTION_COLUMNS } = await import('../src/core/harness/client-setup.ts');
      const columns = CLIENT_INSPECTION_COLUMNS.split(',').map(c => c.trim());
      for (const id of [CLIENT_ID, 'cli-deleted', 'cli-public', 'cli-missing']) {
        await site(f, 'src/core/harness/client-setup.ts:20', e => M.inspectedClientRow(e, id), async e => pick(await e.readOauthClient(id), columns), { nonEmpty: id !== 'cli-missing' });
      }
    });

    test('reissue read: the columns the caller uses, a deleted client and an unknown client', async () => {
      const projection = ['client_id', 'client_name', 'grant_types', 'client_secret_hash', 'source_id', 'federated_read', 'token_ttl', 'deleted_at'];
      for (const id of [CLIENT_ID, 'cli-deleted', 'cli-public', 'cli-missing']) {
        await site(f, 'src/commands/agent-register.ts:760', async e => (await M.reissueClientRows(e, id, projection))[0] ?? null, async e => pick(await e.readOauthClient(id), projection), { nonEmpty: id !== 'cli-missing' });
      }
      // A brain without a column the caller needs: master's SELECT raised 42703; the checked whole row raises the same.
      const row = (await f.after.readOauthClient(CLIENT_ID))!;
      const { client_secret_hash: _drop, ...without } = row;
      expect(() => requireOauthClientColumns(without, ['client_id', 'client_name', 'grant_types', 'client_secret_hash'])).toThrow(/column "client_secret_hash" does not exist/);
      await expect(f.before.executeRaw('SELECT no_such_column FROM oauth_clients WHERE client_id = $1', [CLIENT_ID])).rejects.toThrow(/no_such_column/);
    });

    // -------- secret rotation
    test('secret rotation: the new hash replaces the old one and only that column changes; a stale read conflicts; an unknown client is invalid', async () => {
      const [b, a] = [f.before, f.after];
      await M.rotateClientSecretMaster(b, 'cli-plain', 'plain', 'gbrain_cs_master-new');
      const secret = await rotateClientSecret(a, 'cli-plain', hashToken('gbrain_cs_plain'));
      const read = async (e: BrainEngine) => (await e.readOauthClient('cli-plain'))!;
      const [rb, ra] = [await read(b), await read(a)];
      expect(rb.client_secret_hash).toBe(hashToken('gbrain_cs_master-new'));
      expect(ra.client_secret_hash).toBe(hashToken(secret));
      const { client_secret_hash: _b, ...restB } = rb;
      const { client_secret_hash: _a, ...restA } = ra;
      expect(canon(restA, false)).toEqual(canon(restB, false)); // no other column moved
      covered.add('src/commands/agent-register.ts:821');
      // Unknown client: master threw vanished mid-rotation (reissue_invalid_target); so does the new path.
      await expect(M.rotateClientSecretMaster(b, 'cli-missing', 'missing', 'gbrain_cs_x')).rejects.toThrow(/vanished mid-rotation/);
      const gone = await rotateClientSecret(a, 'cli-missing', 'hash').catch(e => e);
      expect(gone).toBeInstanceOf(RegisterError);
      expect((gone as RegisterError).reason).toBe('reissue_invalid_target');
      expect((gone as RegisterError).message).toMatch(/vanished mid-rotation/);
      // A stale read: the secret changed after the caller read it. Master replaced it silently; the new path conflicts and changes nothing.
      const before = (await a.readOauthClient('cli-plain'))!.client_secret_hash;
      const stale = await rotateClientSecret(a, 'cli-plain', OLD_HASH).catch(e => e);
      expect(stale).toBeInstanceOf(RegisterError);
      expect((stale as RegisterError).reason).toBe('reissue_conflict');
      expect((await a.readOauthClient('cli-plain'))!.client_secret_hash).toBe(before);
      await M.rotateClientSecretMaster(b, 'cli-plain', 'plain', 'gbrain_cs_master-stale');
      expect((await b.readOauthClient('cli-plain'))!.client_secret_hash).toBe(hashToken('gbrain_cs_master-stale')); // master: the stale caller won
      covered.add('src/commands/agent-register.ts:819');
    });

    test('secret rotation: of two reissues that read the same secret exactly one wins and the loser changes nothing (master: both returned a secret)', async () => {
      const read = async (e: BrainEngine) => (await e.readOauthClient('cli-live'))!.client_secret_hash!;
      const hash = await read(f.after);
      const settled = await Promise.allSettled([rotateClientSecret(f.after, 'cli-live', hash), rotateClientSecret(f.after, 'cli-live', hash)]);
      expect(settled.filter(s => s.status === 'fulfilled')).toHaveLength(1);
      const lost = settled.find(s => s.status === 'rejected') as PromiseRejectedResult;
      expect((lost.reason as RegisterError).reason).toBe('reissue_conflict');
      const winner = (settled.find(s => s.status === 'fulfilled') as PromiseFulfilledResult<string>).value;
      expect(await read(f.after)).toBe(hashToken(winner));
      const master = await Promise.allSettled([M.rotateClientSecretMaster(f.before, 'cli-live', 'live', 'gbrain_cs_m1'), M.rotateClientSecretMaster(f.before, 'cli-live', 'live', 'gbrain_cs_m2')]);
      expect(master.filter(s => s.status === 'fulfilled')).toHaveLength(2);
      for (const id of ['cli-live']) for (const e of [f.before, f.after]) await e.executeRaw('UPDATE oauth_clients SET client_secret_hash = $2 WHERE client_id = $1', [id, OLD_HASH]);
    });

    // -------- chunk reads
    test('oversized embed skips: marked live pages that fit, and how many have no chunk row', async () => {
      for (const bytes of [1000, 120, 10_000, 0]) {
        await site(f, 'src/commands/doctor/checks/content-quality.ts:77',
          async e => { const r = await M.oversizedEmbedSkipRow(e, bytes); return { marked: Number(r?.n ?? 0), chunkless: Number(r?.chunkless ?? 0) }; },
          e => e.countOversizedEmbedSkips(bytes), { nonEmpty: bytes !== 0 });
      }
      expect(await f.after.countOversizedEmbedSkips(1000)).toEqual({ marked: 3, chunkless: 2 });
    });

    test('qualified symbol names: exact and did-you-mean sets, byte order and the limit, an unsealed and a deleted page stay out, and a world-only caller reads what an unscoped one does (the walk passes no scope)', async () => {
      const asReader = <T>(run: () => Promise<T>) => withCallerAccess(READER, run);
      const exact = (bare: string) => (e: BrainEngine) => M.exactQualifiedNames(e, 'default', bare);
      const member = (bare: string, match: 'exact' | 'contains', limit: number) => (e: BrainEngine) => e.listQualifiedSymbolNames('default', bare, { match, limit });
      for (const bare of ['run', 'mod.run', 'runner', 'secret_run', 'nothing']) {
        await site(f, 'src/core/code-intel/recursive-walk.ts:91', exact(bare), member(bare, 'exact', 25), { nonEmpty: bare !== 'nothing' });
        await site(f, 'src/core/code-intel/recursive-walk.ts:91', e => asReader(() => exact(bare)(e)), e => asReader(() => member(bare, 'exact', 25)(e)), { nonEmpty: bare !== 'nothing' });
      }
      for (const bare of ['run', 'fuzz_a', 'ZED', 'nothing']) {
        await site(f, 'src/core/code-intel/recursive-walk.ts:106', e => M.fuzzyQualifiedNames(e, 'default', bare), member(bare, 'contains', 5), { nonEmpty: bare !== 'nothing' });
        await site(f, 'src/core/code-intel/recursive-walk.ts:106', e => asReader(() => M.fuzzyQualifiedNames(e, 'default', bare)), e => asReader(() => member(bare, 'contains', 5)(e)), { nonEmpty: bare !== 'nothing' });
      }
      const stored = await M.exactQualifiedNames(f.before, 'default', 'run');
      expect(stored).toContain('priv.run'); // unscoped, a private served page is read as master read it
      expect(stored).not.toContain('unsealed.run');
      expect(stored).not.toContain('gone.run');
      // The walk passes no scope (`codeReadFilter([], {})`), so it applies no private-page rule, and the member keeps that: a world-only caller reads the same names.
      expect(await asReader(() => f.after.listQualifiedSymbolNames('default', 'run', { match: 'exact', limit: 25 }))).toContain('priv.run');
      expect(await f.after.listQualifiedSymbolNames('other', 'run', { match: 'exact', limit: 25 })).toEqual(['other.run']);
      // The named order change: the member returns names in byte order, and over the limit the first n of them.
      const names = await f.after.listQualifiedSymbolNames('default', 'fuzz', { match: 'contains', limit: 25 });
      expect(names).toEqual(byteSorted(names));
      expect(names).toHaveLength(7);
      expect(await f.after.listQualifiedSymbolNames('default', 'fuzz', { match: 'contains', limit: 5 })).toEqual(names.slice(0, 5));
      expect(new Set(await M.fuzzyQualifiedNames(f.before, 'default', 'fuzz'))).toSatisfy((s: Set<string>) => s.size === 5 && [...s].every(n => names.includes(n))); // master: five of the seven, plan order
    });

    // -------- chat usage
    test('usage window: sums per model and phase in the window, in cost order, and the first logged time of the whole ledger', async () => {
      // Windows with no cost tie keep master's order exactly; the others compare as sets (a tie's order is the named change).
      for (const days of [1, 3]) await site(f, 'src/core/ops/usage.ts:55', e => M.usageWindowRows(e, days), async e => (await e.readChatUsage(days)).rows, { ordered: true });
      for (const days of [30, 365, 7]) await site(f, 'src/core/ops/usage.ts:55', e => M.usageWindowRows(e, days), async e => (await e.readChatUsage(days)).rows);
      await site(f, 'src/core/ops/usage.ts:71', async e => (await M.usageSinceRows(e))[0]?.since ?? null, async e => (await e.readChatUsage(30)).logged_since);
      const week = await f.after.readChatUsage(7);
      expect(week.rows.map(r => `${r.model}/${r.phase}`)).toEqual(['m-b/expand', 'm-a/null', 'm-a/synth', 'm-e/null', 'm-e/x', 'm-f/x', 'm-d/null']); // equal costs: model, then phase, null first
      expect(week.rows.find(r => r.model === 'm-b')).toMatchObject({ calls: 2, unpriced_calls: 1, cost_usd: 1.5 });
      expect(week.rows.find(r => r.model === 'm-d')).toMatchObject({ calls: 1, unpriced_calls: 1, cost_usd: null });
      expect(week.rows.some(r => r.model === 'm-c')).toBe(false); // 40 days old: outside every window here, inside the ledger's first time
      const [old] = await f.after.executeRaw<{ old: boolean }>(`SELECT (min(created_at) < now() - interval '39 days') AS old FROM chat_usage_log`);
      expect(old!.old).toBe(true);
    });

    // -------- segmented embed page
    test('segmented embed page: a sealed live segmented page by id and by slug; unsealed, private, archived-source, inline, deleted and unknown pages read as master read them', async () => {
      const idOf = async (e: BrainEngine, slug: string, sourceId = 'default') => Number((await e.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id = $1 AND slug = $2', [sourceId, slug]))[0]!.id);
      for (const [slug, sourceId] of [['seg/sealed', 'default'], ['seg/unsealed', 'default'], ['seg/private', 'default'], ['seg/arch', 'segarch'], ['seg/inline', 'default'], ['seg/none', 'default']] as const) {
        const interesting = slug === 'seg/sealed' || slug === 'seg/private';
        await site(f, 'src/core/page-body/segmented-embedding.ts:61', e => M.segmentedEmbedPageRow(e, { sourceId, slug }), e => readSegmentedEmbedPage(e, { sourceId, slug }), { nonEmpty: interesting }).catch(err => { throw new Error(`${slug}: ${err instanceof Error ? err.message : err}`); });
        if (slug !== 'seg/none') {
          await site(f, 'src/core/page-body/segmented-embedding.ts:61', async e => M.segmentedEmbedPageRow(e, { id: await idOf(e, slug, sourceId) }), async e => readSegmentedEmbedPage(e, { id: await idOf(e, slug, sourceId) }), { nonEmpty: interesting });
        }
      }
      await site(f, 'src/core/page-body/segmented-embedding.ts:61', e => M.segmentedEmbedPageRow(e, { id: 987_654_321 }), e => readSegmentedEmbedPage(e, { id: 987_654_321 }), { nonEmpty: false });
      const read = await readSegmentedEmbedPage(f.after, { sourceId: 'default', slug: 'seg/sealed' });
      expect(read).toMatchObject({ slug: 'seg/sealed', source_id: 'default', body_storage: 'segmented' });
      expect(await readSegmentedEmbedPage(f.after, { sourceId: 'default', slug: 'seg/private' })).not.toBeNull(); // the embed reads every sealed page: no visibility filter, as on master
      expect(await readSegmentedEmbedPage(f.after, { sourceId: 'segarch', slug: 'seg/arch' })).toBeNull();
      expect(await readSegmentedEmbedPage(f.after, { sourceId: 'default', slug: 'seg/unsealed' })).toBeNull();
      await withCallerAccess(READER, async () => {
        expect(await readSegmentedEmbedPage(f.after, { sourceId: 'default', slug: 'seg/private' })).not.toBeNull(); // world-only caller: the same as master's
        expect(await M.segmentedEmbedPageRow(f.before, { sourceId: 'default', slug: 'seg/private' })).not.toBeNull();
      });
    });

    // -------- managed roots
    test('managed roots: the persistence brain probe, and the host bindings united with every source that has a path', async () => {
      await site(f, 'src/core/persistence/filesystem-guard.ts:18', async e => (await M.persistenceBrainPresent(e))?.present === true, e => e.hasPersistenceTable('persistence_brain'));
      for (const host of [HOST, OTHER_HOST, 'a8000000-0000-4000-8000-0000000000ff']) {
        const rows = await site(f, 'src/core/persistence/filesystem-guard.ts:30', e => M.managedRootRows(e, host), e => e.listManagedRootBindings(host), { mask: ['source_incarnation'] }) as Array<Record<string, unknown>>;
        const paths = rows.map(r => r.local_path as string).sort();
        if (host === HOST) expect(paths).toEqual(['/tmp/n8-arch', '/tmp/n8-other', '/tmp/n8-wt-1', '/tmp/n8-wt-2']);
        if (host === OTHER_HOST) expect(paths).toEqual(['/tmp/n8-arch', '/tmp/n8-other', '/tmp/n8-wt-2-other']);
      }
      const pair = await makePair(kind, closers);
      for (const e of pair) { await seedWorld(e, kind); await e.executeRaw('DROP TABLE persistence_brain CASCADE'); }
      const g: Fixture = { before: pair[0]!, after: pair[1]!, backend: kind };
      expect(await site(g, 'src/core/persistence/filesystem-guard.ts:18', async e => (await M.persistenceBrainPresent(e))?.present === true, e => e.hasPersistenceTable('persistence_brain'), { nonEmpty: false })).toBe(false);
    }, 240_000);

    // -------- page append sizes
    test('page body sizes: stored body bytes and truth bytes of an inline and a segmented page; no page reads nothing', async () => {
      const idOf = async (e: BrainEngine, slug: string) => Number((await e.executeRaw<{ id: number }>('SELECT id FROM pages WHERE slug = $1 AND source_id = $2', [slug, 'default']))[0]!.id);
      for (const slug of ['seg/inline', 'seg/sealed', 'skip/chunkless', 'skip/chunkless2']) {
        await site(f, 'src/core/persistence/page-append.ts:437', async e => pick(await M.pageBodySizeRow(e, await idOf(e, slug)), ['bytes', 'truth']), async e => {
          const sizes = await e.readPageBodySizes(await idOf(e, slug));
          return pick(sizes as unknown as Record<string, unknown>, ['bytes', 'truth']);
        });
      }
      await site(f, 'src/core/persistence/page-append.ts:437', async e => (await M.pageBodySizeRow(e, 987_654_321)) ?? null, e => e.readPageBodySizes(987_654_321), { nonEmpty: false });
    });

    // -------- worktree refresh resume
    test('refresh resume: draining and stale or lagging syncing refreshes of this host, oldest syncing last, and the last commits of a refresh\'s sources', async () => {
      const mine = (r: Record<string, unknown>) => ({ id: r.id, state: r.state, stale: r.stale, source_ids: r.source_ids, old_head: r.old_head });
      for (const [host, budgetMs] of [[HOST, 60_000], [HOST, 1], [HOST, 1_000_000_000], [OTHER_HOST, 60_000], ['a8000000-0000-4000-8000-0000000000ff', 60_000]] as const) {
        const listed = await site(f, 'src/core/persistence/worktree-refresh.ts:1226',
          async e => (await M.resumableRefreshRows(e, host, budgetMs)).map(mine), async e => (await e.listResumableRefreshes(host, budgetMs)).map(r => mine(r as Record<string, unknown>)),
          { ordered: true, nonEmpty: host === HOST }) as Array<Record<string, unknown>>;
        if (host === HOST && budgetMs === 60_000) expect(listed.map(r => r.id)).toEqual([REFRESH(1), REFRESH(3), REFRESH(4)]); // draining first, then syncing by age
      }
      await expect(M.resumableRefreshRows(f.before, 'not-a-host', 1)).rejects.toThrow(/invalid input syntax for type uuid/);
      await expect(f.after.listResumableRefreshes('not-a-host', 1)).rejects.toThrow(/invalid input syntax for type uuid/);
      for (const ids of [['other', 'default'], ['default', 'other', 'no-such'], ['plain'], [], ['no-such']]) {
        await site(f, 'src/core/persistence/worktree-refresh.ts:1237', e => M.sourceLastCommitRows(e, ids), e => e.listSourceLastCommits(ids), { ordered: true, nonEmpty: ids.includes('other') || ids.includes('default') });
      }
    });

    // -------- carried connect-gate reads on seeded rows (no moved caller: absolute answers, so a wrong statement cannot hide behind equal arms)
    test('connect gate reads: a custody row, and only the committed writer deactivations', async () => {
      const e = f.after;
      const RUN = 'a8000000-0000-4000-8000-0000000000e1';
      await e.executeRaw(`INSERT INTO persistence_graduation (singleton, role, run_id, state) VALUES (1, 'source', $1::uuid, 'quiesced')`, [RUN]);
      try {
        expect(await e.readGraduationGateRow()).toEqual({ role: 'source', run_id: RUN, state: 'quiesced', source_data_dir: null });
        expect(await e.readGraduationGateRow({ withRunSetting: true })).toEqual({ role: 'source', run_id: RUN, state: 'quiesced', source_data_dir: null, run: null });
      } finally { await e.executeRaw('DELETE FROM persistence_graduation'); }
      expect(await e.readGraduationGateRow()).toBeNull();
      const change = (op: string, state: string, outcome: string | null) => e.executeRaw(
        `INSERT INTO persistence_topology_changes (principal_id, request_id, digest, operation, source_id, state, outcome) VALUES (gen_random_uuid(), gen_random_uuid(), 'd', $1, 'default', $2, $3::text::jsonb)`, [op, state, outcome]);
      await change('writer_deactivate', 'committed', '{"brain_id":"b1","retired_mode_epoch":3}');
      await change('writer_deactivate', 'failed', '{"brain_id":"b2"}');
      await change('writer_deactivate', 'recovering', null);
      await change('topology_change', 'committed', '{"brain_id":"b3"}');
      try {
        expect(await e.listRetiredDeactivations()).toEqual([{ outcome: { brain_id: 'b1', retired_mode_epoch: 3 } }]);
      } finally { await e.executeRaw('DELETE FROM persistence_topology_changes'); }
      expect(await e.listRetiredDeactivations()).toEqual([]);
    });

    // -------- carried owner and effect scans on seeded rows (their callers are not in this cut: absolute answers, so a wrong statement cannot hide behind equal arms)
    test('owner and effect scans: recovery heads, overdue holds, effect recoveries, the claimable effect, gated mirrors and a request\'s effects', async () => {
      const e = f.after;
      const REQ = (n: number) => `a8000000-0000-4000-8000-0000000003${String(n).padStart(2, '0')}`;
      const req = (n: number, wt: number, state: string, o: { recovery?: boolean; refresh?: number; ageSeconds?: number; updatedSeconds?: number } = {}) => e.executeRaw(
        `INSERT INTO persistence_requests (id, principal_kind, principal_id, request_id, operation, source_id, source_incarnation, slug, worktree_id, digest, authority, intent_bytes, terminal_reservation, state, recovery, deferred_refresh_id, created_at, updated_at)
         VALUES ($1::uuid, 'local_cli', 'n8', gen_random_uuid(), 'put_page', 'default', gen_random_uuid(), $2, $3::uuid, 'd', '{}'::jsonb, 0, 0, $4, $5::text::jsonb, $6::uuid,
           now() - ($7::integer * interval '1 second'), now() - ($8::integer * interval '1 second'))`,
        [REQ(n), `n8/${n}`, WT(wt), state, o.recovery ? '{"x":1}' : null, o.refresh ? REFRESH(o.refresh) : null, o.ageSeconds ?? 10, o.updatedSeconds ?? o.ageSeconds ?? 10]);
      const eff = (n: number, kind: string, wt: number, o: { state?: string; recovery?: boolean; errorCode?: string; data?: string; nextSecondsAgo?: number } = {}) => e.executeRaw(
        `INSERT INTO persistence_effects (request_id, kind, data, state, worktree_id, source_id, error_code, recovery, next_attempt_at)
         VALUES ($1::uuid, $2, $3::text::jsonb, $4, $5::uuid, 'default', $6, $7::text::jsonb, now() - ($8::integer * interval '1 second'))`,
        [REQ(n), kind, o.data ?? '{}', o.state ?? 'queued', WT(wt), o.errorCode ?? null, o.recovery ? '{"x":1}' : null, o.nextSecondsAgo ?? 60]);
      const effectId = async (n: number, kind: string) => Number((await e.executeRaw<{ id: number }>('SELECT id FROM persistence_effects WHERE request_id = $1::uuid AND kind = $2', [REQ(n), kind]))[0]!.id);
      try {
        // Recovery heads: the first recovering request of each worktree this host owns, oldest update first.
        await req(1, 1, 'recovering', { recovery: true, updatedSeconds: 300 });
        await req(2, 1, 'recovering', { recovery: true, updatedSeconds: 200 });
        await req(3, 2, 'recovering', { recovery: true, updatedSeconds: 400 });
        await req(4, 5, 'recovering', { recovery: true, updatedSeconds: 100 });
        const heads = async (host: string, excluded: string[]) => (await e.listOwnerRecoveryHeads<{ id: string }>(host, excluded)).map(r => r.id);
        expect(await heads(HOST, [])).toEqual([REQ(3), REQ(1)]);
        expect(await heads(HOST, [WT(2)])).toEqual([REQ(1)]);
        expect(await heads(OTHER_HOST, [])).toEqual([REQ(4)]);
        // Overdue holds behind an unreleased refresh, in sequence order; a fresh hold and another host's are not listed.
        await req(5, 3, 'deferred', { refresh: 1, ageSeconds: 1000 });
        await req(6, 4, 'deferred', { refresh: 3, ageSeconds: 900 });
        await req(7, 3, 'deferred', { refresh: 1, ageSeconds: 5 });
        const overdue = async (host: string) => (await e.listOverdueHeldWrites<{ id: string }>(host, 60_000, 'refresh')).map(r => r.id);
        expect(await overdue(HOST)).toEqual([REQ(5), REQ(6)]);
        expect(await overdue(OTHER_HOST)).toEqual([]);
        expect(await e.transaction(tx => tx.lockOverdueHold({ kind: 'refresh', refreshId: REFRESH(1) }))).toBe(true);
        expect(await e.transaction(tx => tx.lockOverdueHold({ kind: 'refresh', refreshId: null }))).toBe(false);
        // Effects: open recoveries after a cursor, a request's effects in byte order of kind, the next claimable effect, a gated mirror.
        await eff(1, 'git', 1, { recovery: true });
        await eff(3, 'git', 2, { recovery: true });
        await eff(1, 'links', 1, { state: 'committed' });
        await eff(1, 'embedding', 1, { state: 'committed' });
        const a = await effectId(1, 'git'); const b = await effectId(3, 'git');
        expect((await e.listEffectRecoveries<{ id: string | number }>(HOST, null, 10)).map(r => Number(r.id))).toEqual([a, b]);
        expect((await e.listEffectRecoveries<{ id: string | number }>(HOST, String(a), 10)).map(r => Number(r.id))).toEqual([b]);
        expect((await e.readRequestEffects(REQ(1))).map(r => r.kind)).toEqual(['embedding', 'git', 'links']);
        await req(8, 4, 'queued'); await req(9, 4, 'queued');
        await eff(8, 'git', 4); await eff(9, 'git', 4);
        const first = await effectId(8, 'git');
        expect(Number((await e.selectClaimableEffect<{ id: string | number }>(HOST, []))!.id)).toBe(first); // equal next_attempt_at: the lower id
        await req(10, 3, 'queued');
        await eff(10, 'withdrawal-mirror', 3, { state: 'failed', errorCode: 'targets_parked', data: '{"parked":[{"error_code":"code-x"}]}' });
        expect((await e.listGatedMirrorRequests(HOST, 'code-x', ['code-x'])).map(r => r.id)).toEqual([REQ(10)]);
        expect(await e.listGatedMirrorRequests(HOST, 'code-y', ['code-y'])).toEqual([]);
        expect(await e.listGatedMirrorRequests(OTHER_HOST, 'code-x', ['code-x'])).toEqual([]);
      } finally {
        await e.executeRaw('DELETE FROM persistence_effects');
        await e.executeRaw('DELETE FROM persistence_requests');
      }
    });

    // -------- carried trust allow rules on seeded rows
    test('trust allow rules list: active ones by id, removed ones on request, narrowed by source', async () => {
      const e = f.after;
      try {
        await e.executeRaw(`INSERT INTO trust_allow_rules (source_id, uri_prefix, created_by) VALUES ('default', 'https://a.example/', 'owner'), ('plain', NULL, 'owner')`);
        await e.executeRaw(`INSERT INTO trust_allow_rules (source_id, uri_prefix, created_by, removed_at, removed_by) VALUES ('default', 'https://b.example/', 'owner', now(), 'owner')`);
        const ids = async (opts?: { sourceIds?: string[]; includeRemoved?: boolean }) => (await e.listTrustAllowRuleRows(opts)).map(r => `${r.source_id}:${r.uri_prefix ?? ''}`);
        expect(await ids()).toEqual(['default:https://a.example/', 'plain:']);
        expect(await ids({ includeRemoved: true })).toEqual(['default:https://a.example/', 'plain:', 'default:https://b.example/']);
        expect(await ids({ sourceIds: ['plain'] })).toEqual(['plain:']);
        expect(await ids({ sourceIds: ['default'], includeRemoved: true })).toEqual(['default:https://a.example/', 'default:https://b.example/']);
      } finally { await e.executeRaw('DELETE FROM trust_allow_rules'); }
    });

    // -------- the moved files and the sites
    test('no moved caller file still holds the statements master ran', () => {
      const files = ['src/commands/access.ts', 'src/commands/agent-register.ts', 'src/commands/doctor/checks/content-quality.ts', 'src/core/access/requester-scope.ts',
        'src/core/code-intel/recursive-walk.ts', 'src/core/harness/client-setup.ts', 'src/core/ops/usage.ts', 'src/core/page-body/segmented-embedding.ts',
        'src/core/persistence/filesystem-guard.ts', 'src/core/persistence/page-append.ts', 'src/core/persistence/worktree-refresh.ts'];
      const master = /FROM oauth_clients WHERE client_id = \$1|UPDATE oauth_clients SET client_secret_hash|FROM chat_usage_log|embed_skip'->>|SELECT DISTINCT symbol_name_qualified|to_regclass\('persistence_brain'\)|FROM persistence_host_bindings h JOIN|SELECT f\.\*,f\.updated_at|SELECT last_commit FROM sources WHERE id=ANY|SELECT p\.id, p\.slug, p\.source_id, p\.title|SELECT COALESCE\(body_bytes/;
      const stillThere = files.filter(file => master.test(readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')));
      expect(stillThere).toEqual([]);
    });

    test('every moved statement of the N8 callers has a case', () => {
      expect([...covered].sort()).toEqual([...ALL_SITES].sort());
    });
  });
}
