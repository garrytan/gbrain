import { prepareRemoteJob, prepareRemoteAgent, assertRemoteJobControl } from '../minions/submission-authority.ts';
import type { MinionJob } from '../minions/types.ts';

function publicJob(job: MinionJob) {
  const { submission_authority: _authority, ...visible } = job;
  return { ...visible, private_queue_owner_token: job.private_queue_owner_token == null ? null : '[redacted]' };
}

/** Fields `list_jobs` may project to (F10 token trim): every public job field. */
const LIST_JOB_FIELDS = [
  'id', 'name', 'queue', 'status', 'priority', 'data', 'max_attempts', 'attempts_made', 'attempts_started', 'backoff_type',
  'backoff_delay', 'backoff_jitter', 'stalled_counter', 'max_stalled', 'lock_token', 'lock_until', 'delay_until', 'parent_job_id',
  'on_child_fail', 'tokens_input', 'tokens_output', 'tokens_cache_read', 'depth', 'max_children', 'timeout_ms', 'timeout_at',
  'lock_duration_ms', 'remove_on_complete', 'remove_on_fail', 'idempotency_key', 'private_queue_owner_job_id',
  'private_queue_owner_token', 'private_queue_lease_until', 'quiet_hours', 'stagger_key', 'result', 'progress', 'error_text',
  'stacktrace', 'created_at', 'started_at', 'finished_at', 'updated_at', 'coalesced',
] as const satisfies readonly (keyof MinionJob)[];

/** Parse list_jobs' `fields` (array or comma string); undefined = every field. */
function parseJobFields(raw: unknown): readonly string[] | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const list = (Array.isArray(raw) ? raw : String(raw).split(',')).map(f => String(f).trim()).filter(Boolean);
  const valid: ReadonlySet<string> = new Set(LIST_JOB_FIELDS);
  const unknown = list.filter(f => !valid.has(f));
  if (unknown.length > 0) {
    throw opError('invalid_params', `list_jobs: unknown field(s) ${unknown.map(f => JSON.stringify(f.slice(0, 40))).join(', ')}.`,
      `Pass fields from: ${LIST_JOB_FIELDS.join(', ')} (e.g. fields: ["id", "name", "status"]), or omit fields for every field.`);
  }
  return list.length ? list : undefined;
}

/**
 * Jobs (Minions) operation cluster — pure move from operations.ts (v0.46.x
 * tranche 2). Op consts stay module-private; `jobsOperations` below lists
 * them in EXACTLY the order they appear in the canonical `operations` array
 * in ../operations.ts (the array interleaves the generic queue ops before
 * the agent-lane pair, unlike the definition order here — the array order is
 * the contract). Never import from '../operations.ts' here (cycle).
 */

import type { Operation, OperationContext } from './contract.ts';
import { opError, type OperationError } from './contract.ts';
import type { Action } from '../agent-output.ts';
import { hostFix, invalidParam, readFix, scopeDeniedError } from './op-fix.ts';
import { hasScope } from '../scope.ts';
import { SOURCE_ID_RE } from '../source-id.ts';
import {
  assertEmbedBackfillQueueAdmission,
  InvalidEmbedBackfillSourceIdError,
  NoEmbedBackfillWorkerSurfaceError,
} from '../minions/embed-backfill-admission.ts';

// --- Jobs (Minions) ---

/**
 * #4098 — agent-lane ownership fence for the generic jobs ops.
 *
 * get_job / list_jobs / get_job_progress / cancel_job are `scope: 'admin'`
 * ops that gained `agentCallable: true` so an agent-scoped OAuth client can
 * monitor + cancel the jobs it submitted via submit_agent — WITHOUT admin.
 * Returns the owner client id to fence on, or null when the caller is
 * unfenced (full visibility):
 *
 *   - trusted local CLI (ctx.remote === false): unfenced (today's behavior)
 *   - token with admin scope: unfenced (satisfied the op's declared scope)
 *   - stdio MCP (remote, transport 'stdio', no per-token auth): unfenced —
 *     the local-pipe surface ceiling governs there, same posture as today
 *   - anything else (the agentCallable carve-out, i.e. agent scope without
 *     admin): MUST carry ctx.auth.clientId; fenced on
 *     `data->>'__owner_client_id'`. Missing identity → permission_denied
 *     (fail closed, mirroring get_agent_job).
 */
function agentOwnerFence(ctx: OperationContext, opName: string): string | null {
  if (ctx.remote === false) return null;
  const scopes = ctx.auth?.scopes;
  if (scopes && hasScope(scopes, 'admin')) return null;
  if (!ctx.auth && ctx.transport === 'stdio') return null;
  const clientId = ctx.auth?.clientId;
  if (!clientId || typeof clientId !== 'string') {
    throw scopeDeniedError({
      op: opName, required: ['admin'], auth: ctx.auth, transport: ctx.transport === 'http' ? 'http' : 'stdio',
      message: `${opName} without admin scope requires an authenticated OAuth client identity.`,
      legacy_error: 'permission_denied',
    });
  }
  return clientId;
}

function listJobsFix(why: string): Action {
  return readFix(why, { argv: ['gbrain', 'jobs', 'list', '--json'], mcp: { tool: 'list_jobs', arguments: {} } });
}

function getJobFix(id: unknown, why: string): Action {
  if (typeof id !== 'number' || !Number.isSafeInteger(id)) return listJobsFix('Lists jobs with their ids and current status.');
  return readFix(why, { argv: ['gbrain', 'jobs', 'get', String(id), '--json'], mcp: { tool: 'get_job', arguments: { id } } });
}

/** A1 frozen pair: a missing job keeps `error: invalid_params` and reports `code: not_found`. */
function jobNotFound(message: string): OperationError {
  return opError('not_found', message,
    'No job with that id is visible to this caller (jobs owned by another client read as missing). List jobs to find the right id.',
    { legacy_error: 'invalid_params', fix: listJobsFix('Lists the jobs this caller can see, with their ids and status.') });
}

/** The job exists but is in the wrong state for this transition; nothing changed. */
function jobStateError(id: unknown, message: string, need: string): OperationError {
  return opError('invalid_params', message, `Nothing changed. ${need} Check the job's current status first.`,
    { fix: getJobFix(id, 'Shows the job\'s current status, so you can pick the transition it allows.') });
}

