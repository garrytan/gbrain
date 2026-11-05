/**
 * GBRA-217: a human reason on a page write. One canonical form for every source of a reason (a caller's
 * `reason` parameter, a Git `gbrain-reason:` trailer), admitted before the write request is journaled.
 *
 * Where it lands: the snapshot a write archives carries it (`page_versions.change_reason`, read back as
 * `replaced_because`), and a write whose file reaches Git carries it in the commit as a path-mapped
 * trailer `gbrain-reason: <path>: <text>`. A private page never puts its reason in a commit message, and
 * a repo-less brain keeps it in the database alone (`reason_recorded.git: 'no_repository'`).
 */
import { relative, sep } from 'node:path';
import { opError } from '../ops/contract.ts';
import { scanTextSpans } from '../secret-scan.ts';
import { privatePagesFilterFragment } from '../search/private-visibility.ts';
import type { GitCommitNote } from './effect-model.ts';
import { sourceCanonicalGit } from './git-door.ts';
import type { SqlEngine, WriteRequest } from './model.ts';
import type { PreparedMutation } from './coordinator.ts';
import type { Notice } from '../agent-output.ts';

export const CHANGE_REASON_MAX = 500;
export const CHANGE_REASON_OPERATIONS: readonly string[] = ['put_page', 'edit_page', 'revert_version'];
export const REASON_TRAILER_KEY = 'gbrain-reason';
const DOCS = 'docs/guides/page-history.md#reasons';

/** Tabs and line breaks become spaces, other control characters go, runs of spaces collapse; empty means absent. */
export function canonicalChangeReason(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.replace(/[\t\n\r\u2028\u2029]/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '').replace(/ {2,}/g, ' ').trim();
  return text || null;
}

/**
 * Admission: the canonical reason, or a refusal before anything is journaled. The value is never echoed: an over-long
 * reason is refused by its length, and a secret by the detector that matched.
 */
export function admitChangeReason(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string') throw opError('invalid_params', 'reason must be a string.', 'Pass reason as one line of text, or omit it.');
  const reason = canonicalChangeReason(raw);
  if (reason === null) return null;
  const length = [...reason].length;
  if (length > CHANGE_REASON_MAX) {
    throw opError('change_reason_rejected', `reason is ${length} characters after normalisation; the limit is ${CHANGE_REASON_MAX}. Nothing was written.`,
      `Shorten reason to ${CHANGE_REASON_MAX} characters or fewer and retry the same request.`, { reason: 'reason_too_long', docs: DOCS, legacy_error: 'invalid_params' });
  }
  const hit = scanTextSpans(reason).find(span => span.finding !== null);
  if (hit) {
    const offset = [...reason.slice(0, hit.start)].length;
    throw opError('change_reason_rejected', `reason contains what looks like a secret (${hit.finding!.pattern} at character ${offset}). Nothing was written.`,
      'Remove the secret from reason and retry with a new request_id. A reason is stored in page history and can be pushed in a Git commit message.',
      { reason: 'reason_contains_secret', docs: DOCS, legacy_error: 'invalid_params' });
  }
  return reason;
}

/** The reason note for one path, merged into a note another preparer gave (a repair keeps its subject and trailer). */
export function withReasonNote(path: string, reason: string, base?: GitCommitNote): GitCommitNote {
  const trailer = `${REASON_TRAILER_KEY}: ${path}: ${reason}`;
  return base ? { ...base, trailers: [...(base.trailers ?? []), trailer] }
    : { subject: '', line: `${path}: ${reason}`, trailers: [trailer] };
}

/** A note without what `withReasonNote` added: a reason-only note goes, a merged one keeps its own subject, line and trailers. */
export function withoutReasonNote(note: GitCommitNote): GitCommitNote | undefined {
  const key = `${REASON_TRAILER_KEY}: `;
  const reasons = (note.trailers ?? []).filter(trailer => trailer.startsWith(key)).map(trailer => trailer.slice(key.length));
  if (!reasons.length) return note;
  if (note.subject === '' && reasons.includes(note.line)) return undefined;
  const trailers = (note.trailers ?? []).filter(trailer => !trailer.startsWith(key));
  return { subject: note.subject, line: note.line, ...(trailers.length ? { trailers } : {}) };
}

async function pageWorldVisible(engine: SqlEngine, sourceId: string, slug: string): Promise<boolean> {
  const [page] = await engine.executeRaw<{ world: boolean }>(
    `SELECT ${privatePagesFilterFragment('p')} AS world FROM pages p WHERE p.source_id = $1 AND p.slug = $2 AND p.deleted_at IS NULL`, [sourceId, slug]);
  return page?.world === true;
}

/**
 * The note a file commits with, checked against its page's visibility at commit time: a page that is not world-visible
 * any more (a later member of its group, or a later write, made it private) commits without its reason.
 */
