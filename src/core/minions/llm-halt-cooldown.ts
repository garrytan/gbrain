/**
 * #4310 — provider-identity-keyed global-LLM-halt cooldown for queued LLM
 * jobs (first consumer: the facts-absorb worker boundary in
 * src/commands/jobs.ts).
 *
 * The gap: when the chat provider is GLOBALLY broken (revoked key, exhausted
 * spend limit, hard rate limit), every queued facts-absorb job independently
 * makes its own doomed LLM call, burns a retry attempt, and eventually
 * dead-letters — a queue of N page writes turns into N × max_attempts wasted
 * provider calls and N dead jobs for one shared root cause. #3044's
 * classifyGlobalLlmError/createGlobalLlmHaltTracker already name the halt
 * classes; this module applies them ACROSS jobs in the worker process.
 *
 * Policy:
 *   - A halt-class failure (auth/billing on first hit; rate_limit after
 *     RATE_LIMIT_HALT_STREAK consecutive hits, streak shared across jobs)
 *     arms a cooldown keyed on the PROVIDER identity of the model the job
 *     used. The failing job's own error still propagates (visible failure,
 *     normal retry/backoff — never swallowed).
 *   - While the cooldown is active, matching jobs are DEFERRED without
 *     burning an attempt: the wrapper throws RateLeaseUnavailableError with
 *     `retryInMs` = remaining cooldown, and the worker's lease-full path
 *     requeues them delayed (never dead-letters a job the provider outage
 *     doomed).
 *   - On expiry, exactly ONE job is admitted as the bounded PROBE; the rest
 *     keep deferring on a short retry until the probe settles. Probe success
 *     clears the cooldown (and the rate-limit streak); another halt-class
 *     failure re-arms it with doubled backoff (capped).
 *
 * In-process state (one worker = one cooldown view); `GBRAIN_LLM_HALT_COOLDOWN=0`
 * disables the whole mechanism (incident escape hatch).
 *
 * Tested in test/llm-halt-cooldown.test.ts.
 */

import type { MinionJobContext, MinionHandler } from './types.ts';
import {
  createGlobalLlmHaltTracker,
  haltedClassOf,
  type GlobalLlmErrorClass,
} from '../ai/errors.ts';
import { RateLeaseUnavailableError } from './rate-leases.ts';
import { splitProviderModelId } from '../model-id.ts';
import { getChatModel } from '../ai/gateway.ts';

/** Base cooldown per halt class (ms). Doubles per consecutive halted probe. */
export const HALT_COOLDOWN_BASE_MS: Record<GlobalLlmErrorClass, number> = {
  auth: 5 * 60_000, // deterministic until an operator fixes the key
  billing: 5 * 60_000, // deterministic until quota/credit is restored
  rate_limit: 60_000, // bursts clear on their own — probe sooner
};
export const HALT_COOLDOWN_MAX_MS = 30 * 60_000;
/** Defer cadence while a probe is in flight (plus jitter). */
const PROBE_WAIT_RETRY_MS = 15_000;

interface CooldownState {
  /** epoch ms when the cooldown lapses and a probe may go through. */
  until: number;
  cls: GlobalLlmErrorClass;
  /** consecutive halted probes → exponential re-arm. */
  strikes: number;
  probeInFlight: boolean;
  tracker: ReturnType<typeof createGlobalLlmHaltTracker>;
}

const cooldowns = new Map<string, CooldownState>();

/** Test-only: clear all cooldown state. */
export function _resetLlmHaltCooldownsForTests(): void {
  cooldowns.clear();
}

/** Introspection (doctor / tests): remaining cooldown ms for a key, or 0. */
export function llmHaltCooldownRemainingMs(key: string, now: number = Date.now()): number {
  const s = cooldowns.get(key);
  if (!s) return 0;
  return Math.max(0, s.until - now);
}

function cooldownDisabled(): boolean {
  const raw = (process.env.GBRAIN_LLM_HALT_COOLDOWN ?? '').toLowerCase();
  return raw === '0' || raw === 'false' || raw === 'off';
}

function trackerFor(key: string): CooldownState['tracker'] {
  const existing = cooldowns.get(key);
  if (existing) return existing.tracker;
  // Streak state must survive across jobs BEFORE any cooldown is armed —
  // three rate-limited jobs in a row are the whole point. Park a zero-length
  // cooldown row to carry the tracker.
  const fresh: CooldownState = {
    until: 0,
    cls: 'rate_limit',
    strikes: 0,
    probeInFlight: false,
    tracker: createGlobalLlmHaltTracker(),
  };
  cooldowns.set(key, fresh);
  return fresh.tracker;
}

