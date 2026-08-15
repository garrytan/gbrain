/**
 * MEMORY_VERBS v1 — `writeSingleFact`: the zero-LLM single-fact write seam
 * behind the `remember` verb [E1].
 *
 * `runFactsPipeline` is extraction-first (LLM-gated in extract.ts) and cannot
 * back a verb whose fact arrives pre-formed. This module reuses the pipeline's
 * post-extraction stages directly: resolve → dedup (embedding cosine, same
 * 0.95 threshold) → fence-first write (markdown durability) with the same
 * legacy DB-only fallbacks (thin-client, unparented, stub-guard).
 *
 * Supersession [X1, frozen as implementation-defined]: minimal deterministic
 * rule, zero LLM — when the top dedup candidate scores >= threshold with the
 * SAME kind but DIFFERENT text, the new fact supersedes it (a near-duplicate
 * with changed content is an update: "X at Acme" → "X left Acme"). Same text
 * → plain duplicate (existing id returned, nothing written).
 *
 * Degradation (documented in the protocol doc): with no embedding provider,
 * dedup/supersession are skipped on the fence path and near-duplicates may
 * insert — `degraded_dedup: true` tells the caller.
 *
 * Provenance (c6): callers pass free-text provenance which lands on
 * `NewFact.source` verbatim — this seam deliberately does NOT take a
 * FactsBackstopCtx (whose `source` union is pipeline-internal).
 */

import type { BrainEngine, FactInsertStatus, NewFact } from '../engine.ts';

const DEDUP_THRESHOLD = 0.95;
const DEDUP_CANDIDATE_LIMIT = 5;

export interface SingleFactInput {
  fact: string;
  /** Free-text attribution, stored verbatim as the fact's `source`. */
  provenance: string;
  kind?: NewFact['kind'];
  /** Free-form entity ref; canonicalized via resolveEntitySlug. */
  entity?: string | null;
  /** Facts-layer default 'private'; the remember VERB passes 'world' [F2]. */
  visibility?: 'private' | 'world';
  validUntil?: Date | null;
  sessionId?: string | null;
  confidence?: number;
}

export interface SingleFactResult {
  id: number;
  status: FactInsertStatus;
  entity_slug: string | null;
  valid_until: Date | null;
  /** True when no embedding provider — dedup/supersession skipped. */
  degraded_dedup: boolean;
}

