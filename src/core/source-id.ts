/**
 * src/core/source-id.ts — single canonical source_id validation.
 *
 * Dependency-free by design (no imports beyond TS stdlib). Imported by both
 * engines, cycle, source-resolver, sources-ops, and any future site that
 * needs to validate a source_id. Pre-v0.38 the regex was duplicated across
 * three files (`utils.ts` had a permissive variant; `sources-ops.ts` and
 * `source-resolver.ts` had the strict variant). Codex outside-voice flagged
 * the drift; this module is the consolidation.
 *
 * **Canonical regex (strict):** `^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$`
 *
 * Rules enforced:
 *   - 1-32 characters
 *   - lowercase alphanumeric only (no underscores, no dots, no slashes)
 *   - interior hyphens allowed
 *   - first and last character must be alphanumeric (no edge hyphens)
 *
 * Single-character source IDs like `a` or `1` are valid. Underscored ids
 * like `my_source` are rejected even though they passed the legacy
 * permissive regex — `sources-ops` always rejected them at creation time,
 * so no existing source IDs break.
 *
 * **Exports two validators:**
 *   - `isValidSourceId(s)`: boolean — for tiers that silently fall back
 *     to the next resolution step on invalid input (dotfile, brain_default).
 *   - `assertValidSourceId(s)`: void, throws — for tiers that must reject
 *     invalid input loudly (explicit `--source` flag, `GBRAIN_SOURCE` env,
 *     `cycleLockIdFor` primitive defense-in-depth).
 *
 * Codex P1-F flagged the need for both shapes.
 */

export const SOURCE_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;

/** Returns true if the string matches the canonical source_id regex. */
export function isValidSourceId(s: unknown): s is string {
  return typeof s === 'string' && SOURCE_ID_RE.test(s);
}

/**
 * Throws if the input doesn't match the canonical source_id regex.
 * Error message includes the offending value (JSON-stringified for
 * non-string types so debugging weird input is fast).
 */
export function assertValidSourceId(s: unknown): asserts s is string {
  if (!isValidSourceId(s)) {
    throw new Error(
      `Invalid source_id: ${JSON.stringify(s)}. ` +
      `Must be 1-32 lowercase alnum chars with optional interior hyphens ` +
      `(matches ${SOURCE_ID_RE}).`,
    );
  }
}

/**
 * Normalize the optional `source` field of an `/admin/api/register-client`
 * request body into a write source_id.
 *
 * Mirrors the CLI's `--source` flag. Returns the literal `'default'` when the
 * field is omitted (`undefined`/`null`) so every caller that doesn't send
 * `source` keeps landing on source_id='default' (the pre-source HTTP
 * register-client behavior). A present-but-invalid value throws (via
 * `assertValidSourceId`) so the route can surface a structured 400 instead of
 * failing at INSERT time.
 */
export function normalizeSourceInput(raw: unknown): string {
  if (raw === undefined || raw === null) return 'default';
  assertValidSourceId(raw);
  return raw;
}

/**
 * Normalize the optional `federatedRead` field of an
 * `/admin/api/register-client` request body into a source_id array, or
 * `undefined` when omitted.
 *
 * Mirrors the CLI's `--federated-read` flag. `undefined`/`null` → `undefined`
 * so `registerClientManual` applies its own default (`[sourceId]`, a
 * non-federated client whose read scope equals its write scope). A present
 * value must be a non-empty array whose every element is a valid source_id;
 * anything else throws for a structured 400.
 */
export function normalizeFederatedReadInput(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(
      `Invalid federatedRead: ${JSON.stringify(raw)}. ` +
      `Must be a non-empty array of source_ids.`,
    );
  }
  for (const s of raw) assertValidSourceId(s);
  return raw as string[];
}
