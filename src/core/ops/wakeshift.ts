/**
 * Report-back watches over Wakeshift (plan D2, D5, D6, D7): `watch_job`,
 * `watch_write_request`, `watch_cron`, `accept_wakeshift_terms`,
 * `list_watches`, `unwatch`. Listed only while the owner has run
 * `gbrain wakeshift enable` and a usable key is on the host (publish gate
 * `mcp.publish_wakeshift`, file plane plus key presence; no DB plane, so no
 * remote caller can flip it). Each watch runs its target's own read check
 * first: the get_job owner fence, the get_write_request receipt path, or a
 * registered cron name under admin scope, so a foreign id reads exactly like
 * a missing one and nothing is sent. On a brain with live access members a
 * principal's first watch returns the agreement step (terms.ts) until it
 * calls accept_wakeshift_terms. A watch belongs to the principal that made it;
 * list and unwatch touch only that principal's rows. What leaves the machine:
 * docs/guides/wakeshift.md. Never import from '../operations.ts' here (cycle).
 */
import { opError, type Operation, type OperationContext, type OperationError } from './contract.ts';
import { readFix } from './op-fix.ts';
import { agentOwnerFence, assertJobOwned, jobNotFound } from './jobs.ts';
import { receiptAccess, receiptCallerSource, receiptNotFound, receiptVisible } from './persistence.ts';
import { memberIdentityFor } from '../access/caller.ts';
import { parseWriteRequestId } from '../persistence/preconditions.ts';
import { WakeshiftError, type WakeshiftCall } from '../wakeshift/client.ts';
import { wakeshiftBrainKey, wakeshiftRuntime, wakeshiftSecret, wakeshiftUserId, type WakeshiftRuntime } from '../wakeshift/config.ts';
import { CRON_FINISHED, JOB_FINISHED, WRITE_SETTLED, cronName } from '../wakeshift/events.ts';
import { drainWakes, endAtWakeshift, liveAccessMembers, STDIO_REGISTRATION_PRINCIPAL } from '../wakeshift/drain.ts';
import { agreementStep, operatorTerms, recordAcceptance, termsAccepted, wakePrincipalKey, type WakePrincipalRef } from '../wakeshift/terms.ts';

const WATCH_TTL = '7d';
const TERMINAL = new Set(['completed', 'failed', 'dead', 'cancelled']);
const REDACTION = { exempt: 'watch bookkeeping: job, request and cron ids, states and times, never retrieved brain text' } as const;
type Fix = ReturnType<typeof readFix>;

/** The three arguments Wakeshift asks a subscribing tool to take (its HTTP API, "The caller"). */
const CALLER_PARAMS = {
  session_key: { type: 'string', description: "This conversation's session_key, from an earlier result (a secret token, or a handle such as claude-code#2). Keep it to this conversation; don't share or log it." },
  harness: { type: 'string', description: "The program you're running in: codex, claude-code, cursor (local CLI or IDE), cursor-cloud (Cursor cloud agent), grok-bot, copilot-cli, opencode, antigravity, openclaw (even when it runs your turns in Codex), hermes, chatgpt, or your program's name if it isn't listed" },
  conversation_id: { type: 'string', description: 'Your own ID for this conversation, if your program gives you one. Cursor and Grok Bot: the output of `printenv CURSOR_CONVERSATION_ID`. Codex and Antigravity send it automatically; others leave it empty' },
} as const;

function waitFix(id: number): Fix {
  return readFix('Waits for the job without Wakeshift (at most 55 s a call; call again while terminal is false).',
    { argv: ['gbrain', 'jobs', 'wait', String(id)], mcp: { tool: 'wait_job', arguments: { id } } });
}

function receiptFix(requestId: string): Fix {
  return readFix('Reads the write receipt without Wakeshift; read again at retry_after_ms until the state is final.',
    { argv: ['gbrain', 'write-request', '--', requestId], mcp: { tool: 'get_write_request', arguments: { request_id: requestId } } });
}

function notEnabled(): OperationError {
  return opError('wakeshift_not_enabled', 'Reporting back through Wakeshift is off on this brain.',
    'Use wait_job or get_write_request instead, or ask the brain owner to run gbrain wakeshift enable on the brain host.');
}

function needsConversation(tool: string, suggestion: string, fix?: Fix): OperationError {
  return opError('wakeshift_needs_conversation', `${tool} wakes an MCP conversation; a CLI run has none to wake.`, suggestion, fix ? { fix } : {});
}

