// v0.42.63 — frontmatter-field filter: op-boundary validator + shared SQL
// compiler for the `frontmatter_filter` param on `search` / `query` /
// `list_pages`.
//
// One module, two exports, both engines:
//   - parseFrontmatterFilterParam() runs at the op boundary (operations.ts)
//     and validates shape loudly — invalid input throws, never silently
//     returns an empty result set.
//   - compileFrontmatterFilter() is the ONE predicate→SQL compiler both
//     engines call (postgres-engine + pglite-engine, search + listPages
//     paths) so the SQL shape cannot drift between engines.
//
// Injection control is PARAMETER BINDING, not validate-then-interpolate:
// every key and value is pushed onto the caller's positional params array
// and referenced as `$N`. The only text spliced into SQL is the
// engine-supplied column expression (e.g. 'p.frontmatter') and operators
// from the whitelists below. The conservative key charset check in the
// validator is defense-in-depth on top of that, not the control.
//
// Operator semantics (per the U1 design):
//   eq       → `column @> $N::text::jsonb` — GIN-accelerated containment
//              against idx_pages_frontmatter (default jsonb_ops). The
//              param binds as text and the cast parses it — the sanctioned
//              positional jsonb bind (see docs/ENGINES.md; a raw-string
//              bind to `$N::jsonb` is the #2339 double-encode class).
//              Type-sensitive: eq value 5 matches jsonb number 5, not "5".
//   exists   → `column ? $N` (jsonb key-exists operator).
//   missing  → `NOT (column ? $N)`.
//   lt/lte/
//   gt/gte   → `(column ->> $K::text) <op> $V::text` — text comparison,
//              unindexed. Correct for ISO-8601 date strings (lexicographic
//              == chronological); arbitrary numbers compare as text.
//
// Predicates AND together.

export type FrontmatterFilterOp = 'eq' | 'exists' | 'missing' | 'lt' | 'lte' | 'gt' | 'gte';

export interface FrontmatterPredicate {
  /** Frontmatter field name (top-level key). Conservative identifier charset. */
  key: string;
  op: FrontmatterFilterOp;
  /**
   * Required scalar for eq (string|number|boolean) and the comparisons
   * (string|number). Must be absent for exists/missing.
   */
  value?: string | number | boolean;
}

export const FRONTMATTER_FILTER_OPS: ReadonlySet<string> = new Set([
  'eq', 'exists', 'missing', 'lt', 'lte', 'gt', 'gte',
]);

/**
 * SQL comparison-operator whitelist for lt/lte/gt/gte. Exported for the
 * postgres.js tagged-template path (listPages), which splices the operator
 * via `sql.unsafe()` — safe because the value comes from THIS map, keyed by
 * the validated op enum (same pattern as PAGE_SORT_SQL).
 */
export const FRONTMATTER_CMP_SQL: Readonly<Record<'lt' | 'lte' | 'gt' | 'gte', string>> = {
  lt: '<',
  lte: '<=',
  gt: '>',
  gte: '>=',
};

/** Conservative key charset: alnum/underscore start, then alnum . _ - ; max 128. */
const KEY_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

/** Bound the predicate count so a remote caller can't inflate the SQL. */
const MAX_PREDICATES = 32;

function fail(msg: string): never {
  throw new Error(
    `Invalid frontmatter_filter: ${msg}. Expected an array of ` +
    `{key, op, value?} predicates with op in {eq, exists, missing, lt, lte, gt, gte}; ` +
    `value is required for eq/lt/lte/gt/gte and must be absent for exists/missing.`,
  );
}

/**
 * Op-boundary validator. Accepts the MCP shape (array of predicate
 * objects) or the CLI shape (JSON string of the same array). Returns
 * undefined for absent/empty input; throws a loud Error on anything
 * malformed — a filtered query must never silently degrade to unfiltered.
 */
