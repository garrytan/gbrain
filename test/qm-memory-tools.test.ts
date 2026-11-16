/**
 * GST-359 D: QM's memory provider pair, memory_recall and memory_write.
 *
 * 1. Protects: memory_write saves 1-20 facts through remember's persistence path onto the attested member's own page
 *    (readable by that member alone, private rows, provenance qm:<actor id>; <caller's>), only for an attested person,
 *    with request ids from uuidv5(member, idempotency_key): a replay returns the original receipt, the same key from
 *    two members is two writes, and a write still publishing answers pending with a pollable request_id.
 *    memory_recall answers the person's own recent facts first, then the facts they may read ranked by the query,
 *    one plain line per fact (fence and heading markers stripped, never page bodies), as many whole lines as fit and
 *    no marker line (QM reads every line as a fact), never longer than max_chars (200-12000, default 6000). Success codes ride
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
import { boundFactLines, boundRecallChars, isoDate, memoryWriteRequestId, plainFactText, MEMORY_RECALL_MAX_CHARS } from '../src/core/ops/qm-memory.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { operations } from '../src/core/operations.ts';
import { startHttpTransport } from '../src/mcp/http-transport.ts';
import { RateLimiter } from '../src/mcp/rate-limit.ts';
import { BEHAVIOR_CHANGES } from '../src/core/behavior-change-notice.ts';
import { withTrustPromotion } from '../src/core/persistence/context.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { readsUnscopedOnPurpose } from './helpers/reads-unscoped.ts';

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

  test('only whole fact lines, no marker line, never past the cap, at every cap from the minimum up', () => {
    for (let max = MEMORY_RECALL_MAX_CHARS.min; max < lines.join('\n').length; max += 7) {
      const { kept, text } = boundFactLines(lines, max);
      expect(text.length).toBeLessThanOrEqual(max);
      expect(kept).toBeGreaterThan(0);
      expect(kept).toBeLessThan(lines.length);
      expect(text.split('\n')).toEqual(lines.slice(0, kept));
      expect(lines.slice(0, kept + 1).join('\n').length).toBeGreaterThan(max);
    }
  });

  test('a max_chars cut drops the cut facts from facts_groups and entity_unspecified, never naming a fact it left out (#8465 note)', () => {
    const fact = (id: number, entity: string) => ({ id, fact: 'Fact ' + id + ' about ' + entity + ' ' + 'ledger detail '.repeat(10) });
    const facts = [fact(1, 'acme-example'), fact(2, 'beta-example'), fact(3, 'gamma-example')];
    const group = (id: number, entity: string) => ({ source_id: 'source-a', entity_slug: 'companies/' + entity, fact_ids: [String(id)], top_relevance: 1 / id });
    const out = { facts, total: 3, facts_groups: [group(1, 'acme-example'), group(2, 'beta-example'), group(3, 'gamma-example')],
      entity_unspecified: { candidates: ['acme-example', 'beta-example', 'gamma-example'].map(e => ({ source_id: 'source-a', entity_slug: 'companies/' + e })), suggestion: 'Ask which one.' } };
    const two = boundRecallChars(out, facts[0]!.fact.length + 1 + facts[1]!.fact.length);
    expect(two.facts.map(f => f.id)).toEqual([1, 2]);
    expect(two.facts_groups.map(g => g.fact_ids)).toEqual([['1'], ['2']]);
    expect(two.entity_unspecified?.candidates.map(c => c.entity_slug)).toEqual(['companies/acme-example', 'companies/beta-example']);
    const one = boundRecallChars(out, facts[0]!.fact.length + 1);
    expect(one.facts.map(f => f.id)).toEqual([1]);
    expect(one.facts_groups.map(g => g.fact_ids)).toEqual([['1']]);
    expect('entity_unspecified' in one).toBe(false);
    const whole = boundRecallChars(out, 12_000);
    expect({ groups: whole.facts_groups, unspecified: whole.entity_unspecified, truncated: whole.truncated }).toEqual({ groups: out.facts_groups, unspecified: out.entity_unspecified, truncated: false });
  });

  test('a list that fits is returned whole with no tail; an empty list is empty text', () => {
    expect(boundFactLines(lines.slice(0, 3), 6000)).toEqual({ kept: 3, text: lines.slice(0, 3).join('\n') });
    expect(boundFactLines([], 200)).toEqual({ kept: 0, text: '' });
    expect(boundFactLines(['x'.repeat(500)], 200)).toEqual({ kept: 0, text: '' });
  });

  test('fence, heading and rule markers are stripped and the fact is one line', () => {
    expect(plainFactText('## Plan\n' + TICKS + 'ts\nharbor ledger\n' + TICKS + '\n---\n~~~ next ~~~')).toBe('Plan ts harbor ledger next');
    expect(plainFactText('#1 priority is the harbor')).toBe('#1 priority is the harbor');
  });

  test('every Unicode line break and control character becomes a space, so one fact is always one line', () => {
    const breaks = ['\u0085', '\u2028', '\u2029', '\u001b[31m', '\u0007', '\u009b', '\r', '\u000b', '\u000c', '\u007f', '\u0000'];
    for (const b of breaks) {
      const out = plainFactText('harbor' + b + '## ledger' + b + 'notes');
      expect(out).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/);
      expect(out.startsWith('harbor ')).toBe(true);
      expect(out.endsWith('notes')).toBe(true);
    }
    expect(plainFactText('a\u2028## heading\u0085---\u0085b')).toBe('a heading b');
  });

  test('dates render from their own year, month and day: years 1-99 are never read as 19xx or 20xx', () => {
    expect(isoDate('0050-03-01 00:00:00+00')).toBe('0050-03-01');
    expect(isoDate('0005-06-07 12:00:00+00')).toBe('0005-06-07');
    const early = new Date(Date.UTC(2000, 0, 1));
    early.setUTCFullYear(50, 2, 1);
    expect(isoDate(early)).toBe('0050-03-01');
    expect(isoDate(new Date(Date.UTC(2026, 9, 30, 23, 59)))).toBe('2026-10-30');
    expect(isoDate(null)).toBe('undated');
    expect(isoDate('not a date')).toBe('undated');
  });

  test('the C1 behavior-change row no longer says forget and forget_fact are not attestable; the D row discloses the audience refusal', () => {
    expect(String(BEHAVIOR_CHANGES.find(r => r.id === 'qm_attested_actor_gst359')!.text)).not.toMatch(/forget/);
    expect(String(BEHAVIOR_CHANGES.find(r => r.id === 'qm_memory_provider_gst359')!.text)).toContain('audience_not_supported');
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
const ATTEST_OPS = ['forget', 'forget_fact', 'get_write_request', 'memory_recall', 'memory_write'];

for (const kind of testBackends()) {
  describe('memory_recall and memory_write (' + kind + ', repo-less)', () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
    const tokens: Record<string, string> = {};
    const verify = async (bearer: string) => await provider().verifyAccessToken(bearer) as unknown as AuthInfo;
    type Who = { token: string; actor?: string; audience?: string };
    const alice: Who = { token: 'qm', actor: ALICE_ID };
    const bob: Who = { token: 'qm', actor: BOB_ID };
    const carol: Who = { token: 'qm', actor: CAROL_ID };

    async function call(as: Who, op: string, params: Record<string, unknown>, extra: { writeWaitMs?: number } = {}) {
      const out: ToolResult = await dispatchToolCall(engine, op, { ...params }, {
        remote: true, transport: 'http', auth: await verify(tokens[as.token]!), sourceId: SRC, takesHoldersAllowList: ['world'],
        ...(as.actor !== undefined || as.audience !== undefined ? { actor: { header: as.actor, ...(as.audience !== undefined ? { audience: as.audience } : {}) } } : {}), ...extra,
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
      const qmDefault = await register('qmdefault');
      await bindCredential(engine, { kind: 'client', id: qmDefault.id }, { attestActor: 'qm' });
      for (const [name, c] of [['qm', qm], ['bob', bobKey], ['plain', plain], ['qmdefault', qmDefault]] as const) tokens[name] = (await provider().exchangeClientCredentials(c.id, c.secret)).access_token;
      const legacy = await mintLegacyToken(engine, { name: 'qm-mem-legacy-' + randomUUID().slice(0, 8), scopes: ['read', 'write'], takesHolders: ['world'], sourceGrant: [SRC] });
      await bindCredential(engine, { kind: 'token', id: legacy.id }, { attestActor: 'qm', attestOps: ATTEST_OPS });
      tokens.legacy = legacy.token;
      const legacyRead = await mintLegacyToken(engine, { name: 'qm-mem-legacy-ro-' + randomUUID().slice(0, 8), scopes: ['read'], takesHolders: ['world'], sourceGrant: [SRC] });
      await bindCredential(engine, { kind: 'token', id: legacyRead.id }, { attestActor: 'qm', attestOps: ATTEST_OPS });
      tokens.legacyRead = legacyRead.token;
      for (const c of [qm, plain, qmDefault]) await readsUnscopedOnPurpose(engine, c.id, 'client');
      for (const t of [legacy, legacyRead]) await readsUnscopedOnPurpose(engine, t.id);
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
      const longer = await write(alice, [...facts, { fact: 'Alice adds a third canaryreplay extra', provenance: 'turn 1' }], key);
      expect({ isError: longer.isError, write_error: longer.json.write_error }).toEqual({ isError: true, write_error: 'idempotency_conflict' });
      expect(await factRows('canaryreplay extra')).toHaveLength(0);
      const shorter = await write(alice, [facts[0]!], key);
      expect({ isError: shorter.isError, write_error: shorter.json.write_error }).toEqual({ isError: true, write_error: 'idempotency_conflict' });
      expect(await factRows('canaryreplay')).toHaveLength(2);
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

    test('acting_user "" or null, as a model fills an optional argument, reads as omitted on recall and write (GST-923)', async () => {
      for (const empty of ['', null]) {
        for (const as of [alice, { token: 'qm' }, { token: 'bob' }]) {
          const filled = await recall(as, 'budget ledger', { acting_user: empty });
          const omitted = await recall(as, 'budget ledger');
          expect({ isError: filled.isError, code: filled.json.code, text: filled.text }).toEqual({ isError: omitted.isError, code: omitted.json.code, text: omitted.text });
        }
        const saved = await call(alice, 'memory_write', { facts: [{ fact: 'Empty acting user write canaryemptyactor', provenance: 'x' }], idempotency_key: randomUUID(), acting_user: empty }, { writeWaitMs: 30_000 });
        expect(saved.structured?.status ?? saved.text).toBe('committed');
        const unattested = await call({ token: 'qm' }, 'memory_write', { facts: [{ fact: 'Unattested write canaryemptyrefused', provenance: 'x' }], idempotency_key: randomUUID(), acting_user: empty });
        expect({ code: unattested.json.code, reason: unattested.json.reason }).toEqual({ code: 'actor_not_attested', reason: 'actor_required' });
      }
      expect(await factRows('canaryemptyrefused')).toHaveLength(0);
    }, 120_000);

    test('source_id "" or null, as a model fills an optional argument, reads as omitted on recall and write (#8465 note)', async () => {
      for (const empty of ['', null]) {
        const filled = await recall(alice, 'budget ledger', { source_id: empty });
        const omitted = await recall(alice, 'budget ledger');
        expect({ isError: filled.isError, code: filled.json.code, text: filled.text }).toEqual({ isError: omitted.isError, code: omitted.json.code, text: omitted.text });
        const saved = await call(alice, 'memory_write', { facts: [{ fact: 'Empty source id write canaryemptysource' + (empty === null ? 'null' : 'blank'), provenance: 'x' }], idempotency_key: randomUUID(), source_id: empty }, { writeWaitMs: 30_000 });
        expect(saved.structured?.status ?? saved.text).toBe('committed');
      }
      const rows = await factRows('canaryemptysource');
      expect(rows.map(r => r.source_markdown_slug)).toEqual(['memory/members/alice-example', 'memory/members/alice-example']);
    }, 120_000);

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
      expect(out.structured!.facts[at('canaryownrecent')]).toEqual({ id: expect.any(String), text: 'Alice moved standup to Tuesdays canaryownrecent', date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), kind: 'fact', arm: 'own', own_page: true });
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
        const lines = out.text ? out.text.split('\n') : [];
        const kept = out.structured!.facts.length;
        if (max > MEMORY_RECALL_MAX_CHARS.min) expect(kept).toBeGreaterThan(0);
        expect(lines).toHaveLength(kept);
        for (const line of lines) expect(line).toMatch(/^- Carol harbor .+canarycarol \(\d{4}-\d{2}-\d{2}; fact\)$/);
      }
      for (const max_chars of [199, 12_001, 500.5, '600']) {
        const out = await recall(carol, 'harbor ledger', { max_chars });
        expect(out.isError).toBe(true);
        expect(out.json.code).toBe('invalid_params');
      }
    }, 120_000);

    test('a recall that names sources reads as the scope, never as the person: none of their own member-page facts (GST-1094)', async () => {
      const SCOPE = 'qm-scope-room';
      await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [SCOPE]);
      const c = await provider().registerClientManual('d-scope-' + randomUUID().slice(0, 8), ['client_credentials'], 'read write', [], SRC);
      await provider().rescopeClient(c.clientId, { federatedRead: [SRC, SCOPE] });
      await bindCredential(engine, { kind: 'client', id: c.clientId }, { attestActor: 'qm' });
      tokens.scoped = (await provider().exchangeClientCredentials(c.clientId, c.clientSecret ?? '')).access_token;
      const aliceScoped: Who = { token: 'scoped', actor: ALICE_ID };
      expect((await write(aliceScoped, [{ fact: 'Alice keeps her seat preference canaryscopeown budget ledger', provenance: 'turn 40' }])).structured?.status).toBe('committed');
      const restricted = 'notes/alice-only-scope';
      await importFromContent(engine, restricted, '---\ntype: note\ntitle: Alice only\nreadable_by:\n  - member:alice-example\n---\n# Alice only\n', { sourceId: SRC });
      await engine.insertFact({ fact: 'Alice salary review canaryscoperestricted budget ledger', kind: 'fact', entity_slug: ACME, source: 'test', visibility: 'world' }, { source_id: SRC });
      await engine.executeRaw('UPDATE facts SET source_markdown_slug = $1 WHERE fact LIKE $2', [restricted, '%canaryscoperestricted%']);
      await engine.insertFact({ fact: 'The room budget ledger review is Friday canaryscoperoom', kind: 'event', entity_slug: null, source: 'test', visibility: 'world' }, { source_id: SCOPE });
      await engine.insertFact({ fact: 'Acme budget ledger audit is open canaryscopeworld', kind: 'event', entity_slug: ACME, source: 'test', visibility: 'world' }, { source_id: SRC });
      __resetPrivateVisibilityCacheForTests();
      const asPerson = await recall(aliceScoped, 'budget ledger', { max_chars: 12_000 });
      for (const needle of ['canaryscopeown', 'canaryscopeworld', 'canaryscoperoom']) expect(asPerson.text).toContain(needle);
      expect(asPerson.all).not.toContain('canaryscoperestricted');
      for (const args of [{ source_id: SRC }, { source_ids: [SRC] }, { source_ids: [SRC, SCOPE] }]) {
        const asScope = await recall(aliceScoped, 'budget ledger', { max_chars: 12_000, ...args });
        expect(asScope.isError).toBe(false);
        expect(asScope.text).toContain('canaryscopeworld');
        for (const needle of ['canaryscopeown', 'canaryscoperestricted', 'canarywritealice', 'canaryownrecent']) expect(asScope.all).not.toContain(needle);
        expect(JSON.stringify(asScope.out._meta?.warnings ?? [])).not.toContain('unknown_param');
      }
      const room = await recall(aliceScoped, 'budget ledger', { source_ids: [SCOPE] });
      expect(room.text).toContain('canaryscoperoom');
      for (const needle of ['canaryscopeworld', 'canaryscopeown', 'canaryscoperestricted']) expect(room.all).not.toContain(needle);
      const outside = await recall(alice, 'budget ledger', { source_ids: [SCOPE] });
      expect({ isError: outside.isError, code: outside.json.code }).toEqual({ isError: true, code: 'permission_denied' });
      expect(outside.structured?.error?.code).toBe('permission_denied');
      const all = await recall(aliceScoped, 'budget ledger', { source_id: '__all__' });
      expect({ isError: all.isError, code: all.json.code }).toEqual({ isError: true, code: 'invalid_params' });
      const none = await recall(aliceScoped, 'budget ledger', { source_id: SCOPE, source_ids: [SRC] });
      expect({ isError: none.isError, text: none.text, facts: none.structured?.facts }).toEqual({ isError: false, text: '', facts: [] });
      const unlinked = await recall({ token: 'scoped', actor: 'U0NOBODY' }, 'budget ledger', { source_ids: [SCOPE] });
      expect(unlinked.structured).toEqual({ facts: [], truncated: false, code: 'actor_unlinked' });
    }, 120_000);

    test('each recalled fact names its arm: own for the person\'s recent facts, ranked for query matches, ranked only under a scope read (GST-1158 F5)', async () => {
      for (const [fact, provenance] of [['Alice charts the harbor tide canaryarmown', 'turn 50'], ['Alice charted the harbor tide last year canaryarmold', 'turn 49']]) {
        expect((await write(alice, [{ fact, provenance }])).structured?.status).toBe('committed');
      }
      await engine.executeRaw("UPDATE facts SET created_at = now() - interval '3 days', valid_from = now() - interval '3 days' WHERE source_id = $1 AND fact LIKE '%canaryarmold%'", [SRC]);
      await engine.insertFact({ fact: 'Acme harbor tide tables canaryarmranked', kind: 'fact', entity_slug: ACME, source: 'test', visibility: 'world' }, { source_id: SRC });
      const out = await recall(alice, 'harbor tide', { max_chars: 12_000 });
      expect(out.isError).toBe(false);
      const arm = (needle: string) => out.structured!.facts.find((f: { text: string }) => f.text.includes(needle))?.arm;
      expect({ own: arm('canaryarmown'), old: arm('canaryarmold'), world: arm('canaryarmranked') }).toEqual({ own: 'own', old: 'ranked', world: 'ranked' });
      for (const f of out.structured!.facts) expect(Object.keys(f).sort()).toEqual(['arm', 'date', 'id', 'kind', 'own_page', 'text']);
      const firstRanked = out.structured!.facts.findIndex((f: { arm: string }) => f.arm === 'ranked');
      expect(out.structured!.facts.slice(firstRanked).every((f: { arm: string }) => f.arm === 'ranked')).toBe(true);
      const asScope = await recall(alice, 'harbor tide', { max_chars: 12_000, source_id: SRC });
      expect(asScope.structured!.facts.length).toBeGreaterThan(0);
      expect(asScope.structured!.facts.every((f: { arm: string; own_page: boolean }) => f.arm === 'ranked' && f.own_page === false)).toBe(true);
      expect(asScope.all).not.toContain('canaryarmown');
    }, 120_000);

    test('a recall that names sources keeps folder fail-closed coverage: facts under a pending prefix stay hidden', async () => {
      expect(tokens.scoped).toBeDefined();
      const aliceScoped: Who = { token: 'scoped', actor: ALICE_ID };
      const held = 'pending-hr/scope-note';
      await importFromContent(engine, held, '---\ntype: note\ntitle: Held note\n---\n# Held note\n', { sourceId: SRC });
      await engine.insertFact({ fact: 'Payroll budget ledger draft canaryscopepending', kind: 'fact', entity_slug: ACME, source: 'test', visibility: 'world' }, { source_id: SRC });
      await engine.executeRaw('UPDATE facts SET source_markdown_slug = $1 WHERE fact LIKE $2', [held, '%canaryscopepending%']);
      __resetPrivateVisibilityCacheForTests();
      expect((await recall(aliceScoped, 'payroll budget ledger', { max_chars: 12_000, source_id: SRC })).text).toContain('canaryscopepending');
      await engine.executeRaw('INSERT INTO access_policy_state (source_id) VALUES ($1) ON CONFLICT (source_id) DO NOTHING', [SRC]);
      await engine.executeRaw("INSERT INTO access_pending_coverage (source_id, prefix, reason) VALUES ($1, 'pending-hr/', 'invalid')", [SRC]);
      try {
        __resetPrivateVisibilityCacheForTests();
        for (const args of [{ source_id: SRC }, { source_ids: [SRC] }]) {
          const asScope = await recall(aliceScoped, 'payroll budget ledger', { max_chars: 12_000, ...args });
          expect(asScope.isError).toBe(false);
          expect(asScope.all).not.toContain('canaryscopepending');
        }
      } finally {
        await engine.executeRaw("DELETE FROM access_pending_coverage WHERE source_id = $1 AND prefix = 'pending-hr/'", [SRC]);
        __resetPrivateVisibilityCacheForTests();
      }
    }, 120_000);

    test('generic recall takes max_chars: whole facts in order, no marker, structured truncated, invalid values refused; without it recall is unchanged (HARN-15)', async () => {
      const ENTITY = 'companies/harn-recall-example';
      for (let i = 0; i < 12; i++) {
        await engine.insertFact({ fact: 'Harn recall world fact ' + String(i).padStart(2, '0') + ' ' + 'ledger detail '.repeat(6) + 'canaryharnrecall', kind: 'fact', entity_slug: ENTITY, source: 'test', visibility: 'world' }, { source_id: SRC });
      }
      const recallAll = (args: Record<string, unknown> = {}) => call({ token: 'plain' }, 'recall', { entity: ENTITY, ...args });
      const base = await recallAll();
      expect(base.isError).toBe(false);
      expect(base.json.facts.length).toBe(12);
      expect('truncated' in base.json).toBe(false);
      expect(base.json.total).toBe(12);
      const again = await recallAll();
      expect(Object.keys(again.json).sort()).toEqual(Object.keys(base.json).sort());
      const baseIds = base.json.facts.map((f: { id: number }) => f.id);
      for (const max_chars of [500, 1000, 1500]) {
        const out = await recallAll({ max_chars });
        expect(out.isError).toBe(false);
        const facts = out.json.facts as Array<{ id: number; fact: string }>;
        expect(facts.length).toBeGreaterThan(0);
        expect(facts.length).toBeLessThan(12);
        expect(facts.map(f => f.fact).join('\n').length).toBeLessThanOrEqual(max_chars);
        expect(facts.map(f => f.id)).toEqual(baseIds.slice(0, facts.length));
        const next = base.json.facts[facts.length].fact as string;
        expect(facts.map(f => f.fact).join('\n').length + 1 + next.length).toBeGreaterThan(max_chars);
        expect(out.json.truncated).toBe(true);
        expect(out.json.total).toBe(facts.length);
        expect(out.text).not.toMatch(/\d+ more|truncated at/i);
      }
      const roomy = await recallAll({ max_chars: MEMORY_RECALL_MAX_CHARS.max });
      expect(roomy.json.truncated).toBe(false);
      expect(roomy.json.facts.map((f: { id: number }) => f.id)).toEqual(baseIds);
      for (const max_chars of [199, 12_001, 500.5, '600']) {
        const out = await recallAll({ max_chars });
        expect(out.isError).toBe(true);
        expect(out.json.code ?? out.json.error).toBe('invalid_params');
        expect(out.text).not.toContain('canaryharnrecall');
      }
      // A client that fills optional integers from the schema sends at least the minimum, never 0.
      expect(operations.find(o => o.name === 'recall')!.params.max_chars).toMatchObject({ type: 'integer', minimum: MEMORY_RECALL_MAX_CHARS.min });
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

    test('a database failure while resolving the person comes back as a structured error, never a thrown call', async () => {
      const target = engine as { executeRaw: typeof engine.executeRaw };
      const own = Object.prototype.hasOwnProperty.call(target, 'executeRaw');
      const real = target.executeRaw;
      target.executeRaw = (async function (this: BrainEngine, ...args: Parameters<typeof engine.executeRaw>) {
        if (typeof args[0] === 'string' && args[0].includes('access_member_links')) throw Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
        return real.apply(this, args);
      }) as typeof engine.executeRaw;
      try {
        for (const [op, args] of [['memory_recall', { query: 'budget ledger' }], ['memory_write', { facts: [{ fact: 'Lock timeout canarylocktimeout', provenance: 'turn 1' }], idempotency_key: randomUUID() }]] as const) {
          const out = await call(alice, op, args as Record<string, unknown>);
          expect(out.isError).toBe(true);
          expect(typeof out.json.code).toBe('string');
          expect(out.structured?.error?.code).toBe(out.json.code);
        }
      } finally {
        if (own) target.executeRaw = real;
        else delete (target as Partial<typeof target>).executeRaw;
      }
      expect(await factRows('canarylocktimeout')).toHaveLength(0);
    }, 60_000);

    test('fact text arrives without fence or heading markers', async () => {
      await write(alice, [{ fact: '## Harbor rules\n' + TICKS + '\nkeep the ledger canaryfence\n' + TICKS, provenance: 'turn 4' }]);
      const out = await recall(alice, 'harbor ledger rules');
      const line = out.text.split('\n').find(l => l.includes('canaryfence'));
      expect(line).toMatch(/^- Harbor rules keep the ledger canaryfence \(\d{4}-\d{2}-\d{2}; fact\)$/);
    }, 60_000);

    test('a QM client whose operation grant names only the memory tools writes and reads back its receipts', async () => {
      const c = await provider().registerClientManual('d-pinned-' + randomUUID().slice(0, 8), ['client_credentials'], 'read write', [], SRC);
      await bindCredential(engine, { kind: 'client', id: c.clientId }, { attestActor: 'qm' });
      await engine.executeRaw('UPDATE oauth_clients SET allowed_operations = $2::text[] WHERE client_id = $1', [c.clientId, ['get_write_request', 'memory_recall', 'memory_write']]);
      tokens.pinned = (await provider().exchangeClientCredentials(c.clientId, c.clientSecret ?? '')).access_token;
      const pinned: Who = { token: 'pinned', actor: ALICE_ID };
      const out = await write(pinned, [{ fact: 'Alice prefers the north dock canarypinned', provenance: 'turn 30' }]);
      expect({ isError: out.isError, status: out.structured?.status }).toEqual({ isError: false, status: 'committed' });
      const receipt = await call(pinned, 'get_write_request', { request_id: out.structured!.request_id });
      expect(receipt.isError).toBe(false);
      expect((await recall(pinned, 'north dock')).text).toContain('canarypinned');
    }, 60_000);

    test('forget and forget_fact withdraw the person\'s own member-page fact there alone, never another member\'s or a world fact', async () => {
      const claim = 'Shared standup moved to Thursdays canaryforget';
      const a = await write(alice, [{ fact: claim, provenance: 'turn 11' }]);
      const b = await write(bob, [{ fact: claim, provenance: 'turn 11' }]);
      const [aliceId] = a.structured!.fact_ids;
      const [bobId] = b.structured!.fact_ids;
      const replayKey = randomUUID();
      const replayed = await write(alice, [{ fact: 'Alice moved the harbor sync canaryreplayforget', provenance: 'turn 11' }], replayKey);
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
      expect((await call(alice, 'forget', { id: replayed.structured!.fact_ids[0] })).isError).toBe(false);
      const replay = await write(alice, [{ fact: 'Alice moved the harbor sync canaryreplayforget', provenance: 'turn 11' }], replayKey);
      expect({ isError: replay.isError, fact_ids: replay.structured?.fact_ids }).toEqual({ isError: false, fact_ids: replayed.structured!.fact_ids });
      expect(await active(aliceId!)).toBe(false);
      expect(await active(bobId!)).toBe(true);
      const [ledger] = await engine.executeRaw<{ subject: string }>('SELECT subject FROM fact_withdrawals WHERE source_id = $1 AND fact_hash = gbrain_fact_fingerprint($2)', [SRC, claim]);
      expect(ledger!.subject).toBe('memory/members/alice-example');
      expect((await recall(alice, 'standup Thursdays')).all).not.toContain('canaryforget');
      expect((await recall(bob, 'standup Thursdays')).text).toContain(claim);
      const again = await write(alice, [{ fact: claim, provenance: 'turn 12' }]);
      expect(again.isError).toBe(true);
      expect(again.text).toContain('fact_withdrawn');
      const batchKey = randomUUID();
      const mixed = await write(alice, [{ fact: 'Alice books the harbor room canarymixedfirst', provenance: 'turn 12' }, { fact: claim, provenance: 'turn 12' }], batchKey);
      expect({ isError: mixed.isError, code: mixed.json.code }).toEqual({ isError: true, code: 'invalid_params' });
      expect(await factRows('canarymixedfirst')).toHaveLength(0);
      const fixedBatch = await write(alice, [{ fact: 'Alice books the harbor room canarymixedfirst', provenance: 'turn 12' }], batchKey);
      expect(fixedBatch.structured?.status).toBe('committed');
      const carolCopy = await write(carol, [{ fact: claim, provenance: 'turn 12' }]);
      expect(carolCopy.structured!.status).toBe('committed');
      const second = await write(alice, [{ fact: 'Alice drafts the harbor memo canaryforgetfact', provenance: 'turn 13' }]);
      const viaFactOp = await call(alice, 'forget_fact', { id: Number(second.structured!.fact_ids[0]) });
      expect(viaFactOp.isError).toBe(false);
      expect(await active(second.structured!.fact_ids[0])).toBe(false);
    }, 120_000);

    test('own_page agrees with forget_fact on ownership: every own_page row is withdrawn, every other row is refused (fact_not_found for an attested person), whichever arm found it (GST-2407)', async () => {
      for (const [fact, provenance] of [['Alice logs the harbor buoy canaryownpagerecent', 'turn 60'], ['Alice logged the harbor buoy last spring canaryownpageold', 'turn 59']]) {
        expect((await write(alice, [{ fact, provenance }])).structured?.status).toBe('committed');
      }
      await engine.executeRaw("UPDATE facts SET created_at = now() - interval '3 days', valid_from = now() - interval '3 days' WHERE source_id = $1 AND fact LIKE '%canaryownpageold%'", [SRC]);
      await engine.insertFact({ fact: 'Acme harbor buoy inspection canaryownpageworld', kind: 'fact', entity_slug: ACME, source: 'test', visibility: 'world' }, { source_id: SRC });
      await engine.insertFact({ fact: 'Harbor buoy note on her page path canaryownpagepath', kind: 'fact', entity_slug: null, source: 'test', visibility: 'world' }, { source_id: SRC });
      await engine.executeRaw("UPDATE facts SET source_markdown_slug = 'memory/members/alice-example' WHERE source_id = $1 AND fact LIKE '%canaryownpagepath%'", [SRC]);
      expect((await write(bob, [{ fact: 'Bob logs the harbor buoy canaryownpagebob', provenance: 'turn 61' }])).structured?.status).toBe('committed');
      __resetPrivateVisibilityCacheForTests();
      for (const [as, mine, others] of [[alice, ['canaryownpagerecent', 'canaryownpageold'], ['canaryownpageworld', 'canaryownpagepath']], [{ token: 'bob' }, ['canaryownpagebob'], ['canaryownpageworld']]] as const) {
        const out = await recall(as, 'harbor buoy', { max_chars: 12_000 });
        expect(out.isError).toBe(false);
        const rows = out.structured!.facts as Array<{ id: string; text: string; arm: string; own_page: boolean }>;
        const row = (needle: string) => rows.find(f => f.text.includes(needle));
        for (const needle of [...mine, ...others]) expect(row(needle)).toBeDefined();
        expect(mine.map(n => row(n)!.own_page)).toEqual(mine.map(() => true));
        expect(others.map(n => row(n)!.own_page)).toEqual(others.map(() => false));
        if (as === alice) expect({ recent: row('canaryownpagerecent')!.arm, old: row('canaryownpageold')!.arm }).toEqual({ recent: 'own', old: 'ranked' });
        for (const f of rows.filter(r => r.text.includes('canaryownpage'))) {
          const out = await call(as, 'forget_fact', { id: Number(f.id) });
          expect({ text: f.text, own_page: f.own_page, refused: out.isError }).toEqual({ text: f.text, own_page: f.own_page, refused: !f.own_page });
          if (as === alice && !f.own_page) expect(out.json.code).toBe('fact_not_found');
        }
      }
    }, 120_000);

    test('a request carrying x-qm-audience is refused before any work, with or without the actor header (wave 2 is not served yet)', async () => {
      const before = await factRows('canaryaudience');
      for (const as of [{ ...alice, audience: 'WyJVMEJPQiJd' }, { token: 'qm', audience: 'WyJVMEJPQiJd' }, { token: 'bob', audience: '' }, { token: 'plain', audience: 'x' }] as Who[]) {
        for (const [op, args] of [['memory_recall', { query: 'budget ledger' }], ['memory_write', { facts: [{ fact: 'Audience write canaryaudience', provenance: 'turn 1' }], idempotency_key: randomUUID() }],
          ['get_page', { slug: ACME }], ['forget', { id: '1' }]] as const) {
          const out = await call(as, op, args);
          expect({ op, isError: out.isError, code: out.json.code, reason: out.json.reason }).toEqual({ op, isError: true, code: 'actor_not_attested', reason: 'audience_not_supported' });
          expect(out.structured?.error).toMatchObject({ code: 'actor_not_attested', reason: 'audience_not_supported' });
          expect(out.all).not.toContain('canary');
        }
      }
      expect(await factRows('canaryaudience')).toEqual(before);
    }, 60_000);

    test('the legacy bearer transport refuses x-qm-audience on every method before any work, and its scope refusal of a memory tool carries structuredContent.error', async () => {
      const server = await startHttpTransport({ port: 0, engine, surface: 'full', limiters: {
        ip: new RateLimiter({ limit: 10_000, windowMs: 60_000, lruCap: 100 }),
        token: new RateLimiter({ limit: 10_000, windowMs: 60_000, lruCap: 100 }),
      } });
      try {
        const post = async (token: string, headers: Record<string, string>, body: Record<string, unknown>) => {
          const res = await fetch('http://127.0.0.1:' + server.port + '/mcp', {
            method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json', ...headers },
            body: JSON.stringify({ jsonrpc: '2.0', id: 7, ...body }),
          });
          return await res.json() as { result?: Record<string, any>; error?: { code: number; message: string; data?: Record<string, unknown> } };
        };
        const recallCall = { method: 'tools/call', params: { name: 'memory_recall', arguments: { query: 'budget ledger' } } };
        for (const headers of [{ 'x-qm-actor': ALICE_ID, 'x-qm-audience': 'WyJVMEJPQiJd' }, { 'X-QM-Audience': 'WyJVMEJPQiJd' }] as Array<Record<string, string>>) {
          const called = await post(tokens.legacy!, headers, recallCall);
          expect(called.result!.isError).toBe(true);
          expect(called.result!.structuredContent.error).toMatchObject({ code: 'actor_not_attested', reason: 'audience_not_supported' });
          expect(JSON.stringify(called)).not.toContain('canary');
          for (const method of ['tools/list', 'resources/list', 'resources/read']) {
            const out = await post(tokens.legacy!, headers, { method, params: method === 'resources/read' ? { uri: 'gbrain://capabilities' } : {} });
            expect(out.result).toBeUndefined();
            expect(out.error!.data).toMatchObject({ code: 'actor_not_attested', reason: 'audience_not_supported' });
          }
        }
        expect(JSON.stringify(await post(tokens.legacy!, { 'x-qm-actor': ALICE_ID }, recallCall))).toContain('canary');
        const denied = await post(tokens.legacyRead!, { 'x-qm-actor': ALICE_ID }, { method: 'tools/call', params: { name: 'memory_write', arguments: { facts: [{ fact: 'x', provenance: 'y' }], idempotency_key: randomUUID() } } });
        expect(denied.result!.isError).toBe(true);
        expect(denied.result!.structuredContent.error).toMatchObject({ code: 'insufficient_scope' });
      } finally {
        server.stop(true);
      }
    }, 60_000);

    test('attested and member-bound forget judge ownership first: a fact off the caller\'s own member page is not_found to the attested person, refused by name to a member credential that reads it (#9101), and files no owner proposal', async () => {
      await engine.insertFact({ fact: 'Acme harbor charter is confirmed canaryconfirmed', kind: 'fact', entity_slug: ACME, source: 'test', visibility: 'world' }, { source_id: SRC });
      const [confirmed] = await factRows('canaryconfirmed');
      await engine.transaction(tx => withTrustPromotion(tx, 'user_confirmed', () => tx.executeRaw("UPDATE facts SET trust_tier = 'user_confirmed' WHERE id = $1", [confirmed!.id])));
      const proposals = async () => Number((await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM trust_proposals'))[0]!.n);
      const start = await proposals();
      const a = await write(alice, [{ fact: 'Alice tends the harbor lamps canaryownforget', provenance: 'turn 20' }]);
      const bobOwn = await call({ token: 'bob' }, 'remember', { fact: 'Bob tends the harbor bell canarybobforget', provenance: 'turn 20' });
      expect(bobOwn.isError).toBe(false);
      const [bobRow] = await factRows('canarybobforget');
      expect(bobRow).toMatchObject({ visibility: 'private', source_markdown_slug: 'memory/members/bob-example' });
      for (const as of [alice, { token: 'bob' }] as Who[]) {
        for (const [op, id] of [['forget', String(confirmed!.id)], ['forget_fact', Number(confirmed!.id)]] as const) {
          const out = await call(as, op, { id });
          const code = as === alice ? (op === 'forget' ? 'not_found' : 'fact_not_found') : (op === 'forget' ? 'scope_denied' : 'permission_denied');
          expect({ isError: out.isError, code: out.json.code }).toEqual({ isError: true, code });
        }
      }
      expect(await proposals()).toBe(start);
      const crossed = await call({ token: 'bob' }, 'forget', { id: a.structured!.fact_ids[0] });
      expect(crossed.json.code).toBe('not_found');
      const own = await call({ token: 'bob' }, 'forget', { id: String(bobRow!.id) });
      expect(own.isError).toBe(false);
      const active = async (id: unknown) => (await engine.executeRaw<{ expired_at: unknown }>('SELECT expired_at FROM facts WHERE id = $1', [Number(id)]))[0]?.expired_at === null;
      expect(await active(bobRow!.id)).toBe(false);
      expect(await active(a.structured!.fact_ids[0])).toBe(true);
      expect(await active(confirmed!.id)).toBe(true);
    }, 120_000);

    test('the default attested operations read the person\'s own write receipt; another person and the bare client get not_found', async () => {
      const qmd = (actor?: string): Who => ({ token: 'qmdefault', ...(actor ? { actor } : {}) });
      const out = await write(qmd(ALICE_ID), [{ fact: 'Alice books the night ferry canarydefaultreceipt', provenance: 'turn 21' }], randomUUID(), { writeWaitMs: 0 });
      expect(out.structured!.status).toBe('pending');
      const id = out.structured!.request_id;
      const own = await call(qmd(ALICE_ID), 'get_write_request', { request_id: id });
      expect(own.isError).toBe(false);
      expect(own.all).toContain(id);
      for (const as of [qmd(BOB_ID), qmd()]) {
        const other = await call(as, 'get_write_request', { request_id: id });
        expect({ isError: other.isError, code: other.json.code }).toEqual({ isError: true, code: 'not_found' });
      }
    }, 60_000);

    test('valid_from is a strict ISO date or time in years 0001-9999, checked for the whole batch before any write, so the key is never poisoned', async () => {
      const key = 'qm-poison-' + randomUUID();
      const good = { fact: 'Alice signs the harbor lease canarypoisongood', provenance: 'turn 22' };
      for (const valid_from of ['10000-01-01', '2026-02-30', 'March 3, 2026', '2026-10-30T25:00:00Z', '0000-01-01', '+010000-01-01T00:00:00Z', '2026-10-30 10:00', '20261030']) {
        const out = await write(alice, [good, { fact: 'Alice leaves canarypoisonbad', provenance: 'turn 22', valid_from }], key);
        expect({ valid_from, isError: out.isError, code: out.json.code }).toEqual({ valid_from, isError: true, code: 'invalid_params' });
        const viaRemember = await call({ token: 'bob' }, 'remember', { fact: 'Bob note canarypoisonremember', provenance: 'turn 22', valid_from });
        expect({ valid_from, code: viaRemember.json.code, message: viaRemember.json.message }).toEqual({ valid_from, code: 'invalid_params', message: expect.stringContaining('valid_from') });
      }
      expect(await factRows('canarypoison')).toHaveLength(0);
      const saved = await write(alice, [good], key);
      expect(saved.structured!.status).toBe('committed');
      for (const valid_from of ['0001-01-01', '9999-12-31', '2026-10-30T10:00:00Z', '2026-10-30T10:00:00.123+05:30', '2024-02-29']) {
        const ok = await write(alice, [{ fact: 'Valid date ' + valid_from + ' canaryvalidfrom', provenance: 'turn 23', valid_from }]);
        expect({ valid_from, status: ok.structured?.status ?? ok.text }).toEqual({ valid_from, status: 'committed' });
      }
      await write(alice, [{ fact: 'Alice found the old harbor stone canaryyearfifty', provenance: 'turn 24', valid_from: '0050-03-01' }]);
      const line = (await recall(alice, 'old harbor stone')).text.split('\n').find(l => l.includes('canaryyearfifty'));
      expect(line).toMatch(/\(0050-03-01; fact\)$/);
    }, 120_000);

    test('caller provenance with control characters or its own qm: prefix is refused, and duplicate facts in one call are one fact in the reply', async () => {
      for (const provenance of ['qm:U0EVE; turn 1', 'QM:U0EVE', ' qm:spoof', 'turn\u0000one', 'turn\u001b[2Jone', 'turn\u0085one', 'turn\u2028one', 'turn\none']) {
        const out = await write(alice, [{ fact: 'Provenance check canaryprov', provenance }]);
        expect({ provenance, code: out.json.code }).toEqual({ provenance, code: 'invalid_params' });
      }
      expect(await factRows('canaryprov')).toHaveLength(0);
      for (const bad of ['Invalid \u0000 claim canarynulfact', 'Lone \ud800 surrogate canarynulfact']) {
        const key = randomUUID();
        const out = await write(alice, [{ fact: 'First fact of a bad batch canarynulfirst', provenance: 'turn 27' }, { fact: bad, provenance: 'turn 27' }], key);
        expect({ isError: out.isError, code: out.json.code }).toEqual({ isError: true, code: 'invalid_params' });
        expect(await factRows('canarynulfirst')).toHaveLength(0);
        const fixed = await write(alice, [{ fact: 'First fact of a fixed batch canarynulfixed ' + key, provenance: 'turn 27' }], key);
        expect(fixed.structured?.status).toBe('committed');
      }
      const dup = await write(alice, [{ fact: 'Alice repeats herself canarydup', provenance: 'turn 25' }, { fact: 'Alice repeats herself canarydup', provenance: 'turn 26' }]);
      expect(dup.structured!.status).toBe('committed');
      expect(dup.structured!.fact_ids).toHaveLength(1);
      expect(dup.out.content).toEqual([{ type: 'text', text: 'Saved 1 fact(s).' }]);
      expect(await factRows('canarydup')).toHaveLength(1);
    }, 60_000);

    test('an unlinked person\'s recall still validates its arguments first, and a surface-hidden memory tool refuses with structuredContent.error', async () => {
      const nobody: Who = { token: 'qm', actor: 'U0NOBODY' };
      for (const args of [{ query: 'harbor', max_chars: 5 }, { query: 'harbor', max_chars: 200.5 }, { max_chars: 400 }, { query: 7 }]) {
        const out = await call(nobody, 'memory_recall', args);
        expect({ isError: out.isError, code: out.json.code }).toEqual({ isError: true, code: 'invalid_params' });
        expect(out.structured?.error).toMatchObject({ code: 'invalid_params' });
      }
      const hidden: ToolResult = await dispatchToolCall(engine, 'memory_recall', { query: 'harbor' }, {
        remote: true, transport: 'http', auth: await verify(tokens.qm!), sourceId: SRC, actor: { header: ALICE_ID }, allowedOps: new Set(['get_page']) });
      expect(hidden.isError).toBe(true);
      expect((hidden.structuredContent as { error: { code: string } }).error.code).toBe('unknown_tool');
    }, 60_000);

    test('acting_user without attestation names what is missing in detail: the header, the attest right, or both (GST-1304)', async () => {
      const cases: Array<[Who, string]> = [
        [{ token: 'qm' }, 'missing=x-qm-actor'],
        [{ token: 'plain' }, 'missing=attest_right,x-qm-actor'],
        [{ token: 'plain', actor: ALICE_ID }, 'missing=attest_right'],
      ];
      for (const [as, detail] of cases) {
        const out = await call(as, 'memory_recall', { query: 'harbor ledger', acting_user: ALICE_ID });
        expect(out.json).toMatchObject({ code: 'actor_not_attested', reason: 'argument_without_attestation', detail });
        expect(out.structured?.error).toMatchObject({ code: 'actor_not_attested', reason: 'argument_without_attestation', detail });
      }
      const qmOnly = await call({ token: 'qm' }, 'memory_recall', { query: 'harbor ledger', acting_user: ALICE_ID });
      expect(qmOnly.json.message).toContain('x-qm-actor');
      expect(qmOnly.json.message).not.toContain('attest right');
    }, 60_000);

    test('a memory_recall query over query_chars_ranked is ranked on its first 2,000 characters, never refused (v1 contract; GST-1304)', async () => {
      expect((await write(alice, [{ fact: 'Alice audits the harbor ledger canarylongquery', provenance: 'x' }])).structured!.status).toBe('committed');
      const head = 'harbor ledger budget canarylongquery ';
      const out = await recall(alice, head + 'filler words that pad the question '.repeat(80));
      expect(out.isError).toBe(false);
      expect(out.json.code).toBeUndefined();
      expect(out.text).toContain('canarylongquery');
      const tailOnly = await recall(alice, 'filler words that pad the question '.repeat(60) + ' harbor ledger budget');
      expect(tailOnly.isError).toBe(false);
    }, 60_000);

    test('query_keep "tail" ranks a long query on its last 2,000 characters and reports the cut in query_truncated; without it the v1 head cut is unchanged (#8694, v3)', async () => {
      await engine.insertFact({ fact: 'The harbor tea supplier is canarytailquery', kind: 'fact', entity_slug: null, source: 'test', visibility: 'world' }, { source_id: SRC });
      const preamble = 'You are the provider preamble for this turn and you follow the house style. '.repeat(30);
      const turn = ' which harbor tea supplier canarytailquery';
      try {
        resetGateway();
        configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: DIMS, env: {} });
        const tail = await recall(bob, preamble + turn, { query_keep: 'tail' });
        expect(tail.isError).toBe(false);
        expect(tail.text).toContain('canarytailquery');
        expect(tail.structured?.query_truncated).toBe(true);
        const head = await recall(bob, preamble + turn);
        expect(head.text).not.toContain('canarytailquery');
        expect('query_truncated' in (head.structured ?? {})).toBe(false);
        expect((await recall(bob, preamble + turn, { query_keep: 'head' })).structured?.query_truncated).toBe(true);
        expect((await recall(bob, turn, { query_keep: 'tail' })).structured?.query_truncated).toBe(false);
        const bad = await recall(bob, turn, { query_keep: 'middle' });
        expect({ isError: bad.isError, code: bad.json.code }).toEqual({ isError: true, code: 'invalid_params' });
      } finally {
        resetGateway();
        keyedEmbeddings();
      }
    }, 60_000);

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
