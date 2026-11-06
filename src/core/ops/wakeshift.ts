/**
 * Report-back watches over Wakeshift (plan D6, D7): `watch_job`,
 * `list_watches`, `unwatch`. Listed only while the owner has run
 * `gbrain wakeshift enable` and a usable key is on the host (publish gate
 * `mcp.publish_wakeshift`, file plane plus key presence; no DB plane, so no
 * remote caller can flip it). `watch_job` runs the get_job owner fence first,
 * so a foreign id reads exactly like a missing one and nothing is sent. A
 * watch belongs to the principal that made it; list and unwatch touch only
 * that principal's rows. What leaves the machine: docs/guides/wakeshift.md.
 * Never import from '../operations.ts' here (cycle).
 */
import { opError, type Operation, type OperationContext, type OperationError } from './contract.ts';
import { readFix } from './op-fix.ts';
import { agentOwnerFence, assertJobOwned, jobNotFound } from './jobs.ts';
import { memberIdentityFor } from '../access/caller.ts';
import { WakeshiftError, type WakeshiftCall } from '../wakeshift/client.ts';
import { wakeshiftBrainKey, wakeshiftRuntime, wakeshiftSecret, wakeshiftUserId } from '../wakeshift/config.ts';
import { JOB_FINISHED } from '../wakeshift/events.ts';
import { drainWakes, endAtWakeshift, liveAccessMembers } from '../wakeshift/drain.ts';

const WATCH_TTL = '7d';
const TERMINAL = new Set(['completed', 'failed', 'dead', 'cancelled']);
const REDACTION = { exempt: 'watch bookkeeping: job ids, states and times, never retrieved brain text' } as const;

/** The three arguments Wakeshift asks a subscribing tool to take (its HTTP API, "The caller"). */
const CALLER_PARAMS = {
  session_key: { type: 'string', description: "This conversation's session_key, from an earlier result (a secret token, or a handle such as claude-code#2). Keep it to this conversation; don't share or log it." },
  harness: { type: 'string', description: "The program you're running in: codex, claude-code, cursor (local CLI or IDE), cursor-cloud (Cursor cloud agent), grok-bot, copilot-cli, opencode, antigravity, openclaw (even when it runs your turns in Codex), hermes, chatgpt, or your program's name if it isn't listed" },
  conversation_id: { type: 'string', description: 'Your own ID for this conversation, if your program gives you one. Cursor and Grok Bot: the output of `printenv CURSOR_CONVERSATION_ID`. Codex and Antigravity send it automatically; others leave it empty' },
} as const;

function waitFix(id: number) {
  return readFix('Waits for the job without Wakeshift (at most 55 s a call; call again while terminal is false).',
    { argv: ['gbrain', 'jobs', 'wait', String(id)], mcp: { tool: 'wait_job', arguments: { id } } });
}

function notEnabled(): OperationError {
  return opError('wakeshift_not_enabled', 'Reporting back through Wakeshift is off on this brain.',
    'Use wait_job instead, or ask the brain owner to run gbrain wakeshift enable on the brain host.');
}

export interface WatchPrincipal { kind: 'oauth_client' | 'legacy_token' | 'local_stdio'; id: string; member: string | null }

/** Who is watching: the verified credential (bound member when it has one), else the local stdio pipe. */
export async function watchPrincipal(ctx: OperationContext): Promise<WatchPrincipal | null> {
  const base = ctx.auth
    ? (ctx.auth.principal ?? (ctx.auth.clientId ? { kind: 'oauth_client' as const, id: ctx.auth.clientId } : null))
    : ctx.transport === 'stdio' ? { kind: 'local_stdio' as const, id: 'local' } : null;
  if (!base) return null;
  const identity = await memberIdentityFor(ctx.engine, { ...(ctx.auth ? { member: ctx.auth.member } : {}), principal: base });
  return { ...base, member: identity.find(i => i.startsWith('member:'))?.slice('member:'.length) ?? null };
}

const principalKey = (p: WatchPrincipal) => (p.member ? `member:${p.member}` : `${p.kind}:${p.id}`);

function optString(v: unknown, max: number): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined;
}

