/**
 * v0.32.2 — forget-as-fence path (Codex R2-#3).
 *
 * Before v0.32.2 `gbrain forget` and the MCP `forget_fact` op called
 * `engine.expireFact(id)` directly, which UPDATEs `facts.expired_at`
 * in the DB. After `gbrain rebuild` (v0.32.3) that DB-only mutation
 * would evaporate because the canonical markdown fence is unchanged
 * — the forget would un-happen.
 *
 * The fix: forget becomes a fence rewrite. Strike through the target
 * row's `claim` cell, set its `valid_until` to today, append
 * `forgotten: <reason>` to its `context` cell. The DB's existing
 * `expired_at = valid_until + now()` rule reconstructs the forget
 * state on every rebuild because the fence is canonical.
 *
 * Strikethrough parse contract (extends commit 2's two-mode design):
 *   `~~claim~~` + `context: superseded by #N`    → supersededBy=N
 *   `~~claim~~` + `context: forgotten: <reason>` → forgotten=true
 *   `~~claim~~` + anything else                  → active=false; the
 *      mapper treats this as forgotten for DB-derivation purposes.
 *
 * Two-tier fallback for cross-state safety:
 *   1. If the target row has v51 columns (row_num + source_markdown_slug
 *      + sources.local_path), do the fence rewrite. The forget survives
 *      rebuild.
 *   2. If any of those is missing (pre-v51 legacy row, NULL entity_slug,
 *      no local_path on the source), fall through to the legacy
 *      `engine.expireFact(id)` direct-DB path. A once-per-process
 *      stderr warning names the case so operators see the degraded
 *      mode. These forgets DO NOT survive rebuild — the architecture
 *      doc names this as the explicit DB-only exception for legacy
 *      / thin-client state.
 */

import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

import type { BrainEngine } from '../engine.ts';
import { withPageLock } from '../page-lock.ts';
import { parseFactsFence, renderFactsTable, type ParsedFact } from '../facts-fence.ts';

export interface ForgetFactResult {
  /** True iff the row was found AND a forget was applied (fence or DB). */
  ok: boolean;
  /** Discriminator on the path that handled the forget. */
  path: 'fence' | 'legacy_db' | 'not_found' | 'already_expired';
  /** Human-readable reason captured in `context`; mirrors back what was written. */
  reason: string;
}

interface FactDbRow {
  id: string;
  source_id: string;
  entity_slug: string | null;
  row_num: number | null;
  source_markdown_slug: string | null;
  expired_at: Date | null;
}

interface SourceRow {
  id: string;
  local_path: string | null;
}

/** Format today's date as 'YYYY-MM-DD' UTC. Matches extract-from-fence's helper. */
function todayUtc(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()))
    .toISOString().slice(0, 10);
}

/**
 * Forget a fact by id. Routes through the fence when the row carries
 * v51 columns + the source has a local_path; falls through to legacy
 * `expireFact` otherwise. Idempotent: returns `already_expired` when
 * the row's `expired_at` is already non-null.
 *
 * Reason defaults to `'forgotten'` when the caller doesn't provide one
 * (matches the existing `gbrain forget` CLI which takes no reason
 * argument). MCP `forget_fact` op can pass a more specific reason
 * when the user provides it.
 */