/**
 * #4098 — SQL-side ownership check (the get_agent_job predicate, uniform
 * not-found). Foreign-owned and nonexistent ids are indistinguishable by
 * design (anti-enumeration): both throw the SAME error the unfenced path
 * throws for a missing id.
 */
async function assertJobOwned(ctx: OperationContext, id: number, owner: string): Promise<void> {
  const rows = await ctx.engine.executeRaw<{ id: number }>(
    `SELECT id FROM minion_jobs WHERE id = $1 AND data->>'__owner_client_id' = $2`,
    [id, owner],
  );
  if (rows.length === 0) {
    throw jobNotFound(`Job not found: ${id}`);
  }
}

function noWorkerSurface(ctx: OperationContext, e: NoEmbedBackfillWorkerSurfaceError): OperationError {
  const known = SOURCE_ID_RE.test(e.sourceId);
  const fix = hostFix(ctx, ['gbrain', 'embed', '--stale', '--source', known ? e.sourceId : '<source-id>'],
    'Embeds the stale chunks inline in the CLI process; this engine has no worker to drain a queued backfill.', { consent: ['paid'] });
  return opError('no_worker_surface', e.message,
    'Nothing was queued. Drain the embeddings inline with the command in fix instead of submitting a job.',
    { fix: known ? fix : { ...fix, inputs: [{ name: 'source-id', how: 'The source to embed (`gbrain sources list` shows them).' }] } });
}

const submit_job: Operation = {
  name: 'submit_job',
  idempotent: false,
  outputRedaction: { exempt: 'admin-scoped job introspection: job params and results are operator data, not retrieved brain text' },
  description: 'Submit a background job. Remote callers may submit sync, import, lint or lint-fix for their authenticated filesystem source. Other kinds require local CLI or a dedicated operation.',
  params: {
    name: { type: 'string', required: true, description: 'Remote job type: sync, import, lint, or lint-fix. Local CLI also supports other registered types.' },
    data: { type: 'object', description: 'Remote sync accepts optional pull/noPull (one boolean); other remote jobs accept no parameters. Source and paths are derived from the grant.' },
    queue: { type: 'string', description: 'Queue name (default: "default")' },
    priority: { type: 'number', description: 'Priority (0 = highest, default: 0)' },
    max_attempts: { type: 'number', description: 'Max retry attempts (default: 3)' },
    delay: { type: 'number', description: 'Delay in ms before eligible' },
    timeout_ms: { type: 'number', description: 'Per-job wall-clock timeout in ms; aborted job goes to dead' },
    lock_duration_ms: { type: 'number', description: 'Per-job lock lease in ms (#4145). Out-of-range values are clamped to [5000, 3600000] — remote writers cannot pin an immortal lock. Omit to use the handler-type default (300s for long LLM handlers) or the worker default (30s).' },
  },
  mutating: true,
  scope: 'admin',
  handler: async (ctx, p) => {
    const name = typeof p.name === 'string' ? p.name.trim() : '';
    let jobData = { ...((p.data as Record<string, unknown>) || {}) };
    const remoteSubmission = ctx.remote !== false ? await prepareRemoteJob(ctx, name, p.data) : undefined;
    if (remoteSubmission) jobData = remoteSubmission.data;
    const translateAdmissionError = (e: unknown): never => {
      if (e instanceof InvalidEmbedBackfillSourceIdError) {
        throw invalidParam(ctx, 'submit_job', 'data', e.message, { def: submit_job.params.data, example: { sourceId: ctx.sourceId ?? 'default' } });
      }
      if (e instanceof NoEmbedBackfillWorkerSurfaceError) throw noWorkerSurface(ctx, e);
      throw e;
    };

    // Dry-run is a feasibility preview, not an admission bypass. Evaluate the
    // read-only worker-surface gate before returning so MCP and CLI agree.
    try {
      assertEmbedBackfillQueueAdmission(ctx.engine, name, jobData);
    } catch (e) {
      translateAdmissionError(e);
    }
    if (ctx.dryRun) return { dry_run: true, action: 'submit_job', name };

    // Submit-side MCP guard: reject protected job names from untrusted callers
    // BEFORE we touch the DB. This is the first of the two security layers
    // (the second is MinionQueue.add's check). Independent of the worker-side
    // GBRAIN_ALLOW_SHELL_JOBS env flag — even if that flag is on, MCP callers
    // cannot submit protected-type jobs.
    const { isProtectedJobName } = await import('../minions/protected-names.ts');
    // F7b fail-closed: anything that is not strictly false (i.e., remote=true OR
    // the field somehow leaks in undefined despite the required type) rejects
    // protected job submissions. Closes the HTTP MCP shell-job RCE that surfaced
    // when the HTTP transport's OperationContext literal forgot to set remote.
    if (ctx.remote !== false && isProtectedJobName(name)) {
      throw opError('permission_denied', `'${name}' jobs cannot be submitted over MCP (CLI-only for security)`,
        'Protected job types run only from the trusted local CLI on the brain host; the user or host operator submits it there (command in fix).',
        { fix: { ...hostFix(ctx, ['gbrain', 'jobs', 'submit', name, '--params', '<params>'], `'${name}' jobs can execute host commands, so only the brain host's own CLI may queue them.`),
          inputs: [{ name: 'params', how: 'The job data as one JSON object (what you passed as data).' }] } });
    }

    const { MinionQueue } = await import('../minions/queue.ts');
    const queue = new MinionQueue(ctx.engine);
    // Trusted flag fires ONLY for an explicit local CLI submission of a protected
    // name. Strict `=== false` so an untyped/cast context can't escalate.
    const trusted = remoteSubmission
      ? { submissionAuthority: remoteSubmission.authority }
      : ctx.remote === false && isProtectedJobName(name) ? { allowProtectedSubmit: true } : undefined;

    // v0.35.8.0: pre-enqueue shell-job validation, parity with the CLI submit
    // path. Closes the bug class where shell.ts handler-time validation ran
    // AFTER queue.add() persisted the row (codex F-CDX-1). Note: this branch
    // only fires for trusted local submitters (`ctx.remote === false` AND
    // protected-name allowlist), so remote MCP callers never reach it — but
    // it stays here as defense-in-depth in case a future code path widens
    // the trust gate above.
    if (name === 'shell' && trusted) {
      const { validateShellJobParams } = await import('../minions/handlers/shell-validate.ts');
      validateShellJobParams(jobData);
    }

    const job = await (async () => {
      try {
        return await queue.add(name, jobData, {
          queue: (p.queue as string) || 'default',
          priority: (p.priority as number) || 0,
          max_attempts: (p.max_attempts as number) || 3,
          delay: (p.delay as number) || undefined,
          timeout_ms: (p.timeout_ms as number) || undefined,
          // #4145 [CEO-F7/R2-6]: range enforcement lives in queue.add's
          // clampLockDurationMs (ParamDef has no min/max support; wrong TYPE is
          // rejected by the shared number validation upstream of this handler).
          lock_duration_ms: (p.lock_duration_ms as number) || undefined,
        }, trusted);
      } catch (e) {
        return translateAdmissionError(e);
      }
    })();

    // v0.35.8.0: submit_job audit-log parity with the CLI path (codex F-CDX-4).
    // Pre-v0.35.8.0 the op handler bypassed the shell-audit JSONL writer
    // entirely. Lift the call here so both submit surfaces produce one
    // operational-trace line per shell submission. Best-effort; audit
    // failures never block submission.
    if (name === 'shell' && trusted) {
      try {
        const { logShellSubmission } = await import('../minions/handlers/shell-audit.ts');
        const inheritNames = Array.isArray(jobData.inherit)
          ? (jobData.inherit as unknown[]).filter((s): s is string => typeof s === 'string')
          : undefined;
        logShellSubmission({
          caller: 'mcp',
          // Gated on `trusted` (which requires ctx.remote === false), so
          // we know this path is a local trusted submitter — log it that way.
          remote: false,
          job_id: job.id,
          cwd: typeof jobData.cwd === 'string' ? jobData.cwd : '',
          cmd_display: typeof jobData.cmd === 'string' ? (jobData.cmd as string).slice(0, 80) : undefined,
          argv_display: Array.isArray(jobData.argv)
            ? (jobData.argv as unknown[]).filter((a): a is string => typeof a === 'string').map((a) => a.slice(0, 80))
            : undefined,
          inherit: inheritNames && inheritNames.length > 0 ? inheritNames : undefined,
        });
      } catch { /* audit failures never block submission */ }
    }

    // Amendments 24/25: post-enqueue queue-state probe (time-bounded,
    // fail-open). The job is already persisted; a probe failure degrades to
    // {probe_failed: true}, never an error on a successful submission.
    await emitNoWorkerNotice(ctx, job.queue);
    return { ...publicJob(job), queue_state: await probeQueueStateSafe(ctx, job.queue, [name]) };
  },
};

