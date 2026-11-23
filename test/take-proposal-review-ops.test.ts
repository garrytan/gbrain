/**
 * The dream cycle's propose_takes phase queues LLM-proposed takes in take_proposals, and until now only the host CLI
 * (`gbrain takes propose --accept|--reject`) could review them, so an agent working for a person behind an MCP gateway
 * could not. takes_proposals_list / takes_proposal_get / takes_proposal_accept / takes_proposal_reject review the queue
 * over MCP.
 *
 * Protects: a remote caller lists and reads only proposals whose holder its takes-holder allow-list admits (others are
 * not_found); accept writes the take through the coordinated takes_add path (the take row exists, the proposal records
 * the row, the page version names the caller's agent label); edits mark the take's source "(edited)"; reject stores the
 * reason; acted_by is the agent label and acted_via the credential; a repeated decision returns
 * already_decided and the opposite decision is refused (proposal_already_decided); read scope cannot decide.
 * Fails when: the ops are missing, the holder fence or attribution is dropped, or a decision is not retry-safe.
 * Seams: the legacy bearer transport over a real socket with real tokens, on a repo-less PGLite brain.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { hashToken } from '../src/core/utils.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { startHttpTransport } from '../src/mcp/http-transport.ts';
import { RateLimiter } from '../src/mcp/rate-limit.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { AGENT_LABEL_HEADER } from '../src/core/persistence/attribution.ts';

const CONFIG = { engine: 'pglite', embedding_disabled: true } as const;
const GATEWAY = 'synthetic-proposal-gateway-' + process.pid;
const READER = 'synthetic-proposal-reader-' + process.pid;
const SLUG = 'companies/proposal-example';
const PAGE = '---\ntype: company\ntitle: Proposal Example\n---\n\n# Proposal Example\n\nA synthetic company page.\n';

async function addToken(engine: BrainEngine, name: string, token: string, scopes: string): Promise<void> {
  await engine.executeRaw('INSERT INTO access_tokens(name,token_hash,scopes) VALUES($1,$2,$3::text[])', [name, hashToken(token), scopes]);
}

describe('take-proposal review over MCP', () => {
  let engine: BrainEngine;
  let server: { port: number; stop: (force?: boolean) => unknown };
  let url: string;
  const ids: Record<string, number> = {};

  async function call(token: string, name: string, args: Record<string, unknown>, label?: string): Promise<{ isError: boolean; json: Record<string, any> }> {
    const response = await fetch(url, { method: 'POST',
      headers: { authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
        ...(label === undefined ? {} : { [AGENT_LABEL_HEADER]: label }) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    expect(response.status).toBe(200);
    const raw = await response.text();
    const body = JSON.parse(raw.startsWith('event:') || raw.startsWith('data:') ? raw.split('\n').find(l => l.startsWith('data:'))!.slice(5) : raw);
    const result = body.result ?? body;
    return { isError: result.isError === true, json: JSON.parse(result.content?.[0]?.text ?? '{}') };
  }
  async function propose(claim: string, holder: string, kind = 'take', weight = 0.7): Promise<number> {
    const [row] = await engine.executeRaw<{ id: number }>(
      `INSERT INTO take_proposals (source_id, page_slug, content_hash, prompt_version, proposal_run_id, claim_text, kind, holder, weight, model_id)
       VALUES ('default', $1, 'hash', 'v-test', 'run-test', $2, $3, $4, $5, 'synthetic-model') RETURNING id`,
      [SLUG, claim, kind, holder, weight]);
    return Number(row!.id);
  }
  const row = async (id: number) => (await engine.executeRaw<Record<string, any>>(
    'SELECT status, acted_by, acted_via, decision_reason, promoted_row_num FROM take_proposals WHERE id = $1', [id]))[0]!;
  const attributed = async (slug: string) => await operationsByName.get_write_attribution.handler({
    engine, sourceId: 'default', remote: false, config: CONFIG, logger: { info() {}, warn() {}, error() {} },
  } as unknown as OperationContext, { slug, versions: true }) as Record<string, any>;

  beforeAll(async () => {
    const db = new PGLiteEngine();
    await db.connect({});
    await db.initSchema();
    engine = db;
    await addToken(engine, 'Synthetic proposal gateway', GATEWAY, '{read,write}');
    await addToken(engine, 'Synthetic proposal reader', READER, '{read}');
    server = await startHttpTransport({ port: 0, engine, surface: 'full', limiters: {
      ip: new RateLimiter({ limit: 10_000, windowMs: 60_000, lruCap: 100 }),
      token: new RateLimiter({ limit: 10_000, windowMs: 60_000, lruCap: 100 }),
    } }) as unknown as { port: number; stop: (force?: boolean) => unknown };
    url = 'http://127.0.0.1:' + server.port + '/mcp';
    expect((await call(GATEWAY, 'put_page', { slug: SLUG, content: PAGE })).isError).toBe(false);
    ids.accept = await propose('Proposal-example ships weekly', 'world');
    ids.edit = await propose('Proposal-example hires slowly', 'world', 'hunch', 0.4);
    ids.reject = await propose('Proposal-example sells hardware', 'world');
    ids.hidden = await propose('Proposal-example is owned by the brain', 'brain');
  }, 120_000);

  afterAll(async () => {
    await server?.stop(true);
    await disposePersistenceConsumer(engine);
    await engine.disconnect();
  });

  test('list and get show only proposals the holder allow-list admits', async () => {
    const listed = await call(READER, 'takes_proposals_list', {});
    expect(listed.isError).toBe(false);
    const listedIds = (listed.json.proposals as Array<{ id: number }>).map(p => p.id).sort((a, b) => a - b);
    expect(listedIds).toEqual([ids.accept!, ids.edit!, ids.reject!].sort((a, b) => a - b));
    expect(listed.json.total).toBe(3);

    const filtered = await call(READER, 'takes_proposals_list', { kind: 'hunch', min_weight: 0.3 });
    expect((filtered.json.proposals as Array<{ id: number }>).map(p => p.id)).toEqual([ids.edit!]);

    const got = await call(READER, 'takes_proposal_get', { id: ids.accept });
    expect(got.isError).toBe(false);
    expect(got.json.page_slug).toBe(SLUG);
    expect(got.json.status).toBe('pending');
    expect(String(got.json.claim)).toContain('ships weekly');

    const hidden = await call(READER, 'takes_proposal_get', { id: ids.hidden });
    expect(hidden.isError).toBe(true);
    expect(hidden.json.code).toBe('not_found');
  }, 60_000);

  test('read scope cannot decide', async () => {
    const refused = await call(READER, 'takes_proposal_reject', { id: ids.reject });
    expect(refused.isError).toBe(true);
    expect((await row(ids.reject!)).status).toBe('pending');
  }, 60_000);

  test('accept writes the take as the caller and records its agent label', async () => {
    const accepted = await call(GATEWAY, 'takes_proposal_accept', { id: ids.accept }, 'alice@example.com');
    expect(accepted.isError).toBe(false);
    expect(accepted.json.status).toBe('accepted');
    const stored = await row(ids.accept!);
    expect(stored.status).toBe('accepted');
    expect(stored.acted_by).toBe('alice@example.com');
    expect(stored.acted_via).toBe('mcp:Synthetic proposal gateway');
    expect(Number(stored.promoted_row_num)).toBeGreaterThan(0);
    const takes = await engine.executeRaw<{ claim: string; holder: string; source: string | null }>(
      `SELECT t.claim, t.holder, t.source FROM takes t JOIN pages p ON p.id = t.page_id WHERE p.slug = $1 AND t.row_num = $2`,
      [SLUG, stored.promoted_row_num]);
    expect(takes[0]?.claim).toBe('Proposal-example ships weekly');
    expect(takes[0]?.source).toBe(`take_proposals#${ids.accept}`);
    expect((await attributed(SLUG)).last.agent_label).toBe('alice@example.com');

    // Retrying the same accept is a no-op that reports the recorded outcome.
    const again = await call(GATEWAY, 'takes_proposal_accept', { id: ids.accept }, 'alice@example.com');
    expect(again.isError).toBe(false);
    expect(again.json.already_decided).toBe(true);
    expect(again.json.promoted_row_num).toBe(Number(stored.promoted_row_num));
    // The opposite decision is refused and changes nothing.
    const flip = await call(GATEWAY, 'takes_proposal_reject', { id: ids.accept }, 'bob@example.com');
    expect(flip.isError).toBe(true);
    expect(flip.json.code).toBe('proposal_already_decided');
    expect((await row(ids.accept!)).acted_by).toBe('alice@example.com');
  }, 120_000);

  test('accept with edits marks the take edited; a holder outside the allow-list is refused', async () => {
    const outside = await call(GATEWAY, 'takes_proposal_accept', { id: ids.edit, holder: 'brain' }, 'alice@example.com');
    expect(outside.isError).toBe(true);
    expect(outside.json.code).toBe('permission_denied');
    expect((await row(ids.edit!)).status).toBe('pending');

    const edited = await call(GATEWAY, 'takes_proposal_accept', { id: ids.edit, claim: 'Proposal-example hires carefully', weight: 0.55 }, 'alice@example.com');
    expect(edited.isError).toBe(false);
    expect(edited.json.edited).toBe(true);
    const stored = await row(ids.edit!);
    const [take] = await engine.executeRaw<{ claim: string; weight: number; source: string | null; kind: string }>(
      `SELECT t.claim, t.weight, t.source, t.kind FROM takes t JOIN pages p ON p.id = t.page_id WHERE p.slug = $1 AND t.row_num = $2`,
      [SLUG, stored.promoted_row_num]);
    expect(take?.claim).toBe('Proposal-example hires carefully');
    expect(Number(take?.weight)).toBeCloseTo(0.55, 5);
    expect(take?.kind).toBe('hunch');
    expect(take?.source).toBe(`take_proposals#${ids.edit} (edited)`);
  }, 120_000);

  test('reject stores the reason and the reviewer; a repeat is already_decided', async () => {
    const rejected = await call(GATEWAY, 'takes_proposal_reject', { id: ids.reject, reason: 'Not supported by the page' }, 'bob@example.com');
    expect(rejected.isError).toBe(false);
    expect(rejected.json.status).toBe('rejected');
    const stored = await row(ids.reject!);
    expect(stored).toMatchObject({ status: 'rejected', acted_by: 'bob@example.com', acted_via: 'mcp:Synthetic proposal gateway', decision_reason: 'Not supported by the page' });
    expect((await call(GATEWAY, 'takes_proposal_reject', { id: ids.reject }, 'bob@example.com')).json.already_decided).toBe(true);
    const flip = await call(GATEWAY, 'takes_proposal_accept', { id: ids.reject }, 'alice@example.com');
    expect(flip.json.code).toBe('proposal_already_decided');

    const decided = await call(READER, 'takes_proposals_list', { status: 'rejected' });
    expect((decided.json.proposals as Array<{ id: number; reason: string }>).map(p => [p.id, p.reason])).toEqual([[ids.reject!, 'Not supported by the page']]);
  }, 60_000);
});
