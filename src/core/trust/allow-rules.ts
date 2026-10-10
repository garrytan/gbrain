/**
 * Owner allow rules for the write gate (#5575: DX-14, ENG-20). A rule says
 * "content from this source (optionally under this server-stamped URI prefix,
 * optionally only for this reason family) is benign; stop quarantining it",
 * so recurring external content does not re-quarantine after every sync.
 *
 * Rules are local-only owner state (`gbrain trust allow`), receipted by their
 * own row (who added it, when, why; removal keeps the row with `removed_at`),
 * and listed in `gbrain trust review`. They match only server-stamped fields:
 * the `pages.source_id`, `pages.source_uri` and `pages.source_kind` columns the
 * write path records, never frontmatter an author controls.
 *
 * `matchTrustAllowRule` is pure so the gate (write-gate.ts) can call it with
 * rules it prefetched for a batch, without a database call in the screen.
 */
import type { BrainEngine } from '../engine.ts';
import type { Principal } from '../persistence/model.ts';
import { opError } from '../ops/contract.ts';
import { isValidSourceId } from '../source-id.ts';

/** The write gate's reason families (write-gate-patterns.ts); pinned equal by test/trust-channel-writes.test.ts. */
export const TRUST_ALLOW_REASON_FAMILIES = ['override', 'standing_instruction', 'exfiltration', 'credential'] as const;
export type TrustAllowReasonFamily = typeof TRUST_ALLOW_REASON_FAMILIES[number];

export const TRUST_ALLOW_RULES_SQL = `CREATE TABLE IF NOT EXISTS trust_allow_rules (
  id            BIGSERIAL PRIMARY KEY,
  source_id     TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  uri_prefix    TEXT CHECK (uri_prefix IS NULL OR (length(uri_prefix) BETWEEN 1 AND 2048)),
  reason_family TEXT CHECK (reason_family IS NULL OR reason_family IN (${TRUST_ALLOW_REASON_FAMILIES.map(f => `'${f}'`).join(',')})),
  created_by    TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  removed_at    TIMESTAMPTZ,
  removed_by    TEXT,
  reason        TEXT CHECK (reason IS NULL OR length(reason) <= 500)
);
CREATE INDEX IF NOT EXISTS trust_allow_rules_active_idx ON trust_allow_rules (source_id) WHERE removed_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS trust_allow_rules_active_unique ON trust_allow_rules
  (source_id, COALESCE(uri_prefix, ''), COALESCE(reason_family, '')) WHERE removed_at IS NULL;
`;

export interface TrustAllowRule {
  id: number;
  ref: string;
  source_id: string;
  uri_prefix: string | null;
  reason_family: TrustAllowReasonFamily | null;
  created_by: string;
  created_at: string;
  removed_at: string | null;
  removed_by: string | null;
  reason: string | null;
}

/** The typed ref of an allow rule. */
export const allowRuleRef = (id: number | string): string => `a${id}`;
export function parseAllowRuleRef(ref: string): number | null {
  const m = /^a?(\d{1,18})$/.exec(ref.trim());
  return m ? Number(m[1]) : null;
}

export const principalLabel = (principal: Principal | null | undefined): string => principal ? `${principal.kind}:${principal.id}` : 'host:unregistered';

export interface TrustAllowRuleInput {
  sourceId: string;
  uriPrefix?: string | null;
  reasonFamily?: string | null;
  reason?: string | null;
}

/** Validates a rule as the CLI or the owner IPC received it; returns the normalized fields. */
export function normalizeTrustAllowRule(input: TrustAllowRuleInput): { sourceId: string; uriPrefix: string | null; reasonFamily: TrustAllowReasonFamily | null; reason: string | null } {
  if (!isValidSourceId(input.sourceId)) {
    throw opError('invalid_params', 'trust allow needs --source <id> naming an active source.', 'Pass --source with a source id; gbrain sources list shows them.');
  }
  const uriPrefix = input.uriPrefix ?? null;
  if (uriPrefix !== null && (uriPrefix.length < 1 || uriPrefix.length > 2048 || /[\s\u0000-\u001f\u007f]/.test(uriPrefix))) {
    throw opError('invalid_params', '--uri-prefix must be 1 to 2048 characters with no whitespace or control characters.',
      'Pass the stored source URI prefix exactly, e.g. --uri-prefix https://calendar.example.com/; gbrain trust explain shows a page\'s source_uri.');
  }
  const reasonFamily = input.reasonFamily ?? null;
  if (reasonFamily !== null && !(TRUST_ALLOW_REASON_FAMILIES as readonly string[]).includes(reasonFamily)) {
    throw opError('invalid_params', `--reason-family must be one of ${TRUST_ALLOW_REASON_FAMILIES.join(', ')}.`,
      `Pass one of: ${TRUST_ALLOW_REASON_FAMILIES.join(', ')}, or omit it to allow every family from the source.`);
  }
  const reason = input.reason ?? null;
  if (reason !== null && reason.length > 500) throw opError('invalid_params', '--reason must be at most 500 characters.', 'Shorten --reason.');
  return { sourceId: input.sourceId, uriPrefix, reasonFamily: reasonFamily as TrustAllowReasonFamily | null, reason };
}

const iso = (value: unknown): string | null => value === null || value === undefined ? null : new Date(value as string).toISOString();
function normalize(r: Record<string, unknown>): TrustAllowRule {
  const id = Number(r.id);
  return {
    id, ref: allowRuleRef(id), source_id: String(r.source_id), uri_prefix: (r.uri_prefix as string | null) ?? null,
    reason_family: (r.reason_family as TrustAllowReasonFamily | null) ?? null, created_by: String(r.created_by),
    created_at: iso(r.created_at)!, removed_at: iso(r.removed_at), removed_by: (r.removed_by as string | null) ?? null,
    reason: (r.reason as string | null) ?? null,
  };
}