function termsUnset(): OperationError {
  return opError('wakeshift_shared_brain', 'This brain has access members and its operator has not set the terms and privacy links Wakeshift requires, so nothing was watched.',
    'Ask the brain owner to run gbrain wakeshift enable --terms-url <https url> --privacy-url <https url> on the brain host; meanwhile use wait_job or get_write_request.');
}

export interface WatchPrincipal { kind: 'oauth_client' | 'legacy_token' | 'local_stdio'; id: string; member: string | null }

/**
 * Who is watching: the verified credential (bound member when it has one), else the local stdio pipe. A stdio server
 * started with --stdio-member watches as principal id 'registration', so the drain re-checks that member, never config.
 */
export async function watchPrincipal(ctx: OperationContext): Promise<WatchPrincipal | null> {
  const registered = !ctx.auth && ctx.transport === 'stdio' ? ctx.stdioMember : undefined;
  const base = ctx.auth
    ? (ctx.auth.principal ?? (ctx.auth.clientId ? { kind: 'oauth_client' as const, id: ctx.auth.clientId } : null))
    : ctx.transport === 'stdio' ? { kind: 'local_stdio' as const, id: registered !== undefined ? STDIO_REGISTRATION_PRINCIPAL : 'local' } : null;
  if (!base) return null;
  const identity = await memberIdentityFor(ctx.engine, { ...(ctx.auth ? { member: ctx.auth.member } : {}), principal: base, ...(registered !== undefined ? { stdioMember: registered } : {}) });
  return { ...base, member: identity.find(i => i.startsWith('member:'))?.slice('member:'.length) ?? null };
}

const principalRef = (p: WatchPrincipal): WakePrincipalRef => ({ principal_kind: p.kind, principal_id: p.id, member_id: p.member });

function optString(v: unknown, max: number): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined;
}

function wakeshiftFailure(e: WakeshiftError, tool: string, fallback: string, fix: Fix): OperationError {
  if (e.code === 'other_client') {
    return opError('wakeshift_refused', 'Wakeshift refused the session_key: it belongs to a conversation in another program.',
      `Call ${tool} again without session_key.`, { reason: e.code, fix });
  }
  if (e.status === 0 || e.status === 429 || e.status >= 500) {
    return opError('wakeshift_unavailable', `Wakeshift could not take the watch (${e.code}); nothing was watched.`,
      `Retry ${tool} in a minute, or ${fallback} to wait without it.`, { reason: e.code, fix });
  }
  return opError('wakeshift_refused', `Wakeshift refused the watch (${e.code}): ${e.message}`,
    `${fallback[0]!.toUpperCase()}${fallback.slice(1)} to wait without Wakeshift; the brain owner can check the setup with gbrain wakeshift test.`, { reason: e.code, fix });
}

/**
 * The agreement step this principal still owes on a brain with live access members (null when none is owed); refuses
 * when the operator never set the two links.
 */
async function termsStep(ctx: OperationContext, runtime: WakeshiftRuntime, principal: WatchPrincipal, tool: string): Promise<Record<string, unknown> | null> {
  if (await liveAccessMembers(ctx.engine) === 0) return null;
  const terms = operatorTerms(runtime.file);
  if (!terms) throw termsUnset();
  return await termsAccepted(ctx.engine, principalRef(principal), terms) ? null : agreementStep(terms, tool);
}

interface WatchSpec {
  tool: string;
  event: string;
  target: string;
  targetRef?: string;
  args: Record<string, unknown>;
  reason: string;
  settledNow: boolean;
  fallback: string;
  fix: Fix;
}

/**
 * Subscribe this conversation at Wakeshift (once, ttl 7d), record the watch, roll the subscription back when the
 * insert fails, wake at once when the target already settled, and render Wakeshift's addition as the last block.
 */
