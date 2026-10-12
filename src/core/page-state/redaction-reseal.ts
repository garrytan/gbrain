/**
 * Projection re-seal after a `redaction.projection_classes` change. The
 * chunkers cut from `retrievalTextProjection` (credential-projection.ts), so
 * pages chunked under the old class list carry stale text: identifiers still
 * in chunks after the class was switched on, tokens still there after it was
 * switched off. This walks every live markdown/code page in active sources,
 * scans its canonical body for the union of the old and the new classes, and
 * for each match unseals the page (`text_projection_revision = NULL`, which
 * withholds its old chunks from every retrieval path) and rebuilds its chunks
 * from the unchanged body through `resealSafeChunks` — no page write, no
 * journal admission, no provider call; vectors of unchanged chunk text are
 * kept and re-chunked text waits for `gbrain embed --stale`. Pages with no
 * match under either list are left alone. The classes the chunks were cut
 * with are recorded in `redaction.sealed_projection_classes`; the doctor
 * check `redaction_projection_pending` warns while that differs from the
 * policy. Same shape as `credential-reseal.ts`, which handles private keys.
 */
import type { BrainEngine } from '../engine.ts';
import { scanText } from '../secret-scan.ts';
import { REDACTION_CONFIG_KEYS, parseRedactionClasses, redactionPolicy, type RedactionClass } from '../redaction-policy.ts';
import { resealSafeChunks } from './projections.ts';
import { PageRevisionConflictError } from './types.ts';

export interface RedactionResealResult {
  scanned: number;
  resealed: number;
  unchanged: number;
  superseded: number;
  failed: number;
  classes: RedactionClass[];
}

export interface RedactionProjectionState {
  /** Classes the chunks were last re-sealed with (empty before any re-seal). */
  sealed: RedactionClass[];
  /** Classes the policy names now. */
  wanted: RedactionClass[];
  pending: boolean;
}

const BATCH = 200;
const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x) => b.includes(x));

/** Compare the recorded seal with the policy; `pending` when the chunks were cut under a different class list. */
export async function redactionProjectionState(engine: Pick<BrainEngine, 'getConfig'>, wanted: readonly RedactionClass[] = redactionPolicy().projection): Promise<RedactionProjectionState> {
  const sealed = parseRedactionClasses(await engine.getConfig(REDACTION_CONFIG_KEYS.sealedProjection)) ?? [];
  return { sealed, wanted: [...wanted], pending: !same(sealed, wanted) };
}

/** Re-seal every page whose body the old or the new class list claims, then record the new list. */
export async function resealRedactionProjections(engine: BrainEngine, opts: { classes?: readonly RedactionClass[] } = {}): Promise<RedactionResealResult> {
  const classes = [...(opts.classes ?? redactionPolicy().projection)];
  const { sealed } = await redactionProjectionState(engine, classes);
  const union = [...new Set<RedactionClass>([...classes, ...sealed])];
  const result: RedactionResealResult = { scanned: 0, resealed: 0, unchanged: 0, superseded: 0, failed: 0, classes };
  if (union.length > 0) {
    let after = 0;
    for (;;) {
      const rows = await engine.executeRaw<{ id: number; source_id: string; slug: string; compiled_truth: string | null; timeline: string | null }>(
        `SELECT p.id, p.source_id, p.slug, p.compiled_truth, p.timeline FROM pages p
           JOIN sources s ON s.id = p.source_id AND s.archived IS NOT TRUE
          WHERE p.deleted_at IS NULL AND p.page_kind IN ('markdown','code') AND p.id > $1::bigint
          ORDER BY p.id LIMIT $2`, [after, BATCH]);
      if (rows.length === 0) break;
      for (const row of rows) {
        after = Number(row.id);
        result.scanned++;
        const body = `${row.compiled_truth ?? ''}\n${row.timeline ?? ''}`;
        if (scanText(body, { classes: union }).length === 0) { result.unchanged++; continue; }
        try {
          await engine.executeRaw('UPDATE pages SET text_projection_revision = NULL WHERE id = $1', [row.id]);
          if (await resealSafeChunks(engine, row.slug, row.source_id)) result.resealed++;
          else result.superseded++;
        } catch (error) {
          if (error instanceof PageRevisionConflictError) { result.superseded++; continue; }
          result.failed++;
          process.stderr.write(`[gbrain] Redaction re-chunk failed for ${row.source_id}:${row.slug}; its chunks stay withheld. `
            + `Re-run: gbrain config set ${REDACTION_CONFIG_KEYS.projection} ${classes.join(',') || 'none'}\n`);
        }
      }
      if (rows.length < BATCH) break;
    }
  }
  if (result.failed === 0) await engine.setConfig(REDACTION_CONFIG_KEYS.sealedProjection, classes.join(','));
  return result;
}
