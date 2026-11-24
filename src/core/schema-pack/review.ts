// v0.39 T4 — gbrain schema review-candidates + T5 review-orphans.
//
// Per D3(eng) + codex finding #10: review-candidates re-derives candidate
// names from disk on demand instead of reading the privacy-redacted
// candidate-audit JSONL. Preserves the SHA-8 type-name redaction contract
// for the audit (therapy/adversary/hater-dossier categories) while still
// giving the CLI human-readable type names.
//
// The CLI surface (src/commands/schema.ts:runReviewCandidatesCmd) makes
// this EXPLICIT: every output starts with "Disk-derived candidates from
// current brain state" so users understand what they're reviewing.

import type { BrainEngine } from '../engine.ts';
import { runDetect } from './detect.ts';
import { loadActivePack } from './load-active.ts';
import { loadActivePackForLocalEngine } from './best-effort.ts';
import { storedTypeMissesPack, type TypeUsagePack } from './type-usage.ts';
import { loadConfig, gbrainPath, configPath } from '../config.ts';
import { existsSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface ReviewCandidatesOpts {
  sourceId?: string;
  /** When set, promote this prefix to the active pack as a new page_type. */
  applySlug?: string;
}

export interface CandidateReview {
  prefix: string;
  page_count: number;
  suggested_type: string;
  in_active_pack: boolean;
}

export interface ReviewCandidatesResult {
  candidates: CandidateReview[];
  applied: string | null;
  source_id: string;
}

export async function runReviewCandidates(
  engine: BrainEngine,
  opts: ReviewCandidatesOpts = {},
): Promise<ReviewCandidatesResult> {
  const sourceId = opts.sourceId ?? 'default';
  const detected = await runDetect(engine, { sourceId });
  const cfg = loadConfig();
  let activeTypeNames = new Set<string>();
  let activePackName = 'gbrain-base';
  try {
    const pack = await loadActivePack({ cfg, remote: false, sourceId });
    activePackName = pack.manifest.name;
    activeTypeNames = new Set(pack.manifest.page_types.map((t) => t.name));
  } catch {
    // Active pack load failure: fall through with empty active set.
  }

  const candidates: CandidateReview[] = detected.prefixes
    .filter((p) => !activeTypeNames.has(p.suggested_type))
    .map((p) => ({
      prefix: p.prefix,
      page_count: p.page_count,
      suggested_type: p.suggested_type,
      in_active_pack: false,
    }));

  let applied: string | null = null;
  if (opts.applySlug) {
    const match = candidates.find((c) => c.prefix === opts.applySlug || c.suggested_type === opts.applySlug);
    if (!match) {
      throw new Error(`--apply target not found in current candidate set: ${opts.applySlug}`);
    }
    // Append the new type to a USER pack derived from the active pack.
    // For v0.39.0.0 the simplest correct path is: write a delta file under
    // ~/.gbrain/schema-pack-deltas/<active>-<timestamp>.json so users can
    // review + merge into their pack via `gbrain schema edit`.
    const deltaDir = gbrainPath('schema-pack-deltas');
    mkdirSync(deltaDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const deltaPath = `${deltaDir}/${activePackName}-${ts}.json`;
    writeFileSync(deltaPath, JSON.stringify({
      schema_version: 1,
      active_pack: activePackName,
      added_at: new Date().toISOString(),
      delta: {
        page_types: [{
          name: match.suggested_type,
          primitive: 'entity',
          path_prefixes: [match.prefix],
          aliases: [],
          extractable: false,
          expert_routing: false,
        }],
      },
      source_id: sourceId,
    }, null, 2));
    applied = deltaPath;
  }

  return { candidates, applied, source_id: sourceId };
}

// ----- T5 review-orphans ------------------------------------------

export interface TypeOrphan {
  slug: string;
  source_id: string;
  /** Stored `pages.type` ('' when untyped). */
  type: string;
  reason: 'untyped' | 'undeclared';
}

export interface TypeOrphansResult {
  /** Every page in scope with no active-pack type match (not just the returned page). */
  orphan_count: number;
  orphans: TypeOrphan[];
  /** Stored types the pack neither declares nor aliases, with page counts. */
  undeclared_types: Array<{ type: string; count: number }>;
  /** Active pack name, or null when no pack resolved (only untyped pages are then checked). */
  pack: string | null;
  /** True when orphan_count exceeds the returned orphans. */
  truncated: boolean;
}

/**
 * Pages with no active-pack type match: an empty type, or a type the pack
 * neither declares nor aliases (`storedTypeMissesPack`, the same predicate as
 * `schema lint --with-db`'s `stored_type_undeclared`). Shared by the
 * `schema review-orphans` CLI and the `schema_review_orphans` MCP op.
 */
export async function findTypeOrphans(
  engine: BrainEngine,
  manifest: (TypeUsagePack & { name: string }) | null,
  scope: { sourceId?: string; sourceIds?: string[] },
  limit: number,
): Promise<TypeOrphansResult> {
  const typeRows = await engine.countLivePagesByType(scope);
  const missing = typeRows.filter((r) => (manifest ? storedTypeMissesPack(r.type, manifest) : !r.type));
  const undeclared = missing
    .filter((r): r is { type: string; n: string } => !!r.type)
    .map((r) => ({ type: r.type, count: Number(r.n) }))
    .sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
  const orphanCount = missing.reduce((sum, r) => sum + Number(r.n), 0);
  if (orphanCount === 0) {
    return { orphan_count: 0, orphans: [], undeclared_types: [], pack: manifest?.name ?? null, truncated: false };
  }
  const rowLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 100;
  const rows = await engine.listTypeOrphanRows(scope, undeclared.map((u) => u.type), rowLimit);
  return {
    orphan_count: orphanCount,
    orphans: rows.map((r) => ({
      slug: r.slug,
      source_id: r.source_id,
      type: r.type ?? '',
      reason: r.type ? 'undeclared' : 'untyped',
    })),
    undeclared_types: undeclared,
    pack: manifest?.name ?? null,
    truncated: orphanCount > rows.length,
  };
}

export interface ReviewOrphansOpts {
  sourceId?: string;
}

export interface ReviewOrphansResult extends TypeOrphansResult {
  source_id: string;
}

export async function runReviewOrphans(
  engine: BrainEngine,
  opts: ReviewOrphansOpts = {},
): Promise<ReviewOrphansResult> {
  const sourceId = opts.sourceId ?? 'default';
  const pack = await loadActivePackForLocalEngine(engine, { sourceId });
  const result = await findTypeOrphans(engine, pack?.manifest ?? null, { sourceId }, 1000);
  return { ...result, source_id: sourceId };
}
