/**
 * Runtime Query schema validator.
 *
 * Per the v1.1 eng pass 2 spec. Hand-rolled (no zod dep) to match existing
 * gbrain codebase style (see src/core/yaml-lite.ts for precedent).
 *
 * Validates:
 *   - Required fields (id, tier, text, expected_output_type, gold)
 *   - Tier enum
 *   - expected_output_type enum
 *   - Temporal `as_of_date` rule: any query with a temporal verb MUST
 *     set as_of_date to ISO-8601 | "corpus-end" | "per-source"
 *   - id uniqueness within a batch
 *   - gold.relevant structure when the expected_output_type is
 *     'cited-source-pages' (most common tier-1/2/3 pattern)
 *
 * Public functions:
 *   validateQuery(q)      -> ValidationResult single-query
 *   validateQuerySet(qs)  -> ValidationResult<batch>
 *
 * On failure, returns human-readable reasons with the offending query id
 * so `eval:query:validate` can point contributors at the exact problem.
 */

import type { Query, Tier, ExpectedOutputType } from '../types.ts';

// ─── Enums ─────────────────────────────────────────────────────────

const VALID_TIERS: readonly Tier[] = [
  'easy', 'medium', 'hard', 'adversarial', 'fuzzy', 'externally-authored',
] as const;

const VALID_OUTPUT_TYPES: readonly ExpectedOutputType[] = [
  'answer-string',
  'canonical-entity-id',
  'cited-source-pages',
  'time-qualified-answer',
  'abstention',
  'contradiction-explanation',
  'poison-flag',
  'confidence-score',
] as const;

// ─── Temporal rule (per eng pass 2) ────────────────────────────────

/**
 * Regex for detecting temporal verbs in query text. If any of these
 * appear, the query is temporal and MUST carry an `as_of_date` field.
 * Without that, scoring is ambiguous (which version of the fact is
 * considered correct?).
 */
export const TEMPORAL_VERBS =
  /\b(is|was|were|current|now|at the time|during|as of|when did)\b/i;

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}(T.*)?$/;

// ─── Types ─────────────────────────────────────────────────────────

export interface ValidationIssue {
  queryId: string;
  field: string;
  reason: string;
}

export interface ValidationResult {
  ok: boolean;
  issues: ValidationIssue[];
  /** Count of queries processed (for batch). 1 for single-query validation. */
  total: number;
}

// ─── Individual query validation ───────────────────────────────────

export function validateQuery(q: Query): ValidationResult {
  const issues: ValidationIssue[] = [];
  const qid = q.id || '(missing id)';

  if (!q.id || typeof q.id !== 'string' || q.id.trim().length === 0) {
    issues.push({ queryId: qid, field: 'id', reason: 'id must be a non-empty string (e.g. "q-0001")' });
  }
  if (!q.text || typeof q.text !== 'string' || q.text.trim().length === 0) {
    issues.push({ queryId: qid, field: 'text', reason: 'text must be a non-empty string' });
  }
  if (!VALID_TIERS.includes(q.tier)) {
    issues.push({ queryId: qid, field: 'tier', reason: `tier must be one of ${VALID_TIERS.join(', ')}` });
  }
  if (!VALID_OUTPUT_TYPES.includes(q.expected_output_type)) {
    issues.push({
      queryId: qid,
      field: 'expected_output_type',
      reason: `expected_output_type must be one of ${VALID_OUTPUT_TYPES.join(', ')}`,
    });
  }
  if (!q.gold || typeof q.gold !== 'object') {
    issues.push({ queryId: qid, field: 'gold', reason: 'gold must be an object' });
  }

  // Temporal as-of-date rule (eng pass 2).
  if (q.text && TEMPORAL_VERBS.test(q.text)) {
    if (q.as_of_date === undefined || q.as_of_date === null || q.as_of_date === '') {
      issues.push({
        queryId: qid,
        field: 'as_of_date',
        reason:
          'temporal verb detected; as_of_date required. Set to "corpus-end", "per-source", or an ISO-8601 date.',
      });
    } else if (
      q.as_of_date !== 'corpus-end' &&
      q.as_of_date !== 'per-source' &&
      !ISO_DATE_RE.test(q.as_of_date)
    ) {
      issues.push({
        queryId: qid,
        field: 'as_of_date',
        reason: 'as_of_date must be "corpus-end", "per-source", or ISO-8601 (YYYY-MM-DD)',
      });
    }
  }

  // If expected_output_type is cited-source-pages, gold.relevant should exist
  // and be a non-empty array of slug-like strings.
  if (q.expected_output_type === 'cited-source-pages') {
    const rel = (q.gold as Record<string, unknown>)?.relevant;
    if (!Array.isArray(rel) || rel.length === 0) {
      issues.push({
        queryId: qid,
        field: 'gold.relevant',
        reason: 'cited-source-pages queries require gold.relevant[] with at least one slug',
      });
    } else {
      for (const s of rel) {
        if (typeof s !== 'string' || !/^[a-z][a-z0-9-]*\/[a-z0-9][a-z0-9-]*$/.test(s)) {
          issues.push({
            queryId: qid,
            field: 'gold.relevant',
            reason: `slug "${s}" does not match "dir/slug" format (e.g. "people/alice-chen")`,
          });
          break; // one message per query is enough
        }
      }
    }
  }

  // Abstention queries MUST set expected_abstention to true.
  if (q.expected_output_type === 'abstention') {
    const expAb = (q.gold as Record<string, unknown>)?.expected_abstention;
    if (expAb !== true) {
      issues.push({
        queryId: qid,
        field: 'gold.expected_abstention',
        reason: 'abstention queries require gold.expected_abstention === true',
      });
    }
  }

  // Tier 5.5 externally-authored queries must carry an author field.
  if (q.tier === 'externally-authored') {
    if (!q.author || typeof q.author !== 'string' || q.author.trim().length === 0) {
      issues.push({
        queryId: qid,
        field: 'author',
        reason: 'externally-authored queries require an author field (e.g. "@alice-researcher" or "synthetic-outsider-v1")',
      });
    }
  }

  return { ok: issues.length === 0, issues, total: 1 };
}

// ─── Batch validation ───────────────────────────────────────────────

export function validateQuerySet(queries: Query[]): ValidationResult {
  const issues: ValidationIssue[] = [];
  const seenIds = new Set<string>();

  for (const q of queries) {
    const r = validateQuery(q);
    issues.push(...r.issues);

    // Duplicate ID check (batch-level).
    if (q.id) {
      if (seenIds.has(q.id)) {
        issues.push({ queryId: q.id, field: 'id', reason: 'duplicate id in batch' });
      }
      seenIds.add(q.id);
    }
  }

  return { ok: issues.length === 0, issues, total: queries.length };
}

// ─── Formatting helpers (for CLI output) ───────────────────────────

export function formatIssues(result: ValidationResult): string {
  if (result.ok) {
    return `\u2713 All ${result.total} queries valid.`;
  }
  const lines: string[] = [];
  lines.push(`\u2717 ${result.issues.length} issue(s) across ${result.total} query/queries:`);
  for (const issue of result.issues) {
    lines.push(`  [${issue.queryId}] ${issue.field}: ${issue.reason}`);
  }
  return lines.join('\n');
}
