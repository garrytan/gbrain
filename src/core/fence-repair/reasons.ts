/**
 * The canonical fence reason table (#6188, D13). One entry per reason that a
 * fence refusal, hold or repair outcome can carry: where it arises, which
 * tier clears it, whether the maintenance pass retries it without a person,
 * who acts, the docs anchor and a location-only fix template. The error
 * registry's `invalid_fence.reasons` and the write-refusals anchors are
 * generated from this table.
 *
 * Fix templates take only location placeholders: `{fence}`, `{section}`,
 * `{rows}`, `{columns}`, `{line}` and `{allowed}` (schema vocabulary). They
 * never quote a cell.
 */
import type { Actor } from '../agent-output.ts';
import { FENCE_REPAIR_MEASURED_MODELS } from './measured.ts';
import type { FenceIssue, FenceKind, FenceReason, FenceSection, FenceTier, GateLetter } from './types.ts';

export interface FenceReasonSpec {
  /** Where the reason arises. */
  stage: 'screen' | 'prepare' | 'repair' | 'gate';
  /** The tier that clears it; null when that depends on the page (re-screened). */
  tier: FenceTier | null;
  /** Never sent to the model tier; the fix names the exact edit. */
  manualOnly: boolean;
  /** The maintenance pass clears or retries it with no one acting. */
  autoRetry: boolean;
  actor: Actor;
  /** Raising spend or enabling the model is the user's call. */
  paid: boolean;
  gate?: GateLetter;
  docs: string;
  fix: string;
}

// The anchor is built per reason, so no partial `write-refusals.md#...` literal reads as a broken link (write-refusals-coverage).
const DOCS = 'docs/guides/write-refusals.md';
const REPAIR = 'Preview its repair with `gbrain repair fences` (read-only; it names the exact edit when gbrain will not repair it), or fix the fence and write the page again.';
const BY_HAND = '`gbrain repair fences` (read-only) lists the exact edit.';

type Base = Pick<FenceReasonSpec, 'stage' | 'tier' | 'manualOnly' | 'autoRetry'>;
const tier3: Base = { stage: 'screen', tier: 'llm', manualOnly: false, autoRetry: true };
const manual: Base = { stage: 'screen', tier: 'manual', manualOnly: true, autoRetry: false };
const prepared: Base = { stage: 'prepare', tier: null, manualOnly: false, autoRetry: true };
const run = (autoRetry: boolean, tier: FenceTier | null = 'llm'): Base => ({ stage: 'repair', tier, manualOnly: false, autoRetry });

function entry(base: Base, fix: string, extra: Partial<FenceReasonSpec> = {}): Omit<FenceReasonSpec, 'docs'> {
  return { ...base, actor: 'agent', paid: false, fix, ...extra };
}

function gate(letter: GateLetter, fix: string): Omit<FenceReasonSpec, 'docs'> {
  return entry({ stage: 'gate', tier: null, manualOnly: false, autoRetry: false }, fix, { gate: letter });
}

