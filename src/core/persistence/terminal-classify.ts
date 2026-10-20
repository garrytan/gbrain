/**
 * #6650 (L3): the read-time classification of a terminal write request that did not commit, so an operator sees what a
 * pile of failed, conflicted and cancelled receipts means and what clears it, without a persisted fix or a new table.
 *
 * `classifyTerminal(row)` reads only what survives receipt compaction (`compactWriteReceipts` nulls the intent and the
 * message): `error_code`, `error_detail` (its `origin`, `reason` and `cause`), `operation`, `state`, `recovery`,
 * `blocked_reason` and `compacted`. Every maintenance kind is stored as `submit_job`, so the intent's kind is used only
 * when it is still there (the legacy knock-on texts need it, as `isSyncKnockOn` does). Codes that cover several causes
 * (`source_changed`, `storage_error`) are routed by their recorded origin or reason; when a legacy receipt carries
 * neither, the verdict is `diagnosis_required` with a read-only inspection, never a guessed fix.
 *
 * The verdict speaks the vocabulary of `gbrain sync status` (`class` / `safe_actions` / `needs_human` / `escalate`,
 * `sync-fault-class.ts`) plus an `Action` whose `verify` is read-only. It classifies history only: whether a row blocks
 * something right now (a checkpoint blocker, a recovery record holding its root) is decided by the reader
 * (`terminal-failures.ts`) from PR A's `checkpoint_blockers` and the head blocker's `request_recovery`, never here.
 *
 * `supersessionSql` is the one rule for "a later request on the same page made this one moot", extracted from
 * `gbrain repair failed-writes` (`disposition`), which uses it unchanged; `terminal-failures.ts` uses it to label a
 * row `superseded` / `already_written` / `duplicate`, and anything without that evidence stays `unknown`.
 */
import type { Action } from '../agent-output.ts';
import { CODES } from '../error-registry.ts';
import { compareVersions } from '../migration-ledger.ts';
import { classifySyncFault, SYNC_FAULT_TABLE, type SyncFaultClass, type SyncSafeAction } from './sync-fault-class.ts';
import { isSyncKnockOn, knockOnRoot, SYNC_CURSOR_FENCE_ORIGIN, SYNC_KNOCK_ON_ORIGIN, cursorFenceCause, syncKnockOnSql } from './sync-knock-on.ts';
import { writeFailureDiagnostic } from './verb-errors.ts';
import { publicCategory, type PublicCategory } from './public-category.ts';

export type TerminalCategory =
  | 'recovery_pending' | 'recovery_blocked'
  | 'knock_on' | 'run_replaced' | 'outside_fence'
  | 'operator_cancelled' | 'caller_conflict' | 'file_conflict' | 'canonical_file_missing' | 'fence_unrenderable'
  | 'writer_guard' | 'database_refusal' | 'owner_exception' | 'legacy_publication_refusal'
  | 'sync_fault' | 'transport' | 'caller_refusal' | 'gbrain_defect' | 'diagnosis_required'
  // #6904: the write met a missing relation or column (42P01 / 42703); the schema is behind this build or lost a table.
  | 'schema_missing';

/** The receipt columns the classifier reads; every one but `intent_kind` and `error_message` survives compaction. */
export interface TerminalInput {
  request_id?: string;
  source_id: string;
  slug: string;
  operation: string;
  state: string;
  error_code: string | null;
  error_detail?: object | null;
  recovery: unknown;
  blocked_reason: string | null;
  compacted: boolean;
  publication_started?: boolean | null;
  /** The build that ran the failed attempt (`error_detail.attempt.consumer_version`), else the admitting build. */
  build?: string | null;
  /** Nulled by compaction; used only for the legacy knock-on texts and the message-routed diagnostics. */
  intent_kind?: string | null;
  error_message?: string | null;
  /** A reader that computed `terminalKnockOnSql` passes its answer, so the SQL twin and this verdict cannot disagree. */
  knock_on?: boolean;
  /**
   * #6904: whether the brain's schema is behind this build now (`readSchemaBehind`), which picks a `schema_missing` verdict's
   * fix: apply-migrations when behind, the missing-tables check when at head. Absent or null: unknown, the fix is a doctor read.
   */
  schema_behind?: boolean | null;
}

