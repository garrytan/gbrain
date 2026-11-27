/**
 * The write broker behind the socket's `call` op. It holds the write-capable
 * Google token in memory only, calls only allowlisted tools with conforming
 * arguments, and answers Google's approval prompt only with an owner verdict:
 * an `owner_verdict` ALLOW_ONCE on a repeat of the same call (seam v4, W-B1),
 * or any of Google's choices through the owner's isolated channel. A held
 * write is bound to the grant generation, client, account, caller and turn it
 * was prompted under and expires after 10 minutes. Every intent is recorded
 * before dispatch; a lost upstream reply is `outcome_unknown` and is never
 * resent. Off unless the activation gate passes (preconditions.ts).
 */
import { createHash, randomUUID } from 'node:crypto';
import type { BrokerLedger } from './ledger.ts';
import { McpTransportError, toolErrorReason, type GoogleMcpClient, type McpTool, type PendingPrompt } from './mcp-client.ts';
import { DAY_CALL_CAP, OUTSIDE_PAUSE_AT, TRASH_PAUSE_AT, TURN_CALL_CAP, applyArgumentRules, isAllowedTool, outsideInvitees, type CallEffects } from './policy.ts';
import {
  GOOGLE_SOCKET_VERSION, SocketError, failure,
  type CallRequest, type GoogleServer, type QuotaView, type StatusRequest, type ToolsRequest, type VerdictRequest,
} from './protocol.ts';
import type { ActToken, SocketTokens } from './tokens.ts';

export const VERDICT_TTL_MS = 10 * 60_000;
export const MAX_HELD = 64;
const MAX_HELD_BYTES = 8 * 1024 * 1024;
const TOOLS_CACHE_MS = 3_600_000;
const TURN_FORGET_MS = 24 * 3_600_000;

export interface GateResult { ok: boolean; unmet: string[]; rootGateway: boolean }

export interface BrokerOptions {
  tokens: SocketTokens;
  client: GoogleMcpClient;
  ledger: BrokerLedger;
  audit: (fields: string[]) => void;
  gate: () => GateResult;
  now?: () => number;
}

interface Held {
  request_id: string; kind: 'google_prompt' | 'owner_confirm'; key: string; account: string; server: GoogleServer; tool: string;
  args: Record<string, unknown>; args_hash: string; turn_id: string; caller: string; effects: CallEffects;
  generation: number | null; client_id: string | null; prompt?: PendingPrompt; created_ms: number; confirmed?: boolean;
}

interface Turn { calls: number; outside: number; trash: number; last_ms: number }

type Reply = Record<string, unknown>;

const RECONCILE: Record<GoogleServer, string> = {
  gmail: 'gmail.search_threads or gmail.list_drafts', calendar: 'calendar.list_events', drive: 'drive.search_files', docs: 'docs.read_doc',
  sheets: 'sheets.get_values', slides: 'slides.read_presentation', tasks: 'tasks.list_tasks',
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as object).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export function argsHash(server: GoogleServer, tool: string, args: Record<string, unknown>): string {
  return createHash('sha256').update(canonical({ server, tool, args })).digest('hex');
}

const clean = (text: string): string => text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');

export class GoogleBroker {
  private readonly held = new Map<string, Held>();
  private readonly heldByKey = new Map<string, string>();
  private readonly turns = new Map<string, Turn>();
  private readonly toolsCache = new Map<GoogleServer, { at: number; tools: McpTool[] }>();
  /** Idempotency keys with a call or verdict between its ledger check and its upstream reply; a second one waits its turn by being refused. */
  private readonly inflight = new Set<string>();
  private readonly now: () => number;

  constructor(private readonly opts: BrokerOptions) { this.now = opts.now ?? Date.now; }

  private quota(server: GoogleServer): QuotaView {
    return { product: server, used_today: this.opts.ledger.used(server), cap: DAY_CALL_CAP, day: this.opts.ledger.day() };
  }

  private turn(id: string): Turn {
    const now = this.now();
    for (const [k, t] of this.turns) if (now - t.last_ms > TURN_FORGET_MS) this.turns.delete(k);
    const t = this.turns.get(id) ?? { calls: 0, outside: 0, trash: 0, last_ms: now };
    t.last_ms = now;
    this.turns.set(id, t);
    return t;
  }

