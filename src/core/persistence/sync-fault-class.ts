/**
 * #6340: the one table that turns a managed-sync fault code into three
 * decisions an operator agent can act on without reading fifteen error codes:
 *
 * - `class`: `page` (one entry moved under the sync; the rest of the source is
 *   fine), `connection` (the database went away for a moment; nothing is
 *   recorded against the source), or `systemic` (the writer, the binding, an
 *   approval or gbrain itself; a retry alone changes nothing).
 * - `safe_actions`: what an agent may do on its own, in order of preference.
 *   `retry` reruns the same sync; `retry_when_clean` re-screens a held file once
 *   its edit is committed; `repair` previews and applies a hash-bound file
 *   repair; `reconcile` previews the two diverged versions; `upgrade` installs a
 *   newer gbrain; `none` means wait for a person.
 * - `needs_human`: whether a person has to choose or act before the fault
 *   clears, with `human_reason` naming why.
 *
 * `gbrain sync status --json`, `gbrain sync unblock` and the drain summary all
 * read this table; `docs/guides/sync-unblock-runbook.md` renders it, and
 * `test/sync-runbook-table.test.ts` pins the two together.
 *
 * #6377: a `frontmatter_slug_conflict` hold the content-repair lane judged
 * (`meta.content_repair`) is classified from that verdict: a recommended
 * merge (`merge_recommended`) or an undecidable pair
 * (`content_repair_needs_human`) is `needs_human` with a paragraph rendered
 * from the hold's codes and slugs (`contentRepairHumanReason`), never from
 * model prose; the table row stays the lane's default for every other state.
 */
export type SyncFaultClass = 'page' | 'connection' | 'systemic';
/** #6904: `migrate` applies the pending schema migrations (as the schema owner) before the write is resubmitted. */
export type SyncSafeAction = 'retry' | 'retry_when_clean' | 'repair' | 'reconcile' | 'upgrade' | 'migrate' | 'none';

export interface SyncFaultRule {
  code: string;
  class: SyncFaultClass;
  safe_actions: SyncSafeAction[];
  needs_human: boolean;
  /** When an agent stops looping and pages a person (the runbook's "escalate when" column). */
  escalate: string;
  /** What a person has to do; present when `needs_human`, or when repeated attempts turn it on. */
  human_reason?: string;
}

/** #6340: a hold earned at or after this many re-holds of one path says the page keeps moving under the sync. */
export const HOLD_ATTEMPTS_NEEDS_HUMAN = 3;
/**
 * #6712 PR 2 (L4): and only once this long has passed since the path was first held with its code, so a burst of re-holds
 * (three syncs in ten minutes) never pages a person; a live `worktree_dirty` editor and image holds never escalate.
 */
export const HOLD_ESCALATE_MS = 24 * 60 * 60 * 1000;
/** GBRA-133 S-60: a recorded `storage_error` this many runs in a row repeat (same path, code and message) needs a person. */
export const STORAGE_ERROR_REPEATS = 2;
const ESCALATE_AFTER = `${HOLD_ATTEMPTS_NEEDS_HUMAN} failed attempts over ${HOLD_ESCALATE_MS / 3_600_000} h`;

