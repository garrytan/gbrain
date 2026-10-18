/**
 * #6550 repair: `gbrain trust backfill --repair-unknown-markers` (local CLI only).
 *
 * Before v0.60.249.0 an agent edit of an unclassified legacy page stamped a
 * permanent `trust_tier: unknown` marker into its frontmatter. The backfill
 * later classified the row higher (it ignores an `unknown` marker), so the
 * next agent round trip carried the marker back, lowered the page to
 * unknown and filed a spurious `lower_page` item.
 *
 * Timing alone cannot prove a marker was accidental, so nothing here
 * classifies a page. The preview lists every live page whose marker is
 * `unknown` while its stored tier is higher, with the evidence for each:
 * - the first `page_versions` snapshot that shows the marker, placed before
 *   or after the brain first ran the fixed release (the release's own commit
 *   time is a hard lower bound; `upgrade-state.json` can name the upgrade);
 * - whether the page as first imported (its oldest kept version, or the
 *   page itself when it was never rewritten) already had the marker.
 * Pages whose evidence is consistent with the #6550 stamp are the ones the
 * printed apply command names; the rest are listed as ambiguous. Apply needs
 * the operator to name each page (`--slug`) and the preview hash (`--expect`),
 * and rewrites only those pages at their previewed revisions
 * (page-handlers.ts `repairPageMarker`): the marker becomes the stored tier
 * (none at owner tiers) and the row keeps its tier.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { BrainEngine } from '../engine.ts';
import { gbrainPath } from '../config.ts';
import { shellQuote } from '../agent-output.ts';
import { opError } from '../ops/contract.ts';
import { repairPageMarker, repairedMarker } from './page-handlers.ts';
import { trustProposalRef } from './proposals.ts';
import { pageRef } from './refs.ts';
import { storedTrustTier, type TrustTier } from './tier.ts';

export const TRUST_MARKER_REPAIR_COMMAND = ['gbrain', 'trust', 'backfill', '--repair-unknown-markers'] as const;
/** The first release whose agent edits no longer stamp `unknown` markers. */
export const UNKNOWN_MARKER_FIX_RELEASE = '0.60.249.0';
/** That release's commit time: no brain ran it earlier. */
export const UNKNOWN_MARKER_FIX_RELEASED_AT = '2026-10-15T17:34:32Z';

export interface FixedReleaseRun {
  version: string;
  /** When this brain's host first ran the fixed release, if `upgrade-state.json` records the upgrade into it. */
  first_run_at: string | null;
  basis: 'upgrade_state' | 'release_time';
}

export interface MarkerRepairCandidate {
  source_id: string;
  slug: string;
  page: string;
  revision: string;
  marker: 'unknown';
  stored_tier: TrustTier;
  /** The marker after a repair; null removes it (owner tiers carry none). */
  proposed_marker: TrustTier | null;
  /** The page's tier after a repair: unchanged. */
  proposed_tier: TrustTier;
  evidence: {
    first_marker_snapshot: { version_id: number; snapshot_at: string } | null;
    relative_to_fixed_release: 'before' | 'after' | 'unknown';
    in_original_import: boolean;
  };
  assessment: 'consistent_with_6550' | 'ambiguous';
  reasons: string[];
}

export interface MarkerRepairPreview {
  mode: 'preview';
  fixed_release: FixedReleaseRun;
  candidates: MarkerRepairCandidate[];
  /** Pages an agent edit already lowered to unknown through the marker: revert the item first, then preview again. */
  lowered: Array<{ page: string; ref: string; prior_tier: TrustTier; revert: string[] }>;
  preview_hash: string;
  /** Null when no page is a candidate. */
  apply_command: string[] | null;
}

export interface MarkerRepairApplied {
  mode: 'applied';
  repaired: Array<{ page: string; marker_before: 'unknown'; marker_after: TrustTier | null; tier: TrustTier }>;
  verify: string[];
}

/** The fixed release's first run on this host, from the recorded upgrade when it crossed the release. */
export async function fixedReleaseRun(): Promise<FixedReleaseRun> {
  const { compareReleases } = await import('../behavior-change-notice.ts');
  try {
    const state = JSON.parse(readFileSync(gbrainPath('upgrade-state.json'), 'utf8')) as { last_upgrade?: { from?: unknown; to?: unknown; ts?: unknown } };
    const { from, to, ts } = state.last_upgrade ?? {};
    if (typeof from === 'string' && typeof to === 'string' && typeof ts === 'string' && Number.isFinite(Date.parse(ts))
      && compareReleases(from, UNKNOWN_MARKER_FIX_RELEASE) < 0 && compareReleases(to, UNKNOWN_MARKER_FIX_RELEASE) >= 0) {
      return { version: UNKNOWN_MARKER_FIX_RELEASE, first_run_at: new Date(ts).toISOString(), basis: 'upgrade_state' };
    }
  } catch { /* no recorded upgrade: the release time still bounds the first run */ }
  return { version: UNKNOWN_MARKER_FIX_RELEASE, first_run_at: null, basis: 'release_time' };
}