async function openWatch(ctx: OperationContext, runtime: WakeshiftRuntime, principal: WatchPrincipal, p: Record<string, unknown>, spec: WatchSpec): Promise<{ rowId: number; recognized: boolean }> {
  const user = wakeshiftUserId(wakeshiftSecret(), wakeshiftBrainKey(ctx.config), wakePrincipalKey(principalRef(principal)));
  const caller = ctx.mcpCaller;
  const call: WakeshiftCall = {
    user, tool: spec.tool,
    ...(optString(caller?.client, 200) ? { client: optString(caller?.client, 200) } : {}),
    ...(caller?.meta && typeof caller.meta === 'object' ? { meta: caller.meta } : {}),
    ...(optString(caller?.userAgent, 400) ? { user_agent: optString(caller?.userAgent, 400) } : {}),
    ...(optString(p.session_key, 100) ? { session: optString(p.session_key, 100) } : {}),
    ...(optString(p.harness, 100) ? { harness: optString(p.harness, 100) } : {}),
    ...(optString(p.conversation_id, 200) ? { conversation: optString(p.conversation_id, 200) } : {}),
  };
  let sub;
  try {
    sub = await runtime.api.subscribe({ call, name: spec.event, arguments: spec.args, ttl: WATCH_TTL, once: true, reason: spec.reason });
  } catch (e) {
    if (e instanceof WakeshiftError) throw wakeshiftFailure(e, spec.tool, spec.fallback, spec.fix);
    throw e;
  }
  let rowId: number;
  try {
    const expires = sub.event_subscription.expires_at && !Number.isNaN(Date.parse(sub.event_subscription.expires_at))
      ? sub.event_subscription.expires_at : new Date(Date.now() + 7 * 86_400_000).toISOString();
    const [row] = await ctx.engine.executeRaw<{ id: number }>(
      `INSERT INTO wake_subscriptions (event, target, target_ref, principal_kind, principal_id, member_id, wake_user, ws_subscription_id, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz)
       ON CONFLICT (wake_user, ws_subscription_id) WHERE state = 'open'
       DO UPDATE SET expires_at = EXCLUDED.expires_at, updated_at = now()
       RETURNING id`,
      [spec.event, spec.target, spec.targetRef ?? null, principal.kind, principal.id, principal.member, user, String(sub.event_subscription.id), expires]);
    rowId = Number(row!.id);
  } catch (e) {
    if (sub.event_subscription.created !== false) {
      await runtime.api.unsubscribe({ call, name: spec.event, arguments: spec.args, reason: 'rolled_back' }).catch(() => {});
    }
    throw e;
  }
  if (spec.settledNow) await drainWakes(ctx.engine, { ids: [rowId], runtime }).catch(() => {});
  if (sub.addition && (sub.addition.text || sub.addition.meta)) ctx.emitToolTail?.({ text: sub.addition.text, meta: sub.addition.meta });
  return { rowId, recognized: sub.agent ? sub.agent.harness !== null || sub.agent.claimed !== null : true };
}

function unrecognized(tool: string) {
  return { wakeable: false, note: `Wakeshift did not recognize this agent program, so it may not be able to wake you: call ${tool} again with harness set to your program.` };
}

/** The live runtime and the watching principal, after the checks every watch shares. */
async function watchContext(ctx: OperationContext, tool: string, cliSuggestion: string, fix?: Fix): Promise<{ runtime: WakeshiftRuntime; principal: WatchPrincipal }> {
  if (ctx.remote === false) throw needsConversation(tool, cliSuggestion, fix);
  const runtime = wakeshiftRuntime();
  if (!runtime) throw notEnabled();
  const principal = await watchPrincipal(ctx);
  if (!principal) throw notEnabled();
  return { runtime, principal };
}

const watch_job: Operation = {
  name: 'watch_job',
  mutating: true,
  idempotent: true,
  writeInference: 'non_content',
  outputRedaction: REDACTION,
  description: 'This tool notifies you: it has gbrain wake this conversation through Wakeshift when job id finishes '
    + '(completed, failed, dead or cancelled), so you can stop polling. Call it right after submitting a long job, then end your turn '
    + 'or keep working. The wake names the job and says to call get_job for the result; it carries no page text. '
    + 'Agent-scoped tokens watch only jobs they own. If no wake arrives, call wait_job.',
  params: {
    id: { type: 'number', required: true, description: 'Job ID (from submit_job, submit_agent or list_jobs).' },
    ...CALLER_PARAMS,
  },
  scope: 'admin',
  agentCallable: true,
  publishGateKey: 'mcp.publish_wakeshift',
  cliHints: { hidden: true },
  handler: async (ctx, p) => {
    const id = p.id as number;
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw opError('invalid_params', `watch_job: id must be a positive job id (got ${JSON.stringify(p.id)}).`, 'Pass the id submit_job or list_jobs returned.');
    }
    const { runtime, principal } = await watchContext(ctx, 'watch_job', `Run gbrain jobs wait ${id} to block until the job finishes.`, waitFix(id));
    const step = await termsStep(ctx, runtime, principal, 'watch_job');
    if (step) return step;
    const owner = agentOwnerFence(ctx, 'watch_job');
    if (owner !== null) await assertJobOwned(ctx, id, owner);
    const [job] = await ctx.engine.executeRaw<{ status: string }>('SELECT status FROM minion_jobs WHERE id = $1', [id]);
    if (!job) throw jobNotFound(`Job not found: ${id}`);
    if (ctx.dryRun) return { dry_run: true, action: 'watch_job', job: id };
    const finished = TERMINAL.has(job.status);
    const { rowId, recognized } = await openWatch(ctx, runtime, principal, p, {
      tool: 'watch_job', event: JOB_FINISHED, target: String(id), args: { job: id }, reason: `Watching gbrain job ${id}`,
      settledNow: finished, fallback: `call wait_job ${id}`, fix: waitFix(id),
    });
    return {
      watching: true, watch: rowId, job: id, event: JOB_FINISHED, status: job.status, already_finished: finished,
      expires_in: WATCH_TTL,
      ...(recognized ? {} : unrecognized('watch_job')),
      fallback: `If no wake arrives, call wait_job ${id} (or run gbrain jobs wait ${id}).`,
    };
  },
};

