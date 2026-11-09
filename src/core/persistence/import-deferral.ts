/**
 * GST-1582 (docs/designs/REFRESH_WRITE_BARRIER.md, "Writes that wait for an import"): with the refresh write barrier on, a
 * put_page, capture, remember or add_timeline_entry whose page file holds a committed change managed sync has not imported yet is not refused
 * `pending_import`. The consumer moves its own claim back to `deferred`, naming the source's last imported commit, and the
 * row waits (invisible to claims, journal.ts RELEASED_DEFERRED) until `sources.last_commit` moves past it. It is then
 * prepared again from scratch, as if it had queued behind the import: a remember or add_timeline_entry applies on top, a put_page
 * with expected_revision ends revision_conflict when the import moved the page, and a blind put_page or a capture lands. A blind
 * put_page or a capture that replaces content the import brought in names what it replaced (`supersedes`) on its receipt, in a
 * `gbrain-supersedes:` commit trailer and on the commit ledger line; the replaced revision stays in page history and
 * the imported commit in git. A held write whose import never lands ends `pending_import_expired` (refresh-barrier.ts).
 */
import { relative, sep } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import type { PreparedMutation } from './coordinator.ts';
import { completeWrite, deferralRoom, IMPORT_HOLD_CAPABILITY, publicationGroupKey, REFRESH_BARRIER_CLAIM_PREDICATE } from './journal.ts';
import { deferredReplayRefusal } from './refresh-barrier.ts';
import type { WriteRequest } from './model.ts';
import { fileAtCommit, landedCommit } from './pending-import.ts';
import { sha256 } from './digest.ts';
import { PERSISTENCE_PROTOCOL_PREDICATE } from './protocol.ts';
import { writeSwitchOn } from './switches.ts';

const IMPORT_HELD_OPERATIONS = ['put_page', 'capture', 'remember', 'add_timeline_entry'];
/** A held write that renders the caller's whole body over the imported page, so it names what it replaced. */
const REPLACING_OPERATIONS = ['put_page', 'capture'];
export const SUPERSEDES_TRAILER_KEY = 'gbrain-supersedes';

/**
 * A claimed write whose preparation was refused `pending_import` (`importFrom`: the last imported commit the check saw),
 * moved back to `deferred` behind that import; null when it keeps the refusal (barrier off, another operation, a batch, a
 * live consumer on the owner host that cannot claim a held write).
 * GST-1623: a write that waited behind a refresh is checked against that refresh first, on the file the refusal compared
 * (`importFile`): a refresh that changed it, or a later write that committed first, ends the write here as its replay would
 * have. Otherwise the hold drops the released `deferred_refresh_id`, so a consumer older than the import hold, which claims a
 * deferred row once its refresh is released, never claims a row whose import is still pending (the v294 guard refuses it).
 */
export async function holdForImport(engine: BrainEngine, row: WriteRequest, error: unknown): Promise<WriteRequest | null> {
  const from = (error as { importFrom?: unknown } | null)?.importFrom;
  if (typeof from !== 'string' || !IMPORT_HELD_OPERATIONS.includes(row.operation) || (row.target_kind ?? 'page') !== 'page' || !row.worktree_id
    || publicationGroupKey(row) !== null || !await writeSwitchOn(engine, 'refresh_barrier').catch(() => false)
    || !await deferralRoom(engine, row.worktree_id, IMPORT_HOLD_CAPABILITY)) return null;
  if (row.deferred_refresh_id) {
    const file = (error as { importFile?: { root: string; path: string } }).importFile;
    if (!file) return null;
    const refusal = await deferredReplayRefusal(engine, row, [file]);
    if (refusal) return engine.transaction(tx => completeWrite(tx, row, refusal.state, {}, refusal.failure));
  }
  const [held] = await engine.executeRaw<WriteRequest>(`UPDATE persistence_requests SET state='deferred',deferred_import_from=$3,deferred_refresh_id=NULL,execution_token=NULL,
    claim_expires_at=NULL,blocked_reason=NULL,claim_phase=NULL,updated_at=now()
    WHERE id=$1::uuid AND execution_token=$2::uuid AND state='running' AND recovery IS NULL AND publication_started=false
      AND ${PERSISTENCE_PROTOCOL_PREDICATE} AND ${REFRESH_BARRIER_CLAIM_PREDICATE} RETURNING *`, [row.id, row.execution_token, from]);
  return held ?? null;
}

/** The trailer value a superseding write commits with: `<path>: revision <revision> from <commit>`. */
const supersedesNote = (path: string, revision: string, commit: string) => `${path}: revision ${revision} from ${commit}`;

/** The `gbrain-supersedes:` values among a commit's notes, for its ledger line. */
export function supersededBy(trailers: Iterable<string>): string[] {
  const key = `${SUPERSEDES_TRAILER_KEY}: `;
  return [...trailers].filter(trailer => trailer.startsWith(key)).map(trailer => trailer.slice(key.length));
}

/**
 * A put_page or capture that was held for an import and replaces the page the import wrote: its outcome carries `supersedes`
 * (slug, path, the replaced revision, the imported commit) and its commit the matching trailer. #8759: a capture of an
 * in-source file whose import brought in that very file (the captured bytes) replaced nothing of anyone else's, so it names none.
 */
export async function withSupersedes(row: WriteRequest, prepared: PreparedMutation): Promise<PreparedMutation> {
  if (row.deferred_import_from == null || !REPLACING_OPERATIONS.includes(row.operation) || !prepared.file || prepared.noop || !prepared.observedRevision) return prepared;
  const { root, path } = prepared.file;
  const commit = await landedCommit(root, row.deferred_import_from || null, path);
  if (!commit) return prepared;
  const captured = row.operation === 'capture' ? row.intent?.capture_file_hash : undefined;
  if (typeof captured === 'string') {
    const imported = await fileAtCommit(root, commit, path);
    if (imported !== null && sha256(imported) === captured) return prepared;
  }
  const rel = relative(root, path).split(sep).join('/');
  const supersedes = { slug: row.slug, path: rel, revision: prepared.observedRevision, commit };
  const trailer = `${SUPERSEDES_TRAILER_KEY}: ${supersedesNote(rel, prepared.observedRevision, commit)}`;
  const note = prepared.file.commit;
  prepared.file.commit = note ? { ...note, trailers: [...(note.trailers ?? []), trailer] } : { subject: '', line: '', trailers: [trailer] };
  const apply = prepared.apply.bind(prepared);
  prepared.apply = async (tx, preimage) => ({ ...await apply(tx, preimage), supersedes });
  return prepared;
}