function relativeTo(at: string, run: FixedReleaseRun): MarkerRepairCandidate['evidence']['relative_to_fixed_release'] {
  const ms = Date.parse(at);
  if (ms < Date.parse(UNKNOWN_MARKER_FIX_RELEASED_AT) || (run.first_run_at && ms < Date.parse(run.first_run_at))) return 'before';
  return run.first_run_at ? 'after' : 'unknown';
}

const markerSql = (fm: string) => `jsonb_typeof(${fm}->'trust_tier') = 'string' AND ${fm}->>'trust_tier' = 'unknown'`;

/** Read-only: the candidates, the lowered pages and the hash an apply binds to. */
export async function previewMarkerRepair(engine: BrainEngine, opts: { sourceId?: string | null } = {}): Promise<MarkerRepairPreview> {
  const run = await fixedReleaseRun();
  const rows = await engine.executeRaw<{ id: number; source_id: string; slug: string; trust_tier: string }>(
    `SELECT id, source_id, slug, trust_tier FROM pages
      WHERE deleted_at IS NULL AND ${markerSql('frontmatter')} AND trust_tier IS NOT NULL AND trust_tier <> 'unknown'
        AND ($1::text IS NULL OR source_id = $1) ORDER BY source_id, slug`, [opts.sourceId ?? null]);
  const candidates: MarkerRepairCandidate[] = [];
  for (const row of rows) {
    const snapshot = await engine.readPageSnapshot(row.slug, { sourceId: row.source_id });
    if (!snapshot) continue;
    const [first] = await engine.executeRaw<{ id: number; snapshot_at: string | Date }>(
      `SELECT id, snapshot_at FROM page_versions WHERE page_id = $1 AND ${markerSql('frontmatter')} ORDER BY id LIMIT 1`, [row.id]);
    const [oldest] = await engine.executeRaw<{ marked: boolean }>(
      `SELECT ${markerSql('frontmatter')} AS marked FROM page_versions WHERE page_id = $1 ORDER BY id LIMIT 1`, [row.id]);
    const firstSnapshot = first ? { version_id: Number(first.id), snapshot_at: new Date(first.snapshot_at).toISOString() } : null;
    const relative = firstSnapshot ? relativeTo(firstSnapshot.snapshot_at, run) : 'unknown';
    const inOriginal = oldest ? oldest.marked === true : true;
    const reasons: string[] = [];
    if (inOriginal) reasons.push(oldest ? 'the page as first imported already had the marker (likely deliberate)' : 'the page was never rewritten, so the marker was in it from the start (likely deliberate)');
    if (!firstSnapshot) reasons.push('no saved version shows when the marker appeared');
    else if (relative === 'after') reasons.push('the marker first shows after this brain first ran the fixed release');
    else if (relative === 'unknown') reasons.push('no recorded upgrade shows whether the marker predates the fixed release on this brain');
    const stored = storedTrustTier(row.trust_tier);
    candidates.push({
      source_id: row.source_id, slug: row.slug, page: pageRef(row.source_id, row.slug), revision: snapshot.revision, marker: 'unknown',
      stored_tier: stored, proposed_marker: repairedMarker(stored), proposed_tier: stored,
      evidence: { first_marker_snapshot: firstSnapshot, relative_to_fixed_release: relative, in_original_import: inOriginal },
      assessment: reasons.length ? 'ambiguous' : 'consistent_with_6550',
      reasons: reasons.length ? reasons : ['a version before the fixed release shows the marker, and the page as first imported did not have it'],
    });
  }
  const lowered = (await engine.executeRaw<{ id: number; source_id: string; slug: string; prior_tier: string }>(
    `SELECT tp.id, p.source_id, p.slug, tp.before_state->>'prior_tier' AS prior_tier FROM trust_proposals tp JOIN pages p ON p.id = tp.target_id
      WHERE tp.status = 'pending' AND tp.action = 'lower_page' AND tp.target_table = 'pages' AND p.deleted_at IS NULL
        AND p.trust_tier = 'unknown' AND ${markerSql('p.frontmatter')} AND COALESCE(tp.before_state->>'prior_tier', 'unknown') <> 'unknown'
        AND ($1::text IS NULL OR p.source_id = $1) ORDER BY p.source_id, p.slug`, [opts.sourceId ?? null]))
    .map(r => ({ page: pageRef(r.source_id, r.slug), ref: trustProposalRef(Number(r.id)), prior_tier: storedTrustTier(r.prior_tier), revert: ['gbrain', 'trust', 'revert', trustProposalRef(Number(r.id))] }));
  const preview_hash = `mr_${createHash('sha256').update(JSON.stringify(candidates.map(c => [c.source_id, c.slug, c.revision, c.stored_tier]))).digest('hex').slice(0, 16)}`;
  const named = candidates.filter(c => c.assessment === 'consistent_with_6550');
  const apply_command = candidates.length === 0 ? null : [...TRUST_MARKER_REPAIR_COMMAND, ...(opts.sourceId ? ['--source', opts.sourceId] : []),
    ...(named.length ? named.flatMap(c => ['--slug', c.slug]) : ['--slug', '<SLUG>']), '--expect', preview_hash];
  return { mode: 'preview', fixed_release: run, candidates, lowered, preview_hash, apply_command };
}