  private audit(req: Pick<CallRequest, 'caller' | 'turn_id' | 'account' | 'server' | 'tool' | 'idempotency_key'>, hash: string, outcome: string): void {
    this.opts.audit([req.caller, req.turn_id, req.account, `${req.server}.${req.tool}`, hash.slice(0, 16), req.idempotency_key, outcome,
      `root_gateway=${this.opts.gate().rootGateway ? 1 : 0}`]);
  }

  private expired(h: Held): boolean { return this.now() - h.created_ms > VERDICT_TTL_MS; }

  private drop(h: Held): void { this.held.delete(h.request_id); this.heldByKey.delete(h.key); }

  /** Puts an approved prompt back after Google throttled its answer, so the same approval can be sent again. */
  private rehold(h: Held): void {
    this.held.set(h.request_id, h);
    this.heldByKey.set(h.key, h.request_id);
    this.opts.ledger.put({ key: h.key, args_hash: h.args_hash, account: h.account, server: h.server, tool: h.tool, turn_id: h.turn_id, caller: h.caller, status: 'held', request_id: h.request_id });
  }

  private evictExpired(): void { for (const old of [...this.held.values()]) if (this.expired(old)) this.drop(old); }

  private heldBytes(): number { let n = 0; for (const h of this.held.values()) n += JSON.stringify(h.args).length + (h.prompt?.message.length ?? 0); return n; }

  private hold(h: Omit<Held, 'request_id' | 'created_ms'>): Held {
    const held: Held = { ...h, request_id: randomUUID(), created_ms: this.now() };
    this.held.set(held.request_id, held);
    this.heldByKey.set(held.key, held.request_id);
    this.opts.ledger.put({ key: h.key, args_hash: h.args_hash, account: h.account, server: h.server, tool: h.tool, turn_id: h.turn_id, caller: h.caller, status: 'held', request_id: held.request_id });
    return held;
  }

  private promptReply(h: Held): Reply {
    const p = h.prompt!;
    return {
      ...failure(h.request_id, 'input_required', 'Google asks the account owner to approve this call.'),
      message_md: clean(p.message), choices: p.choices, tool: h.tool, server: h.server, args_hash: h.args_hash,
      expires_at: new Date(h.created_ms + VERDICT_TTL_MS).toISOString(), quota: this.quota(h.server),
      fix: { next: 'ask_user', user_message: 'Approve on an owner turn by repeating this call with owner_verdict ALLOW_ONCE, or answer it with gbrain google approvals.' },
    };
  }

  async call(req: CallRequest): Promise<Reply> {
    if (this.inflight.has(req.idempotency_key)) {
      return { ...failure(randomUUID(), 'outcome_unknown', `another call with this idempotency_key is still in flight; read op status for it, or reconcile with ${RECONCILE[req.server]}`, { reconcile_with: RECONCILE[req.server] }), quota: this.quota(req.server) };
    }
    this.inflight.add(req.idempotency_key);
    try { return await this.callClaimed(req); }
    finally { this.inflight.delete(req.idempotency_key); }
  }