export const SYNC_FAULT_TABLE: ReadonlyArray<SyncFaultRule> = [
  // Page class: one entry, held; the run finished.
  { code: 'worktree_dirty', class: 'page', safe_actions: ['retry_when_clean'], needs_human: false,
    escalate: `${ESCALATE_AFTER} with no edit in the last ${HOLD_ESCALATE_MS / 3_600_000} h: the uncommitted edit is abandoned`, human_reason: 'An uncommitted edit of the file has sat in the checkout for a day without being committed; find out who made it and commit or restore it.' },
  { code: 'concurrent_write', class: 'page', safe_actions: ['reconcile'], needs_human: true, escalate: 'always: the file and the database page diverge',
    human_reason: 'The Git file and the database page both changed; a person chooses which version wins (gbrain sources reconcile <source> <slug> --preview shows both and writes nothing).' },
  { code: 'file_drift', class: 'page', safe_actions: ['reconcile'], needs_human: true, escalate: 'always: importing the file would replace a database version of the page that sync cannot trace to an import of it',
    human_reason: 'Importing the file would replace a database version of the page that sync cannot trace to an import of the file; a person chooses which version wins (gbrain repair file-drift --source <source> --slug <slug> --prefer database|file previews it and writes nothing until applied).' },
  { code: 'preparation_stalled', class: 'page', safe_actions: ['retry', 'upgrade'], needs_human: false,
    escalate: `${ESCALATE_AFTER}, or writer status names a step that never finishes`, human_reason: 'The write owner cannot finish preparing this file; writer status names the step, fix or report it.' },
  // Flip lane C: the database ended the write's statements (SQLSTATE 57014) persistence.max_preparation_attempts times; like
  // preparation_stalled the write ran out of attempts, so the entry is held and the run goes on.
  { code: 'write_interrupted', class: 'page', safe_actions: ['retry'], needs_human: false,
    escalate: `${ESCALATE_AFTER}: gbrain sources writer status --source <source> --json (read-only) names the load on the write owner`,
    human_reason: 'The database keeps ending this file\'s statements before they finish; writer status names the load on the write owner. Reduce it, then gbrain sources retry-held and the same sync.' },
  { code: 'invalid_fence', class: 'page', safe_actions: ['repair'], needs_human: false, escalate: 'the fence repair preview offers no plan (a manual reason)', human_reason: 'Edit the facts or takes table the hold names and commit.' },
  { code: 'invalid_frontmatter', class: 'page', safe_actions: ['repair'], needs_human: false, escalate: 'the repair preview needs an interpretation (--include-ambiguous)', human_reason: 'Approve the proposed frontmatter fix or edit the file.' },
  { code: 'frontmatter_slug_conflict', class: 'page', safe_actions: ['repair'], needs_human: false, escalate: 'the lane recorded why it could not decide', human_reason: 'The content-repair lane could not clear the hold; its recorded verdict names the page, edit or setting.' },
  { code: 'rename_held', class: 'page', safe_actions: ['repair'], needs_human: false, escalate: 'the repair preview needs an interpretation', human_reason: 'Approve re-binding the rename to the current page.' },
  { code: 'file_too_large', class: 'page', safe_actions: ['none'], needs_human: true, escalate: 'always', human_reason: 'The file is over the page size limit; exclude it with sync.exclude, or split it into files under the limit.' },
  { code: 'content_rejected', class: 'page', safe_actions: ['none'], needs_human: true, escalate: 'always', human_reason: 'The content-sanity gate rejected the file; remove the junk or change junk_disposition.' },
  { code: 'parser_regression', class: 'page', safe_actions: ['upgrade'], needs_human: true, escalate: 'always: a gbrain bug', human_reason: 'Report the file and gbrain version, then upgrade; never pin a release older than 0.60.305.0.' },
  // #6712 PR 4b (S-47): bytes an older gbrain imported whose frontmatter aliases expand past #7018's intended bound; only an edit clears it.
  { code: 'frontmatter_alias_limit', class: 'page', safe_actions: ['none'], needs_human: true, escalate: 'always: only an edit to the file or its removal clears it',
    human_reason: 'The file\'s frontmatter nests YAML aliases past the size limit; reduce the alias nesting (or write the values out), or remove the file, and commit.' },
  { code: 'managed_image_sync_unsupported', class: 'page', safe_actions: ['none'], needs_human: false, escalate: 'never: images stay held while multimodal embedding is off', human_reason: 'Leave images held, exclude them with sync.exclude, or set GBRAIN_EMBEDDING_MULTIMODAL=true so the next sync imports them.' },
  // #6712 PR 2 (L4): two content refusals that hold the file; only the owner or the user changes the outcome.
  { code: 'purged_content', class: 'page', safe_actions: ['none'], needs_human: true, escalate: 'always: only the owner clears a purge tombstone',
    human_reason: 'The file carries content the owner purged; delete or edit the file and commit, or (only if the purge was a mistake) the owner clears it with gbrain pages unpurge <slug> --source <source> on the brain host.' },
  { code: 'write_gate_rejected', class: 'page', safe_actions: ['none'], needs_human: true, escalate: 'always: write_gate.external_mode=reject is the user\'s setting',
    human_reason: 'The write gate refuses the file\'s external instruction-like content under write_gate.external_mode=reject; the user decides whether to edit the file or switch the setting back to quarantine.' },
  // #6727: pages an older gbrain imported without recording their file fold to the file's slug, several or one sync cannot write; a person decides.
  { code: 'legacy_slug_conflict', class: 'page', safe_actions: ['none'], needs_human: true, escalate: 'always: only a person decides which legacy page the file takes over',
    human_reason: 'Pages an older gbrain imported without recording their file match this file and sync cannot pick one to import into; a person keeps the one that is its page and removes the others (gbrain delete --source <source> -- <slug>), or renames the file, then syncs.' },
  // #6712 PR 4b (design v3.2 §3.1): a live pass settled the path three passes in a row and it never classified settled; a gbrain bug or an environment fault, never a loop.
  { code: 'settle_mismatch', class: 'page', safe_actions: ['none'], needs_human: true, escalate: 'always: the pass cannot tell why the path does not settle',
    human_reason: 'Sync settled this file three passes in a row but it never read settled afterwards; read gbrain doctor --json and gbrain sources writer status <source> (read-only), fix what they name, then run gbrain sources retry-held <source> to re-test it.' },
  // GBRA-130 A-6: one path's write failed the same unclassifiable way on repeated attempts; held so the rest of the source moves.
  { code: 'page_write_failed', class: 'page', safe_actions: ['upgrade'], needs_human: true, escalate: 'always: the writer cannot place the failure',
    human_reason: 'The write of this file keeps failing with an error gbrain cannot classify (an owner exception or an unplaced refusal); read its receipt (gbrain write-request <request_id>), report it with the gbrain version or fix the file when the error names its content, then run gbrain sources retry-held <source>.' },
  // GBRA-130 A-7: the file is not a readable regular file inside the source root (a symlink, a non-regular file, a permission error).
  { code: 'file_unreadable', class: 'page', safe_actions: ['none'], needs_human: true, escalate: 'always: only a change to the checkout makes the file readable',
    human_reason: 'Sync cannot read this file as a regular file inside the source root (a symlink, a non-regular file or a permission error) and never follows it; make it a readable regular file in the checkout (or exclude it with sync.exclude) and commit, then run gbrain sources retry-held <source>.' },
  // #7848: the file asks for visibility: private in a spelling page privacy does not read; only an edit to the file clears it.
  { code: 'visibility_noncanonical', class: 'page', safe_actions: ['none'], needs_human: true, escalate: 'always: only an edit to the file clears it',
    human_reason: 'The file asks for visibility: private in a spelling page privacy does not read; write visibility: private on its own frontmatter line (lowercase) and commit.' },
  // GBRA-133 S-39: the file's text holds NUL bytes (a UTF-16 save, a binary file, a padded file); only an edit or its removal clears it.
  { code: 'content_null_bytes', class: 'page', safe_actions: ['none'], needs_human: true, escalate: 'always: only an edit to the file or its removal clears it',
    human_reason: 'The file holds NUL bytes, which page text cannot store; save a UTF-16 file as UTF-8, remove the NUL bytes, or remove a binary file (or exclude it with sync.exclude), and commit.' },
  // GBRA-133 S-33: the commit names a Git object the checkout no longer has and the working-tree copy differs; only restoring the object clears it.
  { code: 'git_object_missing', class: 'page', safe_actions: ['none'], needs_human: true, escalate: 'always: only restoring the Git object clears it',
    human_reason: 'The checkout lost the Git object of this committed file and its working-tree copy differs or is gone; run git fsck in the checkout, restore the object with git fetch or from a backup, then sync (every sync re-tests the hold).' },
  // GBRA-133 S-7: the committed name is not valid UTF-8; only renaming the file clears it.
  { code: 'path_not_utf8', class: 'page', safe_actions: ['none'], needs_human: true, escalate: 'always: only renaming the file clears it',
    human_reason: 'The file name is not valid UTF-8, so sync cannot read it by name; rename it to a UTF-8 name (convmv -f latin1 -t utf8 converts a Latin-1 name) and commit.' },
  // #6948: several live pages record the file as their origin; the sync-time heal resolves verified duplicates, a person decides the rest.
  { code: 'origin_conflict', class: 'page', safe_actions: ['repair'], needs_human: false, escalate: 'the hold carries a reason (the pages differ, ids conflict or none is the page the path names), or the heal is off',
    human_reason: 'Several live pages record this file as their origin and sync cannot prove they are one document; a person keeps the page that is the file\'s and soft-deletes the others (gbrain repair origin-twins --source <source> lists them with the commands), then syncs.' },
  // #6948: an `origin_conflict` hold whose verdict carries a reason (sync-status.ts holdVerdict): nothing resolves it without a person.
  // GBRA-133 PR 1: classic rename holds (src/core/classic-rename-holds.ts); only a person changes the file or removes the page.
  { code: 'rename_identity_unreadable', class: 'page', safe_actions: ['none'], needs_human: true, escalate: 'always: the file title or id holds characters the database cannot compare',
    human_reason: 'The database refused to compare this renamed file title or frontmatter id; a person removes the NUL byte or broken Unicode character from the file and commits, then syncs.' },
  { code: 'rename_reconcile_failed', class: 'page', safe_actions: ['none'], needs_human: true, escalate: 'always: the old page may be a duplicate',
    human_reason: 'A rename imported but the old page could not be removed; a person runs a full sync of the source (it removes pages whose file is gone) or removes the old page with gbrain delete.' },
  { code: 'origin_conflict_decision', class: 'page', safe_actions: ['none'], needs_human: true, escalate: 'always: the pages differ, their ids conflict or none is the page the path names',
    human_reason: 'Several live pages record this file as their origin and sync cannot prove they are one document; a person keeps the page that is the file\'s and soft-deletes the others (gbrain repair origin-twins --source <source> lists them with the commands), then syncs.' },
  // GBRA-130 A-17/B-3/B-4: a held `page_identity_changed` path (sync-status.ts holdVerdict): several tombstones, a spelling twin or a takeover whose ids differ.
  { code: 'page_identity_decision', class: 'page', safe_actions: ['none'], needs_human: true, escalate: 'always: only a person decides which page the file is',
    human_reason: 'Sync cannot decide which page this file is (several deleted pages record it, another spelling of it collides, or its frontmatter id differs from the page at its slug) and never guesses; a person restores or purges the deleted pages, keeps one spelling, or fixes the id or the file name, commits, then runs gbrain sync --source <source> --no-pull.' },
  // GBRA-133: a committed file missing from the working tree (a sparse checkout, a deletion not committed); classic sync holds it.
  { code: 'absent_from_worktree', class: 'page', safe_actions: ['none'], needs_human: true, escalate: 'always: only a person decides whether the file comes back or its deletion is committed',
    human_reason: 'The file is committed but missing from the checkout; a person restores it (git restore, or widens the sparse checkout) so the next sync imports it, or commits the deletion with gbrain git commit-push, which clears the hold.' },
  // GBRA-133: a committed file name that is not valid UTF-8 or holds a control character cannot be a page path; classic sync holds it.
  { code: 'unsupported_path', class: 'page', safe_actions: ['none'], needs_human: true, escalate: 'always: only a rename makes the name a page path',
    human_reason: 'The file name is not valid UTF-8 or contains a control character, so it cannot be a page path; a person renames the file to a valid name and commits, and the next sync imports it and clears the hold.' },
  // Older releases recorded these as run failures; a rerun on this release holds the page instead.
  { code: 'revision_conflict', class: 'page', safe_actions: ['retry'], needs_human: false, escalate: 'the same path fails again after a rerun' },
  { code: 'page_identity_changed', class: 'page', safe_actions: ['retry'], needs_human: false, escalate: 'the same path fails again after a rerun' },
  { code: 'pinned_git_worktree_conflict', class: 'page', safe_actions: ['retry'], needs_human: false, escalate: 'the same path fails again after a rerun' },
  { code: 'source_changed', class: 'page', safe_actions: ['retry'], needs_human: false, escalate: 'the same path fails again after a rerun' },
  // #6712 PR 2 (L4): `source_changed` refined by its recorded reason (`detail`); an admission race (`pending_import`, a file that moved
  // between freeze and publication) keeps the retry above, two-sided drift and a missing file need a decision, a binding change an inspection.
  { code: 'pending_import', class: 'page', safe_actions: ['retry'], needs_human: false, escalate: 'the same path refuses again after a sync imported its file' },
  { code: 'raw_file_changed', class: 'page', safe_actions: ['retry'], needs_human: false, escalate: 'the same path fails again after a rerun re-freezes it' },
  { code: 'file_database_drift', class: 'page', safe_actions: ['reconcile'], needs_human: true, escalate: 'always: the file and the database page diverge',
    human_reason: 'The canonical file and the database page both changed; a person chooses which version wins (gbrain repair file-drift --source <source> --slug <slug> --prefer database|file previews it and writes nothing until applied).' },
  { code: 'canonical_file_missing', class: 'page', safe_actions: ['repair'], needs_human: true, escalate: 'always: no sync can import a file that is not there',
    human_reason: 'The page is live but its canonical file is gone (a ghost page); a person restores the file and syncs, or removes the page (gbrain repair ghost-pages --source <source> previews it and writes nothing).' },
  { code: 'source_binding_changed', class: 'systemic', safe_actions: ['none'], needs_human: true, escalate: 'always: the source or its checkout binding moved',
    human_reason: 'The source was replaced, archived or re-bound under the write; inspect it with gbrain sources writer status --source <source> --json before anything is resubmitted.' },
  { code: 'unsafe_file_target', class: 'systemic', safe_actions: ['none'], needs_human: true, escalate: 'always: the file target resolves outside its source',
    human_reason: 'The canonical file target resolves outside its source (a symlink or a moved checkout); inspect the checkout with gbrain sources writer status --source <source> --json, then the user decides how to repair it.' },
  { code: 'cancelled', class: 'page', safe_actions: ['retry'], needs_human: false, escalate: 'the same group is cancelled again after a rerun' },
  // #6643: refinements of `cancelled` / `revision_conflict` by the receipt's recorded cause; they take precedence over the code.
  // #6712 retired both producers (one page, one fate); the rows render what older builds wrote as superseded.
  { code: 'knock_on', class: 'page', safe_actions: ['retry'], needs_human: false, escalate: 'never: superseded; an older gbrain cancelled this page for another page\'s failure and a plain sync re-freezes it' },
  { code: 'run_replaced', class: 'page', safe_actions: ['retry'], needs_human: false, escalate: 'never: another run of the source superseded this one and covers its pages' },
  { code: 'outside_fence', class: 'systemic', safe_actions: ['none'], needs_human: true, escalate: 'always: a request published outside the cursor that admitted it',
    human_reason: 'A sync request was not the entry its cursor held (two drains of one cursor, or a writer defect). gbrain sync status --source <source> --json lists the live cursors; stop the extra drain (pause autopilot with gbrain autopilot pause) and report the fence snapshot the error carries.' },
  { code: 'knock_on_exhausted', class: 'page', safe_actions: ['retry'], needs_human: false, escalate: 'never: superseded; a plain sync resumes the entry an older gbrain stopped on' },
  { code: 'sync_incomplete', class: 'page', safe_actions: ['retry'], needs_human: false, escalate: 'never: an unfinished cursor resumes with the same command' },
  // Connection class: transport only; the cursor and manifest stand.
  { code: 'connection_lost', class: 'connection', safe_actions: ['retry'], needs_human: false, escalate: 'three reruns in a row end connection_lost (the database is unreachable from this host)' },
  { code: 'database_contention', class: 'connection', safe_actions: ['retry'], needs_human: false, escalate: 'three reruns in a row stop on it' },
  { code: 'write_capacity', class: 'connection', safe_actions: ['retry'], needs_human: false, escalate: 'writer status shows the cap held by requests that never settle' },
  // #6696 (A5): a background sync paused near a cumulative cap; interactive writes keep the rest and the pause lifts as capacity returns.
  { code: 'write_capacity_backpressure', class: 'connection', safe_actions: ['retry'], needs_human: false,
    escalate: 'reason lifetime_ids (request ids never free, so only the host raise lifts it), or the pause outlasts a day' },
  { code: 'capacity_paused', class: 'connection', safe_actions: ['retry'], needs_human: false,
    escalate: 'reason lifetime_ids (only the host raise resumes it), or the same pause after the raise' },
  // #6712 PR 1: another process holds the source's drain lease and is committing; a stalled holder ends drain_stalled instead.
  { code: 'sync_drain_lease_held', class: 'connection', safe_actions: ['retry'], needs_human: false,
    escalate: 'never: a holder that stops committing ends the run drain_stalled instead' },
  { code: 'storage_error', class: 'connection', safe_actions: ['retry'], needs_human: false, escalate: 'the same error after a rerun (then it is not a dropped connection)' },
  // #6513: the engine-graduation fence (SQLSTATE 55000) refuses every write until the move finishes; the cursor and manifest stand.
  { code: 'graduation_in_progress', class: 'connection', safe_actions: ['retry'], needs_human: false, escalate: 'gbrain migrate --status --json reports no running move and the fence still refuses' },
  // Systemic class: a retry alone changes nothing.
  { code: 'preparation_systemic', class: 'systemic', safe_actions: ['upgrade', 'retry'], needs_human: true, escalate: 'always', human_reason: 'Several writes could not finish preparing: the write owner is the likely cause. Writer status names it; fix, restart or upgrade it.' },
  { code: 'drain_stalled', class: 'systemic', safe_actions: ['none'], needs_human: true, escalate: 'always', human_reason: 'The write at the head of the source is wedged in its owner; restart the owner process writer status names.' },
  { code: 'recovery_required', class: 'systemic', safe_actions: ['none'], needs_human: true, escalate: 'always', human_reason: 'A write needs recovery on the brain host (gbrain sources writer status --json names it).' },
  { code: 'owner_unavailable', class: 'systemic', safe_actions: ['none'], needs_human: true, escalate: 'always', human_reason: 'The write owner is gone; start or restart it on the brain host.' },
  { code: 'writer_coordinator_required', class: 'systemic', safe_actions: ['none'], needs_human: true, escalate: 'always', human_reason: 'Managed persistence is not active for this source; activate it or sync unmanaged.' },
  { code: 'permission_denied', class: 'systemic', safe_actions: ['none'], needs_human: true, escalate: 'always', human_reason: 'This principal may not sync the source; the owner grants it.' },
  // #7183: the server connection defaults to read-only transactions (pooler session state another client left, or a read-only server).
  { code: 'connection_inherited_read_only', class: 'systemic', safe_actions: ['none'], needs_human: true, escalate: 'always: only the database operator clears read-only server state',
    human_reason: 'The database refused writes as read-only: a pooled server connection inherited default_transaction_read_only from another client, or the role, database or server is read-only. The database operator resets the pooler\'s server connections and finds the client issuing session-level SET; then sync again.' },
  // #6696 (A6/A7): a cumulative cap is full, or too small for the run; only the brain host's reversible config raise clears it.
  { code: 'write_quota_exhausted', class: 'systemic', safe_actions: ['none'], needs_human: true, escalate: 'always',
    human_reason: 'A cumulative write cap is full; the brain host runs the gbrain config set the error prints (gbrain doctor --only persistence_capacity --json names the value), then the same sync resumes.' },
  { code: 'write_quota_insufficient', class: 'systemic', safe_actions: ['none'], needs_human: true, escalate: 'always',
    human_reason: 'The run needs more write capacity than is left; the brain host runs the gbrain config set the error prints, then reruns the same sync.' },
  { code: 'plan_stale', class: 'systemic', safe_actions: ['none'], needs_human: true, escalate: 'always', human_reason: 'The approved company-brain manifest changed; inspect and approve the repository again.' },
  // #6694: the source's pinned slug-root mode changed under a run of a subdirectory source; the checkpoint waits for the choice.
  { code: 'slug_root_mode_mismatch', class: 'systemic', safe_actions: ['none'], needs_human: true, escalate: 'always: the two modes give different slugs',
    human_reason: 'The source pins one slug-root mode and the sync ran under the other. A person chooses: set sources.config.slug_root_mode back to the mode the run used and rerun gbrain sync --no-pull --source <source> (the checkpoint is retried by itself), or keep the pin, retire the refused cursor with gbrain repair managed-sync-orphans --source <source> (preview, then apply with its hash) and rerun the sync (the pages the refused run wrote keep their old slugs beside the new ones).' },
  { code: 'invalid_params', class: 'systemic', safe_actions: ['none'], needs_human: true, escalate: 'always', human_reason: 'The resume options conflict with the stored cursor; use the resume command the error prints.' },
  // #6518: bookkeeping of an incarnation the source no longer has; a retry selects a different key, so only the repair clears it.
  { code: 'cursor_incarnation_retired', class: 'systemic', safe_actions: ['repair'], needs_human: false, escalate: 'the repair preview lists nothing to retire, or the same code returns after the apply' },
];

