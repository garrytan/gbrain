/**
 * GST-1158 F2: an attested call to a contract v3 personal tool answers with its result in structuredContent.
 *
 * 1. Protects: each v3 personal tool (query, get_page, get_timeline, get_backlinks, find_experts, whois, entity,
 *    context_pack, volunteer_context, get_write_request, forget_fact) called as an attested person returns its parsed
 *    result in structuredContent (an array as structuredContent.results), holding every field v3.json freezes, while
 *    content keeps the JSON (context_pack: its text alone, as memory_recall); its refusals carry structuredContent.error;
 *    a read whose answer with structuredContent passes the result cap is refused whole; unattested callers and other
 *    tools are unchanged.
 * 2. Fails when: a v3 tool's structuredContent is missing or drops a frozen field, content changes for a non-text tool,
 *    a refusal lacks structuredContent.error, an attested frame over the cap is sent, or the rewrite reaches an
 *    unattested call or a tool outside v3.
 * 3. Existing coverage: test/qm-memory-tools.test.ts pins the memory pair; test/qm-memory-contract.test.ts pins v3.json.
 * 4. Real seams: OAuth client-credentials tokens verified by the provider, MCP dispatch with x-qm-actor, a repo-less
 *    brain on PGLite and Postgres; writes through the persistence coordinator; no embedding provider (keyless).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { GBrainOAuthProvider } from '../src/core/oauth-provider.ts';
import { sqlQueryForEngine } from '../src/core/sql-query.ts';
import { dispatchToolCall, type ToolResult } from '../src/mcp/dispatch.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { addMember, bindCredential } from '../src/core/access/members.ts';
import { linkMember } from '../src/core/access/actor.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { QM_PERSONAL_OPS } from '../src/core/ops/qm-memory.ts';
import { mintLegacyToken } from '../src/core/token-mint.ts';
import { startHttpTransport } from '../src/mcp/http-transport.ts';
import { RateLimiter } from '../src/mcp/rate-limit.ts';
import { QM_CONTRACT_PATHS } from '../scripts/build-qm-memory-contract.ts';
import type { AuthInfo } from '../src/core/ops/contract.ts';
import { testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

const SRC = 'source-a';
const ALICE_ID = 'U0ALICE';
const PERSON = 'people/bob-example';
const COMPANY = 'companies/acme-example';
const BIG = 'notes/big-example';

/** Checks a value against a v3 frozen shape: a type string, a one-row array of shapes, or an object of shapes. */
function conforms(shape: unknown, value: unknown, at = '$'): string[] {
  if (Array.isArray(shape)) {
    if (!Array.isArray(value)) return [at + ' is not an array'];
    return value.flatMap((v, i) => conforms(shape[0], v, at + '[' + i + ']'));
  }
  if (shape && typeof shape === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return [at + ' is not an object'];
    return Object.entries(shape).flatMap(([k, s]) => k in (value as object) ? conforms(s, (value as Record<string, unknown>)[k], at + '.' + k) : [at + '.' + k + ' is missing']);
  }
  const ok = String(shape).split(' | ').some(t => {
    if (t.startsWith('"')) return value === JSON.parse(t);
    if (t === 'null') return value === null;
    if (t === 'array') return Array.isArray(value);
    if (t === 'object') return !!value && typeof value === 'object' && !Array.isArray(value);
    return typeof value === t;
  });
  return ok ? [] : [at + ' is ' + JSON.stringify(value) + ', not ' + String(shape)];
}

const v3 = JSON.parse(readFileSync(QM_CONTRACT_PATHS[3], 'utf8'));
const frozen = (op: string) => v3.personal_tools.tools.find((t: { name: string }) => t.name === op).result;

