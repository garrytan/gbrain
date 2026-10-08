/**
 * Paid-loop circuit breaker for dream synthesize and patterns.
 *
 * A dream idempotency key whose submissions died 3 times within 24 h is not
 * submitted again until an operator resets it. A submission is one
 * (base key, queue) pair: chunks of one run share the run's private inline
 * queue, so a chunked transcript counts once per run. Deaths are counted by
 * finish time over dead `subagent` rows, reading the live key or the key the
 * queue recorded when it released the slot (`__released_idempotency_key`).
 * Only dead rows count: a completed job, including a legitimate zero-write
 * completion, is never a death.
 *
 * Patterns (#6236): the patterns key digests the reflection set, so it
 * changes whenever a reflection does. Patterns deaths therefore count under
 * the stable per-source key `dream:patterns:source:<source id>` (the job's
 * `source_id`, else `default`), and a patterns child cancelled at its timeout
 * after paid work (tokens recorded) counts as a death too; one cancelled
 * before any work does not. A completed patterns run resets its source key,
 * so only consecutive deaths trip it.
 *
 * Not covered: content-hashed synthesize keys change whenever a transcript
 * grows, and patterns runs outside maintenance carry no key.
 */
import type { BrainEngine } from '../engine.ts';
import type { PhaseResult } from '../cycle.ts';

export const DREAM_BREAKER_KEY_PREFIXES = ['dream:synth-v2:', 'dream:patterns:'] as const;
/** Base-key prefix of the per-source patterns count, whatever each run's content key. */
export const DREAM_PATTERNS_SOURCE_KEY_PREFIX = 'dream:patterns:source:';

/** The stable key every patterns death of this source counts under. */
export function dreamPatternsSourceKey(sourceId: string): string {
  return `${DREAM_PATTERNS_SOURCE_KEY_PREFIX}${sourceId}`;
}
/** Base-key prefix of a contained cycle-phase failure after paid model calls. */
export const DREAM_PHASE_KEY_PREFIX = 'dream:phase:';
export const DREAM_BREAKER_CONFIG_KEY = 'dream.breaker.max_dead_submissions';
export const DREAM_BREAKER_RESETS_KEY = 'dream.breaker.resets';
/** Contained paid phase failures: `{ [base key]: ISO finish times }`, pruned to the 24 h window. */
export const DREAM_BREAKER_CONTAINED_KEY = 'dream.breaker.contained_failures';
export const DEFAULT_MAX_DEAD_SUBMISSIONS = 3;

export interface DeadDreamSubmissions { base_key: string; dead_submissions: number; last_dead_at: string }

export function dreamBreakerBaseKey(key: string): string {
  return key.replace(/:c\d+of\d+$/, '');
}

export function dreamBreakerResetCommand(baseKey: string): string {
  return `gbrain dream reset-key '${baseKey.replaceAll("'", "'\\''")}'`;
}

/** 0 disables the breaker; unset or invalid values use the default. */
export async function loadDreamBreakerThreshold(engine: BrainEngine): Promise<number> {
  const raw = await engine.getConfig(DREAM_BREAKER_CONFIG_KEY);
  if (raw === null || raw === undefined || raw.trim() === '') return DEFAULT_MAX_DEAD_SUBMISSIONS;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : DEFAULT_MAX_DEAD_SUBMISSIONS;
}

async function loadResets(engine: BrainEngine): Promise<Record<string, string>> {
  const raw = await engine.getConfig(DREAM_BREAKER_RESETS_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter(([, at]) => typeof at === 'string' && Number.isFinite(Date.parse(at))));
  } catch { return {}; }
}

/**
 * The one counting rule shared by the breaker, `gbrain dream reset-key --list`
 * and the doctor check. Dead submissions finished before a key's persisted
 * reset time do not count. Backed by the partial index on dead subagent
 * finish times.
 */