const watch_write_request: Operation = {
  name: 'watch_write_request',
  mutating: true,
  idempotent: true,
  writeInference: 'non_content',
  outputRedaction: REDACTION,
  description: 'This tool notifies you: it has gbrain wake this conversation through Wakeshift when your write request settles '
    + '(committed, failed, conflict or cancelled), so you can stop polling get_write_request after write_pending. The wake names the '
    + 'request and says to call get_write_request; it carries no slug or page text. You can watch only your own receipts. If no wake arrives, call get_write_request.',
  params: {
    request_id: { type: 'string', required: true, description: 'The request_id you sent with the write, or the one its receipt shows.' },
    ...CALLER_PARAMS,
  },
  scope: 'write',
  agentCallable: true,
  publishGateKey: 'mcp.publish_wakeshift',
  cliHints: { hidden: true },
  handler: async (ctx, p) => {
    const requestId = parseWriteRequestId(p.request_id);
    if (!requestId) throw opError('invalid_params', 'request_id is required.', 'Pass the request_id you sent with the write, or the one its receipt shows; list_write_requests shows recent ones.');
    const { runtime, principal } = await watchContext(ctx, 'watch_write_request', `Run gbrain write-request -- ${requestId} to read the receipt.`, receiptFix(requestId));
    const step = await termsStep(ctx, runtime, principal, 'watch_write_request');
    if (step) return step;
    const { principal: writer } = await receiptAccess(ctx, 'get_write_request');
    const { getWriteRequest } = await import('../persistence/journal.ts');
    const row = await getWriteRequest(ctx.engine, writer, requestId);
    if (!row || !await receiptVisible(ctx, row)) throw receiptNotFound(receiptCallerSource(ctx));
    if (ctx.dryRun) return { dry_run: true, action: 'watch_write_request', request_id: row.request_id };
    const settled = ['failed', 'conflict', 'cancelled'].includes(row.state) || (row.state === 'committed' && row.recovery == null);
    const { rowId, recognized } = await openWatch(ctx, runtime, principal, p, {
      tool: 'watch_write_request', event: WRITE_SETTLED, target: row.request_id, targetRef: row.id, args: { request_id: row.request_id },
      reason: `Watching gbrain write request ${row.request_id}`, settledNow: settled,
      fallback: `call get_write_request ${row.request_id}`, fix: receiptFix(row.request_id),
    });
    return {
      watching: true, watch: rowId, request_id: row.request_id, event: WRITE_SETTLED, state: row.state, already_settled: settled,
      expires_in: WATCH_TTL,
      ...(recognized ? {} : unrecognized('watch_write_request')),
      fallback: `If no wake arrives, call get_write_request ${row.request_id} (or run gbrain write-request -- ${row.request_id}).`,
    };
  },
};