const BY_CODE = new Map(SYNC_FAULT_TABLE.map(rule => [rule.code, rule]));

/** #6377: a slug-conflict hold's recorded verdict plus where it is (codes and slugs only). */
export interface ContentRepairHoldInput {
  action: 'remove_slug' | 'merge_into' | 'needs_human' | 'pending';
  reason: string;
  canonical?: string;
  named?: string;
  type?: string;
  path: string;
  slug: string | null;
  /** #6865: the lane version that recorded the verdict, the other frontmatter fix codes (`still_invalid`), a named page with no file. */
  lane_version?: number;
  other_codes?: string[];
  named_db_only?: true;
}

/** #6865: the content-repair lane's verdict version; a verdict an older lane recorded (or one with none) is rechecked once, never shown as a person's decision. */
export const CONTENT_REPAIR_LANE_VERSION = 2;

/** Whether this release's lane recorded the verdict. */
export function contentRepairLaneCurrent(state: { lane_version?: number } | null | undefined): boolean {
  return (state?.lane_version ?? 1) >= CONTENT_REPAIR_LANE_VERSION;
}

const SLUG_PAID: ReadonlySet<string> = new Set(['llm_disabled', 'budget_exhausted', 'no_measured_model', 'no_pricing']);
const SLUG_TRANSIENT: ReadonlySet<string> = new Set(['llm_unavailable', 'ledger_unavailable', 'sync_in_progress', 'claimed_elsewhere', 'changed_since_read', 'changed_since_preview']);

