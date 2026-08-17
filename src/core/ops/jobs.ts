/**
 * Jobs (Minions) operation cluster — pure move from operations.ts (v0.46.x
 * tranche 2). Op consts stay module-private; `jobsOperations` below lists
 * them in EXACTLY the order they appear in the canonical `operations` array
 * in ../operations.ts (the array interleaves the generic queue ops before
 * the agent-lane pair, unlike the definition order here — the array order is
 * the contract). Never import from '../operations.ts' here (cycle).
 */

import type { Operation, OperationContext } from './contract.ts';
import { OperationError } from './contract.ts';
import { normalizeSlugPrefix } from './context.ts';

// --- Jobs (Minions) ---

const submit_job: Operation = {
  name: 'submit_job',
  description: 'Submit a background job to the Minions queue. Built-in types are registered by registerBuiltinHandlers (src/commands/jobs.ts) — e.g. sync, embed, lint, import, extract, backlinks, autopilot-cycle, subagent, and more; submitting an unknown name with --follow prints the full list. The `shell` type is CLI-only and rejected over MCP.',
  params: {
    name: { type: 'string', required: true, description: 'Job type (e.g. sync, embed, lint, import, extract, backlinks, autopilot-cycle; shell is CLI-only). Full registry: registerBuiltinHandlers in src/commands/jobs.ts.' },
    data: { type: 'object', description: 'Job payload (JSON)' },
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
      throw new OperationError('permission_denied', `'${name}' jobs cannot be submitted over MCP (CLI-only for security)`);
    }

    const { MinionQueue } = await import('../minions/queue.ts');
    const queue = new MinionQueue(ctx.engine);
    // Trusted flag fires ONLY for an explicit local CLI submission of a protected
    // name. Strict `=== false` so an untyped/cast context can't escalate.
    const trusted = ctx.remote === false && isProtectedJobName(name) ? { allowProtectedSubmit: true } : undefined;

    const jobData = (p.data as Record<string, unknown>) || {};

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

    const job = await queue.add(name, jobData, {
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
    return { ...job, queue_state: await probeQueueStateSafe(ctx, job.queue, [name]) };
  },
};

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
  description: 'Submit an LLM agent job that the worker dispatches via the gateway-native tool loop. Requires the `agent` OAuth scope. Tools, source, slug prefixes, max concurrency, and daily budget are bound at OAuth client registration time.',
  params: {
    prompt: { type: 'string', required: true, description: 'User prompt for the agent' },
    model: { type: 'string', description: 'provider:model string (defaults to models.tier.subagent)' },
    allowed_tools: { type: 'array', description: 'Subset of bound_tools the agent may invoke', items: { type: 'string' } },
    allowed_slug_prefixes: { type: 'array', description: 'Subset of bound_slug_prefixes for put_page writes', items: { type: 'string' } },
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
      throw new OperationError('invalid_request', 'submit_agent over the local CLI: use `gbrain agent run` instead.');
    }

    const clientId = (ctx as { auth?: { clientId?: string } }).auth?.clientId;
    if (!clientId || typeof clientId !== 'string') {
      throw new OperationError('permission_denied', 'submit_agent requires an OAuth client with the `agent` scope.');
    }

    // Load the binding row.
    const { sqlQueryForEngine } = await import('../sql-query.ts');
    const sql = sqlQueryForEngine(ctx.engine);
    let bindingRows: Array<Record<string, unknown>>;
    try {
      bindingRows = await sql`
        SELECT bound_tools, bound_source_id, bound_brain_id, bound_slug_prefixes,
               bound_max_concurrent, budget_usd_per_day::text AS budget_cap
          FROM oauth_clients
         WHERE client_id = ${clientId}
      `;
    } catch (err) {
      throw new OperationError(
        'internal',
        `submit_agent: could not load OAuth client binding: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (bindingRows.length === 0) {
      throw new OperationError('permission_denied', `submit_agent: client_id ${clientId} not found.`);
    }
    const binding = bindingRows[0];
    const boundTools = (binding.bound_tools as string[] | null) ?? null;
    const boundSource = (binding.bound_source_id as string | null) ?? null;
    const boundSlugPrefixes = (binding.bound_slug_prefixes as string[] | null) ?? null;
    const boundMaxConcurrent = Number(binding.bound_max_concurrent ?? 1);
    const budgetCapText = (binding.budget_cap as string | null) ?? null;

    if (boundTools === null) {
      throw new OperationError(
        'permission_denied',
        `submit_agent: client ${clientId} has the agent scope but no bindings. Re-register with --bound-tools, --bound-source, --bound-slug-prefixes, --bound-max-concurrent, --budget-usd-per-day.`,
      );
    }

    // Validate each param against the binding.
    //
    // An EXPLICIT empty array is not "no restriction" here — downstream the
    // subagent worker reads empty `allowed_tools` as "the full tool registry"
    // and empty `allowed_slug_prefixes` as "fall back to the legacy
    // wiki/agents/<job-id>/ namespace". Both subset loops below pass
    // vacuously over an empty list, so `{allowed_tools: [], allowed_slug_prefixes: []}`
    // from a client bound to `['search']` + `['emp-alice/']` would hand its
    // subagent the whole registry (including put_page) writing outside the
    // binding. `??` only substitutes null/undefined, so collapse the empty
    // case to the binding explicitly.
    const requestedToolsRaw = p.allowed_tools as string[] | undefined;
    const requestedTools = requestedToolsRaw === undefined || requestedToolsRaw.length === 0
      ? boundTools
      : requestedToolsRaw;
    for (const t of requestedTools) {
      if (!boundTools.includes(t)) {
        throw new OperationError(
          'permission_denied',
          `submit_agent: tool "${t}" is not in client ${clientId}'s bound_tools (${boundTools.join(', ')}).`,
        );
      }
    }
    const requestedSlugPrefixesRaw = p.allowed_slug_prefixes as string[] | undefined;
    const requestedSlugPrefixes =
      requestedSlugPrefixesRaw === undefined || requestedSlugPrefixesRaw.length === 0
        ? (boundSlugPrefixes ?? [])
        : requestedSlugPrefixesRaw;
    // A bound client must end up with a non-empty delegated fence: an empty
    // list reaches the subagent as "use the legacy wiki/agents/<id>/ namespace",
    // which is outside every bound prefix.
    if (boundSlugPrefixes !== null && requestedSlugPrefixes.length === 0) {
      throw new OperationError(
        'permission_denied',
        `submit_agent: client ${clientId} is slug-bound but its binding resolved to an empty prefix list, which the subagent would read as the unfenced legacy namespace.`,
        'Re-scope the client with a non-empty --bound-slug-prefixes.',
      );
    }
    if (boundSlugPrefixes !== null) {
      for (const sp of requestedSlugPrefixes) {
        // Boundary-aware, same rule as the direct fence: a raw `startsWith`
        // let a boundary-less binding (`emp-alice`) authorize a requested
        // prefix in a SIBLING namespace (`emp-alice-2/`), which is then handed
        // to the child as a full glob grant over another employee's pages.
        if (!boundSlugPrefixes.some(bp => {
          const base = normalizeSlugPrefix(bp);
          const req = normalizeSlugPrefix(sp);
          if (base === '') return false;
          return base.endsWith('/')
            ? req.startsWith(base)
            : req === base || req.startsWith(`${base}/`);
        })) {
          throw new OperationError(
            'permission_denied',
            `submit_agent: slug_prefix "${sp}" is not under any of client ${clientId}'s bound_slug_prefixes.`,
          );
        }
      }
    }

    // Concurrency cap: count active+waiting agent jobs for this client.
    const inflight = await sql`
      SELECT COUNT(*)::int AS n
        FROM minion_jobs j
       WHERE j.name = 'subagent'
         AND j.status IN ('waiting', 'active', 'waiting-children')
         AND j.data->>'__owner_client_id' = ${clientId}
    `;
    const inflightCount = Number((inflight[0]?.n as number | string | undefined) ?? 0);
    if (inflightCount >= boundMaxConcurrent) {
      throw new OperationError(
        'rate_limited',
        `submit_agent: client ${clientId} at concurrency cap (${inflightCount}/${boundMaxConcurrent}).`,
      );
    }

    // Dry-run echo.
    // The subagent fence uses `matchesSlugAllowList`, whose grammar makes a
    // BARE entry match that one slug exactly — so a plain `emp-alice/` binding
    // would let the delegated agent write nothing. Normalize the
    // trailing-slash form into the glob the delegated matcher expects, so one
    // stored column means the same span of slugs on both paths.
    const delegatedSlugPrefixes = requestedSlugPrefixes.map(sp =>
      sp.endsWith('/') ? `${sp}*` : sp);

    if (ctx.dryRun) {
      return {
        dry_run: true,
        action: 'submit_agent',
        client_id: clientId,
        bound_tools: boundTools,
        bound_source: boundSource,
        bound_max_concurrent: boundMaxConcurrent,
        // What the delegated job would ACTUALLY be granted, after the binding
        // is applied — a preview that hides this can't show a widening bug.
        resolved_tools: requestedTools,
        resolved_slug_prefixes: delegatedSlugPrefixes,
      };
    }

    // Submit via MinionQueue with allowProtectedSubmit (the agent op is
    // remote-callable but the underlying job name 'subagent' is protected;
    // the OAuth scope check above stands in for the protected-name guard).
    const { MinionQueue } = await import('../minions/queue.ts');
    const queue = new MinionQueue(ctx.engine);

    const jobData: Record<string, unknown> = {
      prompt: p.prompt as string,
      max_turns: Math.min((p.max_turns as number) ?? 20, 100),
      allowed_tools: requestedTools,
      allowed_slug_prefixes: delegatedSlugPrefixes,
      __owner_client_id: clientId,
    };
    if (typeof p.model === 'string') jobData.model = p.model;
    // Write source for the delegated job comes from the AUTHENTICATED client
    // whenever we have it. `bound_source_id` is an optional, separately-set
    // column: unset it defaulted the child to 'default', and if it disagreed
    // with the token's own source the child followed the column — either way
    // a correctly slug-fenced client could act on the wrong source.
    const delegatedSource = ctx.auth?.sourceId ?? boundSource;
    if (boundSource && ctx.auth?.sourceId && boundSource !== ctx.auth.sourceId) {
      throw new OperationError(
        'permission_denied',
        `submit_agent: client ${clientId}'s bound_source_id (${boundSource}) disagrees with its authenticated source (${ctx.auth.sourceId}); refusing to guess which one governs the delegated write.`,
        'Re-scope the client so the two agree: `gbrain auth rescope-client <id> --source <source>`.',
      );
    }
    if (delegatedSource) jobData.source_id = delegatedSource;
    let job;
    try {
      job = await queue.add(
        'subagent',
        jobData,
        { queue: (p.queue as string) || 'default' },
        { allowProtectedSubmit: true },
      );
    } catch (e) {
      // Admission quota (minions.quota_max_waiting.subagent, config-only):
      // surface as a structured retryable error, not an opaque internal one.
      // The quota message already omits live cross-tenant queue depth.
      const { isQueueQuotaExceededError } = await import('../minions/admission.ts');
      if (isQueueQuotaExceededError(e)) {
        throw new OperationError('rate_limited', e.message, 'Retry after the queue drains, or ask the operator to raise the quota.');
      }
      throw e;
    }

    // Audit trail (D4) — best-effort JSONL.
    try {
      const { logAgentSubmission } = await import('../minions/agent-audit.ts');
      const budgetCapCents = budgetCapText ? Math.round(parseFloat(budgetCapText) * 100) : null;
      const promptText = typeof p.prompt === 'string' ? p.prompt : '';
      logAgentSubmission({
        client_id: clientId,
        job_id: job.id,
        model: typeof p.model === 'string' ? p.model : '<default>',
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
  description: 'Poll an agent job submitted via submit_agent. Returns a trimmed status view (id, status, timestamps, error_text, result) plus queue_position (waiting jobs ahead in claim order; 0 = next) while the job is still waiting. Requires the `agent` OAuth scope; only jobs owned by the calling client are visible.',
  params: {
    id: { type: 'number', required: true, description: 'Job id returned by submit_agent' },
  },
  scope: 'agent',
  handler: async (ctx, p) => {
    const clientId = ctx.auth?.clientId;
    if (!clientId || typeof clientId !== 'string') {
      throw new OperationError(
        'permission_denied',
        'get_agent_job requires an authenticated OAuth client identity.',
        'Call over HTTP MCP with an `agent`-scoped token. Transports without a per-client identity (stdio, legacy bearer) cannot read agent jobs; use admin-scope get_job from a trusted context instead.',
      );
    }
    const id = p.id;
    if (typeof id !== 'number' || !Number.isInteger(id)) {
      throw new OperationError('invalid_params', 'id must be an integer job id');
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
      throw new OperationError('not_found', `Job not found: ${id}`);
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
  description: 'Get job status and details by ID',
  params: {
    id: { type: 'number', required: true, description: 'Job ID' },
  },
  scope: 'admin',
  handler: async (ctx, p) => {
    const { MinionQueue } = await import('../minions/queue.ts');
    const queue = new MinionQueue(ctx.engine);
    const job = await queue.getJob(p.id as number);
    if (!job) throw new OperationError('invalid_params', `Job not found: ${p.id}`);
    return job;
  },
};

const list_jobs: Operation = {
  name: 'list_jobs',
  description: 'List jobs with optional filters',
  params: {
    status: { type: 'string', description: 'Filter by status (waiting, active, completed, failed, delayed, dead, cancelled)' },
    queue: { type: 'string', description: 'Filter by queue name' },
    name: { type: 'string', description: 'Filter by job type' },
    limit: { type: 'number', description: 'Max results (default: 50)' },
  },
  scope: 'admin',
  handler: async (ctx, p) => {
    const { MinionQueue } = await import('../minions/queue.ts');
    const queue = new MinionQueue(ctx.engine);
    return queue.getJobs({
      status: p.status as string | undefined,
      queue: p.queue as string | undefined,
      name: p.name as string | undefined,
      limit: (p.limit as number) || 50,
    } as Parameters<typeof queue.getJobs>[0]);
  },
};

const cancel_job: Operation = {
  name: 'cancel_job',
  description: 'Cancel a waiting, active, or delayed job',
  params: {
    id: { type: 'number', required: true, description: 'Job ID' },
  },
  mutating: true,
  scope: 'admin',
  handler: async (ctx, p) => {
    if (ctx.dryRun) return { dry_run: true, action: 'cancel_job', id: p.id };
    const { MinionQueue } = await import('../minions/queue.ts');
    const queue = new MinionQueue(ctx.engine);
    const cancelled = await queue.cancelJob(p.id as number);
    if (!cancelled) throw new OperationError('invalid_params', `Cannot cancel job ${p.id} (may already be in terminal status)`);
    return cancelled;
  },
};

const retry_job: Operation = {
  name: 'retry_job',
  description: 'Re-queue a failed or dead job for retry',
  params: {
    id: { type: 'number', required: true, description: 'Job ID' },
  },
  mutating: true,
  scope: 'admin',
  handler: async (ctx, p) => {
    if (ctx.dryRun) return { dry_run: true, action: 'retry_job', id: p.id };
    const { MinionQueue } = await import('../minions/queue.ts');
    const queue = new MinionQueue(ctx.engine);
    const retried = await queue.retryJob(p.id as number);
    if (!retried) throw new OperationError('invalid_params', `Cannot retry job ${p.id} (must be failed or dead)`);
    return retried;
  },
};

const get_job_progress: Operation = {
  name: 'get_job_progress',
  description: 'Get structured progress for a running job',
  params: {
    id: { type: 'number', required: true, description: 'Job ID' },
  },
  scope: 'admin',
  handler: async (ctx, p) => {
    const { MinionQueue } = await import('../minions/queue.ts');
    const queue = new MinionQueue(ctx.engine);
    const job = await queue.getJob(p.id as number);
    if (!job) throw new OperationError('invalid_params', `Job not found: ${p.id}`);
    return { id: job.id, name: job.name, status: job.status, progress: job.progress };
  },
};

const pause_job: Operation = {
  name: 'pause_job',
  description: 'Pause a waiting, active, or delayed job',
  params: {
    id: { type: 'number', required: true, description: 'Job ID' },
  },
  scope: 'admin',
  handler: async (ctx, p) => {
    const { MinionQueue } = await import('../minions/queue.ts');
    const queue = new MinionQueue(ctx.engine);
    const job = await queue.pauseJob(p.id as number);
    if (!job) throw new OperationError('invalid_params', `Job not found or not pausable: ${p.id}`);
    return { id: job.id, status: job.status };
  },
};

const resume_job: Operation = {
  name: 'resume_job',
  description: 'Resume a paused job back to waiting',
  params: {
    id: { type: 'number', required: true, description: 'Job ID' },
  },
  scope: 'admin',
  handler: async (ctx, p) => {
    const { MinionQueue } = await import('../minions/queue.ts');
    const queue = new MinionQueue(ctx.engine);
    const job = await queue.resumeJob(p.id as number);
    if (!job) throw new OperationError('invalid_params', `Job not found or not paused: ${p.id}`);
    return { id: job.id, status: job.status };
  },
};

const replay_job: Operation = {
  name: 'replay_job',
  description: 'Replay a completed/failed/dead job, optionally with modified data',
  params: {
    id: { type: 'number', required: true, description: 'Source job ID to replay' },
    data_overrides: { type: 'object', required: false, description: 'Data fields to override (merged with original)' },
  },
  scope: 'admin',
  handler: async (ctx, p) => {
    if (ctx.dryRun) return { dry_run: true, action: 'replay_job', id: p.id };
    const { MinionQueue } = await import('../minions/queue.ts');
    const queue = new MinionQueue(ctx.engine);
    const job = await queue.replayJob(p.id as number, p.data_overrides as Record<string, unknown> | undefined);
    if (!job) throw new OperationError('invalid_params', `Job not found or not in terminal state: ${p.id}`);
    return { id: job.id, name: job.name, status: job.status, source_id: p.id };
  },
};

const send_job_message: Operation = {
  name: 'send_job_message',
  description: 'Send a sidechannel message to a running job\'s inbox',
  params: {
    id: { type: 'number', required: true, description: 'Job ID to message' },
    payload: { type: 'object', required: true, description: 'Message payload (arbitrary JSON)' },
    sender: { type: 'string', required: false, description: 'Sender identity (default: admin)' },
  },
  scope: 'admin',
  handler: async (ctx, p) => {
    if (ctx.dryRun) return { dry_run: true, action: 'send_job_message', id: p.id };
    const { MinionQueue } = await import('../minions/queue.ts');
    const queue = new MinionQueue(ctx.engine);
    const msg = await queue.sendMessage(p.id as number, p.payload, (p.sender as string) ?? 'admin');
    if (!msg) throw new OperationError('invalid_params', `Job not found, not messageable, or sender unauthorized: ${p.id}`);
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
  description:
    'Job queue statistics. PER-BLOCK scoping: by_status and queue_health are GLOBAL ' +
    '(unfiltered); by_type is windowed by since_hours; only the wedge block is scoped to ' +
    'the queue param. wedged: true is the silent-halt signal (a worker is alive but claiming ' +
    'nothing while work waits) — suggest restarting the jobs supervisor on the brain host. ' +
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
      const { wedged, wedge_threshold_minutes } = deriveWedgeSignal(stats.wedge);
      return { schema_version: 1, window_hours: hours, ...stats, wedged, wedge_threshold_minutes };
    }, 'Job queue statistics (minions schema)');
  },
};

// Ops in EXACTLY the canonical `operations` array order.
export const jobsOperations: Operation[] = [
  submit_job, get_job, list_jobs, cancel_job, retry_job, get_job_progress,
  pause_job, resume_job, replay_job, send_job_message,
  submit_agent, get_agent_job, get_job_stats,
];