export interface TerminalVerdict {
  category: TerminalCategory;
  /** #6712 PR 2: the closed public vocabulary beside `category` (`public-category.ts`); total. */
  public_category: PublicCategory;
  /** The code the verdict is keyed on: the row's `error_code`, or the refinement its origin names. */
  code: string;
  origin: string | null;
  class: SyncFaultClass;
  safe_actions: SyncSafeAction[];
  needs_human: boolean;
  human_reason?: string;
  escalate: string;
  /** A gbrain defect class: doctor warns on an unresolved one whatever the trend. */
  defect: boolean;
  /** The release that fixed this class, when one did; a row from an older build is historical. */
  fixed_in: string | null;
  historical: boolean;
  /** The request a knock-on waited on, when its canceller recorded it. */
  root_request_id?: string;
  action: Action;
}

/** #6650: classes a release fixed. A row written by an older build is history: it does not warn. */
export const TERMINAL_FIXED_IN = {
  // #6643: the run re-freezes its own knock-ons and the checkpoint no longer waits on them.
  knock_on: '0.60.216.0',
  // #5974/#5982: a guard P0001 is classified (writer_coordinator_required, origin database_guard) and the misread is fixed;
  // an unclassified "Publication failed (P0001)" receipt can only come from an older build.
  legacy_publication_refusal: '0.60.40.0',
  // #6657: a refused fact-fence adoption is no longer resubmitted every cycle and keeps its metadata.
  fence_unrenderable: '0.60.218.0',
} as const satisfies Partial<Record<TerminalCategory, string>>;

/** The connection-loss texts `classifySyncFault` reads as `connection_lost`; POSIX-compatible, so readers match it in SQL (`~*`). */
export const CONNECTION_MESSAGE_PATTERN = 'ECONN|ETIMEDOUT|EPIPE|connection.*closed|CONNECTION_ENDED';
/** The prefix of an unclassified database refusal written before #5974. */
export const LEGACY_PUBLICATION_PREFIX = 'Publication failed (P0001)';

const DEFECTS = new Set<TerminalCategory>(['outside_fence', 'writer_guard', 'database_refusal', 'owner_exception', 'gbrain_defect', 'fence_unrenderable']);
const FAULT_CODES = new Set(SYNC_FAULT_TABLE.map(rule => rule.code));
const escalateOf = (code: string) => SYNC_FAULT_TABLE.find(rule => rule.code === code)?.escalate ?? 'always';

const statusArgv = (sourceId: string) => ['gbrain', 'sources', 'writer', 'status', '--source', sourceId, '--json'];
const failuresArgv = (sourceId: string) => ['gbrain', 'sources', 'writer', 'failures', sourceId, '--json'];
/** The read-only drill-down an operator re-runs to see the class clear. */
export function terminalVerifyArgv(sourceId: string): string[] { return failuresArgv(sourceId); }
/** The per-receipt read-only inspection (the receipt with its diagnosis). */
export function terminalInspectArgv(requestId: string): string[] { return ['gbrain', 'write-request', requestId, '--json']; }

function syncRetry(sourceId: string, why: string): Action {
  return { argv: ['gbrain', 'sync', '--source', sourceId, '--no-pull', '--json'], consent: [], actor: 'agent', requires_exclusive: false, why,
    verify: { argv: ['gbrain', 'sync', 'status', '--source', sourceId, '--json'] }, docs: 'docs/guides/sync-unblock-runbook.md' };
}
function inspect(sourceId: string, why: string, userMessage?: string): Action {
  return { argv: statusArgv(sourceId), consent: [], actor: userMessage ? 'host_admin' : 'agent', requires_exclusive: false, why,
    ...(userMessage ? { user_message: userMessage } : {}), verify: { argv: failuresArgv(sourceId) }, docs: 'docs/guides/troubleshooting.md#terminal-write-failures' };
}

/**
 * #6712 PR 2 (L4): the file-drift preview over every page still drifted since `since` (a concrete instant, never an age),
 * the fix of a group of drift conflicts on several pages; a single page keeps its `--slug` preview.
 */
export function driftSinceAction(sourceId: string, since: string): Action {
  return { argv: ['gbrain', 'repair', 'file-drift', '--source', sourceId, '--all-drifted', '--since', since, '--prefer', 'database'], consent: [], actor: 'agent', requires_exclusive: false,
    why: `Previews keeping the database copy of every page still drifted since ${since} and writes nothing (it refuses a mix of drift classes and names --class for each); --prefer file previews importing the files instead. Decide with the user, then apply with the printed plan hash.`,
    verify: { argv: failuresArgv(sourceId) }, docs: 'docs/guides/write-refusals.md#file_database_drift' };
}

function build(input: TerminalInput): string | null {
  const attempt = (input.error_detail as { attempt?: { consumer_version?: unknown } } | null | undefined)?.attempt?.consumer_version;
  const value = typeof attempt === 'string' ? attempt : input.build ?? null;
  return value && /^\d+\.\d+\.\d+(\.\d+)?$/.test(value) ? value : null;
}
function stringField(detail: Record<string, unknown> | null | undefined, key: string): string | null {
  const value = detail?.[key];
  return typeof value === 'string' ? value : null;
}

