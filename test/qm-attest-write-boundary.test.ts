/**
 * GST-2249 W1: an attested call (x-qm-actor) never writes a page every reader of it sees without the owner's approval.
 *
 * 1. Protects: every attestable mutating operation in the registry is either deferred (refused at --attest-ops, at
 *    every call and when a stored write is re-resolved) or reviewed here as not a page write; an attested remember with
 *    share: true or visibility "world" is refused (attested_share_refused) at the call, in a batch and when a stored
 *    write carrying it is prepared, and nothing is saved; the attested writeback instructions never offer share: true
 *    and name memory_propose instead.
 * 2. Fails when: a new page-writing operation becomes attestable without a decision, the share refusal is skipped on
 *    any path, or the instructions tell QM to share.
 * 3. Existing coverage: test/access-qm-actor.test.ts calls every deferred operation attested and checks the refusal;
 *    test/remember-share-gst2243.test.ts keeps member-bound credentials' share: true.
 * 4. Real seams: OAuth client-credentials tokens with the attest right, MCP dispatch as a remote caller, the stored
 *    write's preparation, a repo-less brain on PGLite and Postgres.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { __resetHotMemoryCacheForTests } from '../src/core/facts/meta-hook.ts';
import { addMember, bindCredential } from '../src/core/access/members.ts';
import { ACTOR_DEFERRED_OPS, attestableOp, linkMember } from '../src/core/access/actor.ts';
import { operations } from '../src/core/operations.ts';
import { prepareMemoryMutation } from '../src/core/persistence/memory-prepare.ts';
import { ambientOptsFrom, writebackCaller } from '../src/core/facts/writeback-config.ts';
import { buildAmbientWritebackSection } from '../src/core/facts/writeback-instructions.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

/**
 * Attestable mutating operations that write nothing another person reads or relies on, each with the reason. A row
 * here is a reviewed claim; rate_answer, log_ingest and loops_mute|unmute were deferred because their rows are shared.
 */
const NOT_PAGE_WRITES: Record<string, string> = {
  remember: "the person's own member page; share: true is refused when attested",
  memory_write: "the person's own member page, or a scope page the credential's attest_sources allows",
  forget: "withdraws the person's own member-page facts",
  forget_fact: "withdraws one of the person's own member-page facts",
  memory_propose: 'holds the write for the brain owner; nothing is written until the owner approves',
  cancel_write_request: "cancels the caller's own queued request",
  memory_conversation_mode: 'returns a rule for the conversation and stores nothing',
  mute_notice: 'a local notice mute list, outside the brain database',
  request_tools: "the calling client's own MCP tool surface",
  think: 'read-only for remote callers; only a local --save writes',
  submit_agent: "queues a job; every tool call it makes is re-resolved against the deferred operations",
};

describe('W1: the attested write boundary is built from the registry', () => {
  test('every attestable mutating operation is deferred or reviewed as not a page write', () => {
    const unclassified = operations.filter(op => op.mutating && !ACTOR_DEFERRED_OPS.has(op.name) && attestableOp(op.name, op) && !(op.name in NOT_PAGE_WRITES));
    expect(unclassified.map(op => op.name)).toEqual([]);
    for (const name of ACTOR_DEFERRED_OPS) expect(operations.some(op => op.name === name)).toBe(true);
    for (const name of Object.keys(NOT_PAGE_WRITES)) {
      expect({ name, deferred: ACTOR_DEFERRED_OPS.has(name), mutating: operations.find(op => op.name === name)?.mutating }).toEqual({ name, deferred: false, mutating: true });
    }
  });
});

const DIMS = 1536;
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

const SRC = 'qm-w1';
const ALICE_ID = 'U0ALICE';
const ACME = 'companies/acme-example';