/**
 * Queue honesty (agent-first operator wave E5): an accepted job on a queue no
 * worker serves (always on PGLite unless a `gbrain jobs work` drain is live)
 * gets a model-visible `no_worker` notice with the drain/supervisor fix; a
 * PGLite fix behind a running serve becomes the stop-serve-then-run plan.
 * Best-effort: advice never fails a committed submission.
 */
async function emitNoWorkerNotice(ctx: OperationContext, queueName: string): Promise<void> {
  if (!ctx.emitNotice) return;
  try {
    const { queueWorkerAlive, noWorkerNotice, runWaitingJobsFix } = await import('../minions/no-worker.ts');
    const alive = queueWorkerAlive(queueName);
    if (alive !== false) return;
    const [row] = await ctx.engine.executeRaw<{ n: number }>("SELECT count(*)::int AS n FROM minion_jobs WHERE queue = $1 AND status = 'waiting'", [queueName]);
    const waiting = Number(row?.n ?? 0);
    if (waiting === 0) return;
    let fix = runWaitingJobsFix(ctx.engine.kind, queueName);
    if (ctx.config) {
      const { configReadiness, exclusiveFix } = await import('../readiness.ts');
      fix = exclusiveFix(fix, configReadiness(ctx.config, { transport: ctx.transport ?? 'stdio' }).lock_owner);
    }
    ctx.emitNotice(noWorkerNotice(ctx.engine.kind, queueName, waiting, fix));
  } catch { /* advice is best-effort */ }
}

/**
 * Wrapper around `probeQueueState` that also swallows module-load failures,
 * so BOTH submit surfaces (submit_job, submit_agent) satisfy amendment 24's
 * "probe failure NEVER errors a successful submission" — even when the
 * supervisor module itself cannot load.
 */
async function probeQueueStateSafe(
  ctx: OperationContext,
  queue: string,
  handlerNames: string[],
): Promise<Record<string, unknown>> {
  try {
    const { probeQueueState } = await import('../minions/supervisor.ts');
    return (await probeQueueState(ctx.engine, queue, handlerNames)) as unknown as Record<string, unknown>;
  } catch {
    return { probe_failed: true };
  }
}

function agentRunFix(ctx: OperationContext): Action {
  return {
    ...hostFix(ctx, ['gbrain', 'agent', 'run', '--', '<prompt>'],
      'Runs the agent loop in a local gbrain process; submit_agent is the entry point for OAuth clients over HTTP MCP.', { consent: ['paid'] }),
    inputs: [{ name: 'prompt', how: 'The prompt you meant to submit.' }],
  };
}

const CALLER_FIXABLE_DELEGATION = ['delegated_tools_invalid', 'delegated_prefixes_invalid', 'job_namespace_cannot_be_overridden'];

function delegationDenied(ctx: OperationContext, error: Error & { reasons: string[] }): OperationError {
  const reason = error.reasons[0];
  if (error.reasons.every(r => CALLER_FIXABLE_DELEGATION.includes(r))) {
    return opError('permission_denied', error.message,
      'Nothing was queued. Request only tools and slug prefixes inside this client\'s delegation grant, or omit allowed_tools and allowed_slug_prefixes to use the whole grant.',
      { reason });
  }
  return opError('permission_denied', error.message,
    'Nothing was queued. This client\'s delegation grant no longer authorizes the job; the brain host operator reviews the client registration (command in fix).',
    { reason, fix: hostFix(ctx, ['gbrain', 'auth', 'clients', '--json'], 'Lists OAuth clients with their delegation bindings, so the operator can repair this one.') });
}