type Partial_ = Omit<TerminalVerdict, 'defect' | 'fixed_in' | 'historical' | 'escalate' | 'public_category'> & { escalate?: string };

/** The read-time verdict for one terminal receipt that did not commit; null for a committed receipt with no recovery record. */
export function classifyTerminal(input: TerminalInput): TerminalVerdict | null {
  if (input.state === 'committed' && !input.recovery) return null;
  const verdict = route(input);
  const fixedIn = (TERMINAL_FIXED_IN as Partial<Record<TerminalCategory, string>>)[verdict.category] ?? null;
  const ran = build(input);
  const historical = fixedIn !== null && (verdict.category === 'legacy_publication_refusal' || (ran !== null && compareVersions(ran, fixedIn) < 0));
  return { ...verdict, public_category: publicCategory(verdict), escalate: verdict.escalate ?? escalateOf(verdict.code), defect: DEFECTS.has(verdict.category), fixed_in: fixedIn, historical };
}

function fromTable(category: TerminalCategory, code: string, origin: string | null, action: Action, detail?: string | null, message?: string | null): Partial_ {
  const v = classifySyncFault({ code, detail, message });
  return { category, code: detail && FAULT_CODES.has(detail) ? detail : code, origin, class: v.class, safe_actions: v.safe_actions, needs_human: v.needs_human,
    ...(v.human_reason ? { human_reason: v.human_reason } : {}), action };
}

function diagnosis(input: TerminalInput, code: string, origin: string | null, why: string): Partial_ {
  return { category: 'diagnosis_required', code, origin, class: 'systemic', safe_actions: ['none'], needs_human: true,
    human_reason: `${why} The receipt does not record enough to name a fix; inspect it and the writer before acting.`,
    escalate: 'always: a person reads the writer status and the receipt',
    action: inspect(input.source_id, `${why} Writer status and the receipt are read-only; nothing is guessed.`) };
}