/**
 * #6865: what a person does about a slug-conflict hold, from what the lane actually found; undefined while an agent or the
 * lane itself can still clear it (no verdict yet, an older lane's verdict awaiting its recheck, a transient retry), so the
 * attempts escalation never names a person then. "Decide which page keeps the slug" only when the line names a live page.
 */
export function slugConflictEscalation(input: ContentRepairHoldInput | null | undefined): string | undefined {
  if (!input || !contentRepairLaneCurrent(input) || SLUG_TRANSIENT.has(input.reason)) return undefined;
  const named = input.named ? `page \`${input.named}\`${input.named_db_only ? ' (a database-only page with no file)' : ''}` : null;
  if (input.action === 'pending') {
    if (!SLUG_PAID.has(input.reason)) return undefined;
    return `\`${input.path}\` declares the slug of ${named ?? 'the page its slug: line names'}; whether they are the same page needs the content-repair model, which waits on a setting only the user changes (${input.reason}). `
      + `Allow it, or decide which page keeps the slug: delete the slug: line of \`${input.path}\` if they differ, or merge them and delete the duplicate, then commit.`;
  }
  if (input.action !== 'remove_slug') return undefined;
  if (input.reason === 'still_invalid') {
    return `Removing the slug: line of \`${input.path}\` alone leaves it unimportable${input.other_codes?.length ? ` (the frontmatter also needs ${input.other_codes.join(', ')})` : ''}; `
      + `the user approves the frontmatter fix (gbrain repair frontmatter --only ${input.path} --include-ambiguous previews it and writes nothing) or edits the file.`;
  }
  if (input.reason === 'slug_page_mismatch') {
    return `Sync files \`${input.path}\` as page \`${input.slug ?? '?'}\`, which its slug: line does not name exactly; make the line name that slug or move the file, then commit.`;
  }
  return `gbrain decided to remove the slug: line of \`${input.path}\` but could not write it (${input.reason}); delete the line by hand and commit.`;
}