for (const kind of testBackends()) {
  describe('contract v3 personal tools over MCP dispatch (' + kind + ', repo-less)', () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    const provider = () => new GBrainOAuthProvider({ sql: sqlQueryForEngine(engine), transaction: fn => engine.transaction(tx => fn(sqlQueryForEngine(tx))) });
    const tokens: Record<string, string> = {};
    let receipt = '';
    let factId = 0;

    async function call(token: string, op: string, params: Record<string, unknown>, actor: string | null = ALICE_ID) {
      const out: ToolResult = await dispatchToolCall(engine, op, { ...params }, {
        remote: true, transport: 'http', auth: await provider().verifyAccessToken(tokens[token]!) as unknown as AuthInfo, sourceId: SRC,
        ...(actor !== null ? { actor: { header: actor } } : {}), writeWaitMs: 30_000,
      });
      let json: unknown = undefined;
      try { json = JSON.parse(out.content[0]?.text ?? ''); } catch { /* plain text */ }
      return { out, json, structured: out.structuredContent as Record<string, any> | undefined };
    }
    const local = (op: string, params: Record<string, unknown>) => dispatchToolCall(engine, op, params, { remote: false, sourceId: SRC });

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema(); close = () => engine.disconnect(); }
      __resetPrivateVisibilityCacheForTests();
      await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [SRC]);
      await addMember(engine, 'alice-example');
      await importFromContent(engine, PERSON, '---\ntype: person\ntitle: Bob Example\nemail: bob@acme-example.test\n---\n# Bob Example\n\nBob Example keeps the harbor ledger at [[' + COMPANY + ']].\n', { sourceId: SRC });
      await importFromContent(engine, COMPANY, '---\ntype: company\ntitle: Acme Example\n---\n# Acme Example\n\nAcme Example harbor ledger budget notes.\n', { sourceId: SRC });
      await importFromContent(engine, BIG, '---\ntype: note\ntitle: Big Example\n---\n# Big Example\n\n' + 'harbor ledger row '.repeat(8_000) + '\n', { sourceId: SRC });
      expect((await local('add_timeline_entry', { slug: COMPANY, date: '2026-09-02', summary: 'Acme Example opened a harbor office' })).isError).toBeFalsy();
      expect((await local('add_link', { from: PERSON, to: COMPANY, link_type: 'works_at' })).isError).toBeFalsy();
      const register = async (name: string) => {
        const c = await provider().registerClientManual('v3-' + name + '-' + randomUUID().slice(0, 8), ['client_credentials'], 'read write', [], SRC);
        tokens[name] = (await provider().exchangeClientCredentials(c.clientId, c.clientSecret ?? '')).access_token;
        return c.clientId;
      };
      await bindCredential(engine, { kind: 'client', id: await register('qm') }, { attestActor: 'qm', attestOps: [...QM_PERSONAL_OPS, 'memory_recall', 'memory_write', 'get_links'] });
      await register('plain');
      await linkMember(engine, 'alice-example', 'qm', ALICE_ID);
      const saved = await call('qm', 'memory_write', { facts: [{ fact: 'Alice prefers the harbor ledger review on Mondays', provenance: 'turn 1' }], idempotency_key: randomUUID() });
      receipt = saved.structured!.request_id;
      factId = Number(saved.structured!.fact_ids[0]);
    }, 120_000);

    afterAll(async () => {
      await disposePersistenceConsumer(engine).catch(() => undefined);
      await close?.();
    });

    test('each personal tool answers an attested call with its parsed result in structuredContent, holding every frozen field', async () => {
      const cases: Array<[string, Record<string, unknown>, string?]> = [
        ['query', { query: 'harbor ledger' }],
        ['get_page', { slug: PERSON }],
        ['get_timeline', { slug: COMPANY }],
        ['get_backlinks', { slug: COMPANY }],
        ['get_backlinks', { slug: COMPANY, group: 'page' }, 'with_group_page'],
        ['find_experts', { topic: 'harbor ledger' }],
        ['whois', { query: 'bob@acme-example.test' }],
        ['whois', { query: 'Nobody Example' }],
        ['entity', { name: 'Bob Example' }],
        ['entity', { name: 'Nobody Example' }],
        ['entity', { names: ['Bob Example', 'Nobody Example'] }, 'with_names'],
        ['context_pack', { entities: 'Bob Example' }],
        ['volunteer_context', { window: 'user: I am meeting Bob Example about the Acme Example harbor ledger' }],
        ['get_write_request', { request_id: receipt }],
        ['forget_fact', { id: factId, request_id: randomUUID() }],
      ];
      const seen = new Set<string>();
      for (const [op, params, variant] of cases) {
        const { out, json, structured } = await call('qm', op, params);
        expect({ op, isError: out.isError === true }).toEqual({ op, isError: false });
        expect({ op, has: structured !== undefined }).toEqual({ op, has: true });
        const result = frozen(op);
        const shape = variant ? result[variant] : result.structured_content;
        expect({ op, params, problems: conforms(shape, structured) }).toEqual({ op, params, problems: [] });
        if (op === 'context_pack') {
          expect(out.content).toHaveLength(1);
          expect(typeof out.content[0]!.text).toBe('string');
          expect(out.content[0]!.text).toContain('Bob Example');
          expect(structured!.text).toBeUndefined();
        } else {
          expect(structured).toEqual(Array.isArray(json) ? { results: json } : json as Record<string, unknown>);
        }
        seen.add(op);
      }
      expect([...seen].sort()).toEqual([...QM_PERSONAL_OPS].sort());
      const rows = (await call('qm', 'query', { query: 'harbor ledger' })).structured!.results;
      expect(rows.length).toBeGreaterThan(0);
      expect((await call('qm', 'whois', { query: 'bob@acme-example.test' })).structured).toMatchObject({ ambiguous: false, matches: [{ slug: PERSON, source_id: SRC }] });
      expect((await call('qm', 'get_write_request', { request_id: receipt })).structured!.state).toBe('committed');
      expect(frozen('get_write_request').states.known).toContain('committed');
    }, 120_000);

    test('a refusal of a personal tool under attestation carries structuredContent.error with its code', async () => {
      const cases: Array<[string, Record<string, unknown>, string]> = [
        ['get_page', { slug: 'people/nobody-example' }, 'page_not_found'],
        ['get_write_request', { request_id: randomUUID() }, 'not_found'],
        ['forget_fact', { id: 987_654_321 }, 'fact_not_found'],
        ['query', {}, 'invalid_params'],
      ];
      for (const [op, params, code] of cases) {
        const { out, json } = await call('qm', op, params);
        expect({ op, isError: out.isError, code: (json as Record<string, unknown>).code }).toEqual({ op, isError: true, code });
        expect(out.structuredContent?.error).toMatchObject({ code, message: (json as Record<string, unknown>).message });
        expect(v3.errors.codes.map((c: { code: string }) => c.code)).toContain(code);
      }
    }, 60_000);

    test('unattested calls and tools outside v3 are unchanged: no structuredContent, the same JSON content', async () => {
      const plain = await call('plain', 'get_page', { slug: PERSON }, null);
      expect(plain.out.isError).toBeFalsy();
      expect(plain.structured).toBeUndefined();
      expect((plain.json as Record<string, unknown>).slug).toBe(PERSON);
      const missing = await call('plain', 'get_page', { slug: 'people/nobody-example' }, null);
      expect(missing.out.isError).toBe(true);
      expect(missing.structured).toBeUndefined();
      const attestedOther = await call('qm', 'get_links', { slug: PERSON });
      expect(attestedOther.out.isError).toBeFalsy();
      expect(attestedOther.structured).toBeUndefined();
      expect(Array.isArray(attestedOther.json)).toBe(true);
      const plainQuery = await call('plain', 'query', { query: 'harbor ledger' }, null);
      expect(plainQuery.structured).toBeUndefined();
      expect(Array.isArray(plainQuery.json)).toBe(true);
    }, 60_000);

    test('the transport\'s scope refusal of a personal tool carries structuredContent.error under x-qm-actor, and not without it', async () => {
      const legacy = await mintLegacyToken(engine, { name: 'v3-read-' + randomUUID().slice(0, 8), scopes: ['read'], takesHolders: ['world'], sourceGrant: [SRC] });
      await bindCredential(engine, { kind: 'token', id: legacy.id }, { attestActor: 'qm', attestOps: [...QM_PERSONAL_OPS] });
      const server = await startHttpTransport({ port: 0, engine, surface: 'full', limiters: {
        ip: new RateLimiter({ limit: 10_000, windowMs: 60_000, lruCap: 100 }),
        token: new RateLimiter({ limit: 10_000, windowMs: 60_000, lruCap: 100 }),
      } });
      try {
        const post = async (headers: Record<string, string>) => {
          const res = await fetch('http://127.0.0.1:' + server.port + '/mcp', {
            method: 'POST', headers: { authorization: 'Bearer ' + legacy.token, 'content-type': 'application/json', ...headers },
            body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'forget_fact', arguments: { id: factId } } }),
          });
          return (await res.json() as { result: Record<string, any> }).result;
        };
        const attested = await post({ 'x-qm-actor': ALICE_ID });
        expect(attested.isError).toBe(true);
        expect(attested.structuredContent.error).toMatchObject({ code: 'insufficient_scope' });
        const bare = await post({});
        expect(bare.isError).toBe(true);
        expect(bare.structuredContent).toBeUndefined();
      } finally {
        server.stop(true);
      }
    }, 60_000);

    test('an attested read whose answer with structuredContent passes the result cap is refused whole; the unattested read still fits', async () => {
      await engine.setConfig('mcp.max_result_bytes_http', String(256 * 1024));
      try {
        const plain = await call('plain', 'get_page', { slug: BIG, body: 'full' }, null);
        expect(plain.out.isError).toBeFalsy();
        const attested = await call('qm', 'get_page', { slug: BIG, body: 'full' });
        expect({ isError: attested.out.isError, code: (attested.json as Record<string, unknown>).code }).toEqual({ isError: true, code: 'result_too_large' });
        expect(attested.out.structuredContent?.error).toMatchObject({ code: 'result_too_large' });
        const window = await call('qm', 'get_page', { slug: BIG, body: 'outline' });
        expect(window.out.isError).toBeFalsy();
        expect(conforms(frozen('get_page').structured_content, window.structured)).toEqual([]);
        expect(window.structured!.body).toBe('outline');
      } finally {
        await engine.setConfig('mcp.max_result_bytes_http', String(1024 * 1024));
      }
    }, 60_000);
  });
}