// v0.38 Slice 3 — D13 — remote-callable submit_agent with registration-time
// binding enforcement. Distinct from `submit_job` because:
//   1. It's the FIRST op that lets remote MCP callers spawn paid LLM work
//      (cost concerns + audit trail differ from generic submit_job).
//   2. The trust boundary lives in oauth_clients.bound_* fields, not in the
//      protected-name guard. Bindings are enforced PER-OP, not per-name.
//   3. The dispatcher is the subagent handler with the gateway-native loop
//      (agent.use_gateway_loop is auto-on for submit_agent jobs).
const submit_agent: Operation = {
  name: 'submit_agent',
  idempotent: false,
  outputRedaction: { exempt: 'admin-scoped job introspection: job params and results are operator data, not retrieved brain text' },
  description: 'Submit an LLM agent job that the worker dispatches via the gateway-native tool loop. Requires the `agent` OAuth scope. Tools, source, slug prefixes, max concurrency, and daily budget are bound at OAuth client registration time.',
  params: {
    prompt: { type: 'string', required: true, description: 'User prompt for the agent' },
    model: { type: 'string', description: 'provider:model string (defaults to models.tier.subagent)' },
    allowed_tools: { type: 'array', description: 'Subset of bound_tools the agent may invoke', items: { type: 'string' } },
    allowed_slug_prefixes: { type: 'array', description: 'Subset of delegated_slug_prefixes for writes; omit for a job-owned namespace', items: { type: 'string' } },
    max_turns: { type: 'number', description: 'Max LLM turns (default 20, hard cap 100)' },
    queue: { type: 'string', description: 'Queue name (default "default")' },
  },
  mutating: true,
  scope: 'agent',
  handler: async (ctx, p) => {
    // Remote-callable but only when the OAuth client has scope=agent AND
    // a binding row. Local CLI callers (ctx.remote === false) skip the
    // binding check — `gbrain agent run` already runs through subagent.ts
    // directly without going through this op.
    if (ctx.remote === false) {
      throw opError('invalid_request', 'submit_agent over the local CLI: use `gbrain agent run` instead.',
        'On the local CLI, run the agent directly with the command in fix.', { fix: agentRunFix(ctx) });
    }

    const clientId = (ctx as { auth?: { clientId?: string } }).auth?.clientId;
    if (!clientId || typeof clientId !== 'string') {
      const message = 'submit_agent requires an OAuth client with the `agent` scope.';
      if (ctx.transport === 'http') throw scopeDeniedError({ op: 'submit_agent', required: ['agent'], auth: ctx.auth, transport: 'http', message, legacy_error: 'permission_denied' });
      throw opError('permission_denied', message,
        'submit_agent needs an HTTP MCP connection authenticated as an OAuth client with the agent scope. On this machine, the user runs the agent with the command in fix.',
        { fix: agentRunFix(ctx) });
    }

    const { currentDelegationGrant, submissionSnapshot, DelegationDeniedError } = await import('../minions/delegated-policy.ts');
    const { hasScope } = await import('../scope.ts');
    if (!hasScope(ctx.auth?.scopes ?? [], 'agent')) {
      throw scopeDeniedError({
        op: 'submit_agent', required: ['agent'], auth: ctx.auth, transport: ctx.transport === 'http' ? 'http' : 'stdio',
        message: 'submit_agent requires the agent scope.', legacy_error: 'permission_denied',
      });
    }
    const { TIER_DEFAULTS } = await import('../model-config.ts');
    const bad = (param: string, message: string, example: unknown) =>
      invalidParam(ctx, 'submit_agent', param, message, { def: submit_agent.params[param], example });
    if (typeof p.prompt !== 'string' || p.prompt.trim() === '') throw bad('prompt', 'prompt must be nonempty', "Summarize this week's new pages.");
    const maxTurns = p.max_turns ?? 20;
    if (!Number.isSafeInteger(maxTurns) || Number(maxTurns) < 1 || Number(maxTurns) > 100) {
      throw bad('max_turns', 'max_turns must be an integer from 1 to 100', 20);
    }
    if (p.model !== undefined && (typeof p.model !== 'string' || p.model.trim() === '')) {
      throw bad('model', 'model must name a supported agent tool-loop model', TIER_DEFAULTS.subagent);
    }
    if (p.queue !== undefined && (typeof p.queue !== 'string' || !p.queue.trim())) throw bad('queue', 'queue must be nonempty', 'default');
    const { classifyCapabilities } = await import('../ai/capabilities.ts');
    const { normalizeModelId, splitProviderModelId } = await import('../model-id.ts');
    const { resolveModel, isAnthropicProvider, isOpenRouterSubagentFamily } = await import('../model-config.ts');
    const { isConfigTruthy } = await import('../config.ts');
    const resolvedModel = typeof p.model === 'string' ? p.model : await resolveModel(ctx.engine, { tier: 'subagent', configKey: 'models.subagent', fallback: TIER_DEFAULTS.subagent });
    const modelForVerdict = splitProviderModelId(resolvedModel).provider === null && isAnthropicProvider(resolvedModel) ? normalizeModelId(resolvedModel) : resolvedModel;
    if (['unknown', 'unusable:no_tools', 'unusable:no_subagent_loop'].includes(classifyCapabilities(modelForVerdict))) {
      throw bad('model', 'model must name a supported agent tool-loop model', TIER_DEFAULTS.subagent);
    }
    if (!isAnthropicProvider(resolvedModel) && !isOpenRouterSubagentFamily(resolvedModel)
      && !isConfigTruthy(await ctx.engine.getConfig('agent.use_gateway_loop'))) {
      throw opError('invalid_params', 'This provider requires agent.use_gateway_loop=true before submitting an agent job.',
        `Nothing was queued. Pass a model from an Anthropic or OpenRouter family (for example ${TIER_DEFAULTS.subagent}), or ask the brain host operator to enable agent.use_gateway_loop (command in fix).`,
        { fix: hostFix(ctx, ['gbrain', 'config', 'set', 'agent.use_gateway_loop', 'true'], 'Lets the worker run non-Anthropic providers through the gateway-native tool loop.') });
    }
    let snapshot;
    try {
      const grant = await currentDelegationGrant(ctx.engine, clientId, ctx.brainId);
      snapshot = submissionSnapshot(grant, p, ctx.auth?.sourceId);
    } catch (error) {
      if (error instanceof DelegationDeniedError) throw delegationDenied(ctx, error);
      throw error;
    }
    const boundSource = snapshot.sourceId;
    const boundMaxConcurrent = snapshot.maxConcurrent;
    const budgetCapText = snapshot.budgetUsdPerDay;
    const requestedTools = snapshot.tools;
    const requestedSlugPrefixes = snapshot.slugPrefixes;
    const jobData: Record<string, unknown> = {
      prompt: p.prompt, max_turns: maxTurns, model: resolvedModel,
      allowed_tools: requestedTools, allowed_slug_prefixes: requestedSlugPrefixes,
      source_id: snapshot.sourceId, __owner_client_id: clientId,
      __delegation_grant: snapshot,
    };
    const authority = await prepareRemoteAgent(ctx, jobData);
    if (ctx.dryRun) {
      return {
        dry_run: true, action: 'submit_agent', client_id: clientId,
        bound_tools: requestedTools, bound_source: boundSource,
        bound_max_concurrent: boundMaxConcurrent,
        resolved_tools: requestedTools, resolved_slug_prefixes: requestedSlugPrefixes,
        resolved_model: resolvedModel,
        spending: budgetCapText === null ? { mode: 'unlimited' } : { mode: 'capped', usd_per_day: budgetCapText },
      };
    }
    const { MinionQueue } = await import('../minions/queue.ts');
    const queue = new MinionQueue(ctx.engine);
    let job;
    try {
      job = await queue.add('subagent', jobData,
        { queue: (p.queue as string) || 'default' },
        { allowProtectedSubmit: true, delegatedClientId: clientId, submissionAuthority: authority });
    } catch (error) {
      const { isQueueQuotaExceededError } = await import('../minions/admission.ts');
      if (isQueueQuotaExceededError(error)) {
        throw opError('rate_limited', error.message,
          'Nothing was queued: this client is at its concurrent agent-job limit. Check its jobs, and submit again once one finishes.',
          { fix: listJobsFix('Shows this client\'s jobs and their status, including the ones holding its concurrency slots.') });
      }
      if (error instanceof DelegationDeniedError) throw delegationDenied(ctx, error);
      throw error;
    }

    // Audit trail (D4) — best-effort JSONL.
    try {
      const { logAgentSubmission } = await import('../minions/agent-audit.ts');
      const budgetCapCents = budgetCapText ? Math.round(parseFloat(budgetCapText) * 100) : null;
      const promptText = typeof p.prompt === 'string' ? p.prompt : '';
      logAgentSubmission({
        client_id: clientId,
        job_id: job.id,
        model: resolvedModel,
        bound_tools: requestedTools,
        bound_source: boundSource,
        slug_prefixes: requestedSlugPrefixes,
        max_concurrent: boundMaxConcurrent,
        budget_remaining_cents: budgetCapCents,
        prompt_byte_count: Buffer.byteLength(promptText, 'utf8'),
        outcome: 'submitted',
      });
    } catch { /* never block submission */ }

    // Amendments 24/25: the returned job id means nothing if the lane is
    // dead — attach a time-bounded, fail-open queue-state probe.
    return {
      id: job.id,
      name: 'subagent',
      client_id: clientId,
      // Honest-dispatch: true when this submit was param-coalesced onto an
      // existing WAITING job with identical params (same owner lane) instead
      // of enqueuing a new one. Clients wanting N independent runs of one
      // prompt should vary the params (adversarial-review finding — the flag
      // makes the suppression detectable rather than silent).
      ...(job.coalesced === true ? { coalesced: true } : {}),
      queue_state: await probeQueueStateSafe(ctx, job.queue, ['subagent']),
    };
  },
};