function route(input: TerminalInput): Partial_ {
  const code = input.error_code ?? 'unknown';
  const detail = (input.error_detail ?? null) as Record<string, unknown> | null;
  const origin = stringField(detail, 'origin');
  const reason = stringField(detail, 'reason');
  const source = input.source_id;
  if (input.recovery) {
    const blocked = input.blocked_reason === 'unexpected_staging_bytes' || input.blocked_reason === 'unexpected_file_bytes';
    return blocked
      ? { category: 'recovery_blocked', code: 'recovery_required', origin, class: 'systemic', safe_actions: ['none'], needs_human: true,
        human_reason: `The publication recovery record of this request is blocked (${input.blocked_reason}): a file it staged or published changed outside gbrain, so its root stays held until a person inspects the bytes.`,
        escalate: 'always: the bytes on disk differ from what the recovery record expects',
        action: inspect(source, 'Writer status names the held root and the recovery record, read-only.', `Inspect the file named by gbrain sources writer status --source ${source} --json on the brain host; restore the expected bytes or report it.`) }
      : { category: 'recovery_pending', code: 'recovery_required', origin, class: 'systemic', safe_actions: ['retry'], needs_human: false,
        escalate: 'the record is still there after an owner pass (writer status then names a blocked_reason)',
        action: { argv: ['gbrain', 'sync', '--source', source, '--no-pull', '--json'], consent: [], actor: 'agent', requires_exclusive: false,
          why: 'This request holds a publication recovery record, which holds every queued write on its root (head blocker request_recovery). An owner pass on this host '
            + 'finishes it: the sync starts one, cleans the staged files and clears the record (a gbrain serve that owns the root does the same).',
          verify: { argv: failuresArgv(source) }, docs: 'docs/guides/troubleshooting.md#terminal-write-failures' } };
  }
  const knockOn = input.knock_on ?? knockOnSafe(input);
  if (knockOn) {
    const root = knockOnRoot({ error_detail: detail });
    return { ...fromTable('knock_on', code, origin, syncRetry(source, `This page only waited on another page of the same sync${root ? ` (request ${root})` : ''}; a sync re-freezes it under a fresh request.`), 'knock_on'),
      ...(root ? { root_request_id: root } : {}) };
  }
  if (code === 'fence_unrenderable' && origin === null) {
    return { category: 'fence_unrenderable', code, origin, class: 'page', safe_actions: ['none'], needs_human: true,
      human_reason: 'The fact-fence adoption planner produced a fence that does not read back as its facts: a gbrain planning defect to report with the page slug and version.',
      escalate: 'always: a build with the adoption fix wrote it',
      action: { argv: ['gbrain', 'doctor', '--only', 'fence_integrity', '--json'], consent: [], actor: 'agent', requires_exclusive: false,
        why: 'A legacy fact row was not adopted into its page\'s facts fence; the row stays active and searchable. Doctor fence_integrity lists the pages and reason classes, read-only.',
        verify: { argv: failuresArgv(source) }, docs: 'docs/guides/write-refusals.md#fence_unrenderable' } };
  }
  if (origin === SYNC_CURSOR_FENCE_ORIGIN) {
    const cause = cursorFenceCause(detail);
    if (cause === 'outside_fence') return fromTable('outside_fence', code, origin, inspect(source, 'A sync request published outside the cursor that admitted it; writer status and sync status list the drains, read-only.',
      `Stop the extra drain of source ${source} (gbrain autopilot pause), then report the fence snapshot gbrain sync status --source ${source} --json shows.`), 'outside_fence');
    if (cause === 'run_replaced') return fromTable('run_replaced', code, origin, syncRetry(source, 'Another run of the source replaced this one and covers its pages; the current sync finishes the source.'), 'run_replaced');
  }
  if (code === 'cancelled' && input.state === 'cancelled') {
    return { category: 'operator_cancelled', code, origin, class: 'page', safe_actions: ['none'], needs_human: false,
      escalate: 'never: a caller or operator cancelled it before publication',
      action: { argv: terminalInspectArgv(input.request_id ?? '<request_id>'), consent: [], actor: 'agent', requires_exclusive: false,
        why: 'Cancelled before publication by its caller or an operator; nothing was written. The receipt is read-only history.' } };
  }
  if (code === 'writer_coordinator_required' && origin === 'database_guard') {
    return { category: 'writer_guard', code, origin, class: 'systemic', safe_actions: ['none'], needs_human: true,
      human_reason: 'The managed-writer database guard refused the write: a gbrain defect, a schema change by another tool, or two gbrain builds sharing the database.',
      escalate: 'always', action: { ...inspect(source, 'Writer status --probe names the table, operation, guard branch and executing build of each refusal, read-only.',
        'Read recent_failures[].error_detail from gbrain sources writer status --probe --json on the brain host, check doctor managed_guard_schema_drift, then retry the write with a new request id (gbrain repair failed-writes replays caller writes).'),
      argv: ['gbrain', 'sources', 'writer', 'status', '--source', source, '--probe', '--json'] } };
  }
  // #6904: a missing relation or column, classified at publication, or recorded as an owner exception by an older build (its errno).
  if (reason === 'schema_missing' || (origin === 'owner_exception' && ['42P01', '42703'].includes(stringField(detail, 'errno') ?? ''))) {
    return schemaMissingVerdict(input, code, origin, stringField(detail, 'missing'));
  }
  if (origin === 'owner_exception') {
    return { category: 'owner_exception', code, origin, class: 'systemic', safe_actions: ['upgrade'], needs_human: true,
      human_reason: 'The owner raised an unexpected exception while running this write: a gbrain defect.',
      escalate: 'always: report the error class and frame writer status shows',
      action: inspect(source, 'Writer status names the error class, errno, frame and the build that ran the attempt, read-only.',
        'Report the owner exception (gbrain sources writer status --json on the brain host names it) with the gbrain version; upgrade when a fix ships.') };
  }
  if (code === 'storage_error' || code === 'writer_coordinator_required') {
    if (reason === 'graduation_in_progress') return fromTable('transport', code, origin, syncRetry(source, 'The engine-graduation fence refused writes while the brain moved; retry once gbrain migrate --status --json reports it finished.'), 'graduation_in_progress');
    if (reason === 'attribution_unclassified_table' || reason === 'trust_unclassified_table') {
      return { category: 'database_refusal', code, origin, class: 'systemic', safe_actions: ['upgrade'], needs_human: true,
        human_reason: `A gbrain stamp trigger met a table it is not built for (${reason}): two gbrain builds share this database.`, escalate: 'always',
        action: inspect(source, 'Writer status lists the admitter and consumer build of each host, read-only.', 'Upgrade every gbrain process that shares this database to one release, restart them, then retry the write.') };
    }
    if (origin === 'database_trigger' || origin === 'database' || origin === 'database_guard') {
      return diagnosis(input, code, origin, `A database trigger refused the write (${stringField(detail, 'raiser') ?? 'unnamed raiser'}${reason ? `, reason ${reason}` : ''}).`);
    }
    if (!detail && input.error_message?.startsWith(LEGACY_PUBLICATION_PREFIX)) {
      return { category: 'legacy_publication_refusal', code, origin: null, class: 'systemic', safe_actions: ['none'], needs_human: false,
        escalate: 'never: only builds before refusals were classified wrote this receipt',
        action: { argv: ['gbrain', 'repair', 'failed-writes', '--source', source], consent: [], actor: 'agent', requires_exclusive: false,
          why: 'A database refusal recorded before refusals were classified (and before the writer-guard misread was fixed). The read-only preview lists caller writes it can replay.',
          verify: { argv: failuresArgv(source) }, docs: 'docs/guides/repair.md#failed-writes' } };
    }
    if (input.error_message && new RegExp(CONNECTION_MESSAGE_PATTERN, 'i').test(input.error_message)) {
      return fromTable('transport', code, origin, syncRetry(source, 'The database connection dropped during the write; nothing was committed.'), 'connection_lost', input.error_message);
    }
    return diagnosis(input, code, origin, `The write ended ${code} with no recorded origin${input.compacted ? ' (its receipt was compacted)' : ''}.`);
  }
  if (code === 'source_changed') {
    const known = stringField(detail, 'reason') ?? (input.error_message ? writeFailureDiagnostic(code, input.error_message).reason : null);
    if (!known || known === 'source_changed') return diagnosis(input, code, origin, `The write was refused source_changed with no recorded cause${input.compacted ? ' (its receipt was compacted)' : ''}.`);
    // #6712 PR 2 (L4): the recorded reason picks the exit; the verdict text is the fault table's row for it.
    const row = (key: string) => { const v = classifySyncFault({ code, detail: key }); return { class: v.class, safe_actions: v.safe_actions, needs_human: v.needs_human, human_reason: v.human_reason, escalate: escalateOf(key) }; };
    if (known === 'file_database_drift' || known === 'canonical_path_occupied' || known === 'unbound_source') {
      return { category: 'file_conflict', code, origin: origin ?? known, ...row('file_database_drift'),
        action: { argv: ['gbrain', 'repair', 'file-drift', '--source', source, '--slug', input.slug, '--prefer', 'database'], consent: [], actor: 'agent', requires_exclusive: false,
          why: `Previews keeping the database copy of ${input.slug} and rewriting its file, and writes nothing; --prefer file previews importing the file instead. Decide with the user, apply with the printed plan hash, then resubmit the write with a new request id.`,
          verify: { argv: failuresArgv(source) }, docs: 'docs/guides/write-refusals.md#file_database_drift' } };
    }
    if (known === 'canonical_file_missing') {
      return { category: 'canonical_file_missing', code, origin: origin ?? known, ...row('canonical_file_missing'),
        action: { argv: ['gbrain', 'repair', 'ghost-pages', '--source', source], consent: [], actor: 'agent', requires_exclusive: false,
          why: 'Previews the live pages whose canonical file is missing and writes nothing; apply only after the user agrees, or restore the file and sync.',
          verify: { argv: failuresArgv(source) }, docs: 'docs/guides/write-refusals.md#canonical_file_missing' } };
    }
    if (known === 'source_binding_changed' || known === 'unsafe_file_target') {
      const v = row(known);
      return { category: 'diagnosis_required', code, origin: known, ...v,
        action: inspect(source, `The write was refused source_changed (${known}). Writer status shows the source binding and its checkout, read-only.`, v.human_reason) };
    }
    return fromTable('sync_fault', code, origin ?? known, syncRetry(source, `The file changed under the write (${known}); a sync imports the current bytes.`), known === 'pinned_git_worktree_conflict' ? known : 'source_changed');
  }
  // #6834: a checkpoint or fact-batch completion receipt names a bookkeeping slug, never a page; reading it finds nothing.
  // A compacted receipt keeps no intent kind; its operation and slug still identify the bookkeeping request.
  const bookkeeping = (kind: string, operation: string, slug: string) => input.slug === slug && (input.intent_kind ? input.intent_kind === kind : input.operation === operation);
  if (code === 'revision_conflict' && bookkeeping('managed_sync_checkpoint', 'submit_job', '__managed_sync_checkpoint__')) {
    return { category: 'caller_conflict', code, origin, class: 'systemic', safe_actions: ['retry'], needs_human: false, escalate: escalateOf(code),
      action: { argv: ['gbrain', 'sync', 'status', '--source', source, '--json'], consent: [], actor: 'agent', requires_exclusive: false,
        why: 'A sync checkpoint was refused (__managed_sync_checkpoint__ is bookkeeping, not a page). Sync status names the step that finishes or retires its run, read-only; a later checkpoint of the source supersedes this receipt.',
        verify: { argv: failuresArgv(source) }, docs: 'docs/guides/repair.md#managed-sync-orphans' } };
  }
  if (code === 'revision_conflict' && bookkeeping('managed_facts_complete', 'extract_facts', '__managed_facts_complete__')) {
    return { category: 'caller_conflict', code, origin, class: 'systemic', safe_actions: ['none'], needs_human: false, escalate: 'never: the batch\'s committed facts stay',
      action: { argv: terminalInspectArgv(input.request_id ?? '<request_id>'), consent: [], actor: 'agent', requires_exclusive: false,
        why: 'A fact-extraction batch was not recorded complete because some of its per-entity requests did not commit (__managed_facts_complete__ is bookkeeping, not a page). The receipt is read-only history; run the extraction again only if facts are still missing.',
        verify: { argv: failuresArgv(source) } } };
  }
  if (code === 'revision_conflict' || code === 'page_identity_changed') {
    return { category: 'caller_conflict', code, origin, class: 'page', safe_actions: ['retry'], needs_human: false, escalate: escalateOf(code),
      action: { argv: ['gbrain', 'get', '--source', source, '--', input.slug], consent: [], actor: 'agent', requires_exclusive: false,
        why: 'The page changed after the caller read it. Read the current revision and resubmit against it with a new request id.',
        verify: { argv: failuresArgv(source) } } };
  }
  if (FAULT_CODES.has(code)) return fromTable('sync_fault', code, origin, faultAction(code, input), null, input.error_message);
  const entry = (CODES as Record<string, { class: string } | undefined>)[code];
  if (!entry) return diagnosis(input, code, origin, `The write ended with code ${code}, which this build does not know.`);
  if (entry.class === 'server') {
    return { category: 'gbrain_defect', code, origin, class: 'systemic', safe_actions: ['upgrade'], needs_human: true,
      human_reason: `The write ended ${code}, a server-side fault in gbrain.`, escalate: 'always',
      action: inspect(source, 'Writer status names the build that ran the attempt, read-only.', `Report the ${code} receipt with the gbrain version (gbrain errors ${code} explains it); upgrade when a fix ships.`) };
  }
  if (entry.class === 'retryable' || entry.class === 'unavailable') {
    return { category: 'transport', code, origin, class: 'connection', safe_actions: ['retry'], needs_human: false, escalate: 'the same code after a rerun',
      action: { argv: terminalInspectArgv(input.request_id ?? '<request_id>'), consent: [], actor: 'agent', requires_exclusive: false,
        why: `A transient refusal (${code}); the caller resubmits with a new request id. The receipt is read-only.`, verify: { argv: failuresArgv(source) } } };
  }
  return { category: 'caller_refusal', code, origin, class: 'page', safe_actions: ['none'], needs_human: entry.class !== 'caller',
    ...(entry.class !== 'caller' ? { human_reason: `The write was refused ${code} (${entry.class}); gbrain errors ${code} names who acts.` } : {}),
    escalate: 'never: the caller saw the refusal and its fix',
    action: { argv: terminalInspectArgv(input.request_id ?? '<request_id>'), consent: [], actor: 'agent', requires_exclusive: false,
      why: `The caller's write was refused ${code} and the caller saw why; the receipt carries the diagnosis, read-only.`, verify: { argv: failuresArgv(source) } } };
}

