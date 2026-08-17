/**
 * Admission control for the minion queue — the submit-side half of the
 * queue-divergence fix (the drain-side pool-starvation half landed in
 * v0.46.1.0). Three primitives, all ADMISSION-side by design (claim
 * fairness / lane scheduling is explicitly out of scope, tracked in TODOS):
 *
 *   1. PARAM-COALESCING — an identical parentless submit (same name, queue,
 *      owner lane, and payload hash) coalesces onto the newest matching
 *      WAITING row instead of enqueuing a duplicate. Targets the
 *      runaway-producer class: crons re-submitting the same prompt hundreds
 *      of times a day into a queue that drains a fraction of that.
 *   2. WAITING-TTL — a job still WAITING after N hours is cancelled (via the
 *      canonical cancel path, so parents/aggregators resolve) with an
 *      auditable error_text. At structural divergence (intake >> drain),
 *      FIFO wait exceeds any plausible usefulness horizon — cancelling
 *      visibly beats queueing forever.
 *   3. NAME-GLOBAL QUOTA — reject (typed error, never a silent coalesce)
 *      submits once a name's TOTAL waiting count across ALL queues reaches
 *      the configured cap. Counts name-globally because fanout producers use
 *      per-run private queues (dream-inline-*): a (name, queue)-scoped count
 *      would reset to zero for every new private queue and never bind.
 *      NO shipped default (user decision D2C) — activates only via config.
 *
 * Per-name defaults table pattern follows handler-timeouts.ts. Config keys
 * (DB plane, registered under the 'minions.' prefix):
 *   minions.coalesce_params.<name>   ('false'/'0'/'off' disables; default on
 *                                     only for names in PARAM_COALESCE_DEFAULT)
 *   minions.ttl_waiting_hours.<name> (number; 0 disables; default only for
 *                                     names in WAITING_TTL_DEFAULT_HOURS)
 *   minions.quota_max_waiting.<name> (number; no defaults)
 *
 * Env kill-switch: GBRAIN_MINIONS_ADMISSION=0 disables all three wholesale
 * (incident escape hatch — no DB needed).
 *
 * All lookups fail OPEN to the defaults tables: an unreadable config must
 * never block job submission. The first failure per process logs one stderr
 * warning (a silent fail-open is a silent failure).
 */

import { createHash } from 'node:crypto';
import type { BrainEngine } from '../engine.ts';

/** Names whose parentless submits coalesce on identical params by default. */
export const PARAM_COALESCE_DEFAULT: Readonly<Record<string, boolean>> = {
  subagent: true,
};

/** Default waiting-TTL hours per name. Absent = no TTL. */
export const WAITING_TTL_DEFAULT_HOURS: Readonly<Record<string, number>> = {
  subagent: 48,
};

/**
 * Default name-global waiting quotas. EMPTY by design (user decision D2C):
 * the quota mechanism ships but activates only via
 * `minions.quota_max_waiting.<name>` config. The DIVERGENT-queue scream in
 * `jobs stats` / doctor is the default-on protection layer and carries the
 * opt-in hint.
 */
export const QUOTA_MAX_WAITING_DEFAULT: Readonly<Record<string, number>> = {};

/**
 * Keys excluded from the param hash. ONLY the hash's own storage key:
 * `__owner_client_id` is deliberately INCLUDED so coalescing never crosses
 * owner lanes — one OAuth client's submit must not be suppressed by (or
 * handed a job id owned by) another client.
 */
export const PARAM_HASH_EXCLUDED_KEYS: ReadonlySet<string> = new Set(['__param_hash']);

/**
 * error_text prefix stamped by the waiting-TTL sweep. The 24h-cancellation
 * surfaces (jobs stats, doctor) LIKE-match on this exact prefix — keep the
 * sweep's reason string and the consumers' patterns derived from ONE constant
 * so they can never drift apart.
 */
export const TTL_REASON_PREFIX = 'waiting_ttl_expired';

/**
 * Config flag recording WHEN the one-time waiting-TTL notice was shown
 * (ISO timestamp; legacy value 'true' = shown at unknown time). Shared by
 * the worker's warn-before-act gate and the runPostUpgrade banner.
 */
export const TTL_NOTICE_SHOWN_KEY = 'minions.ttl_notice_shown';

