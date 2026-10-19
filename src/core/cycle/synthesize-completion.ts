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
 * afterwards, re-buying triage whenever the verdict cache expired. A dry run
 * on a managed brain reads the source incarnation read-only so its synth-v2
 * keys match the identity a real run would use.
 *
 * `retainedSkips` maps each transcript the fan-out must skip without
 * re-attaching children to its skip reason: legacy `dream:synth:` completions
 * and, on a managed brain, synth-v2 completions under the bare source id.
 * Completions keyed to this run's own identity stay out of the map; the
 * fan-out re-checks them against `successfulV2Keys` (a managed run re-attaches
 * their children for postprocessing).
 *
 * #6924: on a managed brain a completion without an incarnation (legacy keys,
 * bare-source synth-v2 keys) was recorded before the brain went managed, so
 * its identity cannot say which row of this source id it belongs to. It
 * counts only when this source still holds that synthesis's output: a live
 * `dream_generated` page whose `raw_source` names the transcript (matched by
 * basename, like the keys). Pages are deleted with their source row, so a
 * completion of a removed and re-added source, or of another source, never
 * suppresses synthesis.
 */
export async function partitionCompletedSynthesis(
  engine: BrainEngine,
  transcripts: DiscoveredTranscript[],
  sourceId: string,
  maintenance: MaintenanceAuthority | null,
  dryRun: boolean,
): Promise<{ completed: Set<string>; retainedSkips: Map<string, string>; successfulV2Keys: string[]; synthesisIdentity: string }> {
  const incarnation = maintenance
    ? maintenance.writer.sourceIncarnation
    : dryRun ? await readManagedSourceIncarnation(engine, sourceId) : null;
  const synthesisIdentity = incarnation !== null ? `${sourceId}/${incarnation}` : sourceId;
  const successfulV2Keys = await loadSuccessfulSynthesisKeys(engine, sourceId, 'dream:synth-v2:');
  const successfulLegacyKeys = await loadSuccessfulSynthesisKeys(engine, sourceId, 'dream:synth:');
  const retainedOutputs = incarnation !== null ? await loadRetainedOutputSources(engine, sourceId) : null;
  const completed = new Set<string>();
  const retainedSkips = new Map<string, string>();
  for (const t of transcripts) {
    const hash16 = t.contentHash.slice(0, 16);
    const current = findSynthV2Completion(successfulV2Keys, t.filePath, hash16, synthesisIdentity);
    if (current) completed.add(t.filePath);
    if (retainedOutputs && (current || !retainedOutputs.has(basename(t.filePath)))) continue;
    const legacy = findLegacyCompletion(successfulLegacyKeys, t.filePath, hash16);
    const premanaged = retainedOutputs ? findSynthV2Completion(successfulV2Keys, t.filePath, hash16, sourceId) : null;
    const reason = legacy ? `already_synthesized_legacy_${legacy === 'chunked' ? 'chunked' : 'single_chunk'}`
      : premanaged ? `already_synthesized_v2_${premanaged === 'chunked' ? 'chunked' : 'single_chunk'}` : null;
    if (!reason) continue;
    completed.add(t.filePath);
    retainedSkips.set(t.filePath, reason);
  }
  return { completed, retainedSkips, successfulV2Keys, synthesisIdentity };
}

/**
 * #6924: basenames of the transcripts this source's live synthesis output
 * names (`raw_source`, stamped on every classic synthesis page by
 * stampDreamProvenance).
 */
async function loadRetainedOutputSources(engine: BrainEngine, sourceId: string): Promise<Set<string>> {
  const rows = await engine.executeRaw<{ raw_source: string }>(
    `SELECT DISTINCT frontmatter->>'raw_source' AS raw_source
       FROM pages
      WHERE source_id = $1
        AND deleted_at IS NULL
        AND frontmatter->>'dream_generated' = 'true'
        AND COALESCE(frontmatter->>'raw_source', '') <> ''`,
    [sourceId],
  );
  return new Set(rows.map(row => basename(row.raw_source)));
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
