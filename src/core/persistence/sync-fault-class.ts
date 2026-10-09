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
export type SyncSafeAction = 'retry' | 'retry_when_clean' | 'repair' | 'reconcile' | 'upgrade' | 'none';

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

export const SYNC_FAULT_TABLE: ReadonlyArray<SyncFaultRule> = [
  // Page class: one entry, held; the run finished.
  { code: 'worktree_dirty', class: 'page', safe_actions: ['retry_when_clean'], needs_human: false,
    escalate: `held ${HOLD_ATTEMPTS_NEEDS_HUMAN} times: the file keeps changing without being committed`, human_reason: 'Someone (or an agent) keeps editing the file without committing it; find out who and commit or restore it.' },
  { code: 'concurrent_write', class: 'page', safe_actions: ['reconcile'], needs_human: true, escalate: 'always: the file and the database page diverge',
    human_reason: 'The Git file and the database page both changed; a person chooses which version wins (gbrain sources reconcile <source> <slug> --preview shows both and writes nothing).' },
  { code: 'preparation_stalled', class: 'page', safe_actions: ['retry', 'upgrade'], needs_human: false,
    escalate: `held ${HOLD_ATTEMPTS_NEEDS_HUMAN} times, or writer status names a step that never finishes`, human_reason: 'The write owner cannot finish preparing this file; writer status names the step, fix or report it.' },
  { code: 'invalid_fence', class: 'page', safe_actions: ['repair'], needs_human: false, escalate: 'the fence repair preview offers no plan (a manual reason)', human_reason: 'Edit the facts or takes table the hold names and commit.' },
  { code: 'invalid_frontmatter', class: 'page', safe_actions: ['repair'], needs_human: false, escalate: 'the repair preview needs an interpretation (--include-ambiguous)', human_reason: 'Approve the proposed frontmatter fix or edit the file.' },
  { code: 'frontmatter_slug_conflict', class: 'page', safe_actions: ['repair'], needs_human: false, escalate: 'the repair preview needs an interpretation', human_reason: 'Decide which page keeps the slug.' },
  { code: 'rename_held', class: 'page', safe_actions: ['repair'], needs_human: false, escalate: 'the repair preview needs an interpretation', human_reason: 'Approve re-binding the rename to the current page.' },
  { code: 'file_too_large', class: 'page', safe_actions: ['none'], needs_human: true, escalate: 'always', human_reason: 'Split the file or exclude it with sync.exclude.' },
  { code: 'content_rejected', class: 'page', safe_actions: ['none'], needs_human: true, escalate: 'always', human_reason: 'The content-sanity gate rejected the file; remove the junk or change junk_disposition.' },
  { code: 'parser_regression', class: 'page', safe_actions: ['upgrade'], needs_human: true, escalate: 'always: a gbrain bug', human_reason: 'Report the file and gbrain version, then upgrade or pin the last good release.' },
  { code: 'managed_image_sync_unsupported', class: 'page', safe_actions: ['none'], needs_human: false, escalate: 'never: images stay held by design', human_reason: 'Leave images held, or exclude them with sync.exclude.' },
  // Older releases recorded these as run failures; a rerun on this release holds the page instead.
  { code: 'revision_conflict', class: 'page', safe_actions: ['retry'], needs_human: false, escalate: 'the same path fails again after a rerun' },
  { code: 'page_identity_changed', class: 'page', safe_actions: ['retry'], needs_human: false, escalate: 'the same path fails again after a rerun' },
  { code: 'pinned_git_worktree_conflict', class: 'page', safe_actions: ['retry'], needs_human: false, escalate: 'the same path fails again after a rerun' },
  { code: 'source_changed', class: 'page', safe_actions: ['retry'], needs_human: false, escalate: 'the same path fails again after a rerun' },
  { code: 'sync_incomplete', class: 'page', safe_actions: ['retry'], needs_human: false, escalate: 'never: an unfinished cursor resumes with the same command' },
  // Connection class: transport only; the cursor and manifest stand.
  { code: 'connection_lost', class: 'connection', safe_actions: ['retry'], needs_human: false, escalate: 'three reruns in a row end connection_lost (the database is unreachable from this host)' },
  { code: 'database_contention', class: 'connection', safe_actions: ['retry'], needs_human: false, escalate: 'three reruns in a row stop on it' },
  { code: 'write_capacity', class: 'connection', safe_actions: ['retry'], needs_human: false, escalate: 'writer status shows the cap held by requests that never settle' },
  { code: 'storage_error', class: 'connection', safe_actions: ['retry'], needs_human: false, escalate: 'the same error after a rerun (then it is not a dropped connection)' },
  // Systemic class: a retry alone changes nothing.
  { code: 'preparation_systemic', class: 'systemic', safe_actions: ['upgrade', 'retry'], needs_human: true, escalate: 'always', human_reason: 'Several writes could not finish preparing: the write owner is the likely cause. Writer status names it; fix, restart or upgrade it.' },
  { code: 'drain_stalled', class: 'systemic', safe_actions: ['none'], needs_human: true, escalate: 'always', human_reason: 'The write at the head of the source is wedged in its owner; restart the owner process writer status names.' },
  { code: 'recovery_required', class: 'systemic', safe_actions: ['none'], needs_human: true, escalate: 'always', human_reason: 'A write needs recovery on the brain host (gbrain sources writer status --json names it).' },
  { code: 'owner_unavailable', class: 'systemic', safe_actions: ['none'], needs_human: true, escalate: 'always', human_reason: 'The write owner is gone; start or restart it on the brain host.' },
  { code: 'writer_coordinator_required', class: 'systemic', safe_actions: ['none'], needs_human: true, escalate: 'always', human_reason: 'Managed persistence is not active for this source; activate it or sync unmanaged.' },
  { code: 'permission_denied', class: 'systemic', safe_actions: ['none'], needs_human: true, escalate: 'always', human_reason: 'This principal may not sync the source; the owner grants it.' },
  { code: 'plan_stale', class: 'systemic', safe_actions: ['none'], needs_human: true, escalate: 'always', human_reason: 'The approved company-brain manifest changed; inspect and approve the repository again.' },
  { code: 'invalid_params', class: 'systemic', safe_actions: ['none'], needs_human: true, escalate: 'always', human_reason: 'The resume options conflict with the stored cursor; use the resume command the error prints.' },
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
    return `gbrain could not decide whether \`${input.path}\`${other ? ` and page \`${other}\`` : ' and the page its slug: line names'} are the same page; decide which keeps the slug: `
      + `remove the slug: line of \`${input.path}\` if they differ, or merge them by hand and delete the duplicate, then commit; the hold clears on the next sync.`;
  }
  return undefined;
}