function armCooldown(key: string, cls: GlobalLlmErrorClass, now: number, escalate: boolean): void {
  const s = cooldowns.get(key);
  // Strikes escalate per halted PROBE (the documented policy), not per
  // concurrent in-flight failure — a burst of N jobs failing on the same
  // outage is ONE strike, not an instant jump to the 30-min max cooldown.
  const prior = s?.strikes ?? 0;
  const strikes = prior === 0 ? 1 : escalate ? prior + 1 : prior;
  const base = HALT_COOLDOWN_BASE_MS[cls];
  const durationMs = Math.min(base * 2 ** (strikes - 1), HALT_COOLDOWN_MAX_MS);
  cooldowns.set(key, {
    until: now + durationMs,
    cls,
    strikes,
    probeInFlight: false,
    tracker: s?.tracker ?? createGlobalLlmHaltTracker(),
  });
  console.error(
    `[llm-halt] provider "${key}" ${cls} halt — cooling down ${Math.round(durationMs / 1000)}s ` +
      `(strike ${strikes}); queued jobs defer without burning attempts (GBRAIN_LLM_HALT_COOLDOWN=0 disables)`,
  );
}

/**
 * Wrap a queued-job handler with the provider-halt cooldown. `resolveKey`
 * names the provider identity the job will bill against (called per job,
 * AFTER the registerBuiltinJob gateway refresh so config is current).
 */
export function withGlobalLlmHaltCooldown(
  resolveKey: (job: MinionJobContext) => string,
  handler: MinionHandler,
  opts: { now?: () => number } = {},
): MinionHandler {
  const now = opts.now ?? Date.now;
  return async (job) => {
    if (cooldownDisabled()) return handler(job);
    let key: string;
    try {
      key = resolveKey(job) || 'unknown';
    } catch {
      key = 'unknown';
    }

    const state = cooldowns.get(key);
    const t = now();
    let isProbe = false;
    if (state && state.until > 0) {
      if (t < state.until) {
        // Cooling down: defer, no attempt burned (worker lease-full path).
        throw new RateLeaseUnavailableError(
          `global-llm-halt:${state.cls}:${key}`,
          1,
          1,
          Math.max(1000, state.until - t) + Math.floor(Math.random() * 5000),
        );
      }
      if (state.probeInFlight) {
        // Expired but a probe is already out — keep deferring on a short
        // cadence until it settles.
        throw new RateLeaseUnavailableError(
          `global-llm-halt:${state.cls}:${key}`,
          1,
          1,
          PROBE_WAIT_RETRY_MS + Math.floor(Math.random() * 5000),
        );
      }
      state.probeInFlight = true; // this job is the bounded probe
      isProbe = true;
    }

    try {
      const result = await handler(job);
      // Success clears the cooldown AND the shared rate-limit streak.
      cooldowns.delete(key);
      return result;
    } catch (err) {
      // Deferrals thrown by a nested wrapper must pass through untouched.
      if (err instanceof RateLeaseUnavailableError) {
        // But a PROBE that deferred never settled the outage question: release
        // the probe slot (and the lapsed gate) or probeInFlight stays latched
        // forever and every later job — including the requeued probe itself —
        // defers on the 15s cadence until worker restart.
        if (isProbe) {
          const s = cooldowns.get(key);
          if (s) {
            s.probeInFlight = false;
            s.until = 0;
          }
        }
        throw err;
      }
      const tracker = trackerFor(key);
      const decision = tracker.observe(err);
      const cls = haltedClassOf(decision);
      if (cls) {
        armCooldown(key, cls, now(), isProbe);
      } else if (isProbe) {
        // Non-halt failure settles the probe without re-arming — the outage
        // condition is gone even though this item failed on its own merits.
        const s = cooldowns.get(key);
        if (s) {
          s.probeInFlight = false;
          s.until = 0;
        }
      }
      throw err; // the failing job stays a VISIBLE failure (normal retry path)
    }
  };
}

/**
 * Provider identity for a facts-absorb-shaped job: the provider half of the
 * per-job model override when present, else of the gateway's configured chat
 * model. Falls back to the whole model string when there is no provider
 * prefix (bare ids share one credential domain in practice).
 */
export function providerIdentityForJob(job: MinionJobContext, configuredModel: () => string | null): string {
  const jobModel = typeof job.data?.model === 'string' && job.data.model ? job.data.model : null;
  const model = jobModel ?? (configuredModel() || 'unknown');
  const { provider, model: tail } = splitProviderModelId(model);
  return provider ?? (tail || model);
}

/**
 * The facts-absorb boundary wrapper (#4310): cooldown keyed on the provider
 * identity of the job's model override, else the gateway's configured chat
 * model (resolved per job, AFTER registerBuiltinJob's gateway refresh).
 */
export function withFactsAbsorbHaltCooldown(handler: MinionHandler): MinionHandler {
  return withGlobalLlmHaltCooldown(
    (job) =>
      providerIdentityForJob(job, () => {
        try {
          return getChatModel();
        } catch {
          return null;
        }
      }),
    handler,
  );
}