/** Rewrites the markers of exactly the named pages, when the preview still hashes to `expect`. */
export async function applyMarkerRepair(engine: BrainEngine, opts: { slugs: readonly string[]; expect: string; sourceId?: string | null }): Promise<MarkerRepairApplied> {
  const preview = await previewMarkerRepair(engine, { sourceId: opts.sourceId });
  const again = shellQuote([...TRUST_MARKER_REPAIR_COMMAND, ...(opts.sourceId ? ['--source', opts.sourceId] : [])]);
  if (preview.preview_hash !== opts.expect) {
    throw opError('preview_changed', `The marker-repair candidates changed since the preview you approved (${opts.expect}, now ${preview.preview_hash}); nothing was changed.`,
      `Run ${again} again and name the pages from the new preview.`);
  }
  const pages = [...new Set(opts.slugs)].map(slug => {
    const matches = preview.candidates.filter(c => c.slug === slug);
    if (matches.length !== 1) {
      throw opError('invalid_params', matches.length ? `${slug} is a candidate in ${matches.length} sources; nothing was changed.` : `${slug} is not in the marker-repair preview; nothing was changed.`,
        matches.length ? `Pass --source with the page's source (${matches.map(m => m.source_id).join(', ')}).` : `Name only pages the preview lists (${again}).`);
    }
    return matches[0]!;
  });
  const repaired: MarkerRepairApplied['repaired'] = [];
  for (const page of pages) {
    const result = await repairPageMarker(engine, { sourceId: page.source_id, slug: page.slug, expectedRevision: page.revision, confirmation: { via: 'preview_hash' } });
    repaired.push({ page: page.page, marker_before: 'unknown', marker_after: result.marker, tier: result.tier });
  }
  return { mode: 'applied', repaired, verify: [...TRUST_MARKER_REPAIR_COMMAND, ...(opts.sourceId ? ['--source', opts.sourceId] : [])] };
}

/** The human preview; it always ends with the exact apply command. */
export function renderMarkerRepairPreview(preview: MarkerRepairPreview): string {
  const run = preview.fixed_release;
  const lines = [`Pages whose trust_tier marker is "unknown" while their stored tier is higher (#6550). Nothing was changed.`,
    `Fixed release ${run.version}: ${run.first_run_at ? `this host upgraded into it at ${run.first_run_at}` : `released ${UNKNOWN_MARKER_FIX_RELEASED_AT}; no recorded upgrade names when this host first ran it`}.`];
  for (const group of ['consistent_with_6550', 'ambiguous'] as const) {
    const items = preview.candidates.filter(c => c.assessment === group);
    if (!items.length) continue;
    lines.push('', group === 'consistent_with_6550' ? 'Consistent with the #6550 stamp (named in the apply command):' : 'Ambiguous (repair only a page you judge accidental; add its --slug):');
    for (const c of items) {
      const snap = c.evidence.first_marker_snapshot;
      lines.push(`  ${c.slug}  marker unknown, stored ${c.stored_tier}, proposed ${c.proposed_marker ? `marker ${c.proposed_marker}` : 'no marker'} (tier stays ${c.proposed_tier})`,
        `      evidence: ${snap ? `first version with the marker v${snap.version_id} at ${snap.snapshot_at} (${c.evidence.relative_to_fixed_release} the fixed release)` : 'no version shows the marker'}; in the page as first imported: ${c.evidence.in_original_import ? 'yes' : 'no'}`,
        `      ${c.reasons.join('; ')}`);
    }
  }
  if (!preview.candidates.length) lines.push('', 'No page has an "unknown" marker below its stored tier, so there is nothing to repair.');
  if (preview.lowered.length) {
    lines.push('', 'Already lowered to "unknown" through the marker (revert the item, then run this preview again):');
    for (const l of preview.lowered) lines.push(`  ${l.page}  was ${l.prior_tier}: ${shellQuote(l.revert)}`);
  }
  if (preview.apply_command) lines.push('', `Preview hash: ${preview.preview_hash}`, `Apply with: ${shellQuote(preview.apply_command)}`);
  return lines.join('\n');
}
