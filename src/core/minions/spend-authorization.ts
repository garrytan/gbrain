/**
 * Submit-time spend authorization on queued paid jobs.
 *
 * A consent-gated CLI producer (`book-mirror`, `enrich --background`,
 * `jobs submit enrich|subagent`) stores the user's authorization on every job
 * it queues through the trusted `MinionQueue.add` option `spendAuthorization`
 * (never through job data). All jobs of one command share one group and one
 * approved total. The worker runs each such job under `runWithJobSpend`, which
 * installs the AI invocation guard (the seam delegated spend uses): every
 * provider attempt reserves its maximum liability against
 * `group:<group_id>` in the durable meter and settles its measured usage.
 *
 * Rows of those producers queued before the record existed (NULL, with the
 * producers' idempotency-key prefixes) are stamped `legacy_default` by the
 * claim UPDATE itself (`LEGACY_DEFAULT_CLAIM_SET_SQL`), one group per row.
 * Every other job is `unrecorded` and runs under its producer's own budget.
 */
import { randomUUIDv7 } from 'bun';
import type { BrainEngine } from '../engine.ts';
import { shellQuote, type Action, type Effect } from '../agent-output.ts';
import { DEFAULT_PAID_CAP_USD, resumeMaxUsd, type Authorization } from '../consent.ts';
import { opError } from '../ops/contract.ts';
import { loadPricingOverrides } from '../budget/budget-tracker.ts';
import { withAIInvocationGuard } from '../ai/invocation-guard.ts';
import { GroupBudgetRefusal, RESERVATION_TTL_MS, readGroupSpend, reserveGroup, settle, type GroupSpend } from './budget-meter.ts';
import { actualCents, maximumInvocationCents, unboundedInvocationCause } from './delegated-spend.ts';
import { UnrecoverableError } from './errors.ts';
import { RateLeaseUnavailableError } from './rate-leases.ts';
import type { MinionJob, MinionJobContext } from './types.ts';
import { spendBasis, type JobSpendContext, type SpendAuthorization } from './spend-record.ts';

export * from './spend-record.ts';

/** Pre-upgrade rows of these producers get a `legacy_default` record when a worker claims them. */
export const LEGACY_SPEND_KEY_PREFIXES = { subagent: ['book-mirror:'], enrich: ['enrich:', 'cli:enrich:'] } as const;

/** A queued spend-authorized row waiting longer than this while workers run is flagged by doctor. */
export const FENCED_ROW_WAIT_MS = 10 * 60 * 1000;
/** A job delayed by live holds of its group retries this many times (one reservation TTL) before it dies. */
export const MAX_PRESSURE_RENEWALS = 6;
let pressureRetryMs = Math.floor(RESERVATION_TTL_MS / MAX_PRESSURE_RENEWALS);
export function __setGroupPressureRetryMsForTests(ms: number | null): void {
  pressureRetryMs = ms ?? Math.floor(RESERVATION_TTL_MS / MAX_PRESSURE_RENEWALS);
}

/** The record a consent-gated producer stores on each job it queues. */
export function jobSpendAuthorization(
  auth: Authorization | { uncapped: true; via: 'max_usd' },
  opts: { command: string; est_usd?: number; of?: number; argv?: string[] },
): SpendAuthorization {
  const base = {
    version: 1 as const, kind: 'authorized' as const, group_id: randomUUIDv7(),
    ...(opts.of !== undefined ? { of: opts.of } : {}),
    consented_effects: 'uncapped' in auth ? ['paid' as Effect] : auth.consented_effects,
    command: opts.command,
    ...(opts.est_usd !== undefined ? { est_usd: opts.est_usd } : {}),
    ...(opts.argv ? { argv: opts.argv } : {}),
    authorized_at: new Date().toISOString(),
  };
  if ('uncapped' in auth || auth.cap_usd === null || !Number.isFinite(auth.cap_usd)) {
    return { ...base, cap_usd: null, uncapped: true, cap_source: ('uncapped' in auth ? null : auth.cap_source) ?? 'user', via: auth.via };
  }
  return { ...base, cap_usd: auth.cap_usd, cap_source: auth.cap_source ?? 'default', via: auth.via };
}