/**
 * Grace window between the one-time TTL notice and the first sweep (user
 * requirement D1A: warn BEFORE acting, with enough time to actually react —
 * one maintenance tick (~30s) is not a warning, it's a courtesy log line).
 * Env override is a test seam / incident hatch.
 */
export const TTL_NOTICE_GRACE_MS_DEFAULT = 60 * 60 * 1000;

export function ttlNoticeGraceMs(): number {
  const v = Number(process.env.GBRAIN_MINIONS_TTL_NOTICE_GRACE_MS);
  return Number.isFinite(v) && v >= 0 ? v : TTL_NOTICE_GRACE_MS_DEFAULT;
}

/** Typed admission rejection — submitters surface the message or record a skip. */
export class QueueQuotaExceededError extends Error {
  readonly code = 'quota_exceeded';
  constructor(
    public readonly jobName: string,
    public readonly waiting: number,
    public readonly quota: number,
  ) {
    // The message travels to REMOTE MCP clients via submit_agent — it names
    // the quota (the caller's admission contract) but NOT the live global
    // waiting count, which would leak cross-tenant queue depth. Operators get
    // exact counts locally from 'gbrain jobs stats'; the count stays on the
    // error object for local consumers/tests.
    super(
      `queue admission: '${jobName}' is at its waiting quota (${quota}, all queues). ` +
      `Drain or cancel backlog first — see 'gbrain jobs stats'. ` +
      `Tune: gbrain config set minions.quota_max_waiting.${jobName} <n> (raise) or remove the key (disable).`,
    );
    this.name = 'QueueQuotaExceededError';
  }
}

/**
 * Canonical quota-rejection check for submitters (agent fanout, dream
 * synthesize/patterns, ops). Checks the stable `code` field as well as
 * instanceof/name so it survives dual-module instances and compiled-binary
 * boundaries where instanceof can lie.
 */
export function isQueueQuotaExceededError(e: unknown): e is QueueQuotaExceededError {
  if (e instanceof QueueQuotaExceededError) return true;
  if (!(e instanceof Error)) return false;
  return e.name === 'QueueQuotaExceededError' ||
    (e as { code?: unknown }).code === 'quota_exceeded';
}