  private async callClaimed(req: CallRequest): Promise<Reply> {
    const requestId = randomUUID();
    const fail = (code: Parameters<typeof failure>[1], message: string, extra: Reply = {}, id: string = requestId): Reply =>
      ({ ...failure(id, code, message, extra), quota: this.quota(req.server) });
    const gate = this.opts.gate();
    if (!gate.ok) {
      this.audit(req, '-', 'broker_precondition_unmet');
      return fail('broker_precondition_unmet', `the write broker is off: ${gate.unmet.join('; ')}`, { unmet: gate.unmet });
    }
    let effects: CallEffects;
    try { effects = applyArgumentRules(req.account, req.server, req.tool, req.args); }
    catch (error) {
      const e = error as SocketError;
      this.audit(req, '-', e.code);
      return fail(e.code, e.message, e.extra);
    }
    const hash = argsHash(req.server, req.tool, effects.args);
    const prior = this.opts.ledger.get(req.idempotency_key);
    if (prior && (prior.args_hash !== hash || prior.account !== req.account)) {
      return fail('idempotency_conflict', 'this idempotency_key already names a different call; use a new key for a new intent');
    }
    if (prior?.status === 'done') return { v: GOOGLE_SOCKET_VERSION, ok: true, replayed: true, request_id: prior.request_id, result: null, quota: this.quota(req.server) };
    if (prior?.status === 'failed') return fail((prior.code ?? 'tool_error') as Parameters<typeof failure>[1], 'this intent already ended without effect', { replayed: true });
    if (prior && (prior.status === 'unknown' || prior.status === 'dispatched')) {
      return fail('outcome_unknown', `an earlier attempt of this intent may have reached Google; reconcile with ${RECONCILE[req.server]} before deciding to act again`, { reconcile_with: RECONCILE[req.server] });
    }

    const heldId = this.heldByKey.get(req.idempotency_key);
    const held = heldId ? this.held.get(heldId) : undefined;
    if (prior?.status === 'held' && (!held || this.expired(held))) {
      if (held) this.drop(held);
      this.opts.ledger.put({ ...prior, status: 'failed', code: 'verdict_expired' });
      return fail('verdict_expired', 'the held prompt expired (10 minutes) or the broker restarted; re-call with a new idempotency_key for a fresh prompt');
    }
    let confirmed: Held | undefined;
    if (held) {
      if (held.turn_id !== req.turn_id || held.caller !== req.caller) return fail('verdict_mismatch', 'a held call is answered only on the turn and by the caller that made it', {}, held.request_id);
      if (held.kind === 'owner_confirm') {
        if (!held.confirmed) return fail('owner_confirm_required', 'this call needs the owner to confirm it through gbrain google approvals first; owner_verdict is not accepted for a safety pause', { tool: req.tool, args_hash: hash }, held.request_id);
        confirmed = held;
      } else {
        if (!req.owner_verdict) return this.promptReply(held);
        if (req.owner_verdict.for_request !== held.request_id) return fail('verdict_mismatch', 'owner_verdict.for_request does not name the held prompt for this call', {}, held.request_id);
        if (!held.prompt!.choices.includes('ALLOW_ONCE')) return fail('broker_args_refused', 'Google did not offer ALLOW_ONCE for this prompt; answer it with gbrain google approvals', {}, held.request_id);
        return this.answer(held, 'ALLOW_ONCE');
      }
    } else if (req.owner_verdict) {
      return fail('verdict_expired', 'no held prompt matches this owner_verdict; re-call without it for a fresh prompt');
    }

    const turn = this.turn(req.turn_id);
    if (turn.calls >= TURN_CALL_CAP) return fail('turn_cap', `this turn already made ${TURN_CALL_CAP} broker calls`);
    if (this.opts.ledger.used(req.server) >= DAY_CALL_CAP) {
      const tomorrow = Date.parse(`${this.opts.ledger.day()}T00:00:00Z`) + 86_400_000;
      return fail('day_cap', `the broker made ${DAY_CALL_CAP} ${req.server} calls today (UTC)`, { retry_after_s: Math.ceil((tomorrow - this.now()) / 1000) });
    }
    this.evictExpired();
    if (!confirmed && (this.held.size >= MAX_HELD || this.heldBytes() >= MAX_HELD_BYTES)) {
      return fail('rate_limited', `${this.held.size} calls are already waiting for the owner; answer or let them expire (gbrain google approvals)`, { retry_after_s: VERDICT_TTL_MS / 1000 });
    }
    const base = { key: req.idempotency_key, account: req.account, server: req.server, tool: req.tool, args: effects.args, args_hash: hash, turn_id: req.turn_id, caller: req.caller, effects };
    const pauseOutside = effects.outside > 0 && turn.outside + effects.outside >= OUTSIDE_PAUSE_AT;
    const pauseTrash = effects.trash && turn.trash + 1 >= TRASH_PAUSE_AT;
    if (!confirmed && (pauseOutside || pauseTrash)) {
      const h = this.hold({ ...base, kind: 'owner_confirm', generation: await this.opts.tokens.generationOf(req.account), client_id: null });
      this.audit(req, hash, 'owner_confirm_required');
      return fail('owner_confirm_required', pauseOutside
        ? 'a second invite to an outside address in one turn needs the owner to confirm it through gbrain google approvals'
        : `trash number ${TRASH_PAUSE_AT} in one turn needs the owner to confirm it through gbrain google approvals`, { tool: req.tool, args_hash: hash }, h.request_id);
    }
    const chargedDay = this.opts.ledger.day();
    this.opts.ledger.count(req.server);
    turn.calls++;
    turn.outside += effects.outside;
    if (effects.trash) turn.trash++;
    const release = () => { turn.calls--; turn.outside -= effects.outside; if (effects.trash) turn.trash--; this.opts.ledger.uncount(req.server, chargedDay); };
    let act: ActToken;
    try { act = await this.opts.tokens.actToken(req.account); }
    catch (error) { release(); const e = error as SocketError; this.audit(req, hash, e.code); return fail(e.code, e.message); }
    const after = this.opts.gate();
    if (!after.ok) {
      release();
      this.audit(req, hash, 'broker_precondition_unmet');
      return fail('broker_precondition_unmet', `the write broker was turned off while this call waited for its token: ${after.unmet.join('; ')}`, { unmet: after.unmet });
    }
    if (confirmed) {
      this.drop(confirmed);
      if (act.generation !== confirmed.generation) {
        release();
        this.opts.ledger.put({ ...prior!, status: 'failed', code: 'verdict_expired' });
        return fail('verdict_expired', 'the account was reconnected or disconnected after the owner confirmed this call; re-call with a new idempotency_key', {}, confirmed.request_id);
      }
    }
    return this.dispatch({ ...base, request_id: requestId }, act, undefined, release, confirmed);
  }

