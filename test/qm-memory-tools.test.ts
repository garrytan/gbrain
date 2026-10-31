/**
 * GST-359 D: QM's memory provider pair, memory_recall and memory_write.
 *
 * 1. Protects: memory_write saves 1-20 facts through remember's persistence path onto the attested member's own page
 *    (readable by that member alone, private rows, provenance qm:<actor id>; <caller's>), only for an attested person,
 *    with request ids from uuidv5(member, idempotency_key): a replay returns the original receipt, the same key from
 *    two members is two writes, and a write still publishing answers pending with a pollable request_id.
 *    memory_recall answers the person's own recent facts first, then the facts they may read ranked by the query,
 *    one plain line per fact (fence and heading markers stripped, never page bodies), cut at a line boundary with a
 *    final "… N more" line and never longer than max_chars (200-12000, default 6000). Success codes ride
 *    structuredContent only; an unlinked actor gets an empty success with code actor_unlinked.
 * 2. Fails when: a member write lands on a shared page or as a world row, a key replays across members, a write runs
 *    without an attested person, recall leaks another member's fact or a page body, own recent facts do not lead,
 *    the text exceeds max_chars or is cut inside a line, the unlinked answer is an error, or a keyless brain embeds.
 * 3. Existing coverage: test/access-qm-actor.test.ts (C1) pins the actor; test/access-member-facts.test.ts (C2) pins
 *    member facts through remember and recall. This file pins the two QM tools on top of them.
 * 4. Real seams: OAuth clients issued tokens by the provider's client-credentials grant, verified by the provider,
 *    dispatched through MCP dispatch on a repo-less brain; writes go through the persistence coordinator; embeddings
 *    stubbed (and absent for the keyless case).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { dispatchToolCall, type ToolResult } from '../src/mcp/dispatch.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { __resetHotMemoryCacheForTests, getBrainHotMemoryMeta } from '../src/core/facts/meta-hook.ts';
import { addMember, bindCredential } from '../src/core/access/members.ts';
import { attestRightOf, linkedMember, linkMember } from '../src/core/access/actor.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { boundFactLines, memoryWriteRequestId, plainFactText, MEMORY_RECALL_MAX_CHARS } from '../src/core/ops/qm-memory.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const DIMS = 1536;
const TICKS = String.fromCharCode(96).repeat(3);
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
const keyedEmbeddings = (onCall?: () => void) => {
  configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'test' } });
  __setEmbedTransportForTests((async ({ values }: { values: string[] }) => { onCall?.(); return { embeddings: values.map(vectorFor) }; }) as never);
};

describe('memory_recall text bounds (pure)', () => {
  const lines = Array.from({ length: 40 }, (_, i) => '- fact number ' + i + ' about the harbor ledger (2026-10-30; fact)');

  test('whole lines, then one "… N more" line, never past the cap, at every cap from the minimum up', () => {
    for (let max = MEMORY_RECALL_MAX_CHARS.min; max < lines.join('\n').length; max += 7) {
      const { kept, text } = boundFactLines(lines, max);
      expect(text.length).toBeLessThanOrEqual(max);
      const out = text.split('\n');
      expect(out.slice(0, kept)).toEqual(lines.slice(0, kept));
      expect(kept).toBeLessThan(lines.length);
      expect(out).toHaveLength(kept + 1);
      expect(out[kept]).toBe('… ' + (lines.length - kept) + ' more');
      const oneMore = lines.slice(0, kept + 1).join('\n') + '\n… ' + (lines.length - kept - 1) + ' more';
      expect(oneMore.length).toBeGreaterThan(max);
    }
  });

  test('a list that fits is returned whole with no tail; an empty list is empty text', () => {
    expect(boundFactLines(lines.slice(0, 3), 6000)).toEqual({ kept: 3, text: lines.slice(0, 3).join('\n') });
    expect(boundFactLines([], 200)).toEqual({ kept: 0, text: '' });
    expect(boundFactLines(['x'.repeat(500)], 200)).toEqual({ kept: 0, text: '… 1 more' });
  });

  test('fence, heading and rule markers are stripped and the fact is one line', () => {
    expect(plainFactText('## Plan\n' + TICKS + 'ts\nharbor ledger\n' + TICKS + '\n---\n~~~ next ~~~')).toBe('Plan ts harbor ledger next');
    expect(plainFactText('#1 priority is the harbor')).toBe('#1 priority is the harbor');
  });

  test('a database failure while re-resolving a stored actor is rethrown, never read as unlinked or as no attest right', async () => {
    const failing = (code: string, message: string) => ({ executeRaw: async () => { throw Object.assign(new Error(message), { code }); } }) as never;
    const principal = { principal: { kind: 'oauth_client', id: 'c1' } } as never;
    for (const [code, message] of [['25P02', 'current transaction is aborted, commands ignored until end of transaction block'], ['55P03', 'canceling statement due to lock timeout']]) {
      await expect(linkedMember(failing(code, message), 'qm', ALICE_ID)).rejects.toThrow(message);
      await expect(attestRightOf(failing(code, message), principal)).rejects.toThrow(message);
    }
    expect(await linkedMember(failing('42P01', 'relation "access_member_links" does not exist'), 'qm', ALICE_ID)).toBeNull();
    expect(await attestRightOf(failing('42703', 'column "attest_actor" does not exist'), principal)).toBeNull();
  });

  test('request ids are uuidv5 per member: one key gives different ids to two members and the same id on replay', async () => {
    const a = await memoryWriteRequestId('alice-example', 'key-1', 0);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(await memoryWriteRequestId('alice-example', 'key-1', 0)).toBe(a);
    expect(await memoryWriteRequestId('bob-example', 'key-1', 0)).not.toBe(a);
    expect(await memoryWriteRequestId('alice-example', 'key-1', 1)).not.toBe(a);
  });
});

const SRC = 'qm-memory';
const ALICE_ID = 'U0ALICE';
const BOB_ID = 'oidc:3f2a:bob-example';
const CAROL_ID = 'carol-example@acme.test';
const DAVE_ID = 'U0DAVE';
const ACME = 'companies/acme-example';
const ATTEST_OPS = ['forget', 'forget_fact', 'get_write_request', 'memory_recall', 'memory_write', 'remember'];

for (const kind of testBackends()) {
  describe('memory_recall and memory_write (' + kind + ', repo-less)', () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
    const tokens: Record<string, string> = {};
    const verify = async (bearer: string) => await provider().verifyAccessToken(bearer) as unknown as AuthInfo;
    type Who = { token: string; actor?: string };
    const alice: Who = { token: 'qm', actor: ALICE_ID };
    const bob: Who = { token: 'qm', actor: BOB_ID };
    const carol: Who = { token: 'qm', actor: CAROL_ID };

    async function call(as: Who, op: string, params: Record<string, unknown>, extra: { writeWaitMs?: number } = {}) {
      const out: ToolResult = await dispatchToolCall(engine, op, { ...params }, {
        remote: true, transport: 'http', auth: await verify(tokens[as.token]!), sourceId: SRC, takesHoldersAllowList: ['world'],
        ...(as.actor !== undefined ? { actor: { header: as.actor } } : {}), ...extra,
        metaHook: (name, ctx) => getBrainHotMemoryMeta(name, ctx),
      });
      const text = out.content.map(c => c.text).join('\n');
      let json: Record<string, any> = {};
      try { json = JSON.parse(text); } catch { /* plain text */ }
      return { out, isError: out.isError === true, text, json, structured: out.structuredContent as Record<string, any> | undefined,
        all: text + JSON.stringify(out._meta ?? {}) + JSON.stringify(out.structuredContent ?? {}) };
    }
    const write = (as: Who, facts: Array<Record<string, unknown>>, key: string = randomUUID(), extra: { writeWaitMs?: number } = { writeWaitMs: 30_000 }) =>
      call(as, 'memory_write', { facts, idempotency_key: key }, extra);
    const recall = (as: Who, query: string, args: Record<string, unknown> = {}) => call(as, 'memory_recall', { query, ...args });
    const factRows = (needle: string) => engine.executeRaw<Record<string, any>>(
      'SELECT id, visibility, source_markdown_slug, source FROM facts WHERE source_id = $1 AND fact LIKE $2 ORDER BY id', [SRC, '%' + needle + '%']);

    beforeAll(async () => {
      keyedEmbeddings();
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      __resetPrivateVisibilityCacheForTests();
      __resetHotMemoryCacheForTests();
      await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [SRC]);
      for (const id of ['alice-example', 'bob-example', 'carol-example', 'dave-example']) await addMember(engine, id);
      await importFromContent(engine, ACME, '---\ntype: company\ntitle: Acme Example\n---\n# Acme Example\n\nAcme example harbor ledger canarypagebody budget notes.', { sourceId: SRC });
      const register = async (name: string) => {
        const c = await provider().registerClientManual('d-' + name + '-' + randomUUID().slice(0, 8), ['client_credentials'], 'read write', [], SRC);
        return { id: c.clientId, secret: c.clientSecret ?? '' };
      };
      const qm = await register('qm');
      await bindCredential(engine, { kind: 'client', id: qm.id }, { attestActor: 'qm', attestOps: ATTEST_OPS });
      const bobKey = await register('bob');
      await bindCredential(engine, { kind: 'client', id: bobKey.id }, { member: 'bob-example' });
      const plain = await register('plain');
      for (const [name, c] of [['qm', qm], ['bob', bobKey], ['plain', plain]] as const) tokens[name] = (await provider().exchangeClientCredentials(c.id, c.secret)).access_token;
      await linkMember(engine, 'alice-example', 'qm', ALICE_ID);
      await linkMember(engine, 'bob-example', 'qm', BOB_ID);
      await linkMember(engine, 'carol-example', 'qm', CAROL_ID);
      await linkMember(engine, 'dave-example', 'qm', DAVE_ID);
    }, 120_000);

    afterAll(async () => {
      __setEmbedTransportForTests(null);
      resetGateway();
      await disposePersistenceConsumer(engine).catch(() => undefined);
      await close?.();
    });

    test('a committed write lands private on the member page, readable by that member alone, with qm provenance', async () => {
      const key = randomUUID();
      const out = await write(alice, [{ fact: 'Alice keeps the harbor ledger canarywritealice', provenance: 'slack:C0123/p1', kind: 'preference' }], key);
      expect(out.isError).toBe(false);
      expect(out.structured).toEqual({ status: 'committed', request_id: await memoryWriteRequestId('alice-example', key, 0), fact_ids: [expect.any(String)] });
      expect(out.out.content).toEqual([{ type: 'text', text: 'Saved 1 fact(s).' }]);
      const [row] = await factRows('canarywritealice');
      expect(row).toMatchObject({ visibility: 'private', source_markdown_slug: 'memory/members/alice-example' });
      expect(String(row!.id)).toBe(out.structured!.fact_ids[0]);
      expect(String(row!.source)).toContain('qm:' + ALICE_ID + '; slack:C0123/p1');
      const [page] = await engine.executeRaw<{ page_readers: string[] }>('SELECT page_readers FROM pages WHERE source_id = $1 AND slug = $2', [SRC, 'memory/members/alice-example']);
      expect(page!.page_readers).toEqual(['member:alice-example']);
      expect(out.out._meta?.brain_hot_memory).toBeUndefined();
    }, 60_000);

    test('a replayed key returns the original receipt and writes nothing twice; other facts under it are refused', async () => {
      const key = 'qm-replay-' + randomUUID();
      const facts = [{ fact: 'Alice prefers oolong canaryreplay one', provenance: 'turn 1' }, { fact: 'Alice walks the pier canaryreplay two', provenance: 'turn 1' }];
      const first = await write(alice, facts, key);
      expect(first.structured).toMatchObject({ status: 'committed', request_id: await memoryWriteRequestId('alice-example', key, 0) });
      expect(first.structured!.fact_ids).toHaveLength(2);
      const again = await write(alice, facts, key);
      expect(again.structured).toEqual(first.structured);
      expect(await factRows('canaryreplay')).toHaveLength(2);
      const changed = await write(alice, [{ fact: 'Alice prefers sencha canaryreplay three', provenance: 'turn 1' }], key);
      expect(changed.isError).toBe(true);
      expect({ code: changed.json.code, write_error: changed.json.write_error }).toEqual({ code: 'invalid_params', write_error: 'idempotency_conflict' });
      expect(await factRows('canaryreplay three')).toHaveLength(0);
    }, 60_000);

    test('the same key from two members is two writes, each on its own page', async () => {
      const key = 'qm-shared-' + randomUUID();
      const a = await write(alice, [{ fact: 'Shared turn note canarysamekey', provenance: 'turn 7' }], key);
      const b = await write(bob, [{ fact: 'Shared turn note canarysamekey', provenance: 'turn 7' }], key);
      expect(a.structured!.status).toBe('committed');
      expect(b.structured!.status).toBe('committed');
      expect(b.structured!.request_id).not.toBe(a.structured!.request_id);
      expect(b.structured!.fact_ids).not.toEqual(a.structured!.fact_ids);
      const rows = await factRows('canarysamekey');
      expect(rows.map(r => r.source_markdown_slug).sort()).toEqual(['memory/members/alice-example', 'memory/members/bob-example']);
    }, 60_000);

    test('a write is refused without an attested person, and an unlinked person writes nothing', async () => {
      const cases: Array<[Who, Record<string, unknown>, string, string | undefined]> = [
        [{ token: 'qm' }, {}, 'actor_not_attested', 'actor_required'],
        [{ token: 'bob' }, {}, 'actor_not_attested', 'actor_required'],
        [{ token: 'plain' }, {}, 'actor_not_attested', 'actor_required'],
        [{ token: 'plain', actor: ALICE_ID }, {}, 'actor_not_attested', 'no_attest_right'],
        [{ token: 'qm' }, { acting_user: ALICE_ID }, 'actor_not_attested', 'argument_without_attestation'],
        [alice, { acting_user: BOB_ID }, 'actor_not_attested', 'argument_mismatch'],
        [{ token: 'qm', actor: 'U0NOBODY' }, {}, 'actor_unlinked', undefined],
      ];
      for (const [as, extra, code, reason] of cases) {
        const out = await call(as, 'memory_write', { facts: [{ fact: 'Refused write canaryrefused', provenance: 'x' }], idempotency_key: randomUUID(), ...extra });
        expect({ isError: out.isError, code: out.json.code, reason: out.json.reason }).toEqual({ isError: true, code, reason });
        expect(out.structured?.error).toMatchObject({ code, ...(reason ? { reason } : {}) });
      }
      expect(await factRows('canaryrefused')).toHaveLength(0);
      const named = await call(alice, 'memory_write', { facts: [{ fact: 'Named write canarynamed', provenance: 'x' }], idempotency_key: randomUUID(), acting_user: ALICE_ID });
      expect(named.structured!.status).toBe('committed');
    }, 60_000);

    test('a squatted member page (readers beyond its member) takes no memory_write, and its receipt is not left behind', async () => {
      const dave: Who = { token: 'qm', actor: DAVE_ID };
      const squat = '---\ntype: note\ntitle: Memory of dave-example\nreadable_by:\n  - member:bob-example\n  - member:dave-example\n---\n# Memory of dave-example\n';
      await importFromContent(engine, 'memory/members/dave-example', squat, { sourceId: SRC });
      const key = randomUUID();
      const out = await write(dave, [{ fact: 'Dave keeps the harbor ledger key canarydavesquat', provenance: 'turn 5' }], key);
      expect({ isError: out.isError, code: out.json.code, message: out.json.message }).toMatchObject({ isError: true, code: 'scope_denied', message: expect.stringContaining('does not name its member alone') });
      expect(await factRows('canarydavesquat')).toHaveLength(0);
      expect((await call(dave, 'get_write_request', { request_id: await memoryWriteRequestId('dave-example', key, 0) })).json.code).toBe('not_found');
      expect((await recall(bob, 'harbor ledger key')).all).not.toContain('canarydavesquat');
    }, 60_000);

    test('invalid facts and keys are refused before anything is saved', async () => {
      const bad: Array<Record<string, unknown>> = [
        { facts: [], idempotency_key: 'k1' },
        { facts: Array.from({ length: 21 }, (_, i) => ({ fact: 'f' + i, provenance: 'p' })), idempotency_key: 'k2' },
        { facts: [{ fact: 'ok canarybad', provenance: 'p' }, { fact: '', provenance: 'p' }], idempotency_key: 'k3' },
        { facts: [{ fact: 'ok canarybad', provenance: 'x'.repeat(201) }], idempotency_key: 'k4' },
        { facts: [{ fact: 'ok canarybad', provenance: 'p', kind: 'idea' }], idempotency_key: 'k5' },
        { facts: [{ fact: 'ok canarybad', provenance: 'p', entity: ACME }], idempotency_key: 'k6' },
        { facts: [{ fact: 'ok canarybad', provenance: 'p' }], idempotency_key: 'has space' },
        { facts: [{ fact: 'ok canarybad', provenance: 'p' }], idempotency_key: 'k'.repeat(129) },
      ];
      for (const params of bad) {
        const out = await call(alice, 'memory_write', params);
        expect(out.isError).toBe(true);
        expect(out.json.code).toBe('invalid_params');
        expect(out.structured?.error).toMatchObject({ code: 'invalid_params', message: out.json.message });
      }
      expect(await factRows('canarybad')).toHaveLength(0);
      const fits = await write(alice, [{ fact: 'Max provenance canaryfits', provenance: 'x'.repeat(200) }], 'k'.repeat(128));
      expect(fits.structured!.status).toBe('committed');
    }, 60_000);

    test('a write still publishing answers pending with a request id its receipt is read by', async () => {
      const out = await write(alice, [{ fact: 'Alice books the ferry canarypending', provenance: 'turn 9' }], randomUUID(), { writeWaitMs: 0 });
      expect(out.isError).toBe(false);
      expect(out.structured).toEqual({ status: 'pending', request_id: expect.any(String), fact_ids: [], pending_request_ids: [out.structured!.request_id] });
      expect(out.out.content).toEqual([{ type: 'text', text: 'Accepted 1 fact(s); 1 still publishing.' }]);
      const receipt = await call(alice, 'get_write_request', { request_id: out.structured!.request_id });
      expect(receipt.isError).toBe(false);
      expect(receipt.all).toContain(out.structured!.request_id);
      expect((await call(bob, 'get_write_request', { request_id: out.structured!.request_id })).isError).toBe(true);
    }, 60_000);

    test('recall leads with the person\'s own recent facts, then readable facts ranked by the query, never another member\'s or a page body', async () => {
      for (const [fact, provenance] of [['Alice moved standup to Tuesdays canaryownrecent', 'turn 2'], ['Alice owns the budget ledger review canaryownold', 'turn 0']]) {
        const saved = await write(alice, [{ fact, provenance }]);
        expect(saved.structured?.status ?? saved.text).toBe('committed');
      }
      await engine.executeRaw("UPDATE facts SET created_at = now() - interval '3 days', valid_from = now() - interval '3 days' WHERE source_id = $1 AND fact LIKE '%canaryownold%'", [SRC]);
      await write(bob, [{ fact: 'Bob audits the budget ledger canarybobonly', provenance: 'turn 3' }]);
      await engine.insertFact({ fact: 'Acme budget ledger closes in March canaryworld', kind: 'event', entity_slug: ACME, source: 'test', visibility: 'world' }, { source_id: SRC });
      const out = await recall(alice, 'budget ledger');
      expect(out.isError).toBe(false);
      const lines = out.text.split('\n');
      const at = (needle: string) => lines.findIndex(l => l.includes(needle));
      expect(at('canaryownrecent')).toBeGreaterThanOrEqual(0);
      for (const own of ['canarywritealice', 'canaryownrecent']) expect(at(own)).toBeLessThan(at('canaryownold'));
      expect(at('canaryownold')).toBeGreaterThan(0);
      expect(at('canaryworld')).toBeGreaterThan(at('canaryownrecent'));
      expect(lines[0]).toMatch(/^- .+ \(\d{4}-\d{2}-\d{2}; \w+\)$/);
      expect(out.all).not.toContain('canarybobonly');
      expect(out.all).not.toContain('canarypagebody');
      const ids = out.structured!.facts.map((f: { id: string }) => f.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(Object.keys(out.structured!).sort()).toEqual(['facts', 'truncated']);
      expect(out.structured!.truncated).toBe(false);
      expect(out.structured!.facts[at('canaryownrecent')]).toEqual({ id: expect.any(String), text: 'Alice moved standup to Tuesdays canaryownrecent', date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), kind: 'fact' });
      expect(out.out._meta?.brain_hot_memory).toBeUndefined();
      for (const as of [bob, { token: 'bob' }, { token: 'qm' }, { token: 'plain' }]) {
        const other = await recall(as, 'budget ledger standup Tuesdays');
        expect(other.isError).toBe(false);
        for (const needle of ['canaryownrecent', 'canaryownold', 'canarywritealice', 'canarypagebody']) expect(other.all).not.toContain(needle);
      }
      expect((await recall({ token: 'bob' }, 'budget ledger')).all).toContain('canarybobonly');
    }, 120_000);

    test('max_chars bounds the text at the minimum, the default and with no argument, cut at a line', async () => {
      for (const batch of ['note', 'memo']) {
        await write(carol, Array.from({ length: 20 }, (_, i) => ({ fact: 'Carol harbor ' + batch + ' ' + i + ' ' + 'ledger detail '.repeat(30) + 'canarycarol', provenance: 'bulk' })));
      }
      for (const [args, max] of [[{ max_chars: 200 }, 200], [{}, MEMORY_RECALL_MAX_CHARS.default], [{ max_chars: 12_000 }, 12_000]] as const) {
        const out = await recall(carol, 'harbor ledger', args);
        expect(out.isError).toBe(false);
        expect(out.text.length).toBeLessThanOrEqual(max);
        expect(out.structured!.truncated).toBe(true);
        const lines = out.text.split('\n');
        const kept = out.structured!.facts.length;
        expect(lines).toHaveLength(kept + 1);
        expect(lines[kept]).toMatch(/^… \d+ more$/);
        for (const line of lines.slice(0, kept)) expect(line).toMatch(/^- Carol harbor .+canarycarol \(\d{4}-\d{2}-\d{2}; fact\)$/);
      }
      for (const max_chars of [199, 12_001, 500.5, '600']) {
        const out = await recall(carol, 'harbor ledger', { max_chars });
        expect(out.isError).toBe(true);
        expect(out.json.code).toBe('invalid_params');
      }
    }, 120_000);

    test('an unlinked person gets an empty success whose code rides structuredContent only', async () => {
      const out = await recall({ token: 'qm', actor: 'U0NOBODY' }, 'budget ledger');
      expect(out.isError).toBe(false);
      expect(out.out.content).toEqual([{ type: 'text', text: '' }]);
      expect(out.structured).toEqual({ facts: [], truncated: false, code: 'actor_unlinked' });
      expect((out.out._meta?.access as Record<string, unknown>)?.code).toBe('actor_unlinked');
      const refusedWrite = await call({ token: 'qm', actor: 'U0NOBODY' }, 'memory_write', { facts: [{ fact: 'x', provenance: 'y' }], idempotency_key: 'k' });
      expect({ isError: refusedWrite.isError, code: refusedWrite.json.code }).toEqual({ isError: true, code: 'actor_unlinked' });
      const named = await recall({ token: 'plain', actor: 'U0NOBODY' }, 'budget ledger');
      expect({ isError: named.isError, code: named.json.code, reason: named.json.reason }).toEqual({ isError: true, code: 'actor_not_attested', reason: 'no_attest_right' });
    }, 60_000);

    test('fact text arrives without fence or heading markers', async () => {
      await write(alice, [{ fact: '## Harbor rules\n' + TICKS + '\nkeep the ledger canaryfence\n' + TICKS, provenance: 'turn 4' }]);
      const out = await recall(alice, 'harbor ledger rules');
      const line = out.text.split('\n').find(l => l.includes('canaryfence'));
      expect(line).toMatch(/^- Harbor rules keep the ledger canaryfence \(\d{4}-\d{2}-\d{2}; fact\)$/);
    }, 60_000);

    test('forget and forget_fact withdraw the person\'s own member-page fact there alone, never another member\'s or a world fact', async () => {
      const claim = 'Shared standup moved to Thursdays canaryforget';
      const a = await write(alice, [{ fact: claim, provenance: 'turn 11' }]);
      const b = await write(bob, [{ fact: claim, provenance: 'turn 11' }]);
      const [aliceId] = a.structured!.fact_ids;
      const [bobId] = b.structured!.fact_ids;
      const [worldRow] = await factRows('canaryworld');
      const active = async (id: string) => (await engine.executeRaw<{ expired_at: unknown }>('SELECT expired_at FROM facts WHERE id = $1', [Number(id)]))[0]?.expired_at === null;
      for (const [op, id] of [['forget', bobId], ['forget_fact', bobId], ['forget', String(worldRow!.id)], ['forget_fact', String(worldRow!.id)]] as const) {
        const out = await call(alice, op, { id: op === 'forget' ? id : Number(id) });
        expect(out.isError).toBe(true);
        expect(['not_found', 'fact_not_found']).toContain(out.json.code);
      }
      expect(await active(bobId!)).toBe(true);
      expect(await active(String(worldRow!.id))).toBe(true);
      const forgot = await call(alice, 'forget', { id: aliceId, reason: 'moved back' });
      expect(forgot.isError).toBe(false);
      expect(await active(aliceId!)).toBe(false);
      expect(await active(bobId!)).toBe(true);
      const [ledger] = await engine.executeRaw<{ subject: string }>('SELECT subject FROM fact_withdrawals WHERE source_id = $1 AND fact_hash = gbrain_fact_fingerprint($2)', [SRC, claim]);
      expect(ledger!.subject).toBe('memory/members/alice-example');
      expect((await recall(alice, 'standup Thursdays')).all).not.toContain('canaryforget');
      expect((await recall(bob, 'standup Thursdays')).text).toContain(claim);
      const again = await write(alice, [{ fact: claim, provenance: 'turn 12' }]);
      expect(again.isError).toBe(true);
      expect(again.text).toContain('fact_withdrawn');
      const carolCopy = await write(carol, [{ fact: claim, provenance: 'turn 12' }]);
      expect(carolCopy.structured!.status).toBe('committed');
      const second = await write(alice, [{ fact: 'Alice drafts the harbor memo canaryforgetfact', provenance: 'turn 13' }]);
      const viaFactOp = await call(alice, 'forget_fact', { id: Number(second.structured!.fact_ids[0]) });
      expect(viaFactOp.isError).toBe(false);
      expect(await active(second.structured!.fact_ids[0])).toBe(false);
    }, 120_000);

    test('a keyless brain ranks by keyword and makes no embedding call', async () => {
      let embedCalls = 0;
      try {
        resetGateway();
        configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: DIMS, env: {} });
        __setEmbedTransportForTests((async ({ values }: { values: string[] }) => { embedCalls++; return { embeddings: values.map(vectorFor) }; }) as never);
        const out = await recall(alice, 'budget ledger');
        expect(out.isError).toBe(false);
        expect(out.all).toContain('canaryworld');
        expect(embedCalls).toBe(0);
        resetGateway();
        keyedEmbeddings(() => { embedCalls++; });
        await recall(alice, 'budget ledger');
        expect(embedCalls).toBeGreaterThan(0);
      } finally {
        resetGateway();
        keyedEmbeddings();
      }
    }, 60_000);
  });
}