/** Adds a rule, or returns the active rule with the same (source, prefix, family). */
export async function addTrustAllowRule(engine: Pick<BrainEngine, 'executeRaw'>, input: TrustAllowRuleInput, by: Principal | null): Promise<{ rule: TrustAllowRule; created: boolean }> {
  const rule = normalizeTrustAllowRule(input);
  const [source] = await engine.executeRaw<{ id: string }>('SELECT id FROM sources WHERE id = $1 AND NOT archived', [rule.sourceId]);
  if (!source) {
    throw opError('invalid_params', `Source ${rule.sourceId} is not an active source on this brain.`, 'Pass --source with an active source id; gbrain sources list shows them.');
  }
  const [inserted] = await engine.executeRaw<Record<string, unknown>>(
    `INSERT INTO trust_allow_rules (source_id, uri_prefix, reason_family, created_by, reason) VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT DO NOTHING RETURNING *`, [rule.sourceId, rule.uriPrefix, rule.reasonFamily, principalLabel(by), rule.reason]);
  if (inserted) return { rule: normalize(inserted), created: true };
  const [existing] = await engine.executeRaw<Record<string, unknown>>(
    `SELECT * FROM trust_allow_rules WHERE removed_at IS NULL AND source_id = $1
       AND uri_prefix IS NOT DISTINCT FROM $2 AND reason_family IS NOT DISTINCT FROM $3 ORDER BY id LIMIT 1`,
    [rule.sourceId, rule.uriPrefix, rule.reasonFamily]);
  return { rule: normalize(existing!), created: false };
}

/** Marks a rule removed (the row stays as the receipt). Null when no active rule has that id. */
export async function removeTrustAllowRule(engine: Pick<BrainEngine, 'executeRaw'>, id: number, by: Principal | null): Promise<TrustAllowRule | null> {
  const [row] = await engine.executeRaw<Record<string, unknown>>(
    'UPDATE trust_allow_rules SET removed_at = now(), removed_by = $2 WHERE id = $1 AND removed_at IS NULL RETURNING *', [id, principalLabel(by)]);
  return row ? normalize(row) : null;
}

export async function getTrustAllowRule(engine: Pick<BrainEngine, 'executeRaw'>, id: number): Promise<TrustAllowRule | null> {
  const [row] = await engine.executeRaw<Record<string, unknown>>('SELECT * FROM trust_allow_rules WHERE id = $1', [id]);
  return row ? normalize(row) : null;
}

export async function listTrustAllowRules(engine: Pick<BrainEngine, 'executeRaw'>, opts: { sourceIds?: string[]; includeRemoved?: boolean } = {}): Promise<TrustAllowRule[]> {
  const rows = await engine.executeRaw<Record<string, unknown>>(
    `SELECT * FROM trust_allow_rules WHERE ($1::boolean OR removed_at IS NULL) AND ($2::text[] IS NULL OR source_id = ANY($2::text[])) ORDER BY id`,
    [opts.includeRemoved === true, opts.sourceIds?.length ? opts.sourceIds : null]);
  return rows.map(normalize);
}

/** The server-stamped fields of a write the gate assessed. Never frontmatter. */
export interface TrustAllowCandidate {
  sourceId: string;
  /** `pages.source_uri` as the write path stamped it (connector or capture URI), or null. */
  sourceUri: string | null;
  /** The reason families the gate flagged. */
  families: readonly string[];
}

/**
 * The active rules that cover every flagged family of the candidate, or null
 * when some family is not covered. A rule covers a family when it names that
 * family or no family; it applies when its source matches and its URI prefix
 * (if any) prefixes the server-stamped source URI. A candidate with no
 * families matches nothing (there is nothing to allow).
 */
export function matchTrustAllowRule(rules: readonly Pick<TrustAllowRule, 'id' | 'source_id' | 'uri_prefix' | 'reason_family' | 'removed_at'>[],
  candidate: TrustAllowCandidate): number[] | null {
  if (candidate.families.length === 0) return null;
  const applicable = rules.filter(rule => rule.removed_at === null && rule.source_id === candidate.sourceId
    && (rule.uri_prefix === null || (candidate.sourceUri !== null && candidate.sourceUri.startsWith(rule.uri_prefix))));
  const used = new Set<number>();
  for (const family of new Set(candidate.families)) {
    const cover = applicable.find(rule => rule.reason_family === null || rule.reason_family === family);
    if (!cover) return null;
    used.add(cover.id);
  }
  return [...used].sort((a, b) => a - b);
}

/**
 * DX-14: a gate verdict on content an owner allow rule covers (same source,
 * server-stamped URI prefix, every flagged reason family) becomes `allow`, so
 * recurring benign external content stops re-quarantining. Detector errors are
 * never allowed (fail-closed stays fail-closed). Rules are read once per write.
 */
export async function applyTrustAllowRules<T extends { verdict: string; families: readonly string[]; detectorError: boolean }>(
  engine: Pick<BrainEngine, 'executeRaw'>, assessment: T, write: { sourceId: string; sourceUri: string | null }): Promise<T> {
  if (assessment.verdict === 'allow' || assessment.detectorError || assessment.families.length === 0) return assessment;
  let rules: TrustAllowRule[];
  try { rules = await listTrustAllowRules(engine, { sourceIds: [write.sourceId] }); }
  catch { return assessment; }
  return matchTrustAllowRule(rules, { sourceId: write.sourceId, sourceUri: write.sourceUri, families: [...assessment.families] as never })
    ? { ...assessment, verdict: 'allow' } : assessment;
}