const SPECS: Record<FenceReason, Omit<FenceReasonSpec, 'docs'>> = {
  header_unmapped: entry(tier3, 'The {fence} fence header in the {section} at line {line} has a column with no canonical name. Rename each column to one of {allowed}. ' + REPAIR),
  no_header: entry(tier3, 'The {fence} fence in the {section} at line {line} has rows but no header row. Add the canonical header as the first table line. ' + REPAIR),
  row_before_header: entry(tier3, 'Row(s) {rows} of the {fence} fence in the {section} sit above the header (line {line}). Move them below the header. ' + REPAIR),
  short_row: entry(tier3, 'Row(s) {rows} of the {fence} fence in the {section} (line {line}) are missing a cell in the middle of the row, so its columns are ambiguous. Add the missing cell so every column lines up. ' + REPAIR),
  extra_cells: entry(manual, 'Row(s) {rows} of the {fence} fence in the {section} (line {line}) have more cells than the header, and removing empty cells does not line them up. Often an unescaped `|` cut a cell, usually the claim, in two: write it as `\\|` to join the cell again, or remove the extra cell. gbrain does not guess which cell moved.'),
  claim_split: entry(manual, 'Column `kind` of row(s) {rows} in the {fence} fence ({section}, line {line}) holds text, not a kind word: often the end of a claim an unescaped `|` cut in two, with the kind cell missing. Join that text back into the claim with `\\|` and write the kind, one of {allowed}.'),
  holder_unresolved: entry({ stage: 'screen', tier: 'resolver', manualOnly: false, autoRetry: true },
    'Column `who` of row(s) {rows} in the {fence} fence ({section}, line {line}) is not a holder gbrain recognizes. Write `world`, `brain`, `people/<slug>` or `companies/<slug>`.'),
  missing_begin: entry(manual, 'The {fence} fence in the {section} has an end marker at line {line} with no begin marker before it. Add the begin marker above the table, or delete the stray end marker.'),
  split_rows: entry(manual, 'The {fence} fence that begins at line {line} in the {section} has no end marker and its rows are split by blank lines or text. Join the rows into one table and add the end marker after the last row.'),
  unclosed_trailing_content: entry(tier3, 'The {fence} fence that begins at line {line} in the {section} has no end marker and lines holding a pipe follow its table, so the rules cannot tell rows from prose. The repair model classifies the tail; a prose tail closes the fence after its last row (on a world-visible page after the user approves the lines it shows). ' + REPAIR),
  unclosed_ambiguous_tail: entry({ ...manual, stage: 'repair' }, 'The {fence} fence that begins at line {line} in the {section} has no end marker, and the lines after its table are not plain prose (a row written without pipes, a marker mention, or a tail the repair model could not classify). Add the end marker directly after the last table row and fix the rows below it, or wrap a marker mention in backticks; gbrain does not guess where the fence ends.'),
  tail_exposure_approval: entry({ stage: 'screen', tier: 'deterministic', manualOnly: false, autoRetry: false }, 'The {fence} fence that begins at line {line} in the {section} has no end marker; gbrain can close it after its last table row, but the lines after the table would then be visible to readers of this world-visible page. Preview the close with `gbrain repair fences` (read-only: it prints those lines and the apply command with --expect <hash>), and run that command once the user approves.', { actor: 'user' }),
  marker_near_miss: entry(manual, 'Line {line} of the {section} mentions the takes begin marker but is not a fence followed by a table. Wrap the mention in backticks, or use the exact three-dash marker above a takes table.'),
  repeated_marker: entry(manual, 'The {section} repeats a {fence} fence marker (line {line}); a section holds at most one facts fence and one takes fence. gbrain merges the fences itself when each has a begin and an end marker, the same canonical header and nothing but table lines inside (`merge_fences`: later rows appended, exact duplicates dropped, colliding numbers renumbered). Otherwise, give the fence at line {line} both markers, the same header as the first fence, and move any other text out of it, or delete the extra marker.'),
  takes_in_facts: entry(manual, 'The {fence} fence in the {section} at line {line} holds a takes table. Move the rows into a takes fence (or use `takes_add`), or rewrite them as facts rows.'),
  superseded_ambiguous: entry(manual, 'Row number(s) {rows} appear more than once in the {fence} fence and a `superseded by` reference names them. Decide which row keeps each number, renumber the other and fix the reference.'),
  enum_unmapped: entry(manual, 'Column(s) {columns} of row(s) {rows} in the {fence} fence ({section}, line {line}) hold a value gbrain cannot map. Use one of {allowed}.'),
  weight_missing: entry(manual, 'The {fence} fence ({section}, line {line}) has no weight for row(s) {rows}. Add a weight from 0 to 1; takes have no default weight.'),
  holder_missing: entry(manual, 'The {fence} fence ({section}, line {line}) has no holder for row(s) {rows}. Add a `who` column with `world`, `brain`, `people/<slug>` or `companies/<slug>`.'),
  confidence_out_of_range: entry(manual, 'Column(s) {columns} of row(s) {rows} in the {fence} fence ({section}, line {line}) are not a number from 0 to 1. Write the intended value as a decimal such as 0.8.'),
  claim_value_invalid: entry(manual, 'Column `claim_value` of row(s) {rows} in the {fence} fence ({section}, line {line}) is not a number. Write a number (1,234 separators and a k/M/B suffix are allowed) or leave it empty.'),
  takes_kind_unsupported: entry(manual, 'Column `kind` of row(s) {rows} in the {fence} fence ({section}, line {line}) is not a takes kind. Use one of {allowed}; gbrain does not choose a takes kind for you.'),
  unparseable: entry(prepared, 'The {fence} fence in the {section} does not parse cleanly. ' + REPAIR),
  row_collision: entry(prepared, 'Row number(s) {rows} are used by two {fence} rows on this page. Give one row a new number above every number used on the page.'),
  quoted_fence_rows: entry({ ...prepared, autoRetry: false, manualOnly: true }, 'A {fence} fence in the {section} sits inside markdown code, so this write would remove the rows it holds. Move the fence out of the code block, or delete it to remove its rows.'),
  stored_row_collision: entry({ ...prepared, autoRetry: false, manualOnly: true }, 'Row number(s) {rows} of the {fence} fence are already used by a different stored take that is not in the fence. Renumber the new row, or add the stored take back to the fence.'),
  withdrawn_claim_in_malformed_fence: entry(prepared, 'The {fence} fence in the {section} does not parse and holds a withdrawn claim. Fix the fence first. ' + REPAIR),
  target_fence_malformed: entry(prepared, 'The page this write appends to has a {fence} fence that does not parse ({section}, line {line}). ' + REPAIR),
  prepare_time: entry(prepared, 'The {fence} fence passed the screen but its rows were refused while the write was prepared. ' + REPAIR),
  normalizer_failed: entry({ ...prepared, autoRetry: false, tier: 'manual' }, 'The fence normalizer failed on the {fence} fence in the {section}; the page is held as it was. Run `gbrain doctor --json` and report it; a gbrain upgrade re-screens it.'),
  llm_unavailable: entry(run(true), 'The repair model was unavailable (timeout, rate limit or server error). The next repair run retries.'),
  llm_empty: entry(run(false), 'The repair model returned nothing for the {fence} fence. Fix row(s) {rows} by hand; ' + BY_HAND),
  llm_refused: entry(run(false), 'The repair model declined to repair the {fence} fence. Fix row(s) {rows} by hand; ' + BY_HAND),
  llm_malformed: entry(run(false), 'The repair model did not return a single table for the {fence} fence. Fix row(s) {rows} by hand; ' + BY_HAND),
  llm_truncated: entry(run(false), 'The repair model stopped before finishing the {fence} fence. Fix row(s) {rows} by hand; ' + BY_HAND),
  llm_declined: entry(run(false), 'The repair model found a row of the {fence} fence with more than one reasonable reading and declined to guess. Fix row(s) {rows} by hand; ' + BY_HAND),
  llm_disabled: entry(run(false), 'Model repair is off (`fences.repair.llm`). Fix row(s) {rows} by hand (' + BY_HAND + '), or ask the user before running `gbrain config set fences.repair.llm true`.', { paid: true }),
  no_measured_model: entry(run(false), `No model measured accurate enough for fence repair (${FENCE_REPAIR_MEASURED_MODELS.join(', ')}) has a provider key on this brain and \`models.fence_repair\` is unset, so row(s) {rows} stay held. Fix them by hand (${BY_HAND}), or ask the user which model to trust before setting it: \`gbrain config set models.fence_repair <provider:model>\`.`, { paid: true }),
  budget_exhausted: entry(run(true), 'The daily fence-repair budget is spent; repairs resume after 00:00 UTC. Raising it is the user\'s call: `gbrain config set fences.repair.max_usd_per_day <usd>`.', { paid: true }),
  no_pricing: entry(run(false), 'A spend cap is set but gbrain has no price for the repair model. Look up its price and run `gbrain pricing set <model> --input <usd> --output <usd>` on the brain host.', { paid: true }),
  ledger_unavailable: entry(run(true), 'The spend ledger could not be read, so no model call was made. The next repair run retries.'),
  owner_unavailable: entry(run(true, null), 'Fence repairs run on the brain\'s owner host. Run `gbrain repair fences` there.', { actor: 'host_admin' }),
  owner_cli_required: entry(run(false, null), 'This repair must be applied from the owner host CLI. Run `gbrain repair fences --apply` there.', { actor: 'host_admin' }),
  host_mismatch: entry(run(false, null), 'Another host id owns this source\'s checkout (the hold names both ids), so this host never repairs it. Run `gbrain repair fences --source <source>` on the owner host that `gbrain sources writer status --source <source> --json` names, or give the worker and the shell one GBRAIN_HOME so they share one host identity; never copy or regenerate host.json.', { actor: 'host_admin' }),
  transfer_in_progress: entry(run(true, null), 'A writer transfer of this source is prepared (its worktree is draining), so no host may write it yet. Nothing to do: the next run repairs it once the transfer is accepted or cancelled (`gbrain sources writer status --source <source> --json` shows the state).', { actor: 'host_admin' }),
  clone_in_progress: entry(run(true, null), 'A topology clone of this source\'s checkout is in progress (its worktree is recovering). Nothing to do: the next run repairs it once the clone finishes (`gbrain sources writer status --source <source> --json` shows the state).', { actor: 'host_admin' }),
  incarnation_changed: entry(run(false, null), 'This source\'s checkout binding is from an earlier incarnation of the source (it was removed and re-added, or restored), so no host may write it. On the brain host, review `gbrain sources writer status --source <source> --json` and re-bind the checkout; the next run after that repairs the file.', { actor: 'host_admin' }),
  local_path_missing: entry(run(false, null), 'This host owns the source\'s checkout but has no path registered for it. On the brain host, review `gbrain sources writer status --source <source> --json` and register the checkout again; the next run after that repairs the file.', { actor: 'host_admin' }),
  coordination_path_missing: entry(run(false, null), 'This host\'s registration for the source has no coordination directory. On the brain host, review `gbrain sources writer status --source <source> --json` and repair the registration; the next run after that repairs the file.', { actor: 'host_admin' }),
  sync_in_progress: entry(run(true, null), 'A sync of this source or a write in flight still names this file (a path still ahead in the sync\'s frozen manifest counts; a held path does not); the repair of every other file goes on, and this one is retried on the next run.'),
  time_budget: entry(run(true, null), 'The repair run reached its time budget; the next run resumes where it stopped.'),
  changed_since_read: entry(run(true, null), 'The file changed after the repair read it, so nothing was written. The next repair run reads it again.'),
  changed_since_preview: entry(run(false, null), 'The page changed after the preview, so it was not applied. Preview again with `gbrain repair fences` and apply the new plan.'),
  still_invalid: gate('a', 'The proposed repair of the {fence} fence still does not parse cleanly (gate a). Fix row(s) {rows} by hand.'),
  claim_changed: gate('b', 'The proposed repair of the {fence} fence changed claim text (gate b), so it was rejected. Fix row(s) {rows} by hand.'),
  row_number_changed: gate('c', 'The proposed repair of the {fence} fence changed an existing row number (gate c), so it was rejected. Fix row(s) {rows} by hand.'),
  visibility_loosened: gate('d', 'The proposed repair of the {fence} fence made a row more visible (gate d), so it was rejected. Fix row(s) {rows} by hand.'),
  row_count_changed: gate('e', 'The proposed repair of the {fence} fence added, dropped or left rows outside the fence (gate e), so it was rejected. Fix row(s) {rows} by hand.'),
  cell_changed: gate('f', 'The proposed repair of the {fence} fence changed a cell no rule allows (gate f), so it was rejected. Fix column(s) {columns} of row(s) {rows} by hand.'),
  protection_loosened: gate('g', 'The proposed repair of the {fence} fence would show text the privacy boundary hid (gate g), so it was rejected. Add the end marker where the fence really ends.'),
};