/** #6904: the schema-missing verdict; the fix depends on whether the schema is behind this build right now. */
function schemaMissingVerdict(input: TerminalInput, code: string, origin: string | null, missing: string | null): Partial_ {
  const what = missing ? `the ${missing} relation or column` : 'a relation or column';
  const verify = { argv: ['gbrain', 'doctor', '--json'] };
  const base = { category: 'schema_missing' as const, code, origin, class: 'systemic' as const };
  if (input.schema_behind === true) {
    return { ...base, safe_actions: ['migrate'], needs_human: false, escalate: 'the schema is still behind after gbrain apply-migrations --yes (doctor schema_version names the failing migration)',
      action: { argv: ['gbrain', 'apply-migrations', '--yes'], consent: [], actor: 'agent', requires_exclusive: true,
        why: `The write needed ${what}, which a pending migration adds: the brain schema is behind this gbrain build. Apply the migrations as the database role that owns the gbrain tables, then resubmit the write with a new request id.`,
        verify, docs: 'docs/guides/write-refusals.md#schema_behind' } };
  }
  if (input.schema_behind === false) {
    const human = `The write needed ${what}, but the schema version is at head: a table or column is missing outside a migration (an older backup restored, a table dropped by hand, or a migration recorded without its change). Doctor's schema_missing_tables check names what is missing and gbrain repair missing-tables previews recreating it; decide with the user before applying.`;
    return { ...base, safe_actions: ['repair'], needs_human: true, human_reason: human, escalate: 'always: the schema is at head and still lacks what the write needs',
      action: { argv: ['gbrain', 'doctor', '--json'], consent: [], actor: 'agent', requires_exclusive: false, ask_user: true, user_message: human,
        why: "Read-only: doctor's schema_missing_tables check lists the missing tables and columns and names the gbrain repair missing-tables preview.", verify } };
  }
  return { ...base, safe_actions: ['none'], needs_human: false, escalate: 'doctor reports the schema at head and the write still fails on a missing relation or column',
    action: { argv: ['gbrain', 'doctor', '--json'], consent: [], actor: 'agent', requires_exclusive: false, verify,
      why: `The write needed ${what}. Read-only: when doctor's schema_version reports the schema behind, run gbrain apply-migrations --yes as the database role that owns the gbrain tables and resubmit; when it is at head, its schema_missing_tables check names what is missing (gbrain repair missing-tables previews it).` } };
}

