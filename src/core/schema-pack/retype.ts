// v0.42 Type Unification Cathedral — runRetypeCore primitive.
//
// Mirrors `runSyncCore` chunked UPDATE pattern at sync.ts:102-149. 1000-row
// batches; idempotent WHERE (already-retyped rows excluded); per-batch
// progress; max-iteration safety net.
//
// What's different from runSyncCore:
//   - Targets pages with a SPECIFIC from_type (not NULL/empty type)
//   - Sets BOTH `pages.type` AND `pages.frontmatter` (subtype stamp via
//     jsonb_set) in a single UPDATE
//   - Always writes `frontmatter.legacy_type = <from_type>` for per-page
//     rollback (D8). For rule-driven legacy_type (cluster 8: civic→note
//     with legacy_type=civic), the subtype value supplies the legacy_type
//     directly via subtype_field='legacy_type'.
//   - Special sentinel `from_type: '*unknown*'` is the catch-all (D12)
//     that fires LAST and retypes any page whose type isn't declared in
//     page_types AND isn't the target of any prior retype rule. Substitutes
//     the original type as the subtype value via `subtype: '*original_type*'`.
//   - subtype_field validated against ALLOWED_SUBTYPE_FIELDS allowlist (D9)
//     at runtime (defense-in-depth; pack-load also rejects).
//
// Codex C5: write-side source scoping. Mutations use caller's sourceId
// directly, NOT sourceScopeOpts (read federation).
//
// PGLite + Postgres parity via `executeRaw`.

import type { BrainEngine } from '../engine.ts';
import type { OperationContext } from '../operations.ts';
import { loadActivePackBestEffort } from './best-effort.ts';
import { ALLOWED_SUBTYPE_FIELDS, type AllowedSubtypeField } from './manifest-v1.ts';

/** Sentinel: `from_type: '*unknown*'` matches every page whose type isn't
 *  declared in the pack's page_types AND isn't the target of any prior
 *  explicit retype rule (D12 catch-all). */
export const UNKNOWN_TYPE_SENTINEL = '*unknown*' as const;

/** Sentinel: `subtype: '*original_type*'` substitutes the page's actual
 *  pre-retype type as the subtype value. Only meaningful inside the
 *  catch-all retype rule. */
export const ORIGINAL_TYPE_SENTINEL = '*original_type*' as const;

export interface RetypeRule {
  from_type: string;
  to_type: string;
  /** Subtype value to stamp into frontmatter[subtype_field]. Optional. */
  subtype?: string;
  /** Frontmatter key for the subtype stamp. Default 'subtype'. Validated
   *  against ALLOWED_SUBTYPE_FIELDS to block third-party-pack injection of
   *  load-bearing keys (title, slug, type). */
  subtype_field?: AllowedSubtypeField;
  /** Optional source_path LIKE filter for disambiguation. */
  path_filter?: string;
}

export interface RetypeOpts {
  rules: RetypeRule[];
  /** Apply UPDATE statements. Default false (dry-run). */
  apply?: boolean;
  /** Source ID to scope (codex C5 write-side). Omit for whole-brain. */
  sourceId?: string;
  /** Per-batch row cap. Default 1000. */
  batchSize?: number;
  /** Progress callback fired per batch. */
  onProgress?: (info: {
    rule_index: number;
    appliedSoFar: number;
    ruleTotal: number;
  }) => void;
}

export interface PerRuleResult {
  rule_index: number;
  from_type: string;
  to_type: string;
  subtype?: string;
  /** Pages matching from_type at dry-run time. */
  would_apply: number;
  /** Sample of slugs (capped at 10) for the agent's drilldown. */
  sample_slugs: string[];
  /** Rows actually updated. 0 on dry-run. */
  applied: number;
}

export interface RetypeResult {
  schema_version: 1;
  apply: boolean;
  pack_identity: string | null;
  per_rule: PerRuleResult[];
  total_would_apply: number;
  total_applied: number;
}

/**
 * Validate subtype_field against ALLOWED_SUBTYPE_FIELDS. Defense-in-depth
 * (pack-load also rejects per D9 + manifest schema). Throws on violation
 * so a malformed mapping_rule fed via test fixtures or bypass paths
 * doesn't silently overwrite `title` / `slug` / `type`.
 */
function assertSubtypeFieldAllowed(field: string): asserts field is AllowedSubtypeField {
  if (!ALLOWED_SUBTYPE_FIELDS.includes(field as AllowedSubtypeField)) {
    throw new Error(
      `[runRetypeCore] subtype_field '${field}' not in ALLOWED_SUBTYPE_FIELDS ` +
      `(${ALLOWED_SUBTYPE_FIELDS.join(', ')}). Third-party packs cannot inject ` +
      `arbitrary frontmatter keys via mapping_rules.`,
    );
  }
}

