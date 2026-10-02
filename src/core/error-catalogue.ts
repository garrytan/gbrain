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
} as const satisfies Record<string, CatalogueEntry>;

export type CatalogueName = keyof typeof ERROR_CATALOGUE;

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