  private async answer(h: Held, choice: string): Promise<Reply> {
    const off = (): Reply | null => {
      const gate = this.opts.gate();
      return gate.ok ? null : { ...failure(h.request_id, 'broker_precondition_unmet', `the write broker is off: ${gate.unmet.join('; ')}`, { unmet: gate.unmet }), quota: this.quota(h.server) };
    };
    const before = off();
    if (before) return before;
    let act: ActToken;
    try { act = await this.opts.tokens.actToken(h.account); }
    catch (error) { const e = error as SocketError; return { ...failure(h.request_id, e.code, e.message), quota: this.quota(h.server) }; }
    const after = off();
    if (after) return after;
    this.drop(h);
    if (act.generation !== h.generation || act.client_id !== h.client_id) {
      this.opts.ledger.put({ key: h.key, args_hash: h.args_hash, account: h.account, server: h.server, tool: h.tool, turn_id: h.turn_id, caller: h.caller, status: 'failed', code: 'verdict_expired', request_id: h.request_id });
      return { ...failure(h.request_id, 'verdict_expired', 'the account was reconnected or disconnected after this prompt; re-call with a new idempotency_key for a fresh prompt'), quota: this.quota(h.server) };
    }
    return this.dispatch(h, act, { prompt: h.prompt!, choice }, undefined, h);
  }

  private async dispatch(c: Omit<Held, 'kind' | 'generation' | 'client_id' | 'created_ms'>, act: ActToken, answer?: { prompt: PendingPrompt; choice: string }, noEffect: () => void = () => {}, approved?: Held): Promise<Reply> {
    const record = (status: 'dispatched' | 'done' | 'failed' | 'unknown', code?: string) =>
      this.opts.ledger.put({ key: c.key, args_hash: c.args_hash, account: c.account, server: c.server, tool: c.tool, turn_id: c.turn_id, caller: c.caller, status, request_id: c.request_id, ...(code ? { code } : {}) });
    const req = { caller: c.caller, turn_id: c.turn_id, account: c.account, server: c.server, tool: c.tool, idempotency_key: c.key };
    const fail = (code: Parameters<typeof failure>[1], message: string, extra: Reply = {}): Reply => ({ ...failure(c.request_id, code, message, extra), quota: this.quota(c.server) });
    const settle = (status: 'done' | 'failed' | 'unknown', code?: string): string | null => {
      try { record(status, code); return null; } catch (error) { return (error as Error).message; }
    };
    record('dispatched');
    let outcome;
    try { outcome = await this.opts.client.callTool(c.server, act.token, c.tool, c.args, answer); }
    catch (error) {
      const e = error as McpTransportError;
      if (e.status === 429) { noEffect(); if (approved) this.rehold(approved); else this.opts.ledger.forget(c.key); this.audit(req, c.args_hash, 'rate_limited'); return fail('rate_limited', e.message, { retry_after_s: e.retryAfterS ?? 60 }); }
      if (e.status !== null && e.status >= 400 && e.status < 500) {
        noEffect();
        if (e.status === 401) { this.opts.tokens.dropAct(c.account); this.opts.ledger.forget(c.key); }
        else settle('failed', 'upstream');
        this.audit(req, c.args_hash, 'upstream');
        return fail('upstream', e.message);
      }
      settle('unknown', 'outcome_unknown');
      this.audit(req, c.args_hash, 'outcome_unknown');
      return fail('outcome_unknown', `${e.message}; the call may have taken effect: reconcile with ${RECONCILE[c.server]} before acting again`, { reconcile_with: RECONCILE[c.server] });
    }
    if (outcome.kind === 'input_required') {
      const h = this.hold({ key: c.key, account: c.account, server: c.server, tool: c.tool, args: c.args, args_hash: c.args_hash, turn_id: c.turn_id, caller: c.caller,
        effects: c.effects, kind: 'google_prompt', prompt: outcome.prompt, generation: act.generation, client_id: act.client_id });
      this.audit(req, c.args_hash, 'input_required');
      return this.promptReply(h);
    }
    if (outcome.isError) {
      const reason = toolErrorReason(outcome.text);
      noEffect();
      settle('failed', 'tool_error');
      this.audit(req, c.args_hash, `tool_error:${reason}`);
      return fail('tool_error', `Google's ${c.server}.${c.tool} returned an error (${reason})`, { reason, message_md: clean(outcome.text) });
    }
    const lost = settle('done');
    this.audit(req, c.args_hash, 'ok');
    return { v: GOOGLE_SOCKET_VERSION, ok: true, request_id: c.request_id, result: outcome.result, quota: this.quota(c.server),
      ...(lost ? { warning: `the broker could not save this outcome (${lost}); it remembers it until it restarts` } : {}) };
  }

