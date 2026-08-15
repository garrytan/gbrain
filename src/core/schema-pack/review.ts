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

export interface ReviewOrphansOpts {
  sourceId?: string;
}

export interface ReviewOrphansResult {
  orphans: Array<{ slug: string; source_id: string }>;
  orphan_count: number;
  source_id: string;
}

export async function runReviewOrphans(
  engine: BrainEngine,
  opts: ReviewOrphansOpts = {},
): Promise<ReviewOrphansResult> {
  const sourceId = opts.sourceId ?? 'default';
  const rows = await engine.executeRaw<{ slug: string; source_id: string }>(
    `SELECT slug, source_id FROM pages
     WHERE source_id = $1
       AND deleted_at IS NULL
       AND (type IS NULL OR type = '')
     ORDER BY slug
     LIMIT 1000`,
    [sourceId],
  );
  return {
    orphans: rows.map((r) => ({ slug: r.slug, source_id: r.source_id })),
    orphan_count: rows.length,
    source_id: sourceId,
  };
}