const watch_cron: Operation = {
  name: 'watch_cron',
  mutating: true,
  idempotent: true,
  writeInference: 'non_content',
  outputRedaction: REDACTION,
  description: 'This tool notifies you: it has gbrain wake this conversation through Wakeshift the next time the named cron reports its run '
    + '(ok or failed) with gbrain wakeshift emit. One wake per watch; call it again for the run after. The wake names the cron and the status; '
    + 'read the output where the cron writes it. Only crons the brain owner registered with gbrain wakeshift cron add can be watched.',
  params: {
    name: { type: 'string', required: true, description: 'The cron name the owner registered (letters, digits, dot, underscore and dash).' },
    ...CALLER_PARAMS,
  },
  scope: 'admin',
  publishGateKey: 'mcp.publish_wakeshift',
  cliHints: { hidden: true },
  handler: async (ctx, p) => {
    const name = cronName(p.name);
    if (!name) throw opError('invalid_params', 'watch_cron: name is required.', 'Pass the cron name the brain owner registered (gbrain wakeshift cron list shows them).');
    const { runtime, principal } = await watchContext(ctx, 'watch_cron', 'Check the cron output where it writes it.');
    const step = await termsStep(ctx, runtime, principal, 'watch_cron');
    if (step) return step;
    const registered = await ctx.engine.executeRaw('SELECT 1 FROM wake_crons WHERE name = $1', [name]);
    if (registered.length === 0) {
      throw opError('not_found', 'No registered cron has that name.',
        `Check the name with the brain owner: gbrain wakeshift cron list shows the registered crons, and gbrain wakeshift cron add ${name} registers this one.`);
    }
    if (ctx.dryRun) return { dry_run: true, action: 'watch_cron', cron: name };
    const fix = readFix('Lists the watches this connection holds and their state.', { mcp: { tool: 'list_watches', arguments: {} } });
    const { rowId, recognized } = await openWatch(ctx, runtime, principal, p, {
      tool: 'watch_cron', event: CRON_FINISHED, target: name, args: { name }, reason: `Watching gbrain cron ${name}`,
      settledNow: false, fallback: 'check the cron output where it writes it', fix,
    });
    return {
      watching: true, watch: rowId, cron: name, event: CRON_FINISHED, wakes: 'once, on the next run', expires_in: WATCH_TTL,
      ...(recognized ? {} : unrecognized('watch_cron')),
      fallback: 'If no wake arrives, read the cron output where it writes it.',
    };
  },
};

const accept_wakeshift_terms: Operation = {
  name: 'accept_wakeshift_terms',
  mutating: true,
  idempotent: true,
  writeInference: 'non_content',
  outputRedaction: REDACTION,
  description: 'Record that the user agreed to the agreement step a watch tool returned (agreement_required): this brain operator\'s terms and privacy policy '
    + 'and Wakeshift\'s Connector Terms and Privacy Policy. Call it only after showing the user that step and getting their agreement, then call the watch tool again.',
  params: {
    terms_version: { type: 'string', required: true, description: 'The terms_version from the agreement step.' },
  },
  scope: 'write',
  agentCallable: true,
  publishGateKey: 'mcp.publish_wakeshift',
  cliHints: { hidden: true },
  handler: async (ctx, p) => {
    const { runtime, principal } = await watchContext(ctx, 'accept_wakeshift_terms', 'Watching needs an MCP conversation; nothing to accept from the CLI.');
    if (await liveAccessMembers(ctx.engine) === 0) {
      return { accepted: false, required: false, note: 'This brain serves its owner alone, so no agreement step is needed; call the watch tool directly.' };
    }
    const terms = operatorTerms(runtime.file);
    if (!terms) throw termsUnset();
    if (p.terms_version !== terms.version) return { ...agreementStep(terms, 'Watching'), note: 'The operator\'s terms changed or the version did not match: show the user this step and pass its terms_version.' };
    if (ctx.dryRun) return { dry_run: true, action: 'accept_wakeshift_terms', terms_version: terms.version };
    await recordAcceptance(ctx.engine, principalRef(principal), terms);
    return { accepted: true, terms_version: terms.version, next: 'Call the watch tool again.' };
  },
};

interface WatchRow { id: number; event: string; target: string; state: string; attempts: number; last_error: string | null; created_at: Date | string; expires_at: Date | string }

function publicWatch(r: WatchRow) {
  const key = r.event === JOB_FINISHED ? { job: Number(r.target) } : r.event === WRITE_SETTLED ? { request_id: r.target } : r.event === CRON_FINISHED ? { cron: r.target } : {};
  return { watch: Number(r.id), event: r.event, target: r.target, ...key, state: r.state, attempts: r.attempts, last_error: r.last_error, created_at: r.created_at, expires_at: r.expires_at };
}