function wakeshiftFailure(e: WakeshiftError, id: number): OperationError {
  const fix = waitFix(id);
  if (e.code === 'other_client') {
    return opError('wakeshift_refused', 'Wakeshift refused the session_key: it belongs to a conversation in another program.',
      'Call watch_job again without session_key.', { reason: e.code, fix });
  }
  if (e.status === 0 || e.status === 429 || e.status >= 500) {
    return opError('wakeshift_unavailable', `Wakeshift could not take the watch (${e.code}); nothing was watched.`,
      `Retry watch_job in a minute, or call wait_job ${id} to wait without it.`, { reason: e.code, fix });
  }
  return opError('wakeshift_refused', `Wakeshift refused the watch (${e.code}): ${e.message}`,
    `Call wait_job ${id} to wait without Wakeshift; the brain owner can check the setup with gbrain wakeshift test.`, { reason: e.code, fix });
}

interface WatchRow { id: number; event: string; target: string; state: string; attempts: number; last_error: string | null; created_at: Date | string; expires_at: Date | string }

function publicWatch(r: WatchRow) {
  return { watch: Number(r.id), event: r.event, job: Number(r.target), state: r.state, attempts: r.attempts, last_error: r.last_error, created_at: r.created_at, expires_at: r.expires_at };
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
    if (ctx.remote === false) {
      throw opError('wakeshift_needs_conversation', 'watch_job wakes an MCP conversation; a CLI run has none to wake.',
        `Run gbrain jobs wait ${id} to block until the job finishes.`, { fix: waitFix(id) });
    }
    const runtime = wakeshiftRuntime();
    if (!runtime) throw notEnabled();
    if (await liveAccessMembers(ctx.engine) > 0) {
      throw opError('wakeshift_shared_brain', 'This brain now has live access members, so reporting back is paused; nothing was watched.',
        `Call wait_job ${id} to wait for the job.`, { fix: waitFix(id) });
    }
    const owner = agentOwnerFence(ctx, 'watch_job');
    if (owner !== null) await assertJobOwned(ctx, id, owner);
    const [job] = await ctx.engine.executeRaw<{ status: string }>('SELECT status FROM minion_jobs WHERE id = $1', [id]);
    if (!job) throw jobNotFound(`Job not found: ${id}`);
    const principal = await watchPrincipal(ctx);
    if (!principal) throw notEnabled();
    if (ctx.dryRun) return { dry_run: true, action: 'watch_job', job: id };

    const user = wakeshiftUserId(wakeshiftSecret(), wakeshiftBrainKey(ctx.config), principalKey(principal));
    const caller = ctx.mcpCaller;
    const call: WakeshiftCall = {
      user, tool: 'watch_job',
      ...(optString(caller?.client, 200) ? { client: optString(caller?.client, 200) } : {}),
      ...(caller?.meta && typeof caller.meta === 'object' ? { meta: caller.meta } : {}),
      ...(optString(caller?.userAgent, 400) ? { user_agent: optString(caller?.userAgent, 400) } : {}),
      ...(optString(p.session_key, 100) ? { session: optString(p.session_key, 100) } : {}),
      ...(optString(p.harness, 100) ? { harness: optString(p.harness, 100) } : {}),
      ...(optString(p.conversation_id, 200) ? { conversation: optString(p.conversation_id, 200) } : {}),
    };
    const args = { job: id };
    let sub;
    try {
      sub = await runtime.api.subscribe({ call, name: JOB_FINISHED, arguments: args, ttl: WATCH_TTL, once: true, reason: `Watching gbrain job ${id}` });
    } catch (e) {
      if (e instanceof WakeshiftError) throw wakeshiftFailure(e, id);
      throw e;
    }
    let rowId: number;
    try {
      const expires = sub.event_subscription.expires_at && !Number.isNaN(Date.parse(sub.event_subscription.expires_at))
        ? sub.event_subscription.expires_at : new Date(Date.now() + 7 * 86_400_000).toISOString();
      const [row] = await ctx.engine.executeRaw<{ id: number }>(
        `INSERT INTO wake_subscriptions (event, target, principal_kind, principal_id, member_id, wake_user, ws_subscription_id, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz)
         ON CONFLICT (wake_user, ws_subscription_id) WHERE state = 'open'
         DO UPDATE SET expires_at = EXCLUDED.expires_at, updated_at = now()
         RETURNING id`,
        [JOB_FINISHED, String(id), principal.kind, principal.id, principal.member, user, String(sub.event_subscription.id), expires]);
      rowId = Number(row!.id);
    } catch (e) {
      if (sub.event_subscription.created !== false) {
        await runtime.api.unsubscribe({ call, name: JOB_FINISHED, arguments: args, reason: 'rolled_back' }).catch(() => {});
      }
      throw e;
    }
    const finished = TERMINAL.has(job.status);
    if (finished) await drainWakes(ctx.engine, { ids: [rowId], api: runtime.api }).catch(() => {});
    if (sub.addition && (sub.addition.text || sub.addition.meta)) ctx.emitToolTail?.({ text: sub.addition.text, meta: sub.addition.meta });
    const recognized = sub.agent ? sub.agent.harness !== null || sub.agent.claimed !== null : true;
    return {
      watching: true, watch: rowId, job: id, event: JOB_FINISHED, status: job.status, already_finished: finished,
      expires_in: WATCH_TTL,
      ...(recognized ? {} : { wakeable: false, note: 'Wakeshift did not recognize this agent program, so it may not be able to wake you: call watch_job again with harness set to your program.' }),
      fallback: `If no wake arrives, call wait_job ${id} (or run gbrain jobs wait ${id}).`,
    };
  },
};