/**
 * The paragraph a person reads for a judged slug-conflict hold, or undefined when the verdict needs no person
 * (`remove_slug` is applied by the lane; `pending` waits on the model tier). Names the path and the slugs; never
 * the model's own words.
 */
export function contentRepairHumanReason(input: ContentRepairHoldInput): string | undefined {
  const other = input.named ?? input.canonical;
  const kind = input.type ? `the same ${input.type}` : 'the same thing';
  if (input.action === 'merge_into' && input.canonical) {
    if (input.slug && input.canonical === input.slug && other && other !== input.slug) {
      return `This file and page \`${other}\` describe ${kind}; gbrain recommends keeping \`${input.path}\` (slug \`${input.canonical}\`), merging the unique sections of page \`${other}\` into it and deleting that page's file, then committing; `
        + 'the hold clears on the next maintenance run after that file is gone. gbrain does not merge pages by itself yet.';
    }
    return `This file and page \`${input.canonical}\` describe ${kind}; gbrain recommends merging the unique sections of \`${input.path}\` into \`${input.canonical}\` and deleting \`${input.path}\`, then committing; `
      + 'the hold clears on the next sync after the file is removed. gbrain does not merge pages by itself yet.';
  }
  if (input.action === 'needs_human') {
    return `gbrain could not decide whether \`${input.path}\`${other ? ` and page \`${other}\`${input.named_db_only ? ' (a database-only page with no file)' : ''}` : ' and the page its slug: line names'} are the same page; decide which keeps the slug: `
      + `remove the slug: line of \`${input.path}\` if they differ, or merge them by hand and delete the duplicate, then commit; the hold clears on the next sync.`;
  }
  return undefined;
}