/**
 * Minions-visibility wave — ownership-fenced agent-job status (amendment 27).
 *
 * The companion read for `submit_agent`: an agent-scoped client can poll ONLY
 * its own delegated jobs. Deliberate posture:
 *   - `ctx.auth.clientId` is REQUIRED on EVERY transport — stdio and legacy
 *     bearer callers carry no client identity and are refused
 *     (permission_denied) rather than silently unfenced. This is stricter
 *     than scope enforcement alone (which local/stdio callers bypass).
 *   - The ownership filter is a fail-closed SQL WHERE on
 *     `data->>'__owner_client_id'` (the JSONB predicate submit_agent already
 *     uses for its concurrency cap — identical semantics on both engines),
 *     never a post-fetch JS check.
 *   - Foreign and missing ids return one uniform `not_found` envelope so the
 *     op is not a job-id enumeration oracle (ENG-13; the ErrorCode comment
 *     was widened accordingly). Shell/admin jobs stay on admin-scope
 *     `get_job` — this op reads the agent lane (`name = 'subagent'`) only.
 *   - `queue_position` = count of waiting jobs ahead in claim order
 *     (priority ASC, created_at ASC — the exact ORDER BY of
 *     `MinionQueue.claim`), computed only while status = 'waiting'.
 */
const get_agent_job: Operation = {
  name: 'get_agent_job',
  mutating: false,
  idempotent: true,
  outputRedaction: 'retrieval',
  description: 'Poll an agent job submitted via submit_agent. Returns a trimmed status view (id, status, timestamps, error_text, result) plus queue_position (waiting jobs ahead in claim order; 0 = next) while the job is still waiting. Requires the `agent` OAuth scope; only jobs owned by the calling client are visible.',
  params: {
    id: { type: 'number', required: true, description: 'Job id returned by submit_agent' },
  },
  scope: 'agent',
  handler: async (ctx, p) => {
    const clientId = ctx.auth?.clientId;
    if (!clientId || typeof clientId !== 'string') {
      throw opError(
        'permission_denied',
        'get_agent_job requires an authenticated OAuth client identity.',
        'Call over HTTP MCP with an `agent`-scoped token. Transports without a per-client identity (stdio, legacy bearer) cannot read agent jobs; read the job with admin-scope get_job instead (fix).',
        { fix: getJobFix(p.id, 'get_job reads any job for an admin-scope or trusted local caller.') },
      );
    }
    const id = p.id;
    if (typeof id !== 'number' || !Number.isInteger(id)) {
      throw invalidParam(ctx, 'get_agent_job', 'id', 'id must be an integer job id', { def: get_agent_job.params.id, example: 42 });
    }

    // One round-trip: the ownership fence rides the WHERE, and the
    // queue_position subselect mirrors MinionQueue.claim's candidate set
    // (same queue, status='waiting') and ORDER BY (priority, created_at),
    // with the row id as the deterministic tie-break. Perf: the outer lookup
    // is a primary-key read; the subselect's (queue, status) filter is
    // covered by the wave's wedge-index prefix once that migration (another
    // lane) lands, and stays a small scan until then.
    const rows = await ctx.engine.executeRaw<{
      id: number;
      status: string;
      created_at: string | Date | null;
      started_at: string | Date | null;
      finished_at: string | Date | null;
      error_text: string | null;
      result: unknown;
      queue_position: number | string | null;
    }>(
      `SELECT j.id, j.status, j.created_at, j.started_at, j.finished_at, j.error_text, j.result,
              CASE WHEN j.status = 'waiting' THEN (
                SELECT count(*)::int FROM minion_jobs q
                 WHERE q.queue = j.queue AND q.status = 'waiting'
                   AND (q.priority < j.priority
                        OR (q.priority = j.priority AND q.created_at < j.created_at)
                        OR (q.priority = j.priority AND q.created_at = j.created_at AND q.id < j.id))
              ) ELSE NULL END AS queue_position
         FROM minion_jobs j
        WHERE j.id = $1
          AND j.name = 'subagent'
          AND j.data->>'__owner_client_id' = $2`,
      [id, clientId],
    );
    if (rows.length === 0) {
      // Uniform envelope: foreign-owned and nonexistent ids are
      // indistinguishable by design (anti-enumeration).
      throw opError('not_found', `Job not found: ${id}`,
        'No agent job with that id belongs to this client. List your jobs to find the right id.',
        { fix: listJobsFix('Lists the jobs this client owns, with their ids and status.') });
    }
    const row = rows[0];
    const iso = (v: string | Date | null): string | null =>
      v ? (v instanceof Date ? v.toISOString() : new Date(v).toISOString()) : null;
    // PGLite may hand jsonb back as text; postgres.js parses it.
    let result: unknown = row.result ?? null;
    if (typeof result === 'string') {
      try { result = JSON.parse(result); } catch { /* keep raw text */ }
    }
    return {
      id: row.id,
      status: row.status,
      created_at: iso(row.created_at),
      started_at: iso(row.started_at),
      finished_at: iso(row.finished_at),
      // Cap: error_text is an unbounded worker-written field (stack traces,
      // provider dumps); a remote polling view shouldn't ship megabytes.
      error_text: row.error_text ? row.error_text.slice(0, 2000) : null,
      result,
      ...(row.status === 'waiting' && row.queue_position !== null
        ? { queue_position: Number(row.queue_position) }
        : {}),
    };
  },
};