export async function writeSingleFact(
  engine: BrainEngine,
  sourceId: string,
  input: SingleFactInput,
): Promise<SingleFactResult> {
  const { resolveEntitySlug } = await import('../entities/resolve.ts');
  const { cosineSimilarity } = await import('./classify.ts');
  const { writeFactsToFence, lookupSourceLocalPath } = await import('./fence-write.ts');
  const { isAvailable, embedOne } = await import('../ai/gateway.ts');

  const factText = input.fact.trim();
  const kind = input.kind ?? 'fact';
  const visibility = input.visibility ?? 'private';
  const validUntil = input.validUntil ?? null;

  const resolvedSlug = input.entity
    ? ((await resolveEntitySlug(engine, sourceId, input.entity)) ?? input.entity)
    : null;

  // Embedding (NOT an LLM call): powers dedup + downstream recall. Fail-soft —
  // a missing/failing provider degrades dedup, never the write.
  let embedding: Float32Array | null = null;
  let degradedDedup = false;
  if (isAvailable('embedding')) {
    try {
      embedding = await embedOne(factText);
    } catch {
      degradedDedup = true;
    }
  } else {
    degradedDedup = true;
  }

  // Dedup + supersession decision (same candidates + threshold as the pipeline).
  let supersedeId: number | null = null;
  if (resolvedSlug && embedding) {
    const candidates = await engine.findCandidateDuplicates(sourceId, resolvedSlug, factText, {
      embedding,
      k: DEDUP_CANDIDATE_LIMIT,
    });
    let top: (typeof candidates)[number] | null = null;
    let topScore = -1;
    for (const c of candidates) {
      if (!c.embedding) continue;
      const s = cosineSimilarity(embedding, c.embedding);
      if (s > topScore) {
        topScore = s;
        top = c;
      }
    }
    if (top && topScore >= DEDUP_THRESHOLD) {
      const textDiffers = collapse(top.fact) !== collapse(factText);
      if (top.kind === kind && textDiffers) {
        supersedeId = top.id; // X1: near-duplicate with changed content = update
      } else {
        return {
          id: top.id,
          status: 'duplicate',
          entity_slug: resolvedSlug,
          valid_until: top.valid_until ?? null,
          degraded_dedup: false,
        };
      }
    }
  }

  const newFact: NewFact = {
    fact: factText,
    kind,
    entity_slug: resolvedSlug,
    visibility,
    source: input.provenance,
    source_session: input.sessionId ?? null,
    confidence: input.confidence ?? 1.0,
    valid_until: validUntil,
    embedding,
  };

  // Fence-first write (markdown durability — same policy as the pipeline):
  // requires a resolved, prefixed entity slug and a local_path. Everything
  // else takes the legacy DB-only insertFact path, which also handles the
  // supersedeId bookkeeping engine-side.
  const localPath = resolvedSlug ? await lookupSourceLocalPath(engine, sourceId) : null;
  const fenceable = resolvedSlug !== null && localPath !== null;

  if (fenceable) {
    const result = await writeFactsToFence(
      engine,
      { sourceId, localPath, slug: resolvedSlug },
      [
        {
          fact: factText,
          kind,
          notability: 'medium',
          source: input.provenance,
          context: null,
          visibility,
          confidence: input.confidence ?? 1.0,
          validFrom: new Date(),
          validUntil,
          embedding,
          sessionId: input.sessionId ?? null,
        },
      ],
    );

    if (result.fenceWriteFailed) {
      // Parse-validate rejected the .tmp (quarantined). Hard failure — do NOT
      // fall through to a DB row whose fence is broken (pipeline policy).
      throw new Error(
        `facts fence write failed for ${resolvedSlug} — .tmp quarantined; see the facts write-failure JSONL log`,
      );
    }
    if (!result.stubGuardBlocked && !result.legacyFallback) {
      const newId = result.ids[0];
      if (supersedeId !== null && newId !== undefined) {
        await expireSuperseded(engine, supersedeId, newId);
        return {
          id: newId,
          status: 'superseded',
          entity_slug: resolvedSlug,
          valid_until: validUntil,
          degraded_dedup: degradedDedup,
        };
      }
      return {
        id: newId,
        status: 'inserted',
        entity_slug: resolvedSlug,
        valid_until: validUntil,
        degraded_dedup: degradedDedup,
      };
    }
    // stubGuardBlocked / defensive legacyFallback → DB-only path below.
  }

  const inserted = await engine.insertFact(newFact, { // gbrain-allow-direct-insert: writeSingleFact legacy path for unparented / thin-client / stub-guarded facts (mirrors the pipeline's fallback buckets)
    source_id: sourceId,
    ...(supersedeId !== null ? { supersedeId } : {}),
  });

  return {
    id: inserted.id,
    status: supersedeId !== null ? 'superseded' : inserted.status,
    entity_slug: resolvedSlug,
    valid_until: validUntil,
    degraded_dedup: degradedDedup,
  };
}

/**
 * Fence-path supersession bookkeeping: expire the old row through the fence
 * (strikethrough + valid_until, the same surface `forget` uses) and link
 * `superseded_by` for the audit trail. Both steps best-effort — the new fact
 * is already durably written; a partial supersede is an audit gap, not data
 * loss.
 */
async function expireSuperseded(engine: BrainEngine, oldId: number, newId: number): Promise<void> {
  try {
    const { forgetFactInFence } = await import('./forget.ts');
    await forgetFactInFence(engine, oldId, { reason: `superseded by fact #${newId}` });
  } catch {
    /* best-effort */
  }
  try {
    await engine.executeRaw(`UPDATE facts SET superseded_by = $1 WHERE id = $2`, [newId, oldId]);
  } catch {
    /* best-effort */
  }
}

function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}