export async function countDeadDreamSubmissions(engine: BrainEngine): Promise<DeadDreamSubmissions[]> {
  const resets = await loadResets(engine);
  const dead = await engine.executeRaw<DeadDreamSubmissions>(
    `WITH ended AS (
       SELECT regexp_replace(COALESCE(idempotency_key, data->>'__released_idempotency_key'), ':c[0-9]+of[0-9]+$', '') AS base_key,
              COALESCE(data->>'source_id', 'default') AS source_id, status, queue, finished_at
         FROM minion_jobs
        WHERE name = 'subagent' AND finished_at > now() - interval '24 hours'
          AND (status = 'dead' OR (status = 'cancelled' AND tokens_input + tokens_output > 0))
     ), counted AS (
       SELECT base_key, queue, finished_at FROM ended
        WHERE status = 'dead' AND left(base_key, ${DREAM_BREAKER_KEY_PREFIXES[0].length}) = $1
       UNION ALL
       SELECT $4::text || source_id, queue, finished_at FROM ended
        WHERE left(base_key, ${DREAM_BREAKER_KEY_PREFIXES[1].length}) = $2
     )
     SELECT base_key, COUNT(DISTINCT queue)::int AS dead_submissions, MAX(finished_at)::text AS last_dead_at
       FROM counted
      WHERE finished_at > COALESCE(($3::text::jsonb ->> base_key)::timestamptz, '-infinity'::timestamptz)
      GROUP BY base_key
      ORDER BY dead_submissions DESC, base_key`,
    [DREAM_BREAKER_KEY_PREFIXES[0], DREAM_BREAKER_KEY_PREFIXES[1], JSON.stringify(resets), DREAM_PATTERNS_SOURCE_KEY_PREFIX],
  );
  const cutoff = Date.now() - 24 * 3_600_000;
  for (const [baseKey, times] of Object.entries(await loadContained(engine))) {
    const after = Math.max(cutoff, Date.parse(resets[baseKey] ?? '') || -Infinity);
    const counted = times.filter(at => Date.parse(at) > after).sort();
    if (counted.length) dead.push({ base_key: baseKey, dead_submissions: counted.length, last_dead_at: counted.at(-1)! });
  }
  return dead.sort((a, b) => b.dead_submissions - a.dead_submissions || a.base_key.localeCompare(b.base_key));
}

async function loadContained(engine: BrainEngine): Promise<Record<string, string[]>> {
  const raw = await engine.getConfig(DREAM_BREAKER_CONTAINED_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).flatMap(([key, times]) => Array.isArray(times)
      ? [[key, times.filter((at): at is string => typeof at === 'string' && Number.isFinite(Date.parse(at)))]] : []));
  } catch { return {}; }
}

/**
 * Record a cycle phase whose failure was contained after it made paid model
 * calls (#5484 containment), so doctor's dream_paid_loop sees a phase that
 * keeps paying and failing even though its job no longer dies. The update is
 * serialized on the config row and drops entries older than the window.
 */
export async function recordContainedPaidFailure(engine: BrainEngine, phase: string, sourceId: string): Promise<void> {
  const baseKey = `${DREAM_PHASE_KEY_PREFIX}${phase}:${sourceId}`;
  await engine.transaction(async tx => {
    await tx.executeRaw("INSERT INTO config (key, value) VALUES ($1, '{}') ON CONFLICT (key) DO NOTHING", [DREAM_BREAKER_CONTAINED_KEY]);
    const [row] = await tx.executeRaw<{ value: string; now: string }>(
      `SELECT value, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now FROM config WHERE key=$1 FOR UPDATE`,
      [DREAM_BREAKER_CONTAINED_KEY]);
    let current: Record<string, unknown> = {};
    try { const parsed = JSON.parse(row?.value ?? '{}'); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) current = parsed; } catch { /* rewrite a corrupt value */ }
    const cutoff = Date.parse(row!.now) - 24 * 3_600_000;
    const next: Record<string, string[]> = {};
    for (const [key, times] of Object.entries(current)) {
      const kept = Array.isArray(times) ? times.filter((at): at is string => typeof at === 'string' && Date.parse(at) > cutoff) : [];
      if (kept.length) next[key] = kept;
    }
    next[baseKey] = [...next[baseKey] ?? [], row!.now].slice(-50);
    await tx.executeRaw('UPDATE config SET value=$2 WHERE key=$1', [DREAM_BREAKER_CONTAINED_KEY, JSON.stringify(next)]);
  });
}

export interface DreamBreaker { threshold: number; tripped: Map<string, number> }

/**
 * Tripped base keys for this run, or null when the breaker is disabled or its
 * count failed. A failed count skips the breaker for the run with a warning,
 * the same posture as the synthesize daily cap.
 */
