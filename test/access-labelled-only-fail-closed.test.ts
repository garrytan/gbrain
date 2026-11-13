import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import type { WriteAuthority } from '../src/core/persistence/model.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { runAccess } from '../src/commands/access.ts';
import { linkMember } from '../src/core/access/actor.ts';
import { memberIdentityFor, stdioMemberIdentity } from '../src/core/access/caller.ts';
import { bindCredential } from '../src/core/access/members.ts';
import { setOwner } from '../src/core/access/owner.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { codeClass, codeRetryable } from '../src/core/error-catalogue.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { assertLabelledOnlyCreate, authorizePageVisibility } from '../src/core/persistence/page-visibility.ts';
import { ACCESS_RESTRICTIONS_KEY } from '../src/core/search/private-visibility.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { readsUnscopedOnPurpose } from './helpers/reads-unscoped.ts';

/**
 * GBRA-108 design 1 follow-ups to the labelled-only grant (access_members.labelled_only).
 * 1. Protects: a credential bound to a labelled-only member never reads or writes an unlabelled page as an unbound
 *    guest when its identity lookup fails (liveIdentity throws access_identity_unavailable, retryable, instead of
 *    returning the empty identity); a schema older than the member tables still reads as unbound. A labelled-only
 *    member's unnamed create is refused however the grant arrived: on a long-lived engine that served the brain
 *    unrestricted, on a member that already wrote, through a second serve process, and with
 *    access.restrictions_present deleted by hand. A combined visibility probe that fails never lets a write pass
 *    inside a transaction, and outside one counts as labelled-only.
 * 2. Fails when: a failed lookup reads as a guest, the pre-migration case errors, a cached or ambient unrestricted
 *    policy skips the create check, or a failed probe opens a page.
 * 3. Real seams: tokens minted by the token service and verified by the serve --http verifier, MCP dispatch with
 *    remote: true (put_page through the persistence consumer), the access CLI, the stored-write checks
 *    (authorizePageVisibility, assertLabelledOnlyCreate) and real SQL errors from PGLite, and Postgres with
 *    DATABASE_URL. Failures are injected on the engine's executeRaw, which every transaction it opens inherits.
 */

const SRC = 'lofc-src';
const OWNER = 'alice-example';
const BOT = 'acme-example-bot';
const WRITER = 'acme-example-writer';
const LATE = 'acme-example-late';
const OPEN = 'notes/open-example';
const LABELLED = 'notes/labelled-example';
const MISSING = 'notes/missing-example';
const OPEN_CANARY = 'canarylofcopenx';
const LABELLED_CANARY = 'canarylofclabelledx';
const MEMBER_LOOKUP = 'FROM access_members m LEFT JOIN access_group_members g';
const AUDIENCE_LOOKUP = 'm.id = ANY($1::text[])';
const ACTOR_LOOKUP = 'FROM access_member_links l';
const BOT_EXTERNAL_ID = 'u-acme-example-bot';
const OWNER_SLUG = 'notes/owner-lock-example';
const OWNER_CANARY = 'canarylofcownerx';
/** SQLSTATEs an injected failure raises: an internal error (not transient), a dropped connection and a lock timeout (both transient). */
const FAULT = 'XX000';
const DROPPED = '08006';
const LOCK_TIMEOUT = '55P03';
const ONE_FAILURE = 1;
const SUBMIT_SLUG = 'notes/owner-submit-example';
const SUBMIT_CANARY = 'canarylofcsubmitx';
const SUBMIT_REQUEST = '00000000-0000-4000-8000-00000000a1f1';
/** Submission checks the writer's member twice (writerIdentities, writerLabelledOnly); the stored write's checks come after. */
const SUBMISSION_LOOKUPS = 2;
const COMBINED_PROBE = 'AS any_labelled';
const LOOKUP_FAILURES = 2;
/** Every lookup of one request fails: a put_page checks visibility at preparation and again at publication, two lookups each. */
const REQUEST_OUTAGE = 100;
const PROBE_FAILURES = 1;
/** Takes the combined probe's two parameters and fails with division_by_zero (22012) on both engines. */
const FAILING_STATEMENT = 'SELECT $1::text, $2::text, 1 / 0';
const MiB = 1024 ** 2;
const DIMS = 1536;
const SLOW_MS = 600_000;
const SETUP_MS = 300_000;
const SECOND_POOL = 2;