function faultAction(code: string, input: TerminalInput): Action {
  const v = classifySyncFault({ code });
  if (v.safe_actions[0] === 'retry') return syncRetry(input.source_id, `The sync recorded ${code} (${v.class}); a rerun holds or retries it.`);
  return inspect(input.source_id, `The write ended ${code}; writer status names what holds it, read-only.`, v.human_reason);
}

/** `isSyncKnockOn` over the classifier's columns: a compacted receipt counts by its typed marker alone. */
function knockOnSafe(input: TerminalInput): boolean {
  return isSyncKnockOn({ state: input.state as never, error_code: input.error_code, error_message: input.error_message ?? null, error_detail: (input.error_detail ?? null) as Record<string, unknown> | null,
    recovery: null, publication_started: input.publication_started ?? false, intent: input.intent_kind ? { kind: input.intent_kind } : null });
}

/**
 * The kind-aware knock-on predicate for a read spanning every request, row for row `isSyncKnockOn`: `syncKnockOnSql`
 * matches the legacy texts on any row, while `isSyncKnockOn` takes a typed marker unless the kept intent names a non-sync
 * kind, and a legacy text only on a sync page kind. Never NULL.
 */
export function terminalKnockOnSql(alias: string): string {
  const a = alias, sync = `${a}.intent->>'kind' IN ('managed_sync_import','managed_sync_delete')`;
  return `(${syncKnockOnSql(a)} AND CASE WHEN ${a}.error_detail->>'origin' = '${SYNC_KNOCK_ON_ORIGIN}' THEN (${a}.intent->>'kind' IS NULL OR ${sync}) ELSE COALESCE(${sync}, false) END)`;
}

