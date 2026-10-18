/**
 * Synthesis completion keys: which transcripts a prior dream run already
 * synthesized (the legacy `dream:synth:` path-keyed family and the synth-v2
 * source-identity family), read from completed subagent jobs and the durable
 * dream_synthesis_completions archive. Peeled from synthesize.ts with #5145,
 * which moved the completion check ahead of the paid triage pass.
 */
import { basename } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import type { MaintenanceAuthority } from '../persistence/prepared-maintenance.ts';
import { managedPersistenceEnabled } from '../persistence/ownership.ts';
import type { DiscoveredTranscript } from './transcript-discovery.ts';

/**
 * #5145: split transcripts into already-synthesized and candidates BEFORE the
 * paid triage pass. Classic brains (no maintenance) and dry runs (maintenance
 * forced null) used to triage completed transcripts first and only skip them
 * afterwards, re-buying triage whenever the verdict cache expired. Legacy
 * `dream:synth:` keys count on classic brains only (as the fan-out always
 * did); a dry run on a managed brain reads the source incarnation read-only
 * so its synth-v2 keys match the identity a real run would use. The key lists
 * are returned for the fan-out's own per-transcript checks.
 *
 * A managed brain also honours what its classic runs completed for this same
 * source row (legacy keys and synth-v2 keys under the bare source id), so
 * turning on managed persistence does not re-buy triage and synthesis for the
 * whole history. Keys of an older incarnation, and classic jobs submitted
 * before the source row was (re)created, still do not count.
 */
export async function partitionCompletedSynthesis(
  engine: BrainEngine,
  transcripts: DiscoveredTranscript[],
  sourceId: string,
  maintenance: MaintenanceAuthority | null,
  dryRun: boolean,
): Promise<{ completed: Set<string>; successfulLegacyKeys: string[]; successfulV2Keys: string[]; preManagedV2Keys: string[]; synthesisIdentity: string }> {
  const incarnation = maintenance
    ? maintenance.writer.sourceIncarnation
    : dryRun ? await readManagedSourceIncarnation(engine, sourceId) : null;
  const synthesisIdentity = incarnation !== null ? `${sourceId}/${incarnation}` : sourceId;
  const successfulV2Keys = await loadSuccessfulSynthesisKeys(engine, sourceId, 'dream:synth-v2:');
  const preManaged = incarnation !== null ? await loadPreManagedSynthesisKeys(engine, sourceId) : null;
  const successfulLegacyKeys = preManaged ? preManaged.legacy : await loadSuccessfulSynthesisKeys(engine, sourceId, 'dream:synth:');
  const preManagedV2Keys = preManaged?.v2 ?? [];
  const completed = new Set(transcripts.filter(t => {
    const hash16 = t.contentHash.slice(0, 16);
    return findLegacyCompletion(successfulLegacyKeys, t.filePath, hash16) !== null
      || findSynthV2Completion(successfulV2Keys, t.filePath, hash16, synthesisIdentity) !== null
      || findSynthV2Completion(preManagedV2Keys, t.filePath, hash16, sourceId) !== null;
  }).map(t => t.filePath));
  return { completed, successfulLegacyKeys, successfulV2Keys, preManagedV2Keys, synthesisIdentity };
}

/**
 * Classic-run completions of the CURRENT source row on a managed brain: the
 * legacy family and synth-v2 keys under the bare source id (a managed run
 * always keys `<source>/<incarnation>`, so only a classic run wrote these).
 * Only jobs SUBMITTED after the current source row was created count, so a
 * source removed and re-added under the same id does not inherit the
 * completions of the pages it lost, even when an old job finishes late.
 * `dream_synthesis_completions` is not consulted: it keeps no submission time
 * (and prune stamps an unknown finish as now()), so it cannot prove a row
 * belongs to the current source; a pruned classic completion re-runs.
 */
async function loadPreManagedSynthesisKeys(engine: BrainEngine, sourceId: string): Promise<{ legacy: string[]; v2: string[] }> {
  const v2Prefix = `dream:synth-v2:${encodeURIComponent(sourceId)}:filename:`;
  const rows = await engine.executeRaw<{ idempotency_key: string }>(
    `SELECT j.idempotency_key
       FROM minion_jobs j JOIN sources s ON s.id = $1
      WHERE j.name = 'subagent'
        AND j.status = 'completed'
        AND COALESCE(NULLIF(j.data->>'source_id', ''), 'default') = $1
        AND (j.idempotency_key LIKE 'dream:synth:%' OR left(j.idempotency_key, length($2)) = $2)
        AND j.created_at >= s.created_at`,
    [sourceId, v2Prefix],
  );
  const keys = rows.map(row => row.idempotency_key);
  return { legacy: keys.filter(k => k.startsWith('dream:synth:')), v2: keys.filter(k => k.startsWith(v2Prefix)) };
}

/**
 * #5145: the source incarnation a managed real run would key its synth-v2
 * completions under, read without the write preflight (dry runs never
 * register a writer). Null on a classic brain or when the read fails.
 */
async function readManagedSourceIncarnation(engine: BrainEngine, sourceId: string): Promise<string | null> {
  try {
    if (!await managedPersistenceEnabled(engine)) return null;
    const [row] = await engine.executeRaw<{ incarnation: string | null }>('SELECT incarnation FROM sources WHERE id = $1', [sourceId]);
    return row?.incarnation ?? null;
  } catch {
    return null;
  }
}

