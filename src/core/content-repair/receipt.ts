/**
 * #6377: what a slug-conflict repair records about one write, and the Git
 * subject and trailer of a repaired file.
 *
 * The receipt rides the write's durable outcome (`content_repair`): the
 * actor `content-repair`, the action written (`remove_slug` is the only one
 * that writes; a recommended merge or an undecidable pair writes nothing
 * and lives on the hold instead), the tier that decided it (`deterministic`
 * or `llm`) with its confidence (`high` for the deterministic rules, `medium`
 * for a model verdict), the model (llm only), the model spend and the sha256
 * of the bytes before and after. Hashes and codes only, so it is safe in
 * receipts, results and commit messages; `parseContentRepairReceipt` rejects
 * anything else before it reaches a write.
 */
export const CONTENT_REPAIR_ACTOR = 'content-repair';
export const CONTENT_REPAIR_HOLD_CODE = 'frontmatter_slug_conflict';

export interface ContentRepairReceipt {
  actor: typeof CONTENT_REPAIR_ACTOR;
  hold_code: typeof CONTENT_REPAIR_HOLD_CODE;
  action: 'remove_slug';
  tier: 'deterministic' | 'llm';
  confidence: 'high' | 'medium';
  /** The model that judged (llm tier); null for the deterministic tier. */
  model: string | null;
  /** Model spend for this file (USD); 0 for the deterministic tier, null for an unpriced model. */
  cost_usd: number | null;
  before_sha256: string;
  after_sha256: string;
}

const SHA = /^[0-9a-f]{64}$/;

/** A receipt as stored: well-formed or null, so a forged or damaged value never reaches a receipt or a commit message. */
export function parseContentRepairReceipt(value: unknown): ContentRepairReceipt | null {
  if (!value || typeof value !== 'object') return null;
  const r = value as Record<string, unknown>;
  if (r.actor !== CONTENT_REPAIR_ACTOR || r.hold_code !== CONTENT_REPAIR_HOLD_CODE || r.action !== 'remove_slug') return null;
  if (r.tier !== 'deterministic' && r.tier !== 'llm') return null;
  if (r.confidence !== 'high' && r.confidence !== 'medium') return null;
  if (r.model !== null && (typeof r.model !== 'string' || r.model.length > 200 || /[\r\n]/.test(r.model))) return null;
  if (r.cost_usd !== null && (typeof r.cost_usd !== 'number' || !Number.isFinite(r.cost_usd) || r.cost_usd < 0)) return null;
  if (typeof r.before_sha256 !== 'string' || !SHA.test(r.before_sha256) || typeof r.after_sha256 !== 'string' || !SHA.test(r.after_sha256)) return null;
  return { actor: CONTENT_REPAIR_ACTOR, hold_code: CONTENT_REPAIR_HOLD_CODE, action: 'remove_slug', tier: r.tier, confidence: r.confidence,
    model: r.model as string | null, cost_usd: r.cost_usd as number | null, before_sha256: r.before_sha256, after_sha256: r.after_sha256 };
}

/** `gbrain: repair frontmatter slug in <path>`, the subject of a repaired file's commit. */
export function contentRepairCommitSubject(path: string): string {
  return `gbrain: repair frontmatter slug in ${path.replace(/[\u0000-\u001f\u007f]/g, '?')}`;
}

/** `gbrain-repair: frontmatter_slug_conflict <tier> <confidence>`, the trailer every content-repair commit carries. */
export function contentRepairTrailer(receipt: Pick<ContentRepairReceipt, 'tier' | 'confidence'>): string {
  return `gbrain-repair: ${CONTENT_REPAIR_HOLD_CODE} ${receipt.tier} ${receipt.confidence}`;
}