export interface SyncFaultVerdict { class: SyncFaultClass; safe_actions: SyncSafeAction[]; needs_human: boolean; human_reason?: string }

/**
 * The verdict for one fault. `attempts` is a hold's failed-attempt count (re-holds plus failed safe actions): a page held
 * `HOLD_ATTEMPTS_NEEDS_HUMAN` times with the same code for at least `HOLD_ESCALATE_MS` (`held_for_ms`) keeps moving under the
 * sync, so its own safe action is exhausted and a person is named; a live editor (`live_editor`) is never escalated. `detail` is a receipt's
 * `reason` (for example `pinned_git_worktree_conflict` under `source_changed`) or a drain stop's `cause`; it refines the code
 * when the table knows it. `content_repair` is a slug-conflict hold's recorded verdict: a recommended merge or an
 * undecidable pair names a person. An unknown code is systemic and human: an agent must not guess at it.
 * GBRA-133 S-60: `repeated` is a recorded run failure's path and the runs in a row that stopped there with the same code and
 * message; a `storage_error` that `STORAGE_ERROR_REPEATS` runs repeat is deterministic, not a dropped connection, so a person is named.
 */
export function classifySyncFault(input: { code: string; detail?: string | null; attempts?: number | null; message?: string | null; content_repair?: ContentRepairHoldInput | null;
  /** #6712 PR 2: how long ago the path was first held with this code (`holdEscalation`); escalation needs `HOLD_ESCALATE_MS`. */
  held_for_ms?: number | null;
  /** #6712 PR 2: a `worktree_dirty` hold whose uncommitted bytes changed within `HOLD_ESCALATE_MS`: someone is still editing. */
  live_editor?: boolean; repeated?: { path: string; runs: number } | null }): SyncFaultVerdict {
  const slugRepair = input.code === 'frontmatter_slug_conflict' ? input.content_repair : undefined;
  const judged = slugRepair && contentRepairLaneCurrent(slugRepair) ? contentRepairHumanReason(slugRepair) : undefined;
  if (judged) return { class: 'page', safe_actions: ['none'], needs_human: true, human_reason: judged };
  const slugHuman = input.code === 'frontmatter_slug_conflict' ? slugConflictEscalation(slugRepair) : undefined;
  const rule = (input.detail ? BY_CODE.get(input.detail) : undefined) ?? BY_CODE.get(input.code)
    ?? (/ECONN|ETIMEDOUT|EPIPE|connection.*closed|CONNECTION_ENDED/i.test(input.message ?? '') ? BY_CODE.get('connection_lost') : undefined);
  if (!rule) return { class: 'systemic', safe_actions: ['none'], needs_human: true, human_reason: `Unknown code ${input.code}; run gbrain doctor --json and read gbrain errors ${input.code}.` };
  const repeated = rule.code === 'storage_error' && input.repeated && input.repeated.runs >= STORAGE_ERROR_REPEATS ? input.repeated : undefined;
  if (repeated) {
    const phase = /^<(.+)>$/.exec(repeated.path)?.[1];
    return { class: phase ? 'systemic' : 'page', safe_actions: ['none'], needs_human: true, human_reason: `${phase ? `The sync's ${phase} phase` : repeated.path} stopped the last ${repeated.runs} syncs with `
      + `the same storage_error, so it is not a dropped connection and another rerun will not clear it; read last_error.message, ${phase ? 'run gbrain doctor --json' : 'fix, move or remove the file and commit'}, then sync again, `
      + 'and report it to the gbrain maintainers if the cause is not clear.' };
  }
  const exhausted = !rule.needs_human && (input.attempts ?? 0) >= HOLD_ATTEMPTS_NEEDS_HUMAN && (input.held_for_ms ?? 0) >= HOLD_ESCALATE_MS && !input.live_editor
    && rule.safe_actions[0] !== 'none' && rule.class === 'page' && (input.code !== 'frontmatter_slug_conflict' || slugHuman !== undefined);
  if (!exhausted) return { class: rule.class, safe_actions: rule.safe_actions, needs_human: rule.needs_human, ...(rule.needs_human && rule.human_reason ? { human_reason: rule.human_reason } : {}) };
  return { class: rule.class, safe_actions: ['none'], needs_human: true,
    human_reason: `${(slugHuman ?? rule.human_reason ?? 'The page keeps moving under the sync.').replace(/\.$/, '')} (held ${input.attempts} times over ${Math.floor(input.held_for_ms! / 3_600_000)} h with code ${rule.code}).` };
}