/**
 * Load every `completed` subagent job key in one synthesis key family for
 * one source. Called once per phase per family so the submit loop can skip
 * transcripts already synthesized BEFORE building their link manifest:
 *  - D8 legacy `dream:synth:<filePath>:<hash16>[:c<i>of<n>]` (pre-v2 shape;
 *    must not be re-submitted under v2 keys);
 *  - current `dream:synth-v2:<source>:filename:<basename>:<hash16>[:c<i>of<n>]`
 *    (the queue's idempotency dedupe would coalesce these too, but only after
 *    the manifest build, and the coalesced children would re-enter writtenRefs).
 * `dream:synth:%` does not match `dream:synth-v2:` keys.
 *
 * Plain `status = 'completed'` deliberately mirrors the queue-level
 * idempotency semantics the legacy keys relied on: a completed job blocks
 * re-submission regardless of `result.stop_reason` (pinned in
 * test/minions.test.ts). Filtering on stop_reason here would re-pay for
 * transcripts the old code path never re-ran, and reading `result` at all
 * would need the `(result #>> '{}')` double-encoded-jsonb defense.
 *
 * Completed rows that `jobs prune` removed live on in
 * `dream_synthesis_completions` (the prune archives them), so pruning never
 * makes a synthesized transcript eligible again. Loads source-scoped
 * completions once per phase; no repeated history scan per transcript.
 */
async function loadSuccessfulSynthesisKeys(
  engine: BrainEngine,
  sourceId: string,
  keyPrefix: 'dream:synth:' | 'dream:synth-v2:',
): Promise<string[]> {
  const rows = await engine.executeRaw<{ idempotency_key: string }>(
    `SELECT idempotency_key
       FROM minion_jobs
      WHERE name = 'subagent'
        AND status = 'completed'
        AND COALESCE(NULLIF(data->>'source_id', ''), 'default') = $1
        AND idempotency_key LIKE $2
     UNION
     SELECT idempotency_key FROM dream_synthesis_completions
      WHERE source_id = $1 AND idempotency_key LIKE $2`,
    [sourceId, `${keyPrefix}%`],
  );
  return rows.map(row => row.idempotency_key);
}

/**
 * Mirror of findLegacyCompletion for the synth-v2 key family (grammar as
 * produced by the submit loop / parsed by `parseSynthV2Key`): `'single'` when
 * the unchunked key completed, `'chunked'` when a FULL `:c0of<n>`..`:c<n-1>of<n>`
 * set completed, null otherwise (a cancelled row never counts).
 */
export function findSynthV2Completion(
  successfulKeys: string[],
  filePath: string,
  hash16: string,
  sourceId: string,
): 'single' | 'chunked' | null {
  const prefix =
    `dream:synth-v2:${encodeURIComponent(sourceId)}` +
    `:filename:${encodeURIComponent(basename(filePath))}:${hash16}`;
  const chunkSets = new Map<number, Set<number>>();
  for (const key of successfulKeys) {
    if (key === prefix) return 'single';
    if (!key.startsWith(prefix + ':c')) continue;
    const chunk = /:c(\d+)of(\d+)$/.exec(key);
    if (!chunk) continue;
    const i = Number(chunk[1]);
    const n = Number(chunk[2]);
    if (n < 1 || i < 0 || i >= n) continue;
    let seen = chunkSets.get(n);
    if (!seen) chunkSets.set(n, seen = new Set());
    seen.add(i);
  }
  for (const [n, seen] of chunkSets) {
    if (seen.size === n) return 'chunked';
  }
  return null;
}

/**
 * Match a transcript (by filename + content hash) against completed legacy
 * keys. `'single'` when a `dream:synth:<path>:<hash16>` completion exists;
 * `'chunked'` when a FULL chunk set `:c0of<n>`..`:c<n-1>of<n>` completed
 * (chunk indices are 0-based). Partial chunk sets return null so the
 * transcript gets a fresh v2 synthesis instead of shipping with holes.
 */
export function findLegacyCompletion(
  successfulKeys: string[],
  filePath: string,
  hash16: string,
): 'single' | 'chunked' | null {
  const filename = basename(filePath);
  const hashSuffix = `:${hash16}`;
  /** total chunk count n → completed 0-based chunk indices */
  const chunkSets = new Map<number, Set<number>>();
  for (const key of successfulKeys) {
    const chunk = /:c(\d+)of(\d+)$/.exec(key);
    const base = chunk ? key.slice(0, -chunk[0].length) : key;
    if (!base.endsWith(hashSuffix)) continue;
    const historicalPath = base.slice('dream:synth:'.length, -hashSuffix.length);
    if (basename(historicalPath) !== filename) continue;
    if (!chunk) return 'single';
    const i = Number(chunk[1]);
    const n = Number(chunk[2]);
    if (n < 1 || i < 0 || i >= n) continue;
    let seen = chunkSets.get(n);
    if (!seen) chunkSets.set(n, seen = new Set());
    seen.add(i);
  }
  for (const [n, seen] of chunkSets) {
    if (seen.size === n) return 'chunked';
  }
  return null;
}
