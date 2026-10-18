/**
 * Shared types for malformed facts/takes fence repair (#6188).
 *
 * Every issue, fix and gate failure is location-only: fence, section, row
 * number, column name and section line. None carries claim text, holder
 * names or any other cell value, so they are safe in holds, receipts,
 * refusals, notices and commit messages.
 */

export type FenceKind = 'facts' | 'takes';
export type FenceSection = 'body' | 'timeline';

/**
 * The tier that clears an issue: Tier 1 rules (`deterministic`), Tier 2
 * verified holders (`resolver`), Tier 3 model rewrite (`llm`), or a person
 * (`manual`).
 */
export type FenceTier = 'deterministic' | 'resolver' | 'llm' | 'manual';

/** Validator gate letters (a)-(g). */
export type GateLetter = 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'g';

/** The class each applied fix carries in receipts, holds and previews. */
export type FixClass =
  | 'merge_fences'
  | 'close_fence'
  /** #6377: the end marker inserted after the last row of a fence that trailing page text followed. */
  | 'close_fence_trailing'
  | 'marker_form'
  | 'stray_empty_cell'
  | 'renumber'
  | 'column_default'
  | 'header_alias'
  | 'enum_synonym'
  | 'kind_map'
  | 'holder_alias'
  | 'confidence_format'
  | 'holder_verified';

/** Every fence reason; `FENCE_REASONS` (reasons.ts) holds one entry per code. */
export type FenceReason =
  // Screen residual, Tier 3 (`unclosed_trailing_content`: the tail classifier, #6377).
  | 'header_unmapped' | 'no_header' | 'row_before_header' | 'short_row' | 'unclosed_trailing_content'
  // Screen residual, Tier 2 then manual.
  | 'holder_unresolved'
  // Screen residual, manual only.
  | 'extra_cells' | 'claim_split' | 'missing_begin' | 'split_rows' | 'marker_near_miss' | 'repeated_marker' | 'unclosed_ambiguous_tail'
  // Screen residual, the user's hash-bound approval (#6377): closing the fence would show its trailing lines to readers of a world-visible page.
  | 'tail_exposure_approval'
  | 'takes_in_facts' | 'superseded_ambiguous' | 'enum_unmapped' | 'weight_missing' | 'holder_missing'
  | 'confidence_out_of_range' | 'claim_value_invalid' | 'takes_kind_unsupported'
  // Preparation and publication.
  | 'unparseable' | 'row_collision' | 'quoted_fence_rows' | 'stored_row_collision'
  | 'withdrawn_claim_in_malformed_fence' | 'target_fence_malformed' | 'prepare_time' | 'normalizer_failed'
  // Repair runs.
  | 'llm_unavailable' | 'llm_empty' | 'llm_refused' | 'llm_malformed' | 'llm_truncated' | 'llm_declined' | 'llm_disabled' | 'no_measured_model'
  | 'budget_exhausted' | 'no_pricing' | 'ledger_unavailable' | 'owner_unavailable' | 'owner_cli_required'
  // Owner conditions (#6278; the `owner_unavailable` reasons the owner-refusal matrix names).
  | 'host_mismatch' | 'transfer_in_progress' | 'clone_in_progress' | 'incarnation_changed' | 'local_path_missing' | 'coordination_path_missing'
  | 'sync_in_progress' | 'time_budget' | 'changed_since_read' | 'changed_since_preview'
  // Validator gates.
  | 'still_invalid' | 'claim_changed' | 'row_number_changed' | 'visibility_loosened'
  | 'row_count_changed' | 'cell_changed' | 'protection_loosened';

/** Where an issue or fix sits. Location only: never a cell value. */
export interface FenceLocation {
  fence: FenceKind;
  section: FenceSection;
  /** Row number (for a fix, the number after renumbering); null for a fence-level location or a row without a valid number. */
  row: number | null;
  /** Canonical column (`#`, `claim`, `kind`, `who`, ...); null for a whole row or fence. */
  column: string | null;
  /** 1-based line within the section of the before page; null when unknown. */
  line: number | null;
}

export interface FenceIssue extends FenceLocation {
  reason: FenceReason;
  /** Schema vocabulary for the column (never a cell value). */
  allowed?: readonly string[];
}

export interface FenceFix extends FenceLocation {
  class: FixClass;
  /** `renumber` only: the row's number before the fix (null when it had none). */
  from?: number | null;
}

/** Stored canonical rows for a page: row number to claim text (strikethrough stripped). */
export interface StoredRowMap {
  facts: ReadonlyMap<number, string>;
  takes: ReadonlyMap<number, string>;
}

export interface FenceCtx {
  /** `effectiveVisibility(page)`. */
  pageVisibility: 'private' | 'world';
  /** Stored facts/takes rows; needed only when a `renumber` fix is planned. */
  storedRows?: StoredRowMap;
  /** Tier 2: before-holder text to a verified `people/` or `companies/` slug. */
  verifiedHolders?: ReadonlyMap<string, string>;
  /** Takes kinds the active schema pack declares (`takes_kinds`). */
  takesPackKinds?: readonly string[];
  /** Row numbers of rows hidden from a remote caller; never renumbered or reallocated. */
  hiddenRows?: ReadonlySet<number>;
  /**
   * #6377: the caller holds the user's hash-bound approval to close an unclosed fence ahead of trailing text on a
   * world-visible page (the lines become visible to the page's readers). Private pages never need it: closing
   * shows nothing to anyone new. Unattended runs never set it.
   */
  approveTailExposure?: boolean;
  /** #6377: fences (`<section>:<kind>`) whose trailing lines the tail classifier judged prose, so the close may run although a tail line holds a pipe. */
  tailProse?: ReadonlySet<string>;
}

/** The two canonical body sections. Callers pass their full page type and get it back. */
export interface FencePage {
  compiled_truth: string;
  timeline: string;
}
