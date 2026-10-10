/**
 * #6188: what a fence repair (Tier 2 resolver or Tier 3 model) records about
 * one write, and the Git commit subject of a repaired file.
 *
 * The receipt rides the write's durable outcome (`fence_repair`): the actor
 * `fence-repair`, the tier, the fix classes with their rows and columns, the
 * model (Tier 3 only), the sha256 of the bytes before and after, the model
 * spend and, for a `merge_fences` repair (#6377), where every before row
 * went. Location and hashes only: never a claim, holder or any other cell
 * value, so it is safe in receipts, results and commit messages.
 */
import type { FenceKind, FenceSection, FenceTier } from './types.ts';

export const FENCE_REPAIR_ACTOR = 'fence-repair';

/** One fence `merge_fences` built: every before row by fence index and occurrence, and where it went. */
export interface MergedFenceReceipt {
  fence: FenceKind;
  section: FenceSection;
  /** How many fences of the kind the section held. */
  fences: number;
  rows: Array<{
    /** The row's occurrence in the fence it came from. */
    occurrence: number;
    /** Index of that fence in document order (0 is the primary). */
    from_fence: number;
    /** Occurrence in the merged fence. */
    kept_as?: number;
    /** Merged-fence occurrence of the kept row this exact duplicate equalled. */
    duplicate_of?: number;
  }>;
}

/** Most rows one merged fence records (an 85-row fence is the case this was built for). */
export const MERGED_ROWS_MAX = 2000;

export interface FenceRepairReceipt {
  actor: typeof FENCE_REPAIR_ACTOR;
  tier: Exclude<FenceTier, 'manual'>;
  /** Fix classes and Tier 3 residual reasons the write cleared, sorted. */
  classes: string[];
  rows: number[];
  columns: string[];
  /** The model that rewrote rows (Tier 3); null for the free tiers. */
  model: string | null;
  before_sha256: string;
  after_sha256: string;
  /** Model spend for this page (USD); 0 for the free tiers, null for an unpriced model. */
  cost_usd: number | null;
  /** Where every row of each merged fence went (`merge_fences`); absent otherwise. */
  merged?: MergedFenceReceipt[];
}

const CLASS = /^[a-z_]{1,40}$/;
const SHA = /^[0-9a-f]{64}$/;

/** A receipt as stored: well-formed or null, so a forged or damaged value never reaches a receipt or a commit message. */
export function parseFenceRepairReceipt(value: unknown): FenceRepairReceipt | null {
  if (!value || typeof value !== 'object') return null;
  const r = value as Record<string, unknown>;
  const tiers = ['deterministic', 'resolver', 'llm'];
  if (r.actor !== FENCE_REPAIR_ACTOR || !tiers.includes(String(r.tier))) return null;
  if (!Array.isArray(r.classes) || !r.classes.length || r.classes.length > 40 || !r.classes.every(c => typeof c === 'string' && CLASS.test(c))) return null;
  if (!Array.isArray(r.rows) || r.rows.length > 200 || !r.rows.every(n => Number.isSafeInteger(n) && (n as number) >= 0)) return null;
  if (!Array.isArray(r.columns) || r.columns.length > 40 || !r.columns.every(c => typeof c === 'string' && /^[#a-z_]{1,20}$/.test(c))) return null;
  if (r.model !== null && (typeof r.model !== 'string' || r.model.length > 200 || /[\r\n]/.test(r.model))) return null;
  if (typeof r.before_sha256 !== 'string' || !SHA.test(r.before_sha256) || typeof r.after_sha256 !== 'string' || !SHA.test(r.after_sha256)) return null;
  if (r.cost_usd !== null && (typeof r.cost_usd !== 'number' || !Number.isFinite(r.cost_usd) || r.cost_usd < 0)) return null;
  const merged = r.merged === undefined ? undefined : parseMerged(r.merged);
  if (merged === null) return null;
  return { actor: FENCE_REPAIR_ACTOR, tier: r.tier as FenceRepairReceipt['tier'], classes: [...r.classes as string[]], rows: [...r.rows as number[]],
    columns: [...r.columns as string[]], model: r.model as string | null, before_sha256: r.before_sha256, after_sha256: r.after_sha256, cost_usd: r.cost_usd as number | null,
    ...(merged ? { merged } : {}) };
}

const index = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 0;

/** The `merged` entries: at most one per fence and section, each row sent to exactly one of `kept_as` / `duplicate_of`. */
function parseMerged(value: unknown): MergedFenceReceipt[] | null {
  if (!Array.isArray(value) || value.length > 4) return null;
  const out: MergedFenceReceipt[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') return null;
    const e = entry as Record<string, unknown>;
    if ((e.fence !== 'facts' && e.fence !== 'takes') || (e.section !== 'body' && e.section !== 'timeline')) return null;
    if (out.some(o => o.fence === e.fence && o.section === e.section)) return null;
    if (!index(e.fences) || e.fences < 2 || !Array.isArray(e.rows) || e.rows.length > MERGED_ROWS_MAX) return null;
    const rows: MergedFenceReceipt['rows'] = [];
    for (const row of e.rows) {
      if (!row || typeof row !== 'object') return null;
      const m = row as Record<string, unknown>;
      if (!index(m.occurrence) || !index(m.from_fence) || m.from_fence >= e.fences) return null;
      if ((m.kept_as === undefined) === (m.duplicate_of === undefined)) return null;
      if (m.kept_as !== undefined && !index(m.kept_as)) return null;
      if (m.duplicate_of !== undefined && !index(m.duplicate_of)) return null;
      rows.push({ occurrence: m.occurrence, from_fence: m.from_fence, ...(m.kept_as !== undefined ? { kept_as: m.kept_as } : { duplicate_of: m.duplicate_of as number }) });
    }
    out.push({ fence: e.fence, section: e.section, fences: e.fences, rows });
  }
  return out;
}

/** `gbrain: repair fence in <path> (<classes>)`, the subject of a repaired file's commit. */
export function fenceRepairCommitSubject(path: string, classes: readonly string[]): string {
  return `gbrain: repair fence in ${path.replace(/[\u0000-\u001f\u007f]/g, '?')} (${classes.join(', ')})`;
}
