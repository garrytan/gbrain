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
 * Not covered: content-hashed keys change whenever a transcript grows, and
 * patterns runs outside maintenance carry no key.
 */
import type { BrainEngine } from '../engine.ts';

export const DREAM_BREAKER_KEY_PREFIXES = ['dream:synth-v2:', 'dream:patterns:'] as const;
export const DREAM_BREAKER_CONFIG_KEY = 'dream.breaker.max_dead_submissions';
export const DREAM_BREAKER_RESETS_KEY = 'dream.breaker.resets';
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
  return engine.executeRaw<DeadDreamSubmissions>(
    `WITH dead AS (
       SELECT regexp_replace(COALESCE(idempotency_key, data->>'__released_idempotency_key'), ':c[0-9]+of[0-9]+$', '') AS base_key,
              queue, finished_at
         FROM minion_jobs
        WHERE name = 'subagent' AND status = 'dead' AND finished_at > now() - interval '24 hours'
     )
     SELECT base_key, COUNT(DISTINCT queue)::int AS dead_submissions, MAX(finished_at)::text AS last_dead_at
       FROM dead
      WHERE (left(base_key, ${DREAM_BREAKER_KEY_PREFIXES[0].length}) = $1 OR left(base_key, ${DREAM_BREAKER_KEY_PREFIXES[1].length}) = $2)
        AND finished_at > COALESCE(($3::text::jsonb ->> base_key)::timestamptz, '-infinity'::timestamptz)
      GROUP BY base_key
      ORDER BY dead_submissions DESC, base_key`,
    [DREAM_BREAKER_KEY_PREFIXES[0], DREAM_BREAKER_KEY_PREFIXES[1], JSON.stringify(resets)],
  );
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