type Fail = string | ((sql: string) => string);

/**
 * Makes the next `times` statements on `engine` that contain `marker` fail, in every transaction it opens too (a
 * transaction engine is Object.create(engine)): a SQLSTATE raises an error with that code without reaching the
 * database; a function sends its rewrite of the statement instead, which the database rejects with a real SQLSTATE
 * (and which aborts an open transaction). The first `skip` matching statements run untouched. Returns how many failed
 * and a restore.
 */
function failStatements(engine: BrainEngine, marker: string, times: number, fail: Fail, skip = 0) {
  const original = engine.executeRaw as (...a: unknown[]) => Promise<unknown[]>;
  const state = { skip, left: times, failed: 0 };
  engine.executeRaw = async function (this: BrainEngine, sql: string, params?: unknown[], opts?: unknown) {
    if (sql.includes(marker) && state.skip > 0) state.skip--;
    else if (state.left > 0 && sql.includes(marker)) {
      state.left--;
      state.failed++;
      if (typeof fail === 'string') throw Object.assign(new Error('injected failure ' + fail), { code: fail });
      return original.call(this, fail(sql), params, opts);
    }
    return original.call(this, sql, params, opts);
  } as BrainEngine['executeRaw'];
  return { state, restore: () => { delete (engine as { executeRaw?: unknown }).executeRaw; } };
}

async function withFailures<T>(engine: BrainEngine, marker: string, times: number, fail: Fail, fn: () => Promise<T>, skip = 0): Promise<{ value: T; failed: number }> {
  const injected = failStatements(engine, marker, times, fail, skip);
  try {
    return { value: await fn(), failed: injected.state.failed };
  } finally {
    injected.restore();
  }
}

function vectorFor(text: string): number[] {
  const v = new Array<number>(DIMS).fill(0);
  for (const w of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    let h = 0;
    for (const ch of w) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    v[h % DIMS] += 1;
  }
  const n = Math.hypot(...v) || 1;
  return v.map(x => x / n);
}

interface Brain { engine: BrainEngine; databaseUrl?: string; close: () => Promise<void> }

const note = (title: string, fm: string[], body = 'Written by the group bot.') => ['---', 'type: note', 'title: ' + title, ...fm, '---', '# ' + title, '', body].join('\n');

async function cli(engine: BrainEngine, args: string[]): Promise<void> {
  const spy = spyOn(console, 'log').mockImplementation(() => {});
  try { await runAccess(engine, [...args, '--json']); } finally { spy.mockRestore(); }
}

const provider = (engine: BrainEngine) => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });

async function mint(engine: BrainEngine, name: string, member?: string): Promise<{ token: string; id: string }> {
  const minted = await mintLegacyToken(engine, { name, scopes: ['read', 'write'], takesHolders: ['world'], sourceGrant: [SRC] });
  if (member) await bindCredential(engine, { kind: 'token', id: minted.id }, { member });
  return { token: minted.token, id: minted.id };
}

function shape(out: { content: Array<{ text: string }>; isError?: boolean }) {
  const text = out.content.map(c => c.text).join('\n');
  let json: Record<string, any> = {};
  try { json = JSON.parse(text); } catch { /* prose */ }
  return { isError: out.isError === true, text, json };
}

const verify = async (engine: BrainEngine, token: string) => await provider(engine).verifyAccessToken(token) as unknown as AuthInfo;

/**
 * One remote MCP call as a token, verified per call as serve --http does (or already verified, so an injected failure
 * reaches only the call); `lookup` drops the verifier's join so the identity is looked up from the principal.
 */
async function call(engine: BrainEngine, credential: string | AuthInfo, op: string, params: Record<string, unknown>, lookup = false) {
  const verified = typeof credential === 'string' ? await verify(engine, credential) : credential;
  const auth = lookup ? { ...verified, member: undefined } : verified;
  return shape(await dispatchToolCall(engine, op, params, { remote: true, transport: 'http', auth, sourceId: SRC, takesHoldersAllowList: ['world'], inboundFrameBytes: 4 * MiB }));
}

async function stdioCall(engine: BrainEngine, member: string, op: string, params: Record<string, unknown>) {
  return shape(await dispatchToolCall(engine, op, params, { remote: true, transport: 'stdio', stdioMember: member, sourceId: SRC, takesHoldersAllowList: ['world'], inboundFrameBytes: 4 * MiB }));
}