export interface SyncFaultVerdict { class: SyncFaultClass; safe_actions: SyncSafeAction[]; needs_human: boolean; human_reason?: string }

/**
 * The verdict for one fault. `attempts` is a hold's re-hold count: a page held `HOLD_ATTEMPTS_NEEDS_HUMAN` times with the
 * same code keeps moving under the sync, so its own safe action is exhausted and a person is named. `detail` is a receipt's
 * `reason` (for example `pinned_git_worktree_conflict` under `source_changed`) or a drain stop's `cause`; it refines the code
 * when the table knows it. `content_repair` is a slug-conflict hold's recorded verdict: a recommended merge or an
 * undecidable pair names a person. An unknown code is systemic and human: an agent must not guess at it.
 */
export function classifySyncFault(input: { code: string; detail?: string | null; attempts?: number | null; message?: string | null; content_repair?: ContentRepairHoldInput | null }): SyncFaultVerdict {
  const judged = input.content_repair && input.code === 'frontmatter_slug_conflict' ? contentRepairHumanReason(input.content_repair) : undefined;
  if (judged) return { class: 'page', safe_actions: ['none'], needs_human: true, human_reason: judged };
  const rule = (input.detail ? BY_CODE.get(input.detail) : undefined) ?? BY_CODE.get(input.code)
    ?? (/ECONN|ETIMEDOUT|EPIPE|connection.*closed|CONNECTION_ENDED/i.test(input.message ?? '') ? BY_CODE.get('connection_lost') : undefined);
  if (!rule) return { class: 'systemic', safe_actions: ['none'], needs_human: true, human_reason: `Unknown code ${input.code}; run gbrain doctor --json and read gbrain errors ${input.code}.` };
  const exhausted = !rule.needs_human && (input.attempts ?? 0) >= HOLD_ATTEMPTS_NEEDS_HUMAN && rule.safe_actions[0] !== 'none' && rule.class === 'page';
  if (!exhausted) return { class: rule.class, safe_actions: rule.safe_actions, needs_human: rule.needs_human, ...(rule.needs_human && rule.human_reason ? { human_reason: rule.human_reason } : {}) };
  return { class: rule.class, safe_actions: ['none'], needs_human: true,
    human_reason: `${rule.human_reason ?? 'The page keeps moving under the sync.'} (held ${input.attempts} times with code ${rule.code})` };
}