/**
 * Count + sample pages matching from_type. Used by both dry-run + apply
 * (apply's count drives onProgress.ruleTotal).
 */
async function probeRule(
  engine: BrainEngine,
  fromType: string,
  pathFilter: string | undefined,
  sourceId: string | undefined,
): Promise<{ count: number; sample: string[] }> {
  // The catch-all sentinel uses a special "not in pack types" probe; for now
  // the runRetypeCore catch-all path is handled by the caller as a separate
  // codepath (pack-aware), and probeRule operates on literal from_type only.
  if (fromType === UNKNOWN_TYPE_SENTINEL) {
    // Caller should handle catch-all separately; refuse here to surface bugs.
    throw new Error(`[runRetypeCore] catch-all sentinel '${UNKNOWN_TYPE_SENTINEL}' must be handled by the caller via runCatchAllRetype`);
  }
  let where = `WHERE deleted_at IS NULL AND type = $1`;
  const params: unknown[] = [fromType];
  if (pathFilter) {
    where += ` AND source_path LIKE $${params.length + 1}`;
    params.push(pathFilter);
  }
  if (sourceId) {
    where += ` AND source_id = $${params.length + 1}`;
    params.push(sourceId);
  }
  const cntRows = await engine.executeRaw<{ cnt: string }>(
    `SELECT COUNT(*)::text AS cnt FROM pages ${where}`,
    params,
  );
  const count = parseInt(cntRows[0]?.cnt ?? '0', 10) || 0;
  if (count === 0) return { count: 0, sample: [] };
  const sampleRows = await engine.executeRaw<{ slug: string }>(
    `SELECT slug FROM pages ${where} ORDER BY slug LIMIT 10`,
    params,
  );
  return { count, sample: sampleRows.map((r) => r.slug) };
}

/**
 * Apply a single retype rule in chunked UPDATEs. Returns total rows updated.
 * Idempotent: WHERE `type = from_type` excludes already-retyped rows.
 */
async function applyRetypeRule(
  engine: BrainEngine,
  rule: RetypeRule,
  sourceId: string | undefined,
  batchSize: number,
  ruleIndex: number,
  ruleTotal: number,
  onProgress?: RetypeOpts['onProgress'],
): Promise<number> {
  const subtypeField = (rule.subtype_field ?? 'subtype') as AllowedSubtypeField;
  assertSubtypeFieldAllowed(subtypeField);
  const subtype = rule.subtype;
  // Always write legacy_type per D8 (unless the rule's subtype_field IS
  // legacy_type, in which case the subtype value supplies legacy_type
  // directly and we don't double-write).
  const writeLegacyType = subtypeField !== 'legacy_type';

  let totalApplied = 0;
  for (let i = 0; i < 10000; i++) {
    // Build the WHERE with sourceId + path_filter params first; then the
    // UPDATE-side params at the end (to + subtype + subtype_field +
    // legacy_type stamp).
    const winWhereParts: string[] = [`deleted_at IS NULL`, `type = $1`];
    const winParams: unknown[] = [rule.from_type];
    if (rule.path_filter) {
      winWhereParts.push(`source_path LIKE $${winParams.length + 1}`);
      winParams.push(rule.path_filter);
    }
    if (sourceId) {
      winWhereParts.push(`source_id = $${winParams.length + 1}`);
      winParams.push(sourceId);
    }
    winParams.push(batchSize); // $N+1 → LIMIT placeholder
    const limitPlaceholder = `$${winParams.length}`;

    // Outer SET clause. JSONB layering:
    //   COALESCE(frontmatter, '{}') → starting object
    //   if subtype: jsonb_set(..., ARRAY[subtype_field], to_jsonb(subtype))
    //   if writeLegacyType: jsonb_set(..., ARRAY['legacy_type'], to_jsonb(from_type))
    const fmExpr = buildFrontmatterExpr(subtype, subtypeField, writeLegacyType);

    const allParams = [...winParams, rule.to_type];
    if (subtype !== undefined) allParams.push(subtype);
    if (writeLegacyType) allParams.push(rule.from_type);

    const toPlaceholder = `$${winParams.length + 1}`;
    let subtypePlaceholder: string | undefined;
    let legacyTypePlaceholder: string | undefined;
    if (subtype !== undefined) {
      subtypePlaceholder = `$${winParams.length + 2}`;
    }
    if (writeLegacyType) {
      legacyTypePlaceholder = subtype !== undefined
        ? `$${winParams.length + 3}`
        : `$${winParams.length + 2}`;
    }

    // subtype_field name is interpolated as a SQL string literal (validated
    // by assertSubtypeFieldAllowed → no injection surface).
    const setExpr = fmExpr({
      toPlaceholder,
      subtypePlaceholder,
      legacyTypePlaceholder,
      subtypeFieldLiteral: subtypeField,
    });

    const sqlText = `
      WITH win AS (
        SELECT id FROM pages
        WHERE ${winWhereParts.join(' AND ')}
        LIMIT ${limitPlaceholder}
      ),
      upd AS (
        UPDATE pages
           SET type = ${toPlaceholder},
               frontmatter = ${setExpr},
               updated_at = now()
         WHERE id IN (SELECT id FROM win)
        RETURNING 1
      )
      SELECT COUNT(*)::text AS updated FROM upd
    `;
    try {
      const rows = await engine.executeRaw<{ updated: string }>(sqlText, allParams);
      const batchCount = parseInt(rows[0]?.updated ?? '0', 10) || 0;
      if (batchCount === 0) break;
      totalApplied += batchCount;
      onProgress?.({ rule_index: ruleIndex, appliedSoFar: totalApplied, ruleTotal });
      if (batchCount < batchSize) break;
    } catch (e) {
      throw new Error(
        `retype rule[${ruleIndex}] ${rule.from_type}→${rule.to_type} failed: ${(e as Error).message}`,
      );
    }
  }
  return totalApplied;
}