const get_job: Operation = {
  name: 'get_job',
  mutating: false,
  idempotent: true,
  outputRedaction: { exempt: 'admin-scoped job introspection: job params and results are operator data, not retrieved brain text' },
  description: 'Get job status and details by ID. Agent-scoped tokens (no admin) see only jobs they own.',
  params: {
    id: { type: 'number', required: true, description: 'Job ID' },
  },
  scope: 'admin',
  agentCallable: true,
  handler: async (ctx, p) => {
    const owner = agentOwnerFence(ctx, 'get_job');
    if (owner !== null) await assertJobOwned(ctx, p.id as number, owner);
    const { MinionQueue } = await import('../minions/queue.ts');
    const queue = new MinionQueue(ctx.engine);
    const job = await queue.getJob(p.id as number);
    if (!job) throw jobNotFound(`Job not found: ${p.id}`);
    // private_queue_owner_token is a capability credential (lease renewal /
    // attach), not job data — never expose it over MCP envelopes.
    return publicJob(job);
  },
};

const list_jobs: Operation = {
  name: 'list_jobs',
  mutating: false,
  idempotent: true,
  outputRedaction: { exempt: 'admin-scoped job introspection: job params and results are operator data, not retrieved brain text' },
  description: 'List background jobs with optional status/queue/name filters; pass fields to project each job to the columns you need. Use when checking queued or failed work. Needs admin scope (agent-scoped tokens see only jobs they own).',
  params: {
    status: { type: 'string', description: 'Filter by status (waiting, active, completed, failed, delayed, dead, cancelled)' },
    queue: { type: 'string', description: 'Filter by queue name' },
    name: { type: 'string', description: 'Filter by job type' },
    limit: { type: 'number', description: 'Max results (default: 50)' },
    fields: { type: 'array', items: { type: 'string' }, description: 'Return only these job fields (e.g. ["id","name","status"]) to save tokens; omit for every field.' },
  },
  scope: 'admin',
  agentCallable: true,
  handler: async (ctx, p) => {
    const fields = parseJobFields(p.fields);
    const owner = agentOwnerFence(ctx, 'list_jobs');
    const { MinionQueue } = await import('../minions/queue.ts');
    const queue = new MinionQueue(ctx.engine);
    const jobs = await queue.getJobs({
      status: p.status as string | undefined,
      queue: p.queue as string | undefined,
      name: p.name as string | undefined,
      limit: (p.limit as number) || 50,
      // #4098: SQL-side ownership fence for agent-scoped callers.
      ...(owner !== null ? { ownerClientId: owner } : {}),
    } as Parameters<typeof queue.getJobs>[0]);
    // private_queue_owner_token is a capability credential (lease renewal /
    // attach), not job data — never expose it over MCP envelopes.
    const visible = jobs.map(publicJob);
    return fields ? visible.map(j => Object.fromEntries(fields.map(f => [f, (j as Record<string, unknown>)[f]]))) : visible;
  },
};

const cancel_job: Operation = {
  name: 'cancel_job',
  idempotent: false,
  outputRedaction: { exempt: 'admin-scoped job introspection: job params and results are operator data, not retrieved brain text' },
  description: 'Cancel a waiting, active, or delayed job. Agent-scoped tokens (no admin) can cancel only jobs they own.',
  params: {
    id: { type: 'number', required: true, description: 'Job ID' },
  },
  mutating: true,
  scope: 'admin',
  agentCallable: true,
  handler: async (ctx, p) => {
    if (ctx.dryRun) return { dry_run: true, action: 'cancel_job', id: p.id };
    const owner = agentOwnerFence(ctx, 'cancel_job');
    const { MinionQueue } = await import('../minions/queue.ts');
    const queue = new MinionQueue(ctx.engine);
    // #4098: the owner predicate rides the recursive cancel's CTE seed — a
    // fenced caller can cancel only roots it owns (descendants of an owned
    // root cascade as usual). Foreign and missing ids share one envelope.
    const cancelled = await queue.cancelJob(p.id as number, owner !== null ? { ownerClientId: owner } : undefined);
    if (!cancelled) throw jobStateError(p.id, `Cannot cancel job ${p.id} (may already be in terminal status)`, 'Only waiting, active, delayed or paused jobs can be cancelled.');
    // private_queue_owner_token is a capability credential (lease renewal /
    // attach), not job data — never expose it over MCP envelopes.
    return publicJob(cancelled);
  },
};

