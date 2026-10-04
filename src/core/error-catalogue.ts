/**
 * Error catalogue for coded refusals (fix wave 5, DX-O2 / ENG-O12).
 *
 * One entry per refusal: the stable wire `code` and the docs anchor that
 * explains it. Every entry's anchor must exist in its guide; the doc test
 * (`test/error-catalogue.test.ts`) resolves each `docs` against the Markdown
 * headings and `<a id>` tags, so a renamed heading fails CI instead of
 * leaving a dead link in an error.
 *
 * Wire mapping: an `OperationError` carries the hint as `suggestion` and the
 * anchor as `docs` (its `toJSON()` serializes both for CLI `--json` and MCP);
 * a CLI-only refusal may use a `StructuredError`, which names them `hint` and
 * `docs_url`. `/ingest` renders an `OperationError` as
 * `{ error, message, hint, docs_url }`.
 *
 * Entries are keyed by name, not code, so one code can carry two anchors:
 * `legacy_job_authority` keeps the existing `permission_denied` code and adds
 * its own anchor. Add a refusal by adding one entry and its doc heading.
 */
import { OperationError } from './ops/contract.ts';
import { StructuredAgentError, buildError } from './errors.ts';
import { CODES, type CodeEntry, type RegistryCode } from './error-registry.ts';
import type { ErrorClass } from './agent-output.ts';

export { CODES, type CodeEntry, type RegistryCode } from './error-registry.ts';

export interface CatalogueEntry {
  /** Stable machine-readable code on the wire. */
  code: string;
  /** Repository-relative docs pointer, `docs/guides/<guide>.md#<anchor>`. */
  docs: string;
}

export const ERROR_CATALOGUE = {
  legacy_jobs_active: { code: 'legacy_jobs_active', docs: 'docs/guides/repair.md#legacy-jobs-active' },
  legacy_job_selection_invalid: { code: 'legacy_job_selection_invalid', docs: 'docs/guides/repair.md#legacy-job-selection-invalid' },
  legacy_job_authority: { code: 'permission_denied', docs: 'docs/guides/repair.md#legacy-job-authority' },
  preview_changed: { code: 'preview_changed', docs: 'docs/guides/repair.md#preview-changed' },
  projection_owner_resident: { code: 'projection_owner_resident', docs: 'docs/guides/repair.md#projection-owner-resident' },
  explicit_kind_required: { code: 'explicit_kind_required', docs: 'docs/guides/repair.md#explicit-only-repair-kinds' },
  repair_kind_unavailable: { code: 'unavailable', docs: 'docs/guides/repair.md#explicit-only-repair-kinds' },
  colon_slug_windows_write_through: { code: 'colon_slug_windows_write_through', docs: 'docs/guides/write-refusals.md#colon_slug_windows_write_through' },
  embedding_auth_failed: { code: 'embedding_auth_failed', docs: 'docs/guides/write-refusals.md#embedding_auth_failed' },
  activation_source_path_missing: { code: 'source_changed', docs: 'docs/guides/write-refusals.md#activation_source_path_missing' },
  facts_absorb_write_refused: { code: 'facts_absorb_write_refused', docs: 'docs/guides/write-refusals.md#facts_absorb_write_refused' },
  source_checkout_missing: { code: 'recovery_required', docs: 'docs/guides/write-refusals.md#source_checkout_missing' },
  managed_pull_skipped: { code: 'managed_pull_skipped', docs: 'docs/guides/write-refusals.md#managed_pull_skipped' },
  no_pricing: { code: 'no_pricing', docs: 'docs/guides/write-refusals.md#no_pricing' },
  // F0 `gbrain sources refresh` (worktree-wide coordinated ff-only refresh).
  refresh_not_managed: { code: 'refresh_not_managed', docs: 'docs/guides/write-refusals.md#refresh_not_managed' },
  refresh_not_owner: { code: 'refresh_not_owner', docs: 'docs/guides/write-refusals.md#refresh_not_owner' },
  refresh_no_upstream: { code: 'refresh_no_upstream', docs: 'docs/guides/write-refusals.md#refresh_no_upstream' },
  fetch_failed: { code: 'fetch_failed', docs: 'docs/guides/write-refusals.md#fetch_failed' },
  refresh_diverged: { code: 'refresh_diverged', docs: 'docs/guides/write-refusals.md#refresh_diverged' },
  refresh_dirty: { code: 'refresh_dirty', docs: 'docs/guides/write-refusals.md#refresh_dirty' },
  sync_in_progress: { code: 'sync_in_progress', docs: 'docs/guides/write-refusals.md#sync_in_progress' },
  refresh_in_progress: { code: 'refresh_in_progress', docs: 'docs/guides/write-refusals.md#refresh_in_progress' },
  refresh_drain_timeout: { code: 'refresh_drain_timeout', docs: 'docs/guides/write-refusals.md#refresh_drain_timeout' },
  refresh_source_changed: { code: 'refresh_source_changed', docs: 'docs/guides/write-refusals.md#refresh_source_changed' },
  refresh_recovery_required: { code: 'refresh_recovery_required', docs: 'docs/guides/write-refusals.md#refresh_recovery_required' },
  worktree_refreshing: { code: 'worktree_refreshing', docs: 'docs/guides/write-refusals.md#worktree_refreshing' },
} as const satisfies Record<string, CatalogueEntry>;

