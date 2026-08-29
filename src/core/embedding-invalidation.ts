/**
 * Signature-truth guards for the invalidation/re-embed pipeline (#4305 +
 * #4306). Engine-pure: both engines share these shapes via executeRaw
 * (PGLite and Postgres accept the SQL identically).
 *
 * #4306 — embed_skip-aware stale-signature invalidation.
 * `engine.invalidateStaleSignatureEmbeddings` NULLs mismatched-signature
 * vectors on EVERY page, but every stale/backfill selector
 * (buildStaleChunkWhere / listStaleChunks, both engines) excludes pages whose
 * frontmatter carries `embed_skip`. Invalidate-then-hide: vectors retained on
 * an embed_skip page (embedded BEFORE the marker appeared, e.g. the
 * content-sanity oversize stamp) were destroyed by the next migration and
 * could never be re-embedded — permanent, silent loss.
 * `invalidateStaleSignatureEmbeddingsGuarded` is the ONE invalidation entry
 * point for the migration and embed paths: identical semantics to the engine
 * method PLUS the same NOT-embed_skip predicate the selectors use, so the two
 * halves can never disagree again. Never NULL what nothing will re-embed.
 *
 * #4305 — chunk-model truth cross-check. `pages.embedding_signature` is
 * separate state that can disagree with the vectors it describes: a page
 * stamped WITH the target signature while its chunks' `model` column still
 * names another provider is skipped by every signature-keyed selector, so the
 * old embedding space stays live while plan/status/verify all report
 * converged. The chunk model column is the ground truth; these helpers count
 * and clear the false stamps.
 */

import type { BrainEngine } from './engine.ts';
import {
  resolveActiveEmbeddingColumnFromEngine,
  quoteIdentifier,
} from './search/embedding-column.ts';

/**
 * `<provider:model>:<dims>` — the one-line shape of
 * embedding-migration.ts:migrationSignature, duplicated here so this module
 * stays cycle-free (embedding-migration imports from THIS file).
 */
function targetSignature(toModel: string, toDims: number): string {
  return `${toModel}:${toDims}`;
}

/**
 * S2: quoted identifier of the registry-ACTIVE embedding column. Every
 * helper in this file keys on the vectors writes actually land in
 * (#1262 routes upsertChunks through the registry) — the literal legacy
 * `embedding` column stays NULL forever on a registry-routed brain, which
 * would blind these predicates. Loud resolver failure by design: these are
 * migration-plane reads/writes, and a destructive invalidation must never
 * guess a column.
 */
async function activeColId(engine: Pick<BrainEngine, 'executeRaw'>): Promise<string> {
  const col = await resolveActiveEmbeddingColumnFromEngine(engine);
  return quoteIdentifier(col.name);
}

/**
 * Shared #4305 predicate: the page carries at least one EMBEDDED chunk whose
 * model matches neither the target `provider:model` nor its bare model tail
 * (pre-#3461 rows stored the model without the provider prefix — those must
 * not trigger a surprise paid re-embed). embed_skip pages are excluded to
 * match the selectors (#4306). $1 = target signature, $2 = target model.
 * `colId` = registry-active embedding column identifier (S2).
 */
function falseStampPageWhere(colId: string): string {
  return `
        p.embedding_signature = $1
        AND p.deleted_at IS NULL
        AND NOT (COALESCE(p.frontmatter, '{}'::jsonb) ? 'embed_skip')
        AND EXISTS (
          SELECT 1 FROM content_chunks c
           WHERE c.page_id = p.id AND c.${colId} IS NOT NULL
             AND c.model IS NOT NULL AND c.model <> $2
             AND c.model <> substr($2, strpos($2, ':') + 1)
        )`;
}

/**
 * #4305 count side (plan / verify / --status honesty). Counts the falsely
 * stamped pages plus EVERY embedded chunk on them — invalidation is
 * page-level, so that is the true re-embed workload.
 */
export async function countFalseStampedChunks(
  engine: Pick<BrainEngine, 'executeRaw'>,
  toModel: string,
  toDims: number,
): Promise<{ pages: number; chunks: number; chars: number }> {
  const colId = await activeColId(engine);
  const rows = await engine.executeRaw<{ pages: number; chunks: number; chars: number | string }>(
    `WITH fs AS (
       SELECT p.id FROM pages p
        WHERE ${falseStampPageWhere(colId)}
     )
     SELECT count(DISTINCT fs.id)::int AS pages,
            count(cc.id)::int AS chunks,
            COALESCE(sum(length(cc.chunk_text)), 0)::bigint AS chars
       FROM fs
       JOIN content_chunks cc ON cc.page_id = fs.id
      WHERE cc.${colId} IS NOT NULL`,
    [targetSignature(toModel, toDims), toModel],
  );
  return {
    pages: Number(rows[0]?.pages ?? 0),
    chunks: Number(rows[0]?.chunks ?? 0),
    chars: Number(rows[0]?.chars ?? 0),
  };
}

/**
 * #4305 apply side: clear the false target stamps so the
 * NULL-signature-inclusive invalidation that follows re-embeds those pages.
 * Returns the number of pages cleared.
 */
export async function clearFalseStampedSignatures(
  engine: Pick<BrainEngine, 'executeRaw'>,
  toModel: string,
  toDims: number,
): Promise<number> {
  const colId = await activeColId(engine);
  const rows = await engine.executeRaw<{ id: number }>(
    `UPDATE pages p SET embedding_signature = NULL
      WHERE ${falseStampPageWhere(colId)}
      RETURNING p.id`,
    [targetSignature(toModel, toDims), toModel],
  );
  return (rows as unknown[]).length;
}

export async function invalidateStaleSignatureEmbeddingsGuarded(
  engine: Pick<BrainEngine, 'executeRaw'>,
  opts: { signature: string; sourceId?: string; includeNullSignature?: boolean },
): Promise<number> {
  const colId = await activeColId(engine);
  const params: unknown[] = [opts.signature];
  let srcClause = '';
  if (opts.sourceId !== undefined) {
    params.push(opts.sourceId);
    srcClause = ` AND p.source_id = $${params.length}`;
  }
  // Mirrors the engine method's clauses (NULL-signature grandfather lifted by
  // includeNullSignature, #3391); the embed_skip predicate matches
  // buildStaleChunkWhere exactly.
  const sigClause = opts.includeNullSignature
    ? `(p.embedding_signature IS NULL OR p.embedding_signature <> $1)`
    : `p.embedding_signature IS NOT NULL AND p.embedding_signature <> $1`;
  const rows = await engine.executeRaw<{ page_id: number }>(
    `UPDATE content_chunks cc
        SET ${colId} = NULL, embedded_at = NULL
       FROM pages p
      WHERE cc.page_id = p.id
        AND cc.${colId} IS NOT NULL
        AND NOT (COALESCE(p.frontmatter, '{}'::jsonb) ? 'embed_skip')
        AND ${sigClause}${srcClause}
      RETURNING cc.page_id`,
    params,
  );
  return (rows as unknown[]).length;
}