async function ownRows(ctx: OperationContext, extra: string, params: unknown[]): Promise<WatchRow[]> {
  const principal = await watchPrincipal(ctx);
  if (!principal) return [];
  return ctx.engine.executeRaw<WatchRow>(
    `SELECT id, event, target, state, attempts, last_error, created_at, expires_at, wake_user, ws_subscription_id FROM wake_subscriptions
      WHERE principal_kind = $1 AND principal_id = $2 ${extra} ORDER BY created_at DESC, id DESC LIMIT 50`,
    [principal.kind, principal.id, ...params]);
}

const list_watches: Operation = {
  name: 'list_watches',
  mutating: false,
  idempotent: true,
  outputRedaction: REDACTION,
  description: 'List the jobs this connection is watching through Wakeshift (open watches, plus ones that ended in the last day) with their state: open, delivered, dead or ended.',
  params: {},
  scope: 'admin',
  agentCallable: true,
  publishGateKey: 'mcp.publish_wakeshift',
  cliHints: { hidden: true },
  handler: async (ctx) => {
    if (!wakeshiftRuntime()) throw notEnabled();
    const rows = await ownRows(ctx, "AND (state = 'open' OR updated_at > now() - interval '1 day')", []);
    return { watches: rows.map(publicWatch) };
  },
};

const unwatch: Operation = {
  name: 'unwatch',
  mutating: true,
  idempotent: true,
  writeInference: 'non_content',
  outputRedaction: REDACTION,
  description: 'Stop watching a job: ends this connection\'s open Wakeshift watches on it, so no wake comes for it. Returns how many ended (0 when none was open).',
  params: { job: { type: 'number', required: true, description: 'Job ID you passed to watch_job.' } },
  scope: 'admin',
  agentCallable: true,
  publishGateKey: 'mcp.publish_wakeshift',
  cliHints: { hidden: true },
  handler: async (ctx, p) => {
    const runtime = wakeshiftRuntime();
    if (!runtime) throw notEnabled();
    const job = p.job as number;
    if (!Number.isSafeInteger(job) || job <= 0) throw opError('invalid_params', 'unwatch: job must be a positive job id.', 'Pass the job id you watched (list_watches shows them).');
    if (ctx.dryRun) return { dry_run: true, action: 'unwatch', job };
    const rows = await ownRows(ctx, "AND state = 'open' AND event = $3 AND target = $4", [JOB_FINISHED, String(job)]) as Array<WatchRow & { wake_user: string; ws_subscription_id: string }>;
    let ended = 0;
    for (const row of rows) {
      const done = await ctx.engine.executeRaw(`UPDATE wake_subscriptions SET state = 'ended', last_error = 'unwatched', lease_until = NULL, updated_at = now() WHERE id = $1 AND state = 'open' RETURNING id`, [row.id]);
      if (done.length === 0) continue;
      ended++;
      await endAtWakeshift(runtime.api, row);
    }
    return { job, ended };
  },
};

export const wakeshiftOperations: Operation[] = [watch_job, list_watches, unwatch];
