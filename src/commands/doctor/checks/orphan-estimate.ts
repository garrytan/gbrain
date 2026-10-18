/**
 * #6696 B1: `orphan_ratio` without the full anti-join on large brains.
 *
 * The full scan (`findOrphans`: every live page against both link directions)
 * takes most of a default doctor run on a 61k-page brain. Above
 * `doctor.orphan_ratio.full_scan_max_pages` live pages (default 50,000) the
 * standard tier estimates the ratio from a `TABLESAMPLE SYSTEM` page sample of
 * about `SAMPLE_TARGET` pages, with the same islanded predicate (no live inbound
 * and no live outbound link), the same quarantine flag, slug exclusions and
 * connector-render exclusion; `--tier deep` runs the full scan.
 */
import type { BrainEngine } from '../../../core/engine.ts';
import { loadOrphanPolicyOverrides } from '../../../core/orphan-policy.ts';
import { quarantineFilterFragment } from '../../../core/quarantine.ts';
import { CONNECTOR_RENDER_TYPES, loadConnectorSourceIds, shouldExclude } from '../../orphans.ts';

export const ORPHAN_FULL_SCAN_KEY = 'doctor.orphan_ratio.full_scan_max_pages';
export const ORPHAN_FULL_SCAN_MAX_PAGES_DEFAULT = 50_000;
export const SAMPLE_TARGET = 2000;

/** The live-page cutoff above which the standard tier estimates (a positive integer config value, else the default). */
export async function orphanFullScanMaxPages(engine: BrainEngine): Promise<number> {
  const raw = await engine.getConfig(ORPHAN_FULL_SCAN_KEY).catch(() => null);
  const n = raw === null ? NaN : Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : ORPHAN_FULL_SCAN_MAX_PAGES_DEFAULT;
}

export async function countLivePages(engine: BrainEngine, sourceId?: string): Promise<number> {
  const rows = await engine.executeRaw<{ n: string }>(`SELECT count(*)::text AS n FROM pages WHERE deleted_at IS NULL${sourceId ? ' AND source_id = $1' : ''}`,
    sourceId ? [sourceId] : []);
  return Number(rows[0]?.n ?? 0);
}

export interface OrphanEstimate {
  ratio: number;
  sample_pages: number;
  sample_linkable: number;
  sample_orphans: number;
  sample_percent: number;
  live_pages: number;
}

export async function estimateOrphanRatio(engine: BrainEngine, livePages: number, sourceId?: string): Promise<OrphanEstimate> {
  const percent = Math.min(100, Math.max(0.01, (SAMPLE_TARGET / Math.max(livePages, 1)) * 100));
  const rows = await engine.executeRaw<{ slug: string; type: string | null; source_id: string; quarantined: boolean; islanded: boolean }>(
    `SELECT p.slug, p.type, p.source_id, (NOT ${quarantineFilterFragment('p')}) AS quarantined,
            (NOT EXISTS (SELECT 1 FROM links l JOIN pages src ON src.id = l.from_page_id WHERE l.to_page_id = p.id AND src.deleted_at IS NULL)
             AND NOT EXISTS (SELECT 1 FROM links l JOIN pages tgt ON tgt.id = l.to_page_id WHERE l.from_page_id = p.id AND tgt.deleted_at IS NULL)) AS islanded
       FROM pages p TABLESAMPLE SYSTEM (${percent.toFixed(4)})
      WHERE p.deleted_at IS NULL${sourceId ? ' AND p.source_id = $1' : ''}`,
    sourceId ? [sourceId] : []);
  const overrides = await loadOrphanPolicyOverrides(engine);
  const connectors = await loadConnectorSourceIds(engine);
  const linkable = rows.filter((r) => !shouldExclude(r.slug, overrides, r) && !(connectors.has(r.source_id) && !!r.type && CONNECTOR_RENDER_TYPES.has(r.type)));
  const orphans = linkable.filter((r) => r.islanded).length;
  return { ratio: linkable.length ? orphans / linkable.length : 0, sample_pages: rows.length, sample_linkable: linkable.length, sample_orphans: orphans,
    sample_percent: Number(percent.toFixed(4)), live_pages: livePages };
}