const retry_job: Operation = {
  name: 'retry_job',
  idempotent: false,
  outputRedaction: { exempt: 'admin-scoped job introspection: job params and results are operator data, not retrieved brain text' },
  description: 'Re-queue a failed or dead background job. Use when the cause of the failure is fixed. Needs admin scope. On not_found: list job ids with list_jobs.',
  params: {
    id: { type: 'number', required: true, description: 'Job ID' },
  },
  mutating: true,
  scope: 'admin',
  handler: async (ctx, p) => {
    if (ctx.dryRun) return { dry_run: true, action: 'retry_job', id: p.id };
    const { MinionQueue } = await import('../minions/queue.ts');
    const queue = new MinionQueue(ctx.engine);
    const prior = await queue.getJob(p.id as number);
    if (!prior) throw jobNotFound('Job not found');
    await assertRemoteJobControl(ctx, prior);
    const retried = await queue.retryJob(p.id as number);
    if (!retried) throw jobStateError(p.id, `Cannot retry job ${p.id} (must be failed or dead)`, 'Only failed or dead jobs can be re-queued.');
    // private_queue_owner_token is a capability credential (lease renewal /
    // attach), not job data — never expose it over MCP envelopes.
    return publicJob(retried);
  },
};

const get_job_progress: Operation = {
  name: 'get_job_progress',
  mutating: false,
  idempotent: true,
  outputRedaction: { exempt: 'admin-scoped job introspection: job params and results are operator data, not retrieved brain text' },
  description: 'Get structured progress for a running job. Agent-scoped tokens (no admin) see only jobs they own.',
  params: {
    id: { type: 'number', required: true, description: 'Job ID' },
  },
  scope: 'admin',
  agentCallable: true,
  handler: async (ctx, p) => {
    const owner = agentOwnerFence(ctx, 'get_job_progress');
    if (owner !== null) await assertJobOwned(ctx, p.id as number, owner);
    const { MinionQueue } = await import('../minions/queue.ts');
    const queue = new MinionQueue(ctx.engine);
    const job = await queue.getJob(p.id as number);
    if (!job) throw jobNotFound(`Job not found: ${p.id}`);
    return { id: job.id, name: job.name, status: job.status, progress: job.progress };
  },
};

const pause_job: Operation = {
  name: 'pause_job',
  idempotent: false,
  outputRedaction: { exempt: 'admin-scoped job introspection: job params and results are operator data, not retrieved brain text' },
  description: 'Pause a waiting, active or delayed background job. Use when a job must stop without being cancelled. Needs admin scope. On not_found: list job ids with list_jobs.',
  params: {
    id: { type: 'number', required: true, description: 'Job ID' },
  },
  mutating: true,
  scope: 'admin',
  handler: async (ctx, p) => {
    if (ctx.dryRun) return { dry_run: true, action: 'pause_job', id: p.id };
    const { MinionQueue } = await import('../minions/queue.ts');
    const queue = new MinionQueue(ctx.engine);
    const job = await queue.pauseJob(p.id as number);
    if (!job) throw jobStateError(p.id, `Job not found or not pausable: ${p.id}`, 'Only waiting, active or delayed jobs can be paused.');
    return { id: job.id, status: job.status };
  },
};

const resume_job: Operation = {
  name: 'resume_job',
  idempotent: false,
  outputRedaction: { exempt: 'admin-scoped job introspection: job params and results are operator data, not retrieved brain text' },
  description: 'Resume a paused background job (back to waiting). Use after pause_job once the job may continue. Needs admin scope. On not_found: list job ids with list_jobs.',
  params: {
    id: { type: 'number', required: true, description: 'Job ID' },
  },
  mutating: true,
  scope: 'admin',
  handler: async (ctx, p) => {
    if (ctx.dryRun) return { dry_run: true, action: 'resume_job', id: p.id };
    const { MinionQueue } = await import('../minions/queue.ts');
    const queue = new MinionQueue(ctx.engine);
    const prior = await queue.getJob(p.id as number);
    if (!prior) throw jobNotFound('Job not found');
    await assertRemoteJobControl(ctx, prior);
    const job = await queue.resumeJob(p.id as number);
    if (!job) throw jobStateError(p.id, `Job not found or not paused: ${p.id}`, 'Only paused jobs can be resumed.');
    return { id: job.id, status: job.status };
  },
};

const replay_job: Operation = {
  name: 'replay_job',
  idempotent: false,
  outputRedaction: { exempt: 'admin-scoped job introspection: job params and results are operator data, not retrieved brain text' },
  description: 'Replay a completed/failed/dead job, optionally with modified data',
  params: {
    id: { type: 'number', required: true, description: 'Source job ID to replay' },
    data_overrides: { type: 'object', required: false, description: 'Data fields to override (merged with original)' },
  },
  scope: 'admin',
  mutating: true,
  handler: async (ctx, p) => {
    if (ctx.dryRun) return { dry_run: true, action: 'replay_job', id: p.id };
    const { MinionQueue } = await import('../minions/queue.ts');
    const queue = new MinionQueue(ctx.engine);
    const prior = await queue.getJob(p.id as number);
    if (!prior) throw jobNotFound('Job not found');
    await assertRemoteJobControl(ctx, prior, p.data_overrides);
    const job = await queue.replayJob(p.id as number, p.data_overrides as Record<string, unknown> | undefined);
    if (!job) throw jobStateError(p.id, `Job not found or not in terminal state: ${p.id}`, 'Only completed, failed or dead jobs can be replayed.');
    return { id: job.id, name: job.name, status: job.status, source_id: p.id };
  },
};