/**
 * The claim UPDATE's SET items: the per-acquisition fence token, and the
 * `legacy_default` record for a NULL row of a consent-gated producer
 * (`$groupParam` is a fresh uuid per claim, `$capParam` the default cap).
 */
export function legacyDefaultClaimSetSql(groupParam: string, capParam: string): string {
  const legacy = Object.entries(LEGACY_SPEND_KEY_PREFIXES)
    .map(([name, prefixes]) => `(name = '${name}' AND (${prefixes.map(p => `idempotency_key LIKE '${p}%'`).join(' OR ')}))`)
    .join(' OR ');
  return `spend_claim_token = claim_generation + 1,
        spend_authorization = CASE WHEN spend_authorization IS NULL AND (${legacy}) THEN jsonb_build_object(
          'version', 1, 'kind', 'legacy_default', 'group_id', ${groupParam}::text,
          'cap_usd', CASE WHEN name = 'enrich' AND jsonb_typeof(data->'maxCostUsd') = 'number'
                          THEN CASE WHEN (data->>'maxCostUsd')::numeric > 0 THEN data->'maxCostUsd' ELSE to_jsonb(${capParam}::numeric) END
                          ELSE to_jsonb(${capParam}::numeric) END,
          'cap_source', 'default', 'command', CASE WHEN name = 'enrich' THEN 'enrich' ELSE 'book-mirror' END,
          'authorized_at', to_jsonb(to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))) ELSE spend_authorization END`;
}

/** Fresh claim parameters for `legacyDefaultClaimSetSql`. */
export function legacyDefaultClaimParams(): [string, number] {
  return [randomUUIDv7(), DEFAULT_PAID_CAP_USD];
}

/**
 * Coalesce rule: a resubmission that lands on a live row with no record or a
 * `legacy_default` record installs the new authorization (compare-and-set on
 * the old record; an `active` row picks it up at its next claim). An
 * `authorized` row keeps its own record. Returns the row as it now stands.
 */
export async function adoptSpendAuthorization(engine: BrainEngine, job: MinionJob, record: SpendAuthorization): Promise<MinionJob> {
  const current = job.spend_authorization ?? null;
  if (current?.kind === 'authorized' || job.spend_authorization_invalid) return job;
  const rows = await engine.executeRaw<Record<string, unknown>>(
    `UPDATE minion_jobs SET spend_authorization = $2::text::jsonb, updated_at = now()
      WHERE id = $1 AND status IN ('waiting','delayed','paused','waiting-children','active')
        AND ${current ? `spend_authorization->>'group_id' = $3` : 'spend_authorization IS NULL AND $3::text IS NULL'}
      RETURNING id`,
    [job.id, JSON.stringify(record), current?.group_id ?? null],
  );
  return rows.length ? { ...job, spend_authorization: record } : job;
}

const cents = (usd: number) => Math.round(usd * 100);
const usd = (c: number) => Math.round(c) / 100;

/** A group's amounts in USD, for envelopes, `jobs get` and `jobs list --group`. */
export function groupAmounts(record: SpendAuthorization, spend: GroupSpend) {
  const spent = spend.committedCents + spend.overdueCents;
  return {
    group_id: record.group_id,
    cap_usd: record.cap_usd,
    cap_source: record.cap_source,
    spent_usd: usd(spend.committedCents),
    overdue_usd: usd(spend.overdueCents),
    reserved_usd: usd(spend.liveCents + spend.overdueCents),
    remaining_usd: record.cap_usd === null ? null : usd(Math.max(0, cents(record.cap_usd) - spent)),
  };
}

/** A group's amounts (read-only), or null when the meter tables are unavailable. */
export async function jobGroupAmounts(engine: BrainEngine, record: SpendAuthorization): Promise<ReturnType<typeof groupAmounts> | null> {
  try { return groupAmounts(record, await readGroupSpend(engine, `group:${record.group_id}`)); }
  catch { return null; }
}

