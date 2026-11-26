/**
 * GST-3849 PR 2: the Google token socket's contract, argument rules, write
 * broker and minting, on fakes (no network, synthetic accounts only).
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TokenRedactor } from '../src/commands/google-socket.ts';
import { FileVaultBackend, type CredentialEntry } from '../src/core/creds/vault.ts';
import { GoogleBroker, MAX_HELD, argsHash, VERDICT_TTL_MS, type GateResult } from '../src/core/google-socket/broker.ts';
import { BrokerLedger } from '../src/core/google-socket/ledger.ts';
import { GoogleMcpClient, McpTransportError, toolErrorReason, type ToolCallOutcome } from '../src/core/google-socket/mcp-client.ts';
import { DAY_CALL_CAP, applyArgumentRules } from '../src/core/google-socket/policy.ts';
import { brokerGate, parsePeerList } from '../src/core/google-socket/preconditions.ts';
import { SocketError, parseRequest } from '../src/core/google-socket/protocol.ts';
import { SocketTokens } from '../src/core/google-socket/tokens.ts';

const ACCOUNT = 'alice@example.com';
const GMAIL_RO = 'https://www.googleapis.com/auth/gmail.readonly';
const GMAIL_MODIFY = 'https://www.googleapis.com/auth/gmail.modify';
const CAL_EVENTS = 'https://www.googleapis.com/auth/calendar.events';
const CLIENT = '100001-personala.apps.googleusercontent.com';

const tmp = () => mkdtempSync(join(tmpdir(), 'gbrain-gsock-'));
const code = (fn: () => unknown): string => { try { fn(); return 'none'; } catch (e) { return (e as SocketError).code; } };

describe('protocol', () => {
  test('versions 1 to 3 are refused with unsupported_version', () => {
    for (const v of [1, 2, 3, undefined]) expect(code(() => parseRequest({ v, op: 'mint', account: ACCOUNT, profile: 'ingest', caller: 'x' }))).toBe('unsupported_version');
  });
  test('owner_verdict carries ALLOW_ONCE only', () => {
    const base = { v: 4, op: 'call', account: ACCOUNT, server: 'gmail', tool: 'create_draft', args: {}, turn_id: 't1', idempotency_key: 'k1', caller: 'bridge' };
    expect(code(() => parseRequest({ ...base, owner_verdict: { choice: 'ALLOW_TOOL_ALWAYS', for_request: 'r' } }))).toBe('broker_args_refused');
    expect((parseRequest({ ...base, owner_verdict: { choice: 'ALLOW_ONCE', for_request: 'r' } }) as { owner_verdict?: unknown }).owner_verdict).toEqual({ choice: 'ALLOW_ONCE', for_request: 'r' });
  });
  test('turn_id is at most 128 printable characters, and Chat is not a server', () => {
    const base = { v: 4, op: 'call', account: ACCOUNT, server: 'gmail', tool: 'create_draft', args: {}, idempotency_key: 'k1', caller: 'bridge' };
    expect(code(() => parseRequest({ ...base, turn_id: 'x'.repeat(129) }))).toBe('malformed_request');
    expect(code(() => parseRequest({ ...base, turn_id: 'run-1', server: 'chat' }))).toBe('tool_not_allowed');
  });
});

describe('argument rules', () => {
  test('calendar writes are forced to notificationLevel NONE, and any other level is refused', () => {
    expect(applyArgumentRules(ACCOUNT, 'calendar', 'create_event', { summary: 's' }).args.notificationLevel).toBe('NONE');
    expect(code(() => applyArgumentRules(ACCOUNT, 'calendar', 'update_event', { notificationLevel: 'ALL' }))).toBe('broker_args_refused');
  });
  test('outside invitees are counted by domain; drafts are capped at 20 recipients; tools off the list are refused', () => {
    expect(applyArgumentRules(ACCOUNT, 'calendar', 'create_event', { attendees: [{ email: 'bob@example.com' }, { email: 'carol@acme-example.com' }] }).outside).toBe(1);
    const to = Array.from({ length: 21 }, (_, i) => `p${i}@example.com`).join(',');
    expect(code(() => applyArgumentRules(ACCOUNT, 'gmail', 'create_draft', { to }))).toBe('broker_args_refused');
    expect(code(() => applyArgumentRules(ACCOUNT, 'gmail', 'send_message', {}))).toBe('tool_not_allowed');
    expect(applyArgumentRules(ACCOUNT, 'gmail', 'trash_thread', { threadId: 't' }).trash).toBe(true);
  });
});

describe('activation gate', () => {
  const open = () => 0o40755;
  const closed = () => 0o40700;
  test('every unmet item is named; a fully met gate turns call on', () => {
    expect(brokerGate({}, 1000, '/h', closed).unmet.length).toBe(3);
    expect(brokerGate({ broker_act: true, socket_peers: [1001], broker_joint_probe: 4 }, 1000, '/h', closed)).toEqual({ ok: true, unmet: [], rootGateway: false });
    expect(brokerGate({ broker_act: true, socket_peers: [1001], broker_joint_probe: 4 }, 1000, '/h', open).ok).toBe(false);
    expect(brokerGate({ broker_act: true, socket_peers: [1000], broker_joint_probe: 4 }, 1000, '/h', closed).ok).toBe(false);
  });
  test('a root peer needs the root-gateway opt-in, which skips the home read check; a root broker never passes', () => {
    const cfg = { broker_act: true, socket_peers: [0], broker_joint_probe: 4 };
    expect(brokerGate(cfg, 1000, '/h', open).ok).toBe(false);
    expect(brokerGate({ ...cfg, broker_allow_root_gateway: true }, 1000, '/h', open)).toEqual({ ok: true, unmet: [], rootGateway: true });
    expect(brokerGate({ ...cfg, broker_allow_root_gateway: true }, 0, '/h', closed).unmet).toEqual([expect.stringContaining('runs as root'), expect.stringContaining('own uid')]);
    expect(brokerGate({ ...cfg, socket_peers: [1000], broker_allow_root_gateway: true }, 1000, '/h', closed).ok).toBe(false);
    expect(() => parsePeerList('abc')).toThrow();
    expect(parsePeerList('0, 1001,1001')).toEqual([0, 1001]);
  });
});

const PROMPT: ToolCallOutcome = { kind: 'input_required', prompt: { message: 'Allow\u0007 the agent to create a draft?', choices: ['ALLOW_ONCE', 'ALLOW_TOOL_ALWAYS', 'DENY'], field: 'choice', inputKey: 'k', requestState: 's1' } };
const DONE: ToolCallOutcome = { kind: 'complete', result: { content: [{ type: 'text', text: 'ok' }] }, isError: false, text: 'ok' };

function rig(opts: { gate?: Partial<GateResult>; outcomes?: Array<ToolCallOutcome | Error>; gmailUsedToday?: number } = {}) {
  let t = Date.parse('2026-11-25T12:00:00Z');
  const now = () => t;
  const outcomes = [...(opts.outcomes ?? [])];
  const sent: Array<{ tool: string; args: Record<string, unknown>; answer?: { choice: string } }> = [];
  let generation = 1;
  const client = {
    callTool: async (_s: string, _token: string, tool: string, args: Record<string, unknown>, answer?: { choice: string }) => {
      sent.push({ tool, args, ...(answer ? { answer: { choice: answer.choice } } : {}) });
      const next = outcomes.shift() ?? DONE;
      if (next instanceof Error) throw next;
      return next;
    },
    listTools: async () => [{ name: 'create_draft', description: 'd', inputSchema: {} }, { name: 'send_chat', description: 'x', inputSchema: {} }],
  } as unknown as GoogleMcpClient;
  const tokens = {
    actToken: async (account: string) => ({ token: 'ya29.act', generation, client_id: CLIENT, account }),
    generationOf: async () => generation,
    dropAct: () => {},
  } as unknown as SocketTokens;
  const audit: string[][] = [];
  const statePath = join(tmp(), 'state.json');
  if (opts.gmailUsedToday) writeFileSync(statePath, JSON.stringify({ intents: {}, quota: { '2026-11-25': { gmail: opts.gmailUsedToday } } }));
  const ledger = new BrokerLedger(statePath, now);
  const broker = new GoogleBroker({
    tokens, client, ledger, audit: f => audit.push(f), now,
    gate: () => ({ ok: true, unmet: [], rootGateway: false, ...opts.gate }),
  });
  const call = (over: Record<string, unknown> = {}) => broker.call({ op: 'call', account: ACCOUNT, server: 'gmail', tool: 'create_draft', args: { to: 'bob@example.com', subject: 's' },
    turn_id: 'turn-1', idempotency_key: 'intent-1', caller: 'bridge', ...over } as never);
  return { broker, ledger, call, sent, audit, advance: (ms: number) => { t += ms; }, reconnect: () => { generation++; } };
}

describe('write broker', () => {
  test('off until the gate passes, and every reply carries the quota object', async () => {
    const r = rig({ gate: { ok: false, unmet: ['google.broker_act is false'] } });
    const reply = await r.call();
    expect(reply).toMatchObject({ ok: false, code: 'broker_precondition_unmet', quota: { product: 'gmail', used_today: 0, cap: DAY_CALL_CAP } });
    expect(r.sent).toEqual([]);
  });

  test('Google\'s prompt is relayed; a repeat with owner_verdict ALLOW_ONCE answers it once', async () => {
    const r = rig({ outcomes: [PROMPT, DONE] });
    const first = await r.call();
    expect(first).toMatchObject({ ok: false, code: 'input_required', choices: ['ALLOW_ONCE', 'ALLOW_TOOL_ALWAYS', 'DENY'], message_md: 'Allow the agent to create a draft?' });
    expect(await r.call()).toMatchObject({ code: 'input_required', request_id: first.request_id });
    const answered = await r.call({ owner_verdict: { choice: 'ALLOW_ONCE', for_request: first.request_id } });
    expect(answered).toMatchObject({ ok: true, result: DONE.kind === 'complete' ? DONE.result : null });
    expect(r.sent.map(s => s.answer?.choice ?? null)).toEqual([null, 'ALLOW_ONCE']);
    expect(await r.call({ owner_verdict: { choice: 'ALLOW_ONCE', for_request: first.request_id } })).toMatchObject({ ok: true, replayed: true });
    expect(r.sent.length).toBe(2);
  });

  test('a verdict for another request, after 10 minutes, or after a reconnect never answers Google', async () => {
    const a = rig({ outcomes: [PROMPT] });
    await a.call();
    expect(await a.call({ owner_verdict: { choice: 'ALLOW_ONCE', for_request: 'someone-else' } })).toMatchObject({ code: 'verdict_mismatch' });
    const b = rig({ outcomes: [PROMPT] });
    const held = await b.call();
    b.advance(VERDICT_TTL_MS + 1);
    expect(await b.call({ owner_verdict: { choice: 'ALLOW_ONCE', for_request: held.request_id } })).toMatchObject({ code: 'verdict_expired' });
    const c = rig({ outcomes: [PROMPT] });
    const held2 = await c.call();
    c.reconnect();
    expect(await c.call({ owner_verdict: { choice: 'ALLOW_ONCE', for_request: held2.request_id } })).toMatchObject({ code: 'verdict_expired' });
    expect([a, b, c].map(x => x.sent.length)).toEqual([1, 1, 1]);
  });

  test('the second outside invite in a turn pauses for the owner; owner_verdict cannot pass it, the owner\'s channel can', async () => {
    const r = rig();
    const invite = (key: string, email: string) => r.call({ server: 'calendar', tool: 'create_event', idempotency_key: key, args: { summary: 'x', attendees: [{ email }] } });
    expect(await invite('i1', 'one@acme-example.com')).toMatchObject({ ok: true });
    const paused = await invite('i2', 'two@acme-example.com');
    expect(paused).toMatchObject({ code: 'owner_confirm_required' });
    expect(await r.call({ server: 'calendar', tool: 'create_event', idempotency_key: 'i2', args: { summary: 'x', attendees: [{ email: 'two@acme-example.com' }] },
      owner_verdict: { choice: 'ALLOW_ONCE', for_request: paused.request_id } })).toMatchObject({ code: 'owner_confirm_required' });
    expect(r.sent.length).toBe(1);
    expect(await r.broker.verdict({ op: 'verdict', request_id: paused.request_id as string, choice: 'ALLOW_ONCE' })).toMatchObject({ ok: true, confirmed: true });
    expect(await invite('i2', 'two@acme-example.com')).toMatchObject({ ok: true });
    expect(r.sent[1]!.args.notificationLevel).toBe('NONE');
  });

  test('a confirmed pause is re-checked against the grant, and an unconfirmed one expires after 10 minutes', async () => {
    const r = rig();
    const invite = (key: string, email: string) => r.call({ server: 'calendar', tool: 'create_event', idempotency_key: key, args: { summary: 'x', attendees: [{ email }] } });
    await invite('i1', 'one@acme-example.com');
    const paused = await invite('i2', 'two@acme-example.com');
    await r.broker.verdict({ op: 'verdict', request_id: paused.request_id as string, choice: 'ALLOW_ONCE' });
    r.reconnect();
    expect(await invite('i2', 'two@acme-example.com')).toMatchObject({ code: 'verdict_expired' });
    const late = await invite('i3', 'three@acme-example.com');
    expect(late).toMatchObject({ code: 'owner_confirm_required' });
    r.advance(VERDICT_TTL_MS + 1);
    expect(await r.broker.verdict({ op: 'verdict', request_id: late.request_id as string, choice: 'ALLOW_ONCE' })).toMatchObject({ code: 'verdict_expired' });
    expect(await invite('i3', 'three@acme-example.com')).toMatchObject({ code: 'verdict_expired' });
    expect(r.sent.length).toBe(1);
  });

  test('the owner channel sends Google the exact choice once; a second answer at the same time is refused', async () => {
    const r = rig({ outcomes: [PROMPT, DONE] });
    const held = await r.call();
    const [a, b] = await Promise.all([
      r.broker.verdict({ op: 'verdict', request_id: held.request_id as string, choice: 'DENY' }),
      r.call({ owner_verdict: { choice: 'ALLOW_ONCE', for_request: held.request_id } }),
    ]);
    expect(a).toMatchObject({ ok: true });
    expect(b).toMatchObject({ ok: false });
    expect(r.sent.map(s => s.answer?.choice ?? null)).toEqual([null, 'DENY']);
  });

  test('parallel calls in one turn reserve the pause counters before they send', async () => {
    const r = rig();
    const invite = (key: string, email: string) => r.call({ server: 'calendar', tool: 'create_event', idempotency_key: key, args: { summary: 'x', attendees: [{ email }] } });
    const [a, b] = await Promise.all([invite('p1', 'one@acme-example.com'), invite('p2', 'two@acme-example.com')]);
    expect([a.ok, b.code]).toEqual([true, 'owner_confirm_required']);
    expect(r.sent.length).toBe(1);
  });

  test('a throttled call can be retried under the same key; turning the broker off stops a held prompt', async () => {
    const r = rig({ outcomes: [new McpTransportError('throttled', 429, 5), DONE] });
    expect(await r.call()).toMatchObject({ code: 'rate_limited', retry_after_s: 5 });
    expect(await r.call()).toMatchObject({ ok: true });
    expect(r.sent.length).toBe(2);
    const gate = { ok: true, unmet: [] as string[] };
    const off = rig({ gate, outcomes: [PROMPT] });
    const held = await off.call();
    Object.assign(gate, { ok: false, unmet: ['google.broker_act is false'] });
    expect(await off.broker.verdict({ op: 'verdict', request_id: held.request_id as string, choice: 'ALLOW_ONCE' })).toMatchObject({ code: 'broker_precondition_unmet' });
    expect(off.sent.length).toBe(1);
  });

  test('a reply without a matching tool result is outcome_unknown, never success', async () => {
    const client = new GoogleMcpClient((async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 999999, result: { content: [] } }), { headers: { 'content-type': 'application/json' } })) as never);
    await expect(client.callTool('gmail', 'ya29.act', 'create_draft', {})).rejects.toMatchObject({ status: null });
  });

  test('the day cap is reserved before sending, and a throttled call gives its slot back', async () => {
    const r = rig({ outcomes: [new McpTransportError('throttled', 429, 5)], gmailUsedToday: DAY_CALL_CAP - 1 });
    expect(await r.call()).toMatchObject({ code: 'rate_limited' });
    expect(r.ledger.used('gmail')).toBe(DAY_CALL_CAP - 1);
    const [a, b] = await Promise.all([r.call({ idempotency_key: 'd1', turn_id: 't1' }), r.call({ idempotency_key: 'd2', turn_id: 't2' })]);
    expect([a.ok, b.code]).toEqual([true, 'day_cap']);
    expect(r.sent.length).toBe(2);
    expect(r.ledger.used('gmail')).toBe(DAY_CALL_CAP);
  });

  test('held prompts are bounded: a call past the cap is refused before it reaches Google', async () => {
    const r = rig({ outcomes: Array.from({ length: MAX_HELD }, () => PROMPT) });
    for (let i = 0; i < MAX_HELD; i++) expect(await r.call({ idempotency_key: `h${i}`, turn_id: `t${i}` })).toMatchObject({ code: 'input_required' });
    expect(await r.call({ idempotency_key: 'over', turn_id: 'over' })).toMatchObject({ code: 'rate_limited' });
    expect(r.sent.length).toBe(MAX_HELD);
    r.advance(VERDICT_TTL_MS + 1);
    expect(await r.call({ idempotency_key: 'after', turn_id: 'after' })).toMatchObject({ ok: true });
  });

  test('two calls with one key at the same time send once', async () => {
    const r = rig();
    const [a, b] = await Promise.all([r.call(), r.call()]);
    expect([a.ok, b.code]).toEqual([true, 'outcome_unknown']);
    expect(r.sent.length).toBe(1);
  });

  test('the eleventh trash in a turn pauses', async () => {
    const r = rig();
    for (let i = 1; i <= 10; i++) expect(await r.call({ tool: 'trash_thread', idempotency_key: `t${i}`, args: { threadId: `th${i}` } })).toMatchObject({ ok: true });
    expect(await r.call({ tool: 'trash_thread', idempotency_key: 't11', args: { threadId: 'th11' } })).toMatchObject({ code: 'owner_confirm_required' });
  });

  test('a lost upstream reply is outcome_unknown and is never resent under the same key', async () => {
    const r = rig({ outcomes: [new McpTransportError('no answer', null)] });
    expect(await r.call()).toMatchObject({ code: 'outcome_unknown', recovery: 'reconcile_first', reconcile_with: expect.stringContaining('gmail') });
    expect(await r.call()).toMatchObject({ code: 'outcome_unknown' });
    expect(r.sent.length).toBe(1);
    expect(r.broker.status({ op: 'status', idempotency_key: 'intent-1' })).toMatchObject({ ok: true, intent: { status: 'unknown' } });
  });

  test('an unreadable ledger file is reported, never read as empty', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'state.json'), '{"intents": {');
    expect(new BrokerLedger(join(dir, 'state.json')).unreadable).toContain('move it aside');
    expect(new BrokerLedger(join(tmp(), 'state.json')).unreadable).toBeUndefined();
  });

  test('a key reused for different arguments is a conflict; Google\'s nested isError is not success', async () => {
    const r = rig({ outcomes: [{ kind: 'complete', result: { isError: true }, isError: true, text: 'The request was denied by the user.' }] });
    expect(await r.call()).toMatchObject({ code: 'tool_error', reason: 'user_denied' });
    expect(await r.call({ args: { to: 'carol@example.com' } })).toMatchObject({ code: 'idempotency_conflict' });
    expect(toolErrorReason('Blocked by your administrator policy')).toBe('admin_policy');
  });

  test('tools lists only what call accepts; arguments are hashed canonically', async () => {
    const r = rig();
    expect(await r.broker.tools({ op: 'tools', account: ACCOUNT, server: 'gmail' })).toMatchObject({ ok: true, tools: [{ name: 'create_draft' }] });
    expect(argsHash('gmail', 'x', { a: 1, b: 2 })).toBe(argsHash('gmail', 'x', { b: 2, a: 1 }));
  });

  test('the audit line holds no arguments and no token', async () => {
    const r = rig();
    await r.call();
    const line = r.audit[0]!.join(' ');
    expect(line).toContain('gmail.create_draft');
    expect(line).not.toContain('bob@example.com');
    expect(line).not.toContain('ya29');
  });
});

describe('minting', () => {
  function vaultWith(scopes: string[]): { v: FileVaultBackend; file: string } {
    const h = tmp();
    mkdirSync(join(h, '.gbrain'), { recursive: true });
    const file = join(h, '.gbrain', 'credentials.json');
    const entry: CredentialEntry = { id: `google:${ACCOUNT}`, provider: 'google', kind: 'oauth2', client_ref: 'byo',
      secret: { refresh_token: '1//synthetic-refresh', access_token: 'ya29.sync-slot', expiry: '2099-01-01T00:00:00.000Z' },
      meta: { account: ACCOUNT, scopes, client_id: CLIENT, client_mode: 'personal', connected_at: '2026-11-01T00:00:00.000Z', grant_generation: 1 } };
    writeFileSync(file, JSON.stringify({ version: 2, clients: [{ provider: 'google', client_id: CLIENT, client_secret: 'GOCSPX-synthetic', created_at: '2026-01-01T00:00:00.000Z', account: ACCOUNT, mode: 'personal' }],
      credentials: { [entry.id]: entry } }));
    return { v: new FileVaultBackend(file), file };
  }
  function fakeGoogle(scopeReply: string) {
    const posted: URLSearchParams[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      const body = new URLSearchParams(String(init?.body ?? ''));
      if (url.endsWith('/token')) { posted.push(body); return new Response(JSON.stringify({ access_token: `ya29.minted-${posted.length}`, expires_in: 3600, scope: scopeReply })); }
      throw new Error(`unexpected ${url}`);
    }) as never;
    return { posted, fetchImpl };
  }

  test('a mint asks for the read-only scopes, is cached, and never touches the vault\'s token slot', async () => {
    const { v, file } = vaultWith(['openid', 'email', GMAIL_RO, GMAIL_MODIFY]);
    const before = readFileSync(file, 'utf8');
    const g = fakeGoogle(`openid email ${GMAIL_RO}`);
    const tokens = new SocketTokens(v, g.fetchImpl);
    const one = await tokens.mintIngest(ACCOUNT);
    const two = await tokens.mintIngest(ACCOUNT);
    expect(one.access_token).toBe('ya29.minted-1');
    expect(two.access_token).toBe('ya29.minted-1');
    expect(g.posted.length).toBe(1);
    expect(g.posted[0]!.get('scope')).toBe(`openid email ${GMAIL_RO}`);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  test('a refresh that races a reconnect or disconnect is not_connected, never a token for the old grant', async () => {
    for (const change of ['reconnect', 'disconnect'] as const) {
      const { v, file } = vaultWith(['openid', 'email', GMAIL_RO]);
      const g = fakeGoogle(`openid email ${GMAIL_RO}`);
      const racing = (async (url: string, init?: RequestInit) => {
        const vault = JSON.parse(readFileSync(file, 'utf8'));
        if (change === 'reconnect') vault.credentials[`google:${ACCOUNT}`].meta.grant_generation = 2;
        else delete vault.credentials[`google:${ACCOUNT}`];
        writeFileSync(file, JSON.stringify(vault));
        return (g.fetchImpl as unknown as (u: string, i?: RequestInit) => Promise<Response>)(url, init);
      }) as never;
      await expect(new SocketTokens(v, racing).mintIngest(ACCOUNT)).rejects.toMatchObject({ code: 'not_connected' });
    }
  });

  test('a minted token that comes back write-capable is refused', async () => {
    const { v } = vaultWith(['openid', 'email', GMAIL_RO, GMAIL_MODIFY]);
    const g = fakeGoogle(`openid email ${GMAIL_RO} ${GMAIL_MODIFY}`);
    await expect(new SocketTokens(v, g.fetchImpl).mintIngest(ACCOUNT)).rejects.toMatchObject({ code: 'write_scope_refused' });
  });

  test('the broker token needs a write scope on the grant and is never persisted', async () => {
    const ro = vaultWith(['openid', 'email', GMAIL_RO]);
    await expect(new SocketTokens(ro.v, fakeGoogle('').fetchImpl).actToken(ACCOUNT)).rejects.toMatchObject({ code: 'insufficient_scope' });
    const rw = vaultWith(['openid', 'email', GMAIL_RO, CAL_EVENTS]);
    const before = readFileSync(rw.file, 'utf8');
    const act = await new SocketTokens(rw.v, fakeGoogle(`openid email ${GMAIL_RO} ${CAL_EVENTS}`).fetchImpl).actToken(ACCOUNT);
    expect(act).toMatchObject({ generation: 1, client_id: CLIENT });
    expect(act.token).toBe(['ya29', 'minted-1'].join('.'));
    expect(readFileSync(rw.file, 'utf8')).toBe(before);
  });
});

describe('gwscli output redaction', () => {
  test('a token split across chunks is still replaced, Bearer form included', () => {
    const token = 'ya29.secret-token-value';
    const r = new TokenRedactor(token);
    const out = r.push('header Bearer ya29.sec') + r.push('ret-token-value tail ' + token) + r.flush();
    expect(out).toBe('header Bearer [redacted:google_token] tail [redacted:google_token]');
  });
});