/**
 * Build the per-row frontmatter SET expression. Returns a function that
 * takes the SQL placeholder strings (allocated by the caller based on
 * which optional fields are present) and produces the jsonb_set chain.
 */
function buildFrontmatterExpr(
  subtype: string | undefined,
  subtypeField: AllowedSubtypeField,
  writeLegacyType: boolean,
): (refs: {
  toPlaceholder: string;
  subtypePlaceholder: string | undefined;
  legacyTypePlaceholder: string | undefined;
  subtypeFieldLiteral: string;
}) => string {
  return (refs) => {
    let expr = `COALESCE(frontmatter, '{}'::jsonb)`;
    if (subtype !== undefined && refs.subtypePlaceholder) {
      // subtype_field is the column-name-style literal; build the
      // ARRAY['<literal>'] in SQL string form. Safe because subtypeField
      // is whitelisted by ALLOWED_SUBTYPE_FIELDS.
      expr = `jsonb_set(${expr}, ARRAY['${refs.subtypeFieldLiteral}'], to_jsonb(${refs.subtypePlaceholder}::text), true)`;
    }
    if (writeLegacyType && refs.legacyTypePlaceholder) {
      expr = `jsonb_set(${expr}, ARRAY['legacy_type'], to_jsonb(${refs.legacyTypePlaceholder}::text), true)`;
    }
    return expr;
  };
}

/**
 * Pure core for the unify-types Minion handler's retype phase. Pack
 * identity is captured at start for audit replay; per-rule results
 * include sample_slugs for the agent's drilldown.
 *
 * For the catch-all sentinel rule (from_type === '*unknown*'): caller
 * should expand to one synthesized rule per actual unknown type. See
 * `runCatchAllRetype` in the unify-types handler.
 */
export async function runRetypeCore(
  ctx: OperationContext,
  opts: RetypeOpts,
): Promise<RetypeResult> {
  const apply = opts.apply === true;
  const batchSize = Math.max(1, Math.min(10000, opts.batchSize ?? 1000));
  const sourceId = opts.sourceId;

  const pack = await loadActivePackBestEffort(ctx);

  const per_rule: PerRuleResult[] = [];
  let total_would_apply = 0;
  let total_applied = 0;

  for (let i = 0; i < opts.rules.length; i++) {
    const rule = opts.rules[i];
    if (rule.from_type === UNKNOWN_TYPE_SENTINEL) {
      // Caller (unify-types handler) handles catch-all separately by
      // expanding to one rule per actual unknown type before invoking
      // runRetypeCore. The sentinel should not reach here.
      throw new Error(`[runRetypeCore] catch-all sentinel must be expanded by caller before invocation (rule index ${i})`);
    }
    const { count: would_apply, sample: sample_slugs } = await probeRule(
      ctx.engine,
      rule.from_type,
      rule.path_filter,
      sourceId,
    );
    let applied = 0;
    if (apply && would_apply > 0) {
      applied = await applyRetypeRule(
        ctx.engine,
        rule,
        sourceId,
        batchSize,
        i,
        would_apply,
        opts.onProgress,
      );
    }
    per_rule.push({
      rule_index: i,
      from_type: rule.from_type,
      to_type: rule.to_type,
      subtype: rule.subtype,
      would_apply,
      sample_slugs,
      applied,
    });
    total_would_apply += would_apply;
    total_applied += applied;
  }

  return {
    schema_version: 1,
    apply,
    pack_identity: pack ? pack.identity : null,
    per_rule,
    total_would_apply,
    total_applied,
  };
}