for (const kind of testBackends()) {
  describe('W1: an attested remember never shares (' + kind + ', repo-less)', () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    let qmToken = '';
    const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
    const verify = async (bearer: string) => await provider().verifyAccessToken(bearer) as unknown as AuthInfo;
    async function remember(params: Record<string, unknown>) {
      const out = await dispatchToolCall(engine, 'remember', { provenance: 'qm test', ...params }, {
        remote: true, transport: 'http', auth: await verify(qmToken), sourceId: SRC, actor: { header: ALICE_ID },
      });
      const text = out.content.map(c => c.text).join('\n');
      return { isError: out.isError === true, all: text + JSON.stringify(out.structuredContent ?? {}) };
    }
    const factRow = async (canary: string) => (await engine.executeRaw<Record<string, unknown>>('SELECT visibility, source_markdown_slug FROM facts WHERE fact LIKE $1', ['%' + canary + '%']))[0];

    beforeAll(async () => {
      configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'test' } });
      __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({ embeddings: values.map(vectorFor) })) as never);
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      __resetPrivateVisibilityCacheForTests();
      __resetHotMemoryCacheForTests();
      await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [SRC]);
      await addMember(engine, 'alice-example');
      await importFromContent(engine, ACME, '---\ntype: company\ntitle: Acme Example\n---\n# Acme Example\n\nAcme example builds harbor ledgers.', { sourceId: SRC });
      const c = await provider().registerClientManual('w1-qm-' + randomUUID().slice(0, 8), ['client_credentials'], 'read write', [], SRC);
      await bindCredential(engine, { kind: 'client', id: c.clientId }, { attestActor: 'qm', attestOps: ['get_write_request', 'memory_write', 'remember'] });
      qmToken = (await provider().exchangeClientCredentials(c.clientId, c.clientSecret ?? '')).access_token;
      await linkMember(engine, 'alice-example', 'qm', ALICE_ID);
    }, 120_000);

    afterAll(async () => { __setEmbedTransportForTests(null); resetGateway(); await close?.(); });

    test('share: true and visibility "world" are refused at the call and in a batch, and nothing is saved', async () => {
      for (const extra of [{ share: true }, { visibility: 'world' }]) {
        const out = await remember({ fact: 'Acme renewed for 40 seats canaryw1share', entity: ACME, ...extra });
        expect({ isError: out.isError, refused: out.all.includes('attested_share_refused'), remedy: out.all.includes('memory_propose') }).toEqual({ isError: true, refused: true, remedy: true });
      }
      const batch = await remember({ items: [{ fact: 'Acme pays net 30 canaryw1batch', entity: ACME }], share: true });
      expect({ isError: batch.isError, refused: batch.all.includes('attested_share_refused') }).toEqual({ isError: true, refused: true });
      expect(await factRow('canaryw1share')).toBeUndefined();
      expect(await factRow('canaryw1batch')).toBeUndefined();
      const kept = await remember({ fact: 'Acme audit worried me canaryw1kept', entity: ACME });
      expect(kept.isError).toBe(false);
      expect(await factRow('canaryw1kept')).toMatchObject({ visibility: 'private', source_markdown_slug: 'memory/members/alice-example' });
    }, 120_000);

    test('a shared agent acting for an audience (on_behalf_of, not an attested person) still shares', async () => {
      const c = await provider().registerClientManual('w1-shared-' + randomUUID().slice(0, 8), ['client_credentials'], 'read write', [], SRC);
      await bindCredential(engine, { kind: 'client', id: c.clientId }, { mayActFor: ['member:alice-example'] });
      const auth = await verify((await provider().exchangeClientCredentials(c.clientId, c.clientSecret ?? '')).access_token);
      const out = await dispatchToolCall(engine, 'remember', { fact: 'Acme renewed canaryw1audience', provenance: 'qm test', entity: ACME, share: true },
        { remote: true, transport: 'http', auth, sourceId: SRC, onBehalfOf: { header: 'member:alice-example' } });
      expect(out.isError === true).toBe(false);
      expect(await factRow('canaryw1audience')).toMatchObject({ visibility: 'world', source_markdown_slug: ACME });
    }, 120_000);

    test('a stored shared save made for a person is refused when it is prepared', async () => {
      const [page] = await engine.executeRaw<{ id: number }>('SELECT id FROM pages WHERE source_id = $1 AND slug = $2', [SRC, ACME]);
      const row = { operation: 'remember', request_id: 'w1-prepare-' + randomUUID().slice(0, 6), source_id: SRC, slug: ACME, page_id: page!.id,
        authority: { remote: true, actingFor: { system: 'qm', external_id: ALICE_ID, member: 'alice-example' } },
        intent: { fact: 'Acme signs in June canaryw1stored', kind: 'fact', visibility: 'world', visibility_defaulted: true, share: true, entity_slug: ACME, fence: true, valid_from: new Date().toISOString() } };
      await expect(prepareMemoryMutation(engine, row as never, {} as never)).rejects.toMatchObject({ code: 'invalid_params', reason: 'attested_share_refused' });
      expect(await factRow('canaryw1stored')).toBeUndefined();
    }, 120_000);

    test('the writeback instructions for a service acting for a person never offer share: true', async () => {
      const opts = ambientOptsFrom({ enabled: true, mode: 'salient', transient_ttl: '3d', visibility: 'world' } as never, { remember: true, extractFacts: true, ...writebackCaller(await verify(qmToken)) });
      const section = buildAmbientWritebackSection(opts!);
      expect(section).toContain('never pass share: true');
      expect(section).toContain('memory_propose');
      expect(section).not.toContain('share: true shares');
    }, 60_000);
  });
}