const GROUP_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Every job of a spend group, oldest first (expression index on the record's group_id). */
export async function groupJobs(engine: BrainEngine, groupId: string): Promise<MinionJob[]> {
  if (!GROUP_ID.test(groupId)) return [];
  const { rowToMinionJob } = await import('./types.ts');
  const rows = await engine.executeRaw<Record<string, unknown>>(
    `SELECT * FROM minion_jobs WHERE spend_authorization IS NOT NULL AND spend_authorization->>'group_id' = $1 ORDER BY id`, [groupId]);
  return rows.map(rowToMinionJob);
}

export type SpendRefusalEnvelope = ReturnType<ReturnType<typeof opError>['toJSON']> & {
  group: ReturnType<typeof groupAmounts>;
};

/** Typed, terminal refusal of a group (cap exhausted or a model without a price under a user cap). */
export class SpendGroupRefusedError extends UnrecoverableError {
  readonly tag = 'SPEND_GROUP_REFUSED';
  constructor(readonly envelope: SpendRefusalEnvelope) {
    super(`${envelope.code}: ${envelope.message}`);
    this.name = 'SpendGroupRefusedError';
  }
}

/** Live holds of sibling attempts fill the group: the job is delayed (no attempt burned) and retried. */
export class SpendGroupPressureError extends RateLeaseUnavailableError {
  readonly tag = 'SPEND_GROUP_REFUSED';
  constructor(budgetKey: string, liveCents: number, capCents: number) {
    super(budgetKey, Math.round(liveCents), Math.round(capCents), pressureRetryMs);
    this.name = 'SpendGroupPressureError';
  }
}

/** A worker without the spend-enforcement capability in its job child: the row is released, not failed. */
export class SpendEnforcementUnavailableError extends RateLeaseUnavailableError {
  constructor() {
    super('spend-enforcement-v1', 0, 0, 60_000);
    this.name = 'SpendEnforcementUnavailableError';
  }
}

let childSpendEnforcement = false;
/** Records whether the selected job child advertised `spend-enforcement-v1` at readiness. */
export function noteChildSpendEnforcement(features: readonly string[]): void {
  childSpendEnforcement = features.includes('spend-enforcement-v1');
}
export function childSpendEnforcementReady(): boolean { return childSpendEnforcement; }

/** The resume command: the producer's argv with a doubled `--max-usd`, or null for a legacy row. */
function resumeArgv(record: SpendAuthorization, capUsd: number | null): string[] | null {
  if (!record.argv) return null;
  const argv: string[] = [];
  for (let i = 0; i < record.argv.length; i++) {
    const a = record.argv[i]!;
    if (a === '--max-usd' || a === '--max-cost' || a === '--max-cost-usd') { i++; continue; }
    if (/^--max-(usd|cost|cost-usd)=/.test(a) || a === '--yes' || a === '-y' || a === '--no-confirm') continue;
    argv.push(a);
  }
  return capUsd === null ? [...argv, '--yes'] : [...argv, '--max-usd', resumeMaxUsd(capUsd).toFixed(2), '--yes'];
}

/** The terminal envelope for a group that ran out (`kind: 'cost'`) or met an unpriced model under a user cap. */
export async function spendRefusal(
  engine: BrainEngine,
  job: Pick<MinionJob, 'id' | 'name'>,
  record: SpendAuthorization,
  cause: { kind: 'cost'; overdueHolds?: boolean } | { kind: 'no_pricing' | 'no_context_ceiling'; model: string },
): Promise<SpendGroupRefusedError> {
  const group = groupAmounts(record, await readGroupSpend(engine, `group:${record.group_id}`));
  const listArgv = ['gbrain', 'jobs', 'list', '--group', record.group_id, '--json'];
  if (cause.kind === 'no_context_ceiling') {
    const capped = resumeArgv(record, null);
    const rerun = capped ? shellQuote(capped) : `${record.command} with --yes instead of --max-usd`;
    const e = opError('no_context_ceiling',
      `Job ${job.id} (${record.command}) stopped: ${cause.model} has a known price, but gbrain knows no context-token ceiling for it, so the most one call could cost under the user's $${record.cap_usd!.toFixed(2)} cap cannot be bounded. No provider call was made.`,
      `Do not retry unchanged and do not change the price (it is already known). Ask the user to choose: rerun without the user cap (${rerun}; the default cap then applies and this model runs unmetered with a warning), or have the brain-host operator supply ${cause.model}'s context size (its context-token ceiling from the provider's model page).`,
      { why: 'A user-set cap is enforced per provider attempt by reserving the most that attempt could cost, which needs the model\'s input ceiling as well as its price.',
        docs: 'docs/guides/write-refusals.md#no_context_ceiling',
        fix: { ...(capped ? { argv: capped } : {}), ask_user: true, consent: ['paid'], actor: 'agent', requires_exclusive: false,
          why: `Reruns ${record.command} without the user cap, so ${cause.model} runs unmetered under the default cap.`,
          user_message: `${cause.model} has a known price but no known context size, so your $${record.cap_usd!.toFixed(2)} cap can't bound its calls. Rerun ${record.command} without your cap (that model then runs unmetered), or tell me the model's context size so the operator can declare it?`,
          inputs: [{ name: 'context_tokens', how: `${cause.model}'s context window in tokens, from the provider's model page (OpenRouter lists it as context_length); the brain-host operator declares it.` }],
          verify: { argv: listArgv } } });
    return new SpendGroupRefusedError({ ...e.toJSON(), group } as SpendRefusalEnvelope);
  }
  if (cause.kind === 'no_pricing') {
    const e = opError('no_pricing',
      `Job ${job.id} (${record.command}) stopped: gbrain has no price for ${cause.model}, so the user's $${record.cap_usd!.toFixed(2)} cap cannot be enforced. No provider call was made.`,
      `Look up ${cause.model}'s per-token rate, register it with \`gbrain pricing set\`, then run ${record.command} again.`,
      { why: 'A user-set cap is enforced per provider attempt; an attempt with no known price could spend past it.',
        fix: { argv: ['gbrain', 'pricing', 'set', '--help'], consent: [], actor: 'agent', requires_exclusive: false,
          why: 'Shows how to register the model\'s rate so the cap can meter it.', verify: { argv: listArgv } } });
    return new SpendGroupRefusedError({ ...e.toJSON(), group } as SpendRefusalEnvelope);
  }
  const cap = record.cap_usd!;
  const derived = record.cap_source === 'derived';
  const resume = resumeArgv(record, cap);
  const n = resumeMaxUsd(cap);
  const reconcile = cause.kind === 'cost' && cause.overdueHolds && group.overdue_usd > 0
    ? ` $${group.overdue_usd.toFixed(2)} of it is held by attempts that never reported usage; they count as spent until reconciled.`
    : '';
  const message = `Job ${job.id} (${record.command}) stopped: its group ${record.group_id} reached the $${cap.toFixed(2)} ${derived ? 'cost cap derived from the estimate' : `${record.cap_source} cost cap`} `
    + `(spent $${group.spent_usd.toFixed(2)}, reserved $${group.reserved_usd.toFixed(2)}, remaining $${(group.remaining_usd ?? 0).toFixed(2)}).${reconcile}`;
  const e = opError(derived ? 'derived_cap_exhausted' : 'cost_cap_exceeded', message,
    resume
      ? `Ask the user whether to continue with a $${n.toFixed(2)} cap, then run: ${shellQuote(resume)} (completed work is skipped; inspect the group with ${shellQuote(listArgv)}).`
      : `Ask the user whether to continue; if they agree, run ${record.command} again with --max-usd ${n.toFixed(2)} (completed work is skipped). Inspect the group with ${shellQuote(listArgv)}.`,
    { why: 'Every job of a command shares the total the user approved; the job dies instead of spending past it, and a rerun authorizes additional spend as a new group.',
      fix: resume
        ? { argv: resume, consent: ['paid'], actor: 'agent', requires_exclusive: false,
          why: `Queues the unfinished work under a new $${n.toFixed(2)} group.`,
          user_message: `${record.command} spent its $${cap.toFixed(2)} budget before finishing. Continue with up to $${n.toFixed(2)} more?`,
          verify: { argv: listArgv } }
        : { argv: listArgv, consent: [], actor: 'agent', requires_exclusive: false, why: 'Shows the group\'s jobs and amounts before the user decides on a rerun.' } as Action });
  return new SpendGroupRefusedError({ ...e.toJSON(), group } as SpendRefusalEnvelope);
}

async function pressureRenewals(engine: BrainEngine, jobId: number, budgetKey: string): Promise<number> {
  try {
    const rows = await engine.executeRaw<{ n: number | string }>(
      'SELECT count(*)::int AS n FROM minion_lease_pressure_log WHERE job_id = $1 AND lease_key = $2', [jobId, budgetKey]);
    return Number(rows[0]?.n ?? 0);
  } catch { return 0; }
}

async function recordRefusal(engine: BrainEngine, job: MinionJob, error: SpendGroupRefusedError): Promise<void> {
  if (!job.lock_token) return;
  await engine.executeRaw(
    `UPDATE minion_jobs SET result = $3::text::jsonb, updated_at = now() WHERE id = $1 AND lock_token = $2 AND status = 'active'`,
    [job.id, job.lock_token, JSON.stringify({ spend_refusal: error.envelope })],
  ).catch(() => { /* the error text still carries the code and message */ });
}

async function logSpendBasis(engine: BrainEngine, job: MinionJob, record: SpendAuthorization | null): Promise<void> {
  const { basis, why } = spendBasis(job);
  if (!record) {
    const { paidJobNames } = await import('../../commands/jobs/shared.ts');
    if (!(await paidJobNames([job.name])).length) return;
  }
  const amounts = record ? groupAmounts(record, await readGroupSpend(engine, `group:${record.group_id}`).catch(() => ({ committedCents: 0, overdueCents: 0, liveCents: 0 }))) : null;
  console.log(`[minions] job_spend_basis ${JSON.stringify({
    job_id: job.id, name: job.name, basis,
    cap_usd: record?.cap_usd ?? null, cap_source: record?.cap_source ?? null,
    ...(amounts ? { group_id: amounts.group_id, group_spent_usd: amounts.spent_usd, group_remaining_usd: amounts.remaining_usd } : {}),
    why,
  })}`);
}

/**
 * Runs one claimed job's handler under its spend authorization. NULL rows
 * run exactly as before. An uncapped record reserves nothing (spend is still
 * ledgered by the handler's own tracker). A capped record runs under the
 * invocation guard, nested inside any outer guard (both must admit): each
 * attempt reserves its maximum against the group and settles its usage; an
 * attempt with unknown usage keeps its maximum charged. Refusals are typed:
 * settled exhaustion (or a model without a price under a user cap) is
 * terminal and recorded on the row; live-hold pressure delays the job, at
 * most `MAX_PRESSURE_RENEWALS` times.
 */
export async function runWithJobSpend<T>(
  engine: BrainEngine,
  job: MinionJob,
  ctx: MinionJobContext,
  handler: (ctx: MinionJobContext) => Promise<T>,
): Promise<T> {
  if (job.spend_authorization_invalid) {
    throw new UnrecoverableError(`spend_authorization_invalid: job ${job.id} carries a malformed spend authorization, so it will not run. Cancel it (gbrain jobs cancel ${job.id}) and run the producing command again.`);
  }
  const record = job.spend_authorization ?? null;
  await logSpendBasis(engine, job, record).catch(() => {});
  if (!record) return handler(ctx);
  const budgetKey = `group:${record.group_id}`;
  const spendCtx: MinionJobContext = { ...ctx, spend: { record, budget_key: budgetKey } };
  if (record.uncapped) return handler(spendCtx);
  const capCents = cents(record.cap_usd!);
  const seen: { refusal: SpendGroupRefusedError | SpendGroupPressureError | null } = { refusal: null };
  let warned = false;
  const pricingOverrides = await loadPricingOverrides(engine);
  const guard = async (call: Parameters<Parameters<typeof withAIInvocationGuard>[0]>[0]) => {
    const max = maximumInvocationCents(call, pricingOverrides);
    if (max === null) {
      const kind = unboundedInvocationCause(call, pricingOverrides);
      if (record.cap_source === 'user') throw (seen.refusal = await spendRefusal(engine, job, record, { kind, model: call.model }));
      if (!warned) {
        warned = true;
        process.stderr.write(kind === 'no_context_ceiling'
          ? `[budget] BUDGET_TRACKER_NO_PRICING: model "${call.model}" has a known price but no known context-token ceiling; job ${job.id} runs it unmetered under its ${record.cap_source} $${record.cap_usd!.toFixed(2)} cap.\n`
          : `[budget] BUDGET_TRACKER_NO_PRICING: model "${call.model}" has no known price; job ${job.id} runs it unmetered under its ${record.cap_source} $${record.cap_usd!.toFixed(2)} cap. Register its rate with \`gbrain pricing set\` to meter it.\n`);
      }
    }
    let hold;
    try {
      hold = await reserveGroup(engine, { budgetKey, capCents, estimatedCents: max ?? 0, estimateKnown: max !== null,
        model: call.model, provider: call.model.split(':')[0] || 'unknown', jobId: job.id });
    } catch (error) {
      if (!(error instanceof GroupBudgetRefusal)) throw error;
      if (error.kind === 'pressure' && await pressureRenewals(engine, job.id, budgetKey) < MAX_PRESSURE_RENEWALS) {
        throw (seen.refusal = new SpendGroupPressureError(budgetKey, error.spend.liveCents, capCents));
      }
      throw (seen.refusal = await spendRefusal(engine, job, record, { kind: 'cost', overdueHolds: true }));
    }
    return { async settle(usage: Parameters<typeof actualCents>[1]) {
      const c = actualCents(call, usage, pricingOverrides);
      if (c !== null) await settle(engine, hold.reservationId, c, call.operation);
      else await engine.executeRaw(
        `UPDATE mcp_spend_reservations SET usage_unknown_reason = $2 WHERE reservation_id = $1 AND status IN ('pending','expired')`,
        [hold.reservationId, usage === null ? 'provider_usage_unknown' : 'pricing_unknown'],
      );
    } };
  };
  let result: T;
  try {
    result = await withAIInvocationGuard(guard, () => handler(spendCtx), { inherit: true });
  } catch (error) {
    const typed = seen.refusal ?? (error instanceof SpendGroupRefusedError ? error : null);
    if (typed instanceof SpendGroupRefusedError) await recordRefusal(engine, job, typed);
    throw typed ?? error;
  }
  if (seen.refusal instanceof SpendGroupRefusedError) {
    await recordRefusal(engine, job, seen.refusal);
    throw seen.refusal;
  }
  return result;
}

/**
 * Producer-side summary after queueing under `record`: which jobs carry the
 * new group, which kept an earlier authorization (with the cancel-and-resubmit
 * commands), and which were reused as finished rows.
 */
export function spendSubmitSummary(record: SpendAuthorization, jobs: MinionJob[], rerunArgv: string[]) {
  const fresh: number[] = [];
  const reused: number[] = [];
  const kept = new Map<string, { group_id: string; cap_usd: number | null; job_ids: number[] }>();
  for (const job of jobs) {
    const r = job.spend_authorization;
    if (r?.group_id === record.group_id) fresh.push(job.id);
    else if (r?.kind === 'authorized' && !['completed', 'failed', 'dead', 'cancelled'].includes(job.status)) {
      const entry = kept.get(r.group_id) ?? { group_id: r.group_id, cap_usd: r.cap_usd, job_ids: [] };
      entry.job_ids.push(job.id);
      kept.set(r.group_id, entry);
    } else reused.push(job.id);
  }
  const lines = [`[spend] ${record.command}: ${fresh.length} job(s) queued or re-authorized under group ${record.group_id} `
    + `(${record.uncapped ? 'uncapped, spend ledgered' : `$${record.cap_usd!.toFixed(2)} ${record.cap_source} cap shared by the group`}).`];
  for (const k of kept.values()) {
    lines.push(`[spend] ${k.job_ids.length} job(s) (${k.job_ids.join(', ')}) keep their earlier authorization: group ${k.group_id}, `
      + `${k.cap_usd === null ? 'uncapped' : `$${k.cap_usd.toFixed(2)} cap`}. To run them under the new cap: gbrain jobs cancel --group ${k.group_id}, then ${shellQuote(rerunArgv)}`);
  }
  if (reused.length) lines.push(`[spend] ${reused.length} finished job(s) reused: ${reused.join(', ')}.`);
  if (!record.uncapped && record.cap_source !== 'user') {
    lines.push(`[spend] A model with no known price runs unmetered under this ${record.cap_source} cap (it warns); register its rate with \`gbrain pricing set\` to meter it.`);
  }
  return { summary: { group_id: record.group_id, cap_usd: record.cap_usd, cap_source: record.cap_source, uncapped: record.uncapped === true,
    queued_job_ids: fresh, reused_job_ids: reused, kept: [...kept.values()] }, lines };
}
