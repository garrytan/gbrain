/**
 * #6188: what a fence repair (Tier 2 resolver or Tier 3 model) records about
 * one write, and the Git commit subject of a repaired file.
 *
 * The receipt rides the write's durable outcome (`fence_repair`): the actor
 * `fence-repair`, the tier, the fix classes with their rows and columns, the
 * model (Tier 3 only), the sha256 of the bytes before and after, and the
 * model spend. Location and hashes only: never a claim, holder or any other
 * cell value, so it is safe in receipts, results and commit messages.
 */
import type { FenceTier } from './types.ts';

export const FENCE_REPAIR_ACTOR = 'fence-repair';

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
  return { actor: FENCE_REPAIR_ACTOR, tier: r.tier as FenceRepairReceipt['tier'], classes: [...r.classes as string[]], rows: [...r.rows as number[]],
    columns: [...r.columns as string[]], model: r.model as string | null, before_sha256: r.before_sha256, after_sha256: r.after_sha256, cost_usd: r.cost_usd as number | null };
}

/** `gbrain: repair fence in <path> (<classes>)`, the subject of a repaired file's commit. */
export function fenceRepairCommitSubject(path: string, classes: readonly string[]): string {
  return `gbrain: repair fence in ${path.replace(/[\u0000-\u001f\u007f]/g, '?')} (${classes.join(', ')})`;
}