const send_job_message: Operation = {
  name: 'send_job_message',
  idempotent: false,
  outputRedaction: { exempt: 'admin-scoped job introspection: job params and results are operator data, not retrieved brain text' },
  description: 'Send a sidechannel message to a running job\'s inbox (for jobs that read steering messages). Use when steering a long-running agent job. Needs admin scope. On not_found: list job ids with list_jobs.',
  params: {
    id: { type: 'number', required: true, description: 'Job ID to message' },
    payload: { type: 'object', required: true, description: 'Message payload (arbitrary JSON)' },
    sender: { type: 'string', required: false, description: 'Sender identity — honored for trusted local callers only (default: admin). Remote callers always send as their authenticated identity (mcp:<clientId8>); the param is ignored.' },
  },
  scope: 'admin',
  mutating: true,
  handler: async (ctx, p) => {
    if (ctx.dryRun) return { dry_run: true, action: 'send_job_message', id: p.id };
    const { MinionQueue } = await import('../minions/queue.ts');
    const queue = new MinionQueue(ctx.engine);

    // Sidechannel sender fence (fail-closed, A9). A remote caller must NEVER
    // pick its own sender (impersonation) nor inherit the trusted-local
    // 'admin' default — the persisted sender is the AUTHENTICATED identity,
    // derived exactly like the ops/schema-packs.ts audit actor
    // (mcp:<clientId8>). No authenticated identity → refuse before any write.
    if (ctx.remote !== false) {
      const clientId = ctx.auth?.clientId;
      if (!clientId) {
        throw opError(
          'permission_denied',
          'send_job_message requires an authenticated client identity when called remotely',
          'Nothing was sent. Connect over HTTP MCP as an OAuth client, or have the user send it from the trusted local CLI (command in fix).',
          { fix: { ...hostFix(ctx, ['gbrain', 'call', 'send_job_message', '<arguments>'], 'The trusted local CLI sends as admin; a remote caller needs its own authenticated identity.'),
            inputs: [{ name: 'arguments', how: 'The JSON arguments you passed: the job id and the payload to send.' }] } },
        );
      }
      const sender = `mcp:${clientId.slice(0, 8)}`;
      // The queue-level sender auth only admits in-band identities ('admin' /
      // the parent job id) — see MinionQueue.sendMessage. The op layer has
      // already authenticated this caller, so it validates job state the same
      // way and persists the derived identity itself (same insert shape,
      // raw payload object — never JSON.stringify into jsonb).
      const job = await queue.getJob(p.id as number);
      if (!job || ['completed', 'dead', 'cancelled', 'failed'].includes(job.status)) {
        throw jobStateError(p.id, `Job not found or not messageable: ${p.id}`, 'Only jobs that have not finished accept messages.');
      }
      const rows = await ctx.engine.executeRaw<{ id: number }>(
        `INSERT INTO minion_inbox (job_id, sender, payload)
         VALUES ($1, $2, $3)
         RETURNING id`,
        [p.id, sender, p.payload],
      );
      return { sent: true, message_id: Number(rows[0].id), job_id: p.id };
    }

    const msg = await queue.sendMessage(p.id as number, p.payload, (p.sender as string) ?? 'admin');
    if (!msg) throw jobStateError(p.id, `Job not found, not messageable, or sender unauthorized: ${p.id}`, 'Only unfinished jobs accept messages, from admin or the job\'s parent.');
    return { sent: true, message_id: msg.id, job_id: p.id };
  },
};


/**
 * CLI→MCP gap-closure wave — `gbrain jobs stats` was the one jobs verb with
 * no MCP equivalent (skills/minion-orchestrator documented the gap). Admin
 * scope for jobs-family consistency (every op above is admin; HTTP callers
 * need an admin-scope token). User story: an orchestrating agent checking
 * queue health / catching the silent-halt wedge without shelling out.
 */
const get_job_stats: Operation = {
  name: 'get_job_stats',
  mutating: false,
  idempotent: true,
  outputRedaction: 'no_stored_text',
  description:
    'Job queue statistics. PER-BLOCK scoping: by_status and queue_health are GLOBAL ' +
    '(unfiltered); by_type is windowed by since_hours; only the wedge block is scoped to ' +
    'the queue param. wedged: true is the silent-halt signal (a worker is alive but claiming ' +
    'nothing while work waits) — suggest restarting the jobs supervisor on the brain host. ' +
    'no_worker: true means work is waiting and NO worker is running for the queue (always on PGLite ' +
    'unless a gbrain jobs work drain is live); wedged is then false and the no_worker notice names the fix. ' +
    'private_queue: true means the queue is a parent-owned dream-inline queue: wedged is ' +
    'NEVER true for it and a worker restart cannot help — recovery runs automatically at ' +
    'worker spawn / dream-cycle start; suggest gbrain doctor for the per-queue verdict. ' +
    'Host-process diagnostics (renice, backpressure hints) stay on the gbrain jobs stats CLI.',
  params: {
    queue: { type: 'string', required: false, description: "Queue for the wedge signature (default 'default'). The other blocks stay global/windowed." },
    since_hours: { type: 'number', required: false, description: 'Window for the by_type rollup in hours (default 24, clamped 1..720).' },
  },
  scope: 'admin',
  area: 'jobs',
  handler: async (ctx, p) => {
    const { withRelationGuard } = await import('./contract.ts');
    return withRelationGuard(async () => {
      const { MinionQueue, deriveWedgeSignal } = await import('../minions/queue.ts');
      const queue = new MinionQueue(ctx.engine);
      const rawHours = typeof p.since_hours === 'number' && Number.isFinite(p.since_hours) ? p.since_hours : 24;
      const hours = Math.max(1, Math.min(720, rawHours));
      const stats = await queue.getStats({
        since: new Date(Date.now() - hours * 3_600_000),
        queue: typeof p.queue === 'string' && p.queue.length > 0 ? p.queue : 'default',
      });
      const { queueWorkerAlive } = await import('../minions/no-worker.ts');
      const { wedged, no_worker, wedge_threshold_minutes, private_queue } = deriveWedgeSignal(stats.wedge, { workerAlive: queueWorkerAlive(stats.wedge.queue) });
      if (no_worker) await emitNoWorkerNotice(ctx, stats.wedge.queue);
      // private_queue tells the MCP consumer "restart the worker" is dead-end
      // advice for this queue — it is parent-owned and needs reconciliation.
      return { schema_version: 1, window_hours: hours, ...stats, wedged, no_worker, wedge_threshold_minutes, private_queue };
    }, 'Job queue statistics (minions schema)');
  },
};

// Ops in EXACTLY the canonical `operations` array order.
export const jobsOperations: Operation[] = [
  submit_job, get_job, list_jobs, cancel_job, retry_job, get_job_progress,
  pause_job, resume_job, replay_job, send_job_message,
  submit_agent, get_agent_job, get_job_stats,
];