/** Page removals: a later one supersedes any earlier write of the page. */
export const PAGE_REMOVAL_OPERATIONS: readonly string[] = ['delete_page', 'purge_page'];

/**
 * The supersession rule of `gbrain repair failed-writes`, as a predicate over a candidate later request `c` of the
 * failed request `r` (both `persistence_requests` aliases): the same intent committed, failed or still pending; a later
 * page removal committed or pending; for a `put_page`, any later write committed or pending, or a later caller
 * `put_page` that failed (the newer content); #6834: for a refused sync checkpoint, any later committed checkpoint of the
 * source (both read by kind; a compacted row, which keeps no kind, by its operation); #6824: for a refused connector
 * write, a later committed connector retry whose recorded `retryOf` lineage reaches it (connectorRetrySql). `r` must
 * expose `id`. Literal strings only; NULL-safe for a compacted `c` (no intent).
 */
export function supersessionSql(r: string, c: string): string {
  const removals = PAGE_REMOVAL_OPERATIONS.map(op => `'${op}'`).join(',');
  return `(${c}.source_id=${r}.source_id AND ${c}.slug=${r}.slug AND ${c}.sequence>${r}.sequence AND (
    (${c}.digest=${r}.digest AND ${c}.state IN ('committed','failed','queued','running','recovering'))
    OR (${c}.state IN ('committed','queued','running','recovering') AND (${c}.operation IN (${removals}) OR ${r}.operation='put_page'))
    OR (${r}.slug='__managed_sync_checkpoint__' AND ${r}.operation='submit_job' AND ${c}.state='committed' AND ${c}.operation='submit_job'
      AND COALESCE((SELECT k.intent->>'kind' FROM persistence_requests k WHERE k.id=${r}.id),'managed_sync_checkpoint')='managed_sync_checkpoint'
      AND COALESCE(${c}.intent->>'kind','managed_sync_checkpoint')='managed_sync_checkpoint')
    OR (${r}.operation='put_page' AND ${c}.state='failed' AND ${c}.operation='put_page' AND COALESCE(NOT (${c}.intent ? 'kind'), false))
    OR ${connectorRetrySql(r, c)}))`;
}