export async function visibleCommitNote(engine: SqlEngine, sourceId: string, slug: unknown, note: GitCommitNote | undefined): Promise<GitCommitNote | undefined> {
  if (!note || typeof slug !== 'string' || withoutReasonNote(note) === note) return note;
  return await pageWorldVisible(engine, sourceId, slug) ? note : withoutReasonNote(note);
}

/**
 * A strict group, once every member has applied and before its one commit: each member's note checked as above, and a
 * member whose reason is dropped reports `git: 'private'` on its receipt.
 */
export async function settleGroupCommitNotes(engine: SqlEngine, members: Array<{ row: Pick<WriteRequest, 'source_id' | 'slug'>; note: GitCommitNote | undefined; outcome: Record<string, unknown> }>): Promise<Array<GitCommitNote | undefined>> {
  const notes: Array<GitCommitNote | undefined> = [];
  for (const { row, note, outcome } of members) {
    const visible = await visibleCommitNote(engine, row.source_id, row.slug, note);
    const recorded = outcome.reason_recorded as ReasonRecorded | undefined;
    if (visible !== note && recorded) outcome.reason_recorded = { ...recorded, git: 'private' };
    notes.push(visible);
  }
  return notes;
}

export type ReasonGit = 'committed' | 'queued' | 'superseded' | 'not_file_backed' | 'private' | 'no_repository' | 'none';
export interface ReasonRecorded { reason: string; version: boolean; version_why?: 'page_created' | 'no_change'; git: ReasonGit }

/**
 * Wraps a page publication so the snapshot its apply archives carries the reason, and its file's commit note carries the
 * trailer when the page that results is world-visible. The snapshot rows are the ones this transaction created for the
 * page (the page lock is held), whichever writer path made them.
 */
export function withChangeReason(row: WriteRequest, prepared: PreparedMutation): PreparedMutation {
  const reason = CHANGE_REASON_OPERATIONS.includes(row.operation) ? canonicalChangeReason(row.intent?.reason) : null;
  if (!reason) return prepared;
  const apply = prepared.apply.bind(prepared);
  prepared.apply = async (tx, preimage) => {
    const pageId = preimage?.page.id ?? null;
    const [before] = pageId === null ? [] : await tx.executeRaw<{ last: number | string | null }>('SELECT max(id) AS last FROM page_versions WHERE page_id = $1', [pageId]);
    const outcome = await apply(tx, preimage);
    const stamped = pageId === null || prepared.noop ? [] : await tx.executeRaw<{ id: number }>(
      'UPDATE page_versions SET change_reason = $2 WHERE page_id = $1 AND id > $3 RETURNING id', [pageId, reason, Number(before?.last ?? 0)]);
    const world = await pageWorldVisible(tx, row.source_id, row.slug);
    let git: ReasonGit;
    if (!prepared.file) git = row.authority.databaseOnlyReason === 'no_repo_configured' ? 'no_repository' : world ? 'not_file_backed' : 'private';
    else if (prepared.noop) git = 'none';
    else if (!world) git = 'private';
    else {
      prepared.file.commit = withReasonNote(relative(prepared.file.root, prepared.file.path).split(sep).join('/'), reason, prepared.file.commit);
      git = await sourceCanonicalGit(tx, row.source_id) ? 'committed' : 'queued';
    }
    const recorded: ReasonRecorded = { reason, version: stamped.length > 0, git,
      ...(stamped.length ? {} : { version_why: prepared.observedRevision === null ? 'page_created' : 'no_change' }) };
    return { ...outcome, reason_recorded: recorded };
  };
  return prepared;
}


/**
 * A receipt's `reason_recorded` once its Git effect settled. A non-strict write's Git effect is superseded when a newer
 * write to the same file commits first: that commit carries only the newer write's note, so this reason is in page
 * history but in no commit. The receipt then says `git: 'superseded'` with a degraded `reason_not_committed` notice.
 * Nothing needs fixing, and retrying the write would be wrong.
 */
export async function settledReasonRecorded(engine: SqlEngine, row: Pick<WriteRequest, 'id' | 'outcome'>): Promise<{ recorded: ReasonRecorded; notice: Notice } | null> {
  const recorded = row.outcome?.reason_recorded as ReasonRecorded | undefined;
  if (recorded?.git !== 'queued') return null;
  const [git] = await engine.executeRaw<{ outcome: Record<string, unknown> | null }>(
    "SELECT outcome FROM persistence_effects WHERE request_id = $1::uuid AND kind = 'git' AND state = 'committed'", [row.id]);
  if (git?.outcome?.git !== 'superseded') return null;
  return { recorded: { ...recorded, git: 'superseded' }, notice: { code: 'reason_not_committed', kind: 'degraded',
    why: 'This write\'s reason is kept in gbrain\'s page history (get_versions replaced_because), but not in a Git commit: a newer write to the same file committed first, carrying only its own reason. Nothing needs fixing; do not retry the write.' } };
}