export type CatalogueName = keyof typeof ERROR_CATALOGUE;

/** Wire constants shared by the server and the thin client (A2). */
export const WIRE_CODES = {
  insufficient_scope: 'insufficient_scope',
  unknown_tool: 'unknown_tool',
  not_found: 'not_found',
} as const;

/**
 * A scope denial in any of its historical spellings: the server's
 * `insufficient_scope`, the thin client's legacy `missing_scope`, or
 * `permission_denied` whose canonical code or reason says scope.
 */
export function isScopeErrorCode(code: string | undefined, canonical?: string, reason?: string): boolean {
  if (code === 'insufficient_scope' || code === 'missing_scope' || canonical === 'insufficient_scope') return true;
  return code === 'permission_denied' && (reason === 'insufficient_scope' || reason === 'missing_scope');
}

/** Named refusals (one code may carry several anchors). Same table as ERROR_CATALOGUE. */
export const REFUSALS = ERROR_CATALOGUE;

const CLASS_SUGGESTION: Record<ErrorClass, string> = {
  caller: 'Correct the request using the message above, then retry.',
  consent: 'Stop and ask the user; re-run only with the authorization the message names.',
  retryable: 'Wait briefly, then retry the same request (writes: reuse the same request_id).',
  unavailable: 'A required capability is not available on this brain. Run `gbrain doctor --json` to see what is missing.',
  server: 'Server-side failure, not a caller mistake. Run `gbrain doctor --json` on the brain host; if it repeats, report it to the user.',
  host_only: 'Only the brain host\'s operator can resolve this. Tell the user the message and run `gbrain doctor --json` on the brain host.',
};

const REFUSAL_DOCS_BY_CODE: ReadonlyMap<string, string> = new Map(
  Object.entries(ERROR_CATALOGUE).filter(([name, e]) => name === e.code).map(([, e]) => [e.code, e.docs]),
);

/** Legacy wire values that are not themselves registered codes map to their canonical code. */
const CANONICAL_BY_LEGACY: ReadonlyMap<string, string> = new Map(
  Object.entries(CODES as Record<string, CodeEntry>)
    .filter(([, e]) => e.legacy_error !== undefined && !(e.legacy_error in CODES))
    .map(([code, e]) => [e.legacy_error!, code]),
);

export function isRegistryCode(code: string): code is RegistryCode {
  return Object.prototype.hasOwnProperty.call(CODES, code);
}

/** The registry entry with defaults applied (docs anchor, suggestion), or undefined for an unregistered code. */
export function codeEntry(code: string): (CodeEntry & { docs: string; suggestion: string }) | undefined {
  if (!isRegistryCode(code)) return undefined;
  const e = CODES[code] as CodeEntry;
  return {
    ...e,
    docs: e.docs ?? REFUSAL_DOCS_BY_CODE.get(code) ?? `docs/guides/error-codes.md#${code}`,
    suggestion: e.suggestion ?? CLASS_SUGGESTION[e.class],
  };
}

/** Canonical registry code for a wire `error` value (identity unless the value is a frozen legacy alias). */
export function canonicalCodeFor(wire: string): string {
  return CANONICAL_BY_LEGACY.get(wire) ?? wire;
}

/** An unregistered code is a server fault by construction (the AST test keeps that set empty). */
export function codeClass(code: string): ErrorClass {
  return isRegistryCode(code) ? (CODES[code] as CodeEntry).class : 'server';
}

export function codeRetryable(code: string): boolean {
  if (!isRegistryCode(code)) return false;
  const e = CODES[code] as CodeEntry;
  return e.retryable ?? e.class === 'retryable';
}

/** CLI exit code for an error code (A3 table): entry override, else 1. */
export function exitCodeForCode(code: string): number {
  return isRegistryCode(code) ? (CODES[code] as CodeEntry).exit ?? 1 : 1;
}

/**
 * An `OperationError` for a catalogue entry. `message` is one sentence; `hint`
 * is the exact command to run next, filled with real values.
 */
export function catalogueError(name: CatalogueName, message: string, hint: string): OperationError {
  const entry = ERROR_CATALOGUE[name];
  return new OperationError(entry.code, message, hint, entry.docs);
}

/** The same refusal as a `StructuredError` envelope, for CLI-only surfaces. */
export function catalogueStructuredError(name: CatalogueName, errorClass: string, message: string, hint: string): StructuredAgentError {
  const entry = ERROR_CATALOGUE[name];
  return new StructuredAgentError(buildError({ class: errorClass, code: entry.code, message, hint, docs_url: entry.docs }));
}