async function ownRows(ctx: OperationContext, extra: string, params: unknown[]): Promise<Array<WatchRow & { wake_user: string; ws_subscription_id: string }>> {
  const principal = await watchPrincipal(ctx);
  if (!principal) return [];
  return ctx.engine.executeRaw(
    `SELECT id, event, target, state, attempts, last_error, created_at, expires_at, wake_user, ws_subscription_id FROM wake_subscriptions
      WHERE principal_kind = $1 AND principal_id = $2 ${extra} ORDER BY created_at DESC, id DESC LIMIT 50`,
    [principal.kind, principal.id, ...params]);
}

const list_watches: Operation = {
  name: 'list_watches',
  mutating: false,
  idempotent: true,
  outputRedaction: REDACTION,
  description: 'List what this connection is watching through Wakeshift (jobs, write requests and crons: open watches, plus ones that ended in the last day) with their state: open, delivered, dead or ended.',
  params: {},
  scope: 'write',
  agentCallable: true,
  publishGateKey: 'mcp.publish_wakeshift',
  cliHints: { hidden: true },
  handler: async (ctx) => {
    if (!wakeshiftRuntime()) throw notEnabled();
    const rows = await ownRows(ctx, "AND (state = 'open' OR updated_at > now() - interval '1 day')", []);
    return { watches: rows.map(publicWatch) };
  },
};

/** The one target an unwatch names, as a row filter. */
function unwatchFilter(p: Record<string, unknown>): { key: Record<string, unknown>; extra: string; params: unknown[] } {
  const given = (['job', 'request_id', 'cron', 'watch'] as const).filter(k => p[k] !== undefined && p[k] !== null);
  const usage = () => opError('invalid_params', 'unwatch: pass exactly one of job, request_id, cron or watch.', 'Pass the id you watched; list_watches shows your watches and their ids.');
  if (given.length !== 1) throw usage();
  const k = given[0]!;
  if (k === 'job' || k === 'watch') {
    const n = p[k] as number;
    if (!Number.isSafeInteger(n) || n <= 0) throw usage();
    return k === 'job'
      ? { key: { job: n }, extra: 'AND event = $3 AND target = $4', params: [JOB_FINISHED, String(n)] }
      : { key: { watch: n }, extra: 'AND id = $3', params: [n] };
  }
  if (k === 'request_id') {
    const id = parseWriteRequestId(p.request_id);
    if (!id) throw usage();
    return { key: { request_id: id }, extra: 'AND event = $3 AND target = $4', params: [WRITE_SETTLED, id] };
  }
  const name = cronName(p.cron);
  if (!name) throw usage();
  return { key: { cron: name }, extra: 'AND event = $3 AND target = $4', params: [CRON_FINISHED, name] };
}

const unwatch: Operation = {
  name: 'unwatch',
  mutating: true,
  idempotent: true,
  writeInference: 'non_content',
  outputRedaction: REDACTION,
  description: 'Stop watching: ends this connection\'s open Wakeshift watches on one job, write request or cron (or one watch by its id), so no wake comes for it. Returns how many ended (0 when none was open).',
  params: {
    job: { type: 'number', description: 'Job ID you passed to watch_job.' },
    request_id: { type: 'string', description: 'Request id you passed to watch_write_request.' },
    cron: { type: 'string', description: 'Cron name you passed to watch_cron.' },
    watch: { type: 'number', description: 'A watch id from list_watches.' },
  },
  scope: 'write',
  agentCallable: true,
  publishGateKey: 'mcp.publish_wakeshift',
  cliHints: { hidden: true },
  handler: async (ctx, p) => {
    const runtime = wakeshiftRuntime();
    if (!runtime) throw notEnabled();
    const { key, extra, params } = unwatchFilter(p);
    if (ctx.dryRun) return { dry_run: true, action: 'unwatch', ...key };
    const rows = await ownRows(ctx, `AND state = 'open' ${extra}`, params);
    let ended = 0;
    for (const row of rows) {
      const done = await ctx.engine.executeRaw(`UPDATE wake_subscriptions SET state = 'ended', last_error = 'unwatched', lease_until = NULL, updated_at = now() WHERE id = $1 AND state = 'open' RETURNING id`, [row.id]);
      if (done.length === 0) continue;
      ended++;
      await endAtWakeshift(runtime.api, row);
    }
    return { ...key, ended };
  },
};

export const wakeshiftOperations: Operation[] = [watch_job, watch_write_request, watch_cron, accept_wakeshift_terms, list_watches, unwatch];