export async function loadDreamBreaker(engine: BrainEngine): Promise<DreamBreaker | null> {
  try {
    const threshold = await loadDreamBreakerThreshold(engine);
    if (threshold === 0) return null;
    const rows = await countDeadDreamSubmissions(engine);
    return { threshold, tripped: new Map(rows.filter(row => row.dead_submissions >= threshold).map(row => [row.base_key, row.dead_submissions])) };
  } catch (error) {
    process.stderr.write(`[dream] breaker count query failed (${error instanceof Error ? error.message : String(error)}); `
      + 'skipping the paid-loop breaker for this run\n');
    return null;
  }
}

/**
 * #6236: the patterns phase's skip result when its source key is tripped, or
 * null (breaker off, count failed, or not tripped). The skip carries the reset
 * as a paid `fix` and a read-only verify.
 */
export async function patternsBreakerSkip(engine: BrainEngine, sourceId: string): Promise<PhaseResult | null> {
  const breaker = await loadDreamBreaker(engine);
  const key = dreamPatternsSourceKey(sourceId);
  const refusal = breaker && dreamBreakerRefusal(breaker, key);
  if (!refusal) return null;
  process.stderr.write(`[dream] patterns: ${refusal}\n`);
  return { phase: 'patterns', status: 'skipped', duration_ms: 0, summary: refusal, details: { reason: 'dream_breaker_tripped', code: 'dream_breaker_tripped',
    base_key: key, why: 'The patterns phase died (or was cancelled after paid work) that many times in a row for this source within 24 hours, so it is not submitted again until reset.',
    fix: { argv: ['gbrain', 'dream', 'reset-key', key], consent: ['paid'], actor: 'agent', requires_exclusive: false,
      why: 'Re-enables patterns runs for this source; the next cycle pays for a run, so fix the cause and ask the user first.',
      verify: { argv: ['gbrain', 'doctor', '--only', 'dream_paid_loop', '--json'] } } } };
}

/**
 * A completed patterns run ends its source's death count, so only consecutive
 * deaths trip it. A failed reset is logged; the earlier deaths then keep
 * counting until they leave the 24 h window.
 */
export async function clearPatternsSourceDeaths(engine: BrainEngine, sourceId: string): Promise<void> {
  const key = dreamPatternsSourceKey(sourceId);
  try {
    await resetDreamBreakerKey(engine, key);
  } catch (error) {
    process.stderr.write(`[dream] patterns: could not clear ${key} after a completed run; its earlier deaths keep counting `
      + `until they are 24h old (${error instanceof Error ? error.message : String(error)})\n`);
  }
}

/** Refusal line for the cycle summary and the autopilot log. */
export function dreamBreakerRefusal(breaker: DreamBreaker, baseKey: string): string | null {
  const count = breaker.tripped.get(baseKey);
  if (count === undefined) return null;
  return `dream_breaker_tripped: ${count} dead submissions in 24h (limit ${breaker.threshold}) for ${baseKey}; `
    + `no synthesis submitted. Fix the cause, then run: ${dreamBreakerResetCommand(baseKey)}`;
}

/**
 * Persist a reset: deaths of this key that finished before now (database
 * clock) stop counting. One atomic upsert merges the key into the stored map
 * and drops entries older than the window, so concurrent resets of different
 * keys both survive. Stored in config, so it survives restarts.
 */
export async function resetDreamBreakerKey(engine: BrainEngine, baseKey: string): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO config (key, value)
       VALUES ($1, jsonb_build_object($2::text, to_char((now() + interval '1 millisecond') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))::text)
     ON CONFLICT (key) DO UPDATE SET value = ((
       SELECT COALESCE(jsonb_object_agg(entry.key, entry.value), '{}'::jsonb)
         FROM jsonb_each_text(CASE WHEN config.value IS JSON OBJECT THEN config.value::jsonb ELSE '{}'::jsonb END) entry
        WHERE entry.key <> $2::text AND entry.value ~ '^[0-9]{4}-' AND entry.value::timestamptz > now() - interval '24 hours'
     ) || EXCLUDED.value::jsonb)::text`,
    [DREAM_BREAKER_RESETS_KEY, dreamBreakerBaseKey(baseKey)],
  );
}