export function parseFrontmatterFilterParam(raw: unknown): FrontmatterPredicate[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  let input: unknown = raw;
  if (typeof input === 'string') {
    if (input.trim() === '') return undefined;
    try {
      input = JSON.parse(input);
    } catch {
      fail('not valid JSON');
    }
  }
  return validateFrontmatterPredicates(input);
}

/** Validate an already-parsed value into FrontmatterPredicate[]. Throws on invalid. */
export function validateFrontmatterPredicates(input: unknown): FrontmatterPredicate[] | undefined {
  if (!Array.isArray(input)) fail('expected an array of predicates');
  if (input.length === 0) return undefined;
  if (input.length > MAX_PREDICATES) fail(`too many predicates (max ${MAX_PREDICATES})`);

  const out: FrontmatterPredicate[] = [];
  for (const entry of input) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      fail('each predicate must be an object');
    }
    const { key, op, value } = entry as Record<string, unknown>;
    if (typeof key !== 'string' || !KEY_RE.test(key)) {
      fail(`bad key ${JSON.stringify(key)} (allowed: letters, digits, _ . - ; max 128 chars, no leading . or -)`);
    }
    if (typeof op !== 'string' || !FRONTMATTER_FILTER_OPS.has(op)) {
      fail(`unknown op ${JSON.stringify(op)}`);
    }
    if (op === 'exists' || op === 'missing') {
      if (value !== undefined) fail(`op '${op}' takes no value (got ${JSON.stringify(value)})`);
      out.push({ key, op });
      continue;
    }
    if (op === 'eq') {
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
        fail(`op 'eq' requires a scalar value (string|number|boolean), got ${JSON.stringify(value)}`);
      }
      out.push({ key, op, value });
      continue;
    }
    // lt / lte / gt / gte
    if (typeof value !== 'string' && typeof value !== 'number') {
      fail(`op '${op}' requires a string or number value, got ${JSON.stringify(value)}`);
    }
    out.push({ key, op: op as FrontmatterFilterOp, value });
  }
  return out;
}

/**
 * Compile predicates into positional-SQL condition strings, pushing bound
 * params onto `params` (the engines' shared pattern: push, then reference
 * `$${params.length}`). Returns one condition string per predicate — the
 * caller joins/prefixes with AND in its own dialect. Empty input → [].
 *
 * `column` is an ENGINE-SUPPLIED literal (e.g. 'p.frontmatter'), never
 * user input.
 */
export function compileFrontmatterFilter(
  predicates: readonly FrontmatterPredicate[] | undefined,
  params: unknown[],
  column: string,
): string[] {
  if (!predicates || predicates.length === 0) return [];
  const out: string[] = [];
  for (const pred of predicates) {
    switch (pred.op) {
      case 'eq': {
        // Bind the containment object as TEXT and let the cast parse it —
        // `$N::text::jsonb` is the sanctioned positional jsonb bind (a bare
        // `$N::jsonb` with a stringified param double-encodes on postgres.js).
        params.push(JSON.stringify({ [pred.key]: pred.value }));
        out.push(`${column} @> $${params.length}::text::jsonb`);
        break;
      }
      case 'exists': {
        params.push(pred.key);
        out.push(`${column} ? $${params.length}::text`);
        break;
      }
      case 'missing': {
        params.push(pred.key);
        out.push(`NOT (${column} ? $${params.length}::text)`);
        break;
      }
      case 'lt':
      case 'lte':
      case 'gt':
      case 'gte': {
        const cmp = FRONTMATTER_CMP_SQL[pred.op];
        params.push(pred.key);
        const keyIdx = params.length;
        params.push(String(pred.value));
        out.push(`(${column} ->> $${keyIdx}::text) ${cmp} $${params.length}::text`);
        break;
      }
      default:
        // Unreachable when input came through the validator; loud for
        // direct engine callers that bypass it.
        fail(`unknown op ${JSON.stringify((pred as { op?: unknown }).op)}`);
    }
  }
  return out;
}