export async function forgetFactInFence(
  engine: BrainEngine,
  factId: number,
  opts: { reason?: string } = {},
): Promise<ForgetFactResult> {
  const reason = opts.reason ?? 'forgotten';

  const rows = await engine.executeRaw<FactDbRow>(
    `SELECT id, source_id, entity_slug, row_num, source_markdown_slug, expired_at
       FROM facts WHERE id = $1`,
    [factId],
  );
  if (rows.length === 0) {
    return { ok: false, path: 'not_found', reason };
  }
  const row = rows[0];

  if (row.expired_at !== null) {
    return { ok: false, path: 'already_expired', reason };
  }

  // Fence path requires: v51 columns set + source.local_path set.
  const canFence =
    row.row_num !== null &&
    row.source_markdown_slug !== null &&
    row.entity_slug !== null;

  if (!canFence) {
    // Legacy path — DB-only forget. Doesn't survive `gbrain rebuild`.
    const ok = await engine.expireFact(factId); // gbrain-allow-direct-insert: legacy fallback path inside forgetFactInFence — fence rewrite not possible (pre-v51 row / missing local_path / file deleted / row_num drift)
    return { ok, path: 'legacy_db', reason };
  }

  // Look up source.local_path.
  const sources = await engine.executeRaw<SourceRow>(
    `SELECT id, local_path FROM sources WHERE id = $1 LIMIT 1`,
    [row.source_id],
  );
  const localPath = sources[0]?.local_path ?? null;
  if (!localPath) {
    const ok = await engine.expireFact(factId); // gbrain-allow-direct-insert: legacy fallback path inside forgetFactInFence — fence rewrite not possible (pre-v51 row / missing local_path / file deleted / row_num drift)
    return { ok, path: 'legacy_db', reason };
  }

  const slug = row.source_markdown_slug!;
  const targetRowNum = row.row_num!;
  const filePath = join(localPath, `${slug}.md`);
  const tmpPath = `${filePath}.tmp`;

  if (!existsSync(filePath)) {
    // File deleted out from under us — only the DB has the row.
    // Legacy path is the safe behavior; the operator can fix the
    // tree mismatch separately.
    const ok = await engine.expireFact(factId); // gbrain-allow-direct-insert: legacy fallback path inside forgetFactInFence — fence rewrite not possible (pre-v51 row / missing local_path / file deleted / row_num drift)
    return { ok, path: 'legacy_db', reason };
  }

  return withPageLock(slug, async () => {
    const body = readFileSync(filePath, 'utf-8');
    const parsed = parseFactsFence(body);

    // Find the target row in the fence by row_num.
    const target = parsed.facts.find(f => f.rowNum === targetRowNum);
    if (!target) {
      // Fence is missing the row — DB drifted from markdown. Fall
      // through to legacy expire so the user's intent succeeds; doctor
      // surfaces the drift separately.
      const ok = await engine.expireFact(factId); // gbrain-allow-direct-insert: legacy fallback path inside forgetFactInFence — fence rewrite not possible (pre-v51 row / missing local_path / file deleted / row_num drift)
      return { ok, path: 'legacy_db', reason };
    }

    // Mutate: strike out claim (already-strikethrough rows stay
    // strikethrough), set valid_until = today, append "forgotten:
    // <reason>" to context (preserving any existing context).
    const today = todayUtc();
    const existingContext = target.context?.trim() ?? '';
    const newContext = existingContext
      ? `${existingContext} | forgotten: ${reason}`
      : `forgotten: ${reason}`;

    const updated: ParsedFact[] = parsed.facts.map(f =>
      f.rowNum === targetRowNum
        ? {
            ...f,
            active: false,        // strikethrough on render
            validUntil: today,
            context: newContext,
            forgotten: true,
          }
        : f,
    );

    // Render + atomic .tmp + parse-validate + rename.
    const newFence = renderFactsTable(updated);
    const begin = body.indexOf('<!--- gbrain:facts:begin -->');
    const end   = body.indexOf('<!--- gbrain:facts:end -->', begin + 1);
    if (begin === -1 || end === -1) {
      // Race / corruption: fence disappeared between parse and render.
      // Legacy fallback.
      const ok = await engine.expireFact(factId); // gbrain-allow-direct-insert: legacy fallback path inside forgetFactInFence — fence rewrite not possible (pre-v51 row / missing local_path / file deleted / row_num drift)
      return { ok, path: 'legacy_db', reason };
    }
    const newBody = body.slice(0, begin) + newFence + body.slice(end + '<!--- gbrain:facts:end -->'.length);

    writeFileSync(tmpPath, newBody, 'utf-8');
    const tmpBody = readFileSync(tmpPath, 'utf-8');
    const validate = parseFactsFence(tmpBody);
    if (validate.warnings.length > 0) {
      // Quarantine .tmp; leave the canonical file alone; fall back to
      // DB expire so the user's forget intent still succeeds.
      const ok = await engine.expireFact(factId); // gbrain-allow-direct-insert: legacy fallback path inside forgetFactInFence — fence rewrite not possible (pre-v51 row / missing local_path / file deleted / row_num drift)
      return { ok, path: 'legacy_db', reason };
    }
    renameSync(tmpPath, filePath);

    // Stamp the DB to match: valid_until = today, expired_at = now().
    // This keeps DB query patterns (active facts WHERE expired_at IS NULL)
    // accurate the moment the forget commits, without waiting for the
    // next extract_facts cycle phase to reconcile.
    await engine.executeRaw(
      `UPDATE facts SET valid_until = $1, expired_at = now()
       WHERE id = $2 AND expired_at IS NULL`,
      [today, factId],
    );

    return { ok: true, path: 'fence', reason };
  }, { timeoutMs: 5_000 });
}