async function revision(engine: BrainEngine, slug: string): Promise<string> {
  const out = await dispatchToolCall(engine, 'get_page', { slug, include_content: true }, { remote: false, sourceId: SRC });
  return (JSON.parse(out.content.map(c => c.text).join('\n')) as { revision: string }).revision;
}

const pageRows = async (engine: BrainEngine, slug: string) => engine.executeRaw<{ compiled_truth: string }>('SELECT compiled_truth FROM pages WHERE source_id = $1 AND slug = $2 AND deleted_at IS NULL', [SRC, slug]);
const authorityFor = (tokenId: string): WriteAuthority => ({ version: 1, principal: { kind: 'legacy_token', id: tokenId }, remote: true, excludePrivate: true, sourceId: SRC,
  sourceIncarnation: 'unused', scopes: ['read', 'write'], operations: null, slugPrefixes: null } as WriteAuthority);
const outcome = (p: Promise<unknown>) => p.then(() => 'pass', (e: { code?: string }) => String(e?.code ?? e));

describe('liveIdentity fails closed: the error code', () => {
  test('access_identity_unavailable is registered as retryable', () => {
    expect(codeClass('access_identity_unavailable')).toBe('retryable');
    expect(codeRetryable('access_identity_unavailable')).toBe(true);
  });
});