  /** The owner's isolated channel: confirms a safety pause, or answers Google's prompt with any choice it offered. */
  async verdict(req: VerdictRequest): Promise<Reply> {
    const h = this.held.get(req.request_id);
    if (!h || this.expired(h)) {
      if (h) this.drop(h);
      return failure(req.request_id, 'verdict_expired', 'nothing is held under this request_id (it expired after 10 minutes, was answered, or the broker restarted)');
    }
    if (h.kind === 'owner_confirm') {
      if (req.choice !== 'ALLOW_ONCE') return failure(h.request_id, 'broker_args_refused', 'a safety pause is confirmed with ALLOW_ONCE');
      h.confirmed = true;
      return { v: GOOGLE_SOCKET_VERSION, ok: true, request_id: h.request_id, confirmed: true, next: 'the caller repeats the same call (same idempotency_key) to send it' };
    }
    if (!h.prompt!.choices.includes(req.choice)) return failure(h.request_id, 'broker_args_refused', `Google offered ${h.prompt!.choices.join(', ')}`);
    if (this.inflight.has(h.key)) return failure(h.request_id, 'verdict_already_answered', 'this prompt is already being answered');
    this.inflight.add(h.key);
    try { return await this.answer(h, req.choice); }
    finally { this.inflight.delete(h.key); }
  }

  pending(): Reply {
    const items = [...this.held.values()].filter(h => !this.expired(h)).map(h => ({
      request_id: h.request_id, kind: h.kind, account: h.account, server: h.server, tool: h.tool, args_hash: h.args_hash, turn_id: h.turn_id,
      caller: h.caller, args: h.args, outside: outsideInvitees(h.account, h.server, h.tool, h.args), confirmed: h.confirmed ?? false, message_md: h.prompt ? clean(h.prompt.message) : null, choices: h.prompt?.choices ?? ['ALLOW_ONCE'],
      expires_at: new Date(h.created_ms + VERDICT_TTL_MS).toISOString(),
    }));
    return { v: GOOGLE_SOCKET_VERSION, ok: true, request_id: randomUUID(), pending: items };
  }

  status(req: StatusRequest): Reply {
    const rec = this.opts.ledger.get(req.idempotency_key);
    if (!rec) return failure(randomUUID(), 'intent_unknown', 'no intent with this idempotency_key in the last 24 hours');
    return { v: GOOGLE_SOCKET_VERSION, ok: true, request_id: rec.request_id, intent: { status: rec.status, code: rec.code ?? null, account: rec.account, server: rec.server, tool: rec.tool, updated_at: rec.updated_at } };
  }

  async tools(req: ToolsRequest): Promise<Reply> {
    const requestId = randomUUID();
    const hit = this.toolsCache.get(req.server);
    let list = hit && this.now() - hit.at < TOOLS_CACHE_MS ? hit.tools : null;
    if (!list) {
      try { list = await this.opts.client.listTools(req.server); }
      catch (error) { return failure(requestId, 'upstream', (error as Error).message); }
      this.toolsCache.set(req.server, { at: this.now(), tools: list });
    }
    const tools = list.filter(t => isAllowedTool(req.server, t.name)).map(t => ({ name: t.name, description: t.description ?? '', inputSchema: t.inputSchema ?? {} }));
    return { v: GOOGLE_SOCKET_VERSION, ok: true, request_id: requestId, tools };
  }
}