/** Stable stringify: recursively sorts object keys so hash(key order) is invariant. */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'undefined';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`;
}

/**
 * sha256 over the stable-stringified payload minus PARAM_HASH_EXCLUDED_KEYS.
 * Node-side (not SQL md5(data::text)) so canonicalization is explicit and
 * unit-testable, with no reliance on jsonb text-rendering parity across
 * engines. Stored in data.__param_hash (the `__`-prefixed embedded-metadata
 * convention, like __owner_client_id); a future algorithm change is
 * forward-safe — old rows just stop matching, which means "no coalesce".
 */
export function computeParamHash(data: Record<string, unknown>): string {
  const filtered: Record<string, unknown> = {};
  for (const k of Object.keys(data)) {
    if (PARAM_HASH_EXCLUDED_KEYS.has(k)) continue;
    filtered[k] = data[k];
  }
  return createHash('sha256').update(stableStringify(filtered)).digest('hex');
}

export interface AdmissionPolicy {
  /** Param-coalescing on for this name (parentless submits only). */
  coalesceParams: boolean;
  /** Waiting-TTL in hours; null = no TTL for this name. */
  ttlWaitingHours: number | null;
  /** Name-global max waiting; null = no quota for this name. */
  quotaMaxWaiting: number | null;
}

export function admissionKilled(): boolean {
  return process.env.GBRAIN_MINIONS_ADMISSION === '0';
}

function isOffValue(v: string): boolean {
  // Case-insensitive + trimmed: an operator typing 'FALSE' or 'Off' means
  // OFF — an emergency off-switch that only matches exact lowercase tokens
  // silently stays ON (structured-review finding).
  const t = v.trim().toLowerCase();
  return t === 'false' || t === '0' || t === 'off' || t === 'no';
}

/**
 * Gate for embedding a job name into a COPY-PASTEABLE command hint
 * (`gbrain config set minions.…<name> …`). Display sanitization strips
 * control bytes but keeps shell metacharacters; a name like `x$(cmd)` must
 * never ride into a hint an operator will paste into a shell. Returns the
 * name when it is a safe config-key segment, else null (caller renders a
 * placeholder).
 */
export function safeConfigSegment(name: string): string | null {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(name) ? name : null;
}

function parsePositiveNumber(v: string | null): number | null {
  if (v == null || v.trim() === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null; // 0/garbage = disabled
  return n;
}

// ~60s in-process cache: add() runs per submission; a config read per submit
// would add a query to the hot path for a value that changes at human speed.
type CacheEntry = { at: number; policy: AdmissionPolicy };
const policyCache = new Map<string, CacheEntry>();
const POLICY_CACHE_MS = 60_000;
let warnedFailOpen = false;

/** Test seam: drop the cache so config changes are visible immediately. */
export function _resetAdmissionCacheForTest(): void {
  policyCache.clear();
  warnedFailOpen = false;
}

/**
 * Resolve the admission policy for a job name: config overrides > per-name
 * defaults tables. Fail-open to defaults on any config error (warn once per
 * process). Kill-switch returns the all-off policy.
 */
export async function resolveAdmissionPolicy(engine: BrainEngine, jobName: string): Promise<AdmissionPolicy> {
  if (admissionKilled()) {
    return { coalesceParams: false, ttlWaitingHours: null, quotaMaxWaiting: null };
  }
  const cached = policyCache.get(jobName);
  if (cached && Date.now() - cached.at < POLICY_CACHE_MS) return cached.policy;

  const policy: AdmissionPolicy = {
    coalesceParams: PARAM_COALESCE_DEFAULT[jobName] === true,
    ttlWaitingHours: WAITING_TTL_DEFAULT_HOURS[jobName] ?? null,
    quotaMaxWaiting: QUOTA_MAX_WAITING_DEFAULT[jobName] ?? null,
  };
  try {
    const [coalesceV, ttlV, quotaV] = await Promise.all([
      engine.getConfig(`minions.coalesce_params.${jobName}`),
      engine.getConfig(`minions.ttl_waiting_hours.${jobName}`),
      engine.getConfig(`minions.quota_max_waiting.${jobName}`),
    ]);
    if (coalesceV != null && coalesceV.trim() !== '') {
      policy.coalesceParams = !isOffValue(coalesceV.trim());
    }
    if (ttlV != null && ttlV.trim() !== '') {
      policy.ttlWaitingHours = parsePositiveNumber(ttlV);
    }
    if (quotaV != null && quotaV.trim() !== '') {
      policy.quotaMaxWaiting = parsePositiveNumber(quotaV);
    }
  } catch (e) {
    if (!warnedFailOpen) {
      warnedFailOpen = true;
      console.error(
        `[minions admission] config read failed (${e instanceof Error ? e.message : String(e)}) — ` +
        `using built-in defaults (coalesce=${policy.coalesceParams}, ttl=${policy.ttlWaitingHours ?? 'off'}h, ` +
        `quota=${policy.quotaMaxWaiting ?? 'off'}). Warning prints once per process.`,
      );
    }
  }
  policyCache.set(jobName, { at: Date.now(), policy });
  return policy;
}

/**
 * Names with an active waiting-TTL: defaults ∪ config overrides discovered
 * via listConfigKeys('minions.ttl_waiting_hours.') when the engine supports
 * it (optional method — same guard pattern as config.ts's key listing).
 * Returns name → hours, with 0/garbage-configured names removed.
 */
export async function resolveTtlNames(engine: BrainEngine): Promise<Map<string, number>> {
  if (admissionKilled()) return new Map();
  const out = new Map<string, number>();
  for (const [name, hours] of Object.entries(WAITING_TTL_DEFAULT_HOURS)) out.set(name, hours);
  try {
    const listConfigKeys = (engine as { listConfigKeys?: (prefix: string) => Promise<string[]> }).listConfigKeys;
    if (typeof listConfigKeys === 'function') {
      const prefix = 'minions.ttl_waiting_hours.';
      const keys = await listConfigKeys.call(engine, prefix);
      for (const key of keys) {
        const name = key.slice(prefix.length);
        if (!name) continue;
        const v = parsePositiveNumber(await engine.getConfig(key));
        if (v == null) out.delete(name); // configured 0/garbage = disabled
        else out.set(name, v);
      }
    } else {
      // No listing support: still honor overrides for the DEFAULT names.
      for (const name of Object.keys(WAITING_TTL_DEFAULT_HOURS)) {
        const v = await engine.getConfig(`minions.ttl_waiting_hours.${name}`);
        if (v != null && v.trim() !== '') {
          const n = parsePositiveNumber(v);
          if (n == null) out.delete(name);
          else out.set(name, n);
        }
      }
    }
  } catch {
    // Fail open to the defaults already in `out`.
  }
  return out;
}

/**
 * Count currently-waiting jobs already past their per-name TTL. Shared by
 * the worker's warn-before-act notice and the runPostUpgrade banner so the
 * two channels can never disagree on what "affected" means.
 */
export async function countTtlExpiredWaiting(
  engine: BrainEngine,
  ttlNames: Map<string, number>,
): Promise<{ total: number; by_name: Record<string, number> }> {
  const by_name: Record<string, number> = {};
  let total = 0;
  for (const [name, hours] of ttlNames) {
    const rows = await engine.executeRaw<{ count: string }>(
      `SELECT count(*)::text AS count FROM minion_jobs
        WHERE name = $1 AND status = 'waiting' AND updated_at < now() - ($2 * interval '1 hour')`,
      [name, hours],
    );
    const n = parseInt(rows[0]?.count ?? '0', 10);
    by_name[name] = n;
    total += n;
  }
  return { total, by_name };
}

/** Minimal structural dep so this module never imports MinionQueue (which imports us). */
export interface WaitingTtlSweeper {
  handleWaitingTTL(opts?: { maxPerTick?: number }): Promise<{ cancelled: number; by_name: Record<string, number> }>;
}

export interface WaitingTtlTickResult {
  /**
   * killed  — GBRAIN_MINIONS_ADMISSION=0, nothing done.
   * notice  — first tick: counted affected jobs, persisted the notice
   *           timestamp; caller prints the warning. NOTHING cancelled.
   * grace   — notice shown but the grace window hasn't elapsed; no sweep.
   * swept   — sweep ran (cancelled may be 0).
   */
  phase: 'killed' | 'notice' | 'grace' | 'swept';
  cancelled: number;
  by_name: Record<string, number>;
  /** Populated on phase 'notice': waiting jobs already past their TTL. */
  affected?: number;
}

/**
 * One warn-before-act TTL maintenance tick (user requirement D1A), extracted
 * from the worker interval so it is directly testable (pattern:
 * lock-renewal-tick.ts). Semantics:
 *
 *   flag unset            → count + stamp TTL_NOTICE_SHOWN_KEY with an ISO
 *                           timestamp, return 'notice' (caller warns; no sweep)
 *   flag = ISO timestamp  → sweep only after ttlNoticeGraceMs() has elapsed
 *                           since the notice ('grace' until then)
 *   flag = 'true' (legacy / pre-grace releases) → sweep immediately
 *
 * The upgrade banner stamps the SAME key with the same ISO form, so an
 * interactive `gbrain upgrade` starts the clock too — whichever channel
 * shows the notice first, the operator gets a full grace window to set
 * `minions.ttl_waiting_hours.<name> 0` before anything is cancelled.
 */
export async function runWaitingTtlTick(
  engine: BrainEngine,
  sweeper: WaitingTtlSweeper,
): Promise<WaitingTtlTickResult> {
  if (admissionKilled()) return { phase: 'killed', cancelled: 0, by_name: {} };
  const flag = (await engine.getConfig(TTL_NOTICE_SHOWN_KEY))?.trim() ?? '';
  if (flag === '') {
    const ttlNames = await resolveTtlNames(engine);
    const { total } = await countTtlExpiredWaiting(engine, ttlNames);
    await engine.setConfig(TTL_NOTICE_SHOWN_KEY, new Date().toISOString());
    return { phase: 'notice', cancelled: 0, by_name: {}, affected: total };
  }
  if (flag !== 'true') {
    const ts = Date.parse(flag);
    if (Number.isFinite(ts) && Date.now() - ts < ttlNoticeGraceMs()) {
      return { phase: 'grace', cancelled: 0, by_name: {} };
    }
  }
  const res = await sweeper.handleWaitingTTL();
  return { phase: 'swept', ...res };
}