for (const kind of testBackends()) {
  describe('labelled-only grant fails closed (' + kind + ')', () => {
    const brains: Brain[] = [];
    let engine: BrainEngine;
    let unrestricted: Brain;
    let twoServes: Brain | null = null;
    const bot = { token: '', id: '' };
    const unbound = { token: '', id: '' };
    const owner = { token: '', id: '' };

    beforeAll(async () => {
      configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'test' } });
      __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(vectorFor) })) as never);
      /** A fresh brain with source SRC and no member: the shared one, one that serves unrestricted requests first (Q1(a)), and on Postgres one for two serve processes (Q1(c)). */
      const open = async (): Promise<Brain> => {
        let brain: Brain;
        if (kind === 'postgres') {
          const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
          brain = { engine: pg.engine, databaseUrl: pg.databaseUrl, close: pg.close };
        } else {
          const pglite = new PGLiteEngine();
          await pglite.connect({ engine: 'pglite' } as never);
          await pglite.initSchema();
          brain = { engine: pglite, close: () => pglite.disconnect() };
        }
        brains.push(brain);
        await brain.engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [SRC]);
        return brain;
      };
      engine = (await open()).engine;
      unrestricted = await open();
      if (kind === 'postgres') twoServes = await open();
      await cli(engine, ['member', 'add', OWNER]);
      await cli(engine, ['member', 'add', BOT, '--groups', 'team-a']);
      await cli(engine, ['member', 'add', WRITER]);
      await setOwner(engine, OWNER);
      await importFromContent(engine, OPEN, note('Open example', [], 'Harbor ledger planning notes ' + OPEN_CANARY + ' here.'), { sourceId: SRC });
      await importFromContent(engine, LABELLED, note('Labelled example', ['readable_by: [group:team-a]'], 'Harbor ledger planning notes ' + LABELLED_CANARY + ' here.'), { sourceId: SRC });
      Object.assign(bot, await mint(engine, 'bot-writer', BOT));
      Object.assign(unbound, await mint(engine, 'unbound-writer'));
      await readsUnscopedOnPurpose(engine, unbound.id);
      Object.assign(owner, await mint(engine, 'owner-writer', OWNER));
      await cli(engine, ['member', 'labelled-only', BOT, 'on']);
    }, SETUP_MS);
    afterAll(async () => {
      for (const brain of brains) await brain.close();
      resetGateway();
    }, SETUP_MS);

    test('fix 1 red-first: a labelled-only credential whose identity lookup fails twice never reads an unlabelled page as a guest (get_page, list_pages, search; principal lookup and stdio binding)', async () => {
      expect((await call(engine, bot.token, 'get_page', { slug: OPEN }, true)).json.code).toBe('page_not_found');
      expect((await call(engine, bot.token, 'get_page', { slug: LABELLED }, true)).text).toContain(LABELLED_CANARY);
      const auth = await verify(engine, bot.token);
      const reads: Array<[string, () => Promise<ReturnType<typeof shape>>]> = [
        ['get_page', () => call(engine, auth, 'get_page', { slug: OPEN }, true)],
        ['list_pages', () => call(engine, auth, 'list_pages', { limit: 100 }, true)],
        ['search', () => call(engine, auth, 'search', { query: 'harbor ledger planning notes', match: 'keyword', autocut: false, limit: 100 }, true)],
        ['stdio get_page', () => stdioCall(engine, BOT, 'get_page', { slug: OPEN })],
      ];
      for (const [label, read] of reads) {
        const { value, failed } = await withFailures(engine, MEMBER_LOOKUP, LOOKUP_FAILURES, FAULT, read);
        expect({ label, failed: failed > 0 }).toEqual({ label, failed: true });
        expect({ label, leaked: value.text.includes(OPEN_CANARY) || value.text.includes('"' + OPEN + '"') }).toEqual({ label, leaked: false });
        expect({ label, isError: value.isError, code: value.json.code }).toEqual({ label, isError: true, code: 'access_identity_unavailable' });
      }
      const refused = (await withFailures(engine, MEMBER_LOOKUP, LOOKUP_FAILURES, FAULT, () => call(engine, auth, 'get_page', { slug: OPEN }, true))).value.json;
      expect(refused).toMatchObject({ retryable: true, class: 'retryable', fix: { next: 'wait' } });
      expect(refused.why).toBeString();
    }, SLOW_MS);

    test('fix 1 red-first: a labelled-only credential whose identity lookup fails twice can neither create nor update an unlabelled page as a guest (put_page and the stored-write checks)', async () => {
      const before = (await pageRows(engine, OPEN))[0]!.compiled_truth;
      const checks: Array<[string, () => Promise<unknown>]> = [
        ['update check', () => authorizePageVisibility(engine, authorityFor(bot.id), OPEN)],
        ['create check', () => assertLabelledOnlyCreate(engine, authorityFor(bot.id), 'notes/fc-direct-new', null, {})],
      ];
      for (const [label, check] of checks) {
        const { value, failed } = await withFailures(engine, MEMBER_LOOKUP, LOOKUP_FAILURES, FAULT, () => outcome(check()));
        expect({ label, failed: failed > 0, outcome: value }).toEqual({ label, failed: true, outcome: 'access_identity_unavailable' });
      }
      const auth = await verify(engine, bot.token);
      const puts: Array<[string, string, number, Record<string, unknown>]> = [
        ['put_page update, two failures', OPEN, LOOKUP_FAILURES, { expected_revision: await revision(engine, OPEN) }],
        ['put_page update, every lookup fails', OPEN, REQUEST_OUTAGE, { expected_revision: await revision(engine, OPEN) }],
        ['put_page create, two failures', 'notes/fc-put-new', LOOKUP_FAILURES, {}],
        ['put_page create, every lookup fails', 'notes/fc-put-new', REQUEST_OUTAGE, {}],
      ];
      for (const [label, slug, times, extra] of puts) {
        const { value, failed } = await withFailures(engine, MEMBER_LOOKUP, times, FAULT,
          () => call(engine, auth, 'put_page', { slug, content: note('Bot rewrite', []), ...extra }));
        expect({ label, failed: failed > 0, isError: value.isError }).toEqual({ label, failed: true, isError: true });
        expect({ label, code: value.json.code === 'revision_required' ? 'leaks the hidden page' : 'ok' }).toEqual({ label, code: 'ok' });
      }
      expect((await pageRows(engine, OPEN))[0]!.compiled_truth).toBe(before);
      expect(await pageRows(engine, 'notes/fc-put-new')).toEqual([]);
    }, SLOW_MS);

    test('fix 1: a lookup missing access_members, access_group_members or member_id (a schema older than the member tables) still reads as unbound; a transient failure is rethrown unchanged; any other failure throws access_identity_unavailable', async () => {
      const principal = { principal: { kind: 'legacy_token', id: bot.id } };
      expect(await memberIdentityFor(engine, principal)).toContain('member:' + BOT);
      const missing: Array<[string, (sql: string) => string]> = [
        ['42P01', sql => sql.replace('FROM access_members m', 'FROM pg_temp.access_members m')],
        ['42703', sql => sql.replace('SELECT member_id FROM access_tokens', 'SELECT t.member_id FROM (SELECT id, revoked_at FROM access_tokens) t')],
      ];
      for (const [state, rewrite] of missing) {
        const { value, failed } = await withFailures(engine, MEMBER_LOOKUP, LOOKUP_FAILURES, rewrite, () => memberIdentityFor(engine, principal));
        expect({ state, failed, identity: value }).toEqual({ state, failed: 1, identity: [] });
      }
      const otherObjects: Array<[string, (sql: string) => string]> = [
        ['42P01', sql => sql.replace('FROM access_members m', 'FROM access_members_absent m')],
        ['42703', sql => sql.replace('m.disabled_at IS NULL', 'm.disabled_at_absent IS NULL')],
      ];
      for (const [state, rewrite] of otherObjects) {
        const { value, failed } = await withFailures(engine, MEMBER_LOOKUP, LOOKUP_FAILURES, rewrite, () => outcome(memberIdentityFor(engine, principal)));
        expect({ state, failed, outcome: value }).toEqual({ state, failed: 1, outcome: 'access_identity_unavailable' });
      }
      for (const state of [DROPPED, LOCK_TIMEOUT]) {
        expect({ state, outcome: (await withFailures(engine, MEMBER_LOOKUP, LOOKUP_FAILURES, state, () => outcome(memberIdentityFor(engine, principal)))).value }).toEqual({ state, outcome: state });
      }
      expect((await withFailures(engine, MEMBER_LOOKUP, LOOKUP_FAILURES, FAULT, () => outcome(memberIdentityFor(engine, principal)))).value).toBe('access_identity_unavailable');
      expect((await withFailures(engine, MEMBER_LOOKUP, LOOKUP_FAILURES, FAULT, () => outcome(stdioMemberIdentity(engine, BOT)))).value).toBe('access_identity_unavailable');
      expect(await memberIdentityFor(engine, { principal: { kind: 'legacy_token', id: unbound.id } })).toEqual([]);
      expect(await stdioMemberIdentity(engine)).toEqual([]);
    }, SLOW_MS);

    test('fix 1 (transient): an owner put_page whose stored-write lookup meets one lock timeout is released and retried, and commits', async () => {
      const auth = await verify(engine, owner.token);
      const { value, failed } = await withFailures(engine, MEMBER_LOOKUP, ONE_FAILURE, LOCK_TIMEOUT,
        () => call(engine, auth, 'put_page', { slug: OWNER_SLUG, content: note('Owner lock example', [], 'Owner note ' + OWNER_CANARY + ' here.') }), SUBMISSION_LOOKUPS);
      expect({ failed, isError: value.isError, code: value.json.code ?? null }).toEqual({ failed: ONE_FAILURE, isError: false, code: null });
      expect((await pageRows(engine, OWNER_SLUG))[0]?.compiled_truth).toContain(OWNER_CANARY);
    }, SLOW_MS);

    test('fix 1 red-first (submission): an owner put_page whose submission lookup meets one lock timeout gets the retryable access_identity_unavailable, writes nothing, and commits when sent again with the same request_id', async () => {
      const auth = await verify(engine, owner.token);
      const params = { slug: SUBMIT_SLUG, content: note('Owner submit example', [], 'Owner note ' + SUBMIT_CANARY + ' here.'), request_id: SUBMIT_REQUEST };
      const { value, failed } = await withFailures(engine, MEMBER_LOOKUP, ONE_FAILURE, LOCK_TIMEOUT, () => call(engine, auth, 'put_page', params));
      expect({ failed, isError: value.isError, code: value.json.code, retryable: value.json.retryable, next: value.json.fix?.next })
        .toEqual({ failed: ONE_FAILURE, isError: true, code: 'access_identity_unavailable', retryable: true, next: 'wait' });
      expect(await pageRows(engine, SUBMIT_SLUG)).toEqual([]);
      const again = await call(engine, auth, 'put_page', params);
      expect({ isError: again.isError, code: again.json.code ?? null }).toEqual({ isError: false, code: null });
      expect((await pageRows(engine, SUBMIT_SLUG))[0]?.compiled_truth).toContain(SUBMIT_CANARY);
    }, SLOW_MS);

    test('fix 1 red-first (stored audience and attested actor): a write for a labelled-only member stays labelled-only when re-resolving who it writes for fails', async () => {
      const agent = await mint(engine, 'audience-agent');
      await bindCredential(engine, { kind: 'token', id: agent.id }, { mayActFor: ['member:' + BOT] });
      const attest = await mint(engine, 'attest-agent');
      await bindCredential(engine, { kind: 'token', id: attest.id }, { attestActor: 'qm' });
      await linkMember(engine, BOT, 'qm', BOT_EXTERNAL_ID);
      const healthy = { update: 'page_not_found', create: 'access_labelled_only_unnamed' };
      const writers: Array<[string, WriteAuthority, string, typeof healthy | Record<string, string>]> = [
        ['audience', { ...authorityFor(agent.id), actingFor: ['member:' + BOT] } as WriteAuthority, AUDIENCE_LOOKUP, healthy],
        ['attested', { ...authorityFor(attest.id), actingFor: { system: 'qm', external_id: BOT_EXTERNAL_ID, member: BOT } } as WriteAuthority, ACTOR_LOOKUP, { update: DROPPED, create: DROPPED }],
      ];
      const seen: Record<string, unknown> = {};
      const expected: Record<string, unknown> = {};
      for (const [who, authority, marker, failing] of writers) {
        const checks = async () => ({ update: await outcome(authorizePageVisibility(engine, authority, OPEN)),
          create: await outcome(assertLabelledOnlyCreate(engine, authority, 'notes/fc-stored-new', null, {})) });
        const healthyRun = await checks();
        const { value, failed } = await withFailures(engine, marker, REQUEST_OUTAGE, DROPPED, checks);
        seen[who] = { healthy: healthyRun, failed: failed > 0, failing: value };
        expected[who] = { healthy, failed: true, failing };
      }
      expect(seen).toEqual(expected);
      expect(await pageRows(engine, 'notes/fc-stored-new')).toEqual([]);
    }, SLOW_MS);

    test('fix 1 (R94): with lookups working, the owner credential and an unbound credential read as before', async () => {
      expect((await call(engine, owner.token, 'get_page', { slug: OPEN }, true)).text).toContain(OPEN_CANARY);
      expect((await call(engine, unbound.token, 'get_page', { slug: OPEN }, true)).text).toContain(OPEN_CANARY);
      expect((await call(engine, unbound.token, 'get_page', { slug: LABELLED }, true)).json.code).toBe('page_not_found');
      expect(await memberIdentityFor(engine, { principal: { kind: 'legacy_token', id: owner.id } })).toEqual(['member:' + OWNER]);
    }, SLOW_MS);

    test('Q1(b): the grant set on an existing member after it has written refuses its next unnamed create', async () => {
      const writer = await mint(engine, 'q1b-writer', WRITER);
      expect((await call(engine, writer.token, 'put_page', { slug: 'notes/q1b-first', content: note('First', []) })).isError).toBe(false);
      await cli(engine, ['member', 'labelled-only', WRITER, 'on']);
      try {
        const refused = await call(engine, writer.token, 'put_page', { slug: 'notes/q1b-second', content: note('Second', []) });
        expect(refused.json.code).toBe('access_labelled_only_unnamed');
        expect(await pageRows(engine, 'notes/q1b-second')).toEqual([]);
      } finally {
        await cli(engine, ['member', 'labelled-only', WRITER, 'off']);
      }
    }, SLOW_MS);

    test('Q1(flag): with access.restrictions_present deleted by hand while a labelled-only member exists, its unnamed create is still refused', async () => {
      const [flag] = await engine.executeRaw<{ value: string }>('SELECT value FROM config WHERE key = $1', [ACCESS_RESTRICTIONS_KEY]);
      expect(flag?.value).toBe('1');
      await engine.executeRaw('DELETE FROM config WHERE key = $1', [ACCESS_RESTRICTIONS_KEY]);
      try {
        const refused = await call(engine, bot.token, 'put_page', { slug: 'notes/q1flag-new', content: note('Flag', []) });
        expect(refused.json.code).toBe('access_labelled_only_unnamed');
        expect(await pageRows(engine, 'notes/q1flag-new')).toEqual([]);
      } finally {
        await engine.executeRaw("INSERT INTO config (key, value) VALUES ($1, '1') ON CONFLICT (key) DO UPDATE SET value = '1'", [ACCESS_RESTRICTIONS_KEY]);
      }
    }, SLOW_MS);

    test('Q2 inside a transaction: a combined probe that fails aborts it, so the write check errors and never passes (labelled-only and unbound writers; open, labelled and missing pages)', async () => {
      for (const [who, id] of [['labelled-only', bot.id], ['unbound', unbound.id]] as const) {
        for (const slug of [OPEN, LABELLED, MISSING]) {
          const { value, failed } = await withFailures(engine, COMBINED_PROBE, PROBE_FAILURES, () => FAILING_STATEMENT,
            () => outcome(engine.transaction(tx => authorizePageVisibility(tx, authorityFor(id), slug))));
          expect({ who, slug, failed, passed: value === 'pass' }).toEqual({ who, slug, failed: PROBE_FAILURES, passed: false });
        }
      }
    }, SLOW_MS);

    test('Q2 outside a transaction: a combined probe that fails counts as labelled-only; the labelled-only writer is refused the unlabelled page and allowed the page naming it, and an unbound writer is unaffected', async () => {
      const checks = async (id: string) => ({ open: await outcome(authorizePageVisibility(engine, authorityFor(id), OPEN)),
        labelled: await outcome(authorizePageVisibility(engine, authorityFor(id), LABELLED)), missing: await outcome(authorizePageVisibility(engine, authorityFor(id), MISSING)) });
      const probeFails = (id: string) => withFailures(engine, COMBINED_PROBE, PROBE_FAILURES, () => FAILING_STATEMENT, () => checks(id));
      expect(await probeFails(bot.id)).toEqual({ failed: PROBE_FAILURES, value: { open: 'page_not_found', labelled: 'pass', missing: 'pass' } });
      const unboundBaseline = await checks(unbound.id);
      expect(unboundBaseline).toEqual({ open: 'pass', labelled: 'page_not_found', missing: 'pass' });
      expect(await probeFails(unbound.id)).toEqual({ failed: PROBE_FAILURES, value: unboundBaseline });
    }, SLOW_MS);

    test('Q1(a): on one long-lived engine, after an unrestricted remote write, the first member added with the grant and bound to a credential has its unnamed create refused', async () => {
      const fresh = unrestricted.engine;
      const writer = await mint(fresh, 'q1a-writer');
      expect((await call(fresh, writer.token, 'put_page', { slug: 'notes/q1a-open', content: note('Open', []) })).isError).toBe(false);
      expect(await fresh.executeRaw('SELECT 1 FROM config WHERE key = $1', [ACCESS_RESTRICTIONS_KEY])).toEqual([]);
      await cli(fresh, ['member', 'add', BOT]);
      await cli(fresh, ['member', 'labelled-only', BOT, 'on']);
      await bindCredential(fresh, { kind: 'token', id: writer.id }, { member: BOT });
      const refused = await call(fresh, writer.token, 'put_page', { slug: 'notes/q1a-new', content: note('New', []) });
      expect(refused.json.code).toBe('access_labelled_only_unnamed');
      expect(await pageRows(fresh, 'notes/q1a-new')).toEqual([]);
    }, SLOW_MS);

    // PGLite holds an exclusive lock on its data directory (src/core/pglite-engine.ts acquires it before every open), so
    // a second serve process cannot open the same PGLite brain; two serve processes on one brain exist only on Postgres.
    test.skipIf(kind === 'pglite')('Q1(c): a second serve process (its own engine and pool on the same database) that served the brain unrestricted refuses the unnamed create of a member granted through the first', async () => {
      const second = new PostgresEngine();
      try {
        await second.connect({ database_url: twoServes!.databaseUrl!, poolSize: SECOND_POOL } as never);
        const first = twoServes!.engine;
        const writer = await mint(first, 'q1c-writer');
        expect((await call(second, writer.token, 'put_page', { slug: 'notes/q1c-open', content: note('Open', []) })).isError).toBe(false);
        await cli(first, ['member', 'add', LATE]);
        await cli(first, ['member', 'labelled-only', LATE, 'on']);
        await bindCredential(first, { kind: 'token', id: writer.id }, { member: LATE });
        const refused = await call(second, writer.token, 'put_page', { slug: 'notes/q1c-new', content: note('New', []) });
        expect(refused.json.code).toBe('access_labelled_only_unnamed');
        expect(await pageRows(first, 'notes/q1c-new')).toEqual([]);
      } finally {
        await second.disconnect();
      }
    }, SLOW_MS);
  });
}