/** Hops a connector retry's `retryOf` lineage is followed back; a longer chain leaves the refusal unresolved (fail closed). */
export const CONNECTOR_RETRY_LINEAGE_MAX_DEPTH = 32;
const CONNECTOR_WRITE_KINDS = `'connector_v2_import','connector_v2_delete','connector_v2_checkpoint'`;
const UUID_TEXT = `'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'`;

/**
 * #6824: a connector retry records `retryBase`/`retryOf`/`retryAttempt` in its intent, so its digest never equals the
 * refusal it replaces. A committed retry `c` (read whole as `cc` by its unique sequence) supersedes the refused `r`
 * (read whole as `k` by id; callers may pass narrow row aliases) only when every hop of its
 * recorded `retryOf` chain, back to `r`, has the same principal, source and incarnation, operation, slug and connector
 * intent kind, at a lower sequence, within CONNECTOR_RETRY_LINEAGE_MAX_DEPTH hops. Another refusal of the same item with
 * no recorded link is not proof. Each hop is one lookup on the (principal_kind, principal_id, request_id) unique index.
 */
function connectorRetrySql(r: string, c: string): string {
  return `(${r}.operation='submit_job' AND ${c}.operation='submit_job' AND ${c}.state='committed' AND COALESCE(${c}.intent ? 'retryOf', false)
      AND EXISTS (SELECT 1 FROM persistence_requests k, persistence_requests cc WHERE k.id=${r}.id AND cc.sequence=${c}.sequence
        AND k.intent->>'kind' IN (${CONNECTOR_WRITE_KINDS})
        AND cc.intent->>'kind'=k.intent->>'kind' AND cc.principal_kind=k.principal_kind AND cc.principal_id=k.principal_id
        AND cc.source_incarnation=k.source_incarnation
        AND EXISTS (WITH RECURSIVE lineage(request_id, sequence, intent, depth) AS (
            SELECT cc.request_id, cc.sequence, cc.intent, 0
            UNION ALL
            SELECT p.request_id, p.sequence, p.intent, l.depth+1 FROM lineage l JOIN persistence_requests p
              ON p.principal_kind=k.principal_kind AND p.principal_id=k.principal_id
              AND p.request_id=CASE WHEN l.intent->>'retryOf' ~ ${UUID_TEXT} THEN (l.intent->>'retryOf')::uuid END
            WHERE l.depth<${CONNECTOR_RETRY_LINEAGE_MAX_DEPTH} AND p.sequence<l.sequence AND p.source_id=k.source_id
              AND p.source_incarnation=k.source_incarnation AND p.operation=k.operation AND p.slug=k.slug AND p.intent->>'kind'=k.intent->>'kind')
          SELECT 1 FROM lineage WHERE request_id=k.request_id)))`;
}

/** The order that picks the most telling superseding request: the same intent committed, then the same intent, then the oldest later write. */
export function supersessionOrderSql(r: string, c: string): string {
  return `(${c}.digest=${r}.digest AND ${c}.state='committed') DESC, (${c}.digest=${r}.digest) DESC, ${c}.sequence`;
}

export type TerminalDisposition = 'already_written' | 'duplicate' | 'superseded' | 'unknown';
/** The disposition `supersessionSql`'s first match (in `supersessionOrderSql` order) proves, or `unknown` without one. */
export function dispositionOf(later: { state: string; same_intent: boolean } | null | undefined): TerminalDisposition {
  if (!later) return 'unknown';
  if (later.same_intent && later.state === 'committed') return 'already_written';
  if (later.same_intent) return 'duplicate';
  return 'superseded';
}

/**
 * #6712 PR 2 (L5): the verdict of a fault recorded without its receipt at hand (a hold, a managed-sync failure row, a run
 * stop), read as the failed receipt it stands for, so `last_error`, holds and doctor's `sync_failures` render the same
 * `category` / `public_category` as the receipt itself.
 */
export function classifyRecordedFault(input: { source_id: string; code: string; slug?: string | null; request_id?: string | null;
  error_detail?: Record<string, unknown> | null; message?: string | null }): TerminalVerdict {
  return classifyTerminal({ source_id: input.source_id, slug: input.slug ?? '', operation: 'submit_job', state: 'failed', error_code: input.code,
    error_detail: input.error_detail ?? null, recovery: null, blocked_reason: null, compacted: false, error_message: input.message ?? null,
    ...(input.request_id ? { request_id: input.request_id } : {}) })!;
}