export const FENCE_REASONS: Readonly<Record<FenceReason, FenceReasonSpec>> = Object.fromEntries(
  Object.entries(SPECS).map(([reason, spec]) => [reason, { ...spec, docs: `${DOCS}#fence-${reason}` }]),
) as Record<FenceReason, FenceReasonSpec>;

/** Every reason code, in table order (the registry's `invalid_fence.reasons`). */
export const FENCE_REASON_CODES = Object.keys(FENCE_REASONS) as FenceReason[];

/** Gate letter to reason. */
export const GATE_REASONS: Readonly<Record<GateLetter, FenceReason>> = {
  a: 'still_invalid', b: 'claim_changed', c: 'row_number_changed', d: 'visibility_loosened',
  e: 'row_count_changed', f: 'cell_changed', g: 'protection_loosened',
};

/** A location for messages: one reason in one fence and section. */
export interface FenceMessageLocation {
  reason: FenceReason;
  fence: FenceKind;
  section: FenceSection;
  rows: readonly number[];
  columns: readonly string[];
  line: number | null;
  allowed?: readonly string[];
}

/** The reason's fix with its placeholders filled; a placeholder with no value reads as `?`. */
export function renderFenceFix(at: FenceMessageLocation): string {
  const values: Record<string, string> = {
    fence: at.fence, section: at.section, line: at.line === null ? '?' : String(at.line),
    rows: at.rows.length ? at.rows.join(', ') : '?', columns: at.columns.length ? at.columns.map(c => `\`${c}\``).join(', ') : '?',
    allowed: at.allowed?.length ? at.allowed.map(a => `\`${a}\``).join(', ') : 'the canonical values',
  };
  return FENCE_REASONS[at.reason].fix.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? '?');
}

/** `Fence <reason>: in the <fence> fence (<section>), row(s) N, column(s) C, at line L.` plus the fix. */
export function fenceMessage(at: FenceMessageLocation): string {
  const parts = [`in the ${at.fence} fence (${at.section})`];
  if (at.rows.length) parts.push(`${at.rows.length > 1 ? 'rows' : 'row'} ${at.rows.join(', ')}`);
  if (at.columns.length) parts.push(`${at.columns.length > 1 ? 'columns' : 'column'} ${at.columns.join(', ')}`);
  if (at.line !== null) parts.push(`at line ${at.line}`);
  return `Fence ${at.reason}: ${parts.join(', ')}. ${renderFenceFix(at)}`;
}

/** Message location for one issue. */
export function issueLocation(issue: FenceIssue): FenceMessageLocation {
  const at: FenceMessageLocation = {
    reason: issue.reason, fence: issue.fence, section: issue.section,
    rows: issue.row === null ? [] : [issue.row], columns: issue.column === null ? [] : [issue.column], line: issue.line,
  };
  return issue.allowed ? { ...at, allowed: issue.allowed } : at;
}
