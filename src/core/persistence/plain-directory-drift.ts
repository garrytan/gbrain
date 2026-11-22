/**
 * #8079: a plain-directory source has no Git history, so its sync cannot tell from the file alone whether the file or the
 * page moved last. Its import replaces a page only when the page's current revision was written with its file in step: by
 * a write whose receipt says it imported or wrote the file (a file import, a streamed import that left its file untouched, a
 * write-through), or one this sync saw agree with the file.
 * A page whose current revision a database-only write made (write-through off, a delete that kept its file) keeps it, and
 * the file is refused until a person picks a side.
 */
import type { BrainEngine } from '../engine.ts';
import type { PageSnapshot } from '../page-state/types.ts';
import { opError } from '../ops/contract.ts';

export const PLAIN_DIRECTORY_AGREED_OP = 'plain-directory-agreed';

type Exec = Pick<BrainEngine, 'executeRaw'>;

const IN_STEP = `(r.state='committed' AND r.source_id=p.source_id
  AND (COALESCE(r.outcome->'persistence'->>'file_written', r.outcome->'write_through'->>'written')='true'
    OR (r.outcome->>'imported_file'='true' AND NOT (r.outcome ? 'connector_database')))) IS TRUE`;
const AGREED = `EXISTS (SELECT 1 FROM op_checkpoints c WHERE c.op=$3 AND c.fingerprint=$4 AND c.completed_keys->0->>'revision'=p.knowledge_revision::text)`;
const FROM_PAGE = 'FROM pages p LEFT JOIN persistence_requests r ON r.id=p.revision_write_request_id WHERE p.id=$1 AND p.knowledge_revision::text=$2';
const params = (sourceId: string, incarnation: string, snapshot: PageSnapshot) =>
  [snapshot.page.id, snapshot.revision, PLAIN_DIRECTORY_AGREED_OP, `${sourceId}:${incarnation}:${snapshot.page.id}`];

/** Refuses an import that would replace `snapshot` when a database-only write made its revision; a page that moved since is the revision check's to refuse. */
export async function assertPlainDirectoryFileInStep(engine: Exec, sourceId: string, incarnation: string, snapshot: PageSnapshot, inputPath: string): Promise<void> {
  const [row] = await engine.executeRaw<{ in_step: boolean }>(`SELECT ${IN_STEP} OR ${AGREED} AS in_step ${FROM_PAGE}`, params(sourceId, incarnation, snapshot));
  if (!row || row.in_step) return;
  const slug = snapshot.page.slug;
  throw opError('file_drift', `Sync kept page ${slug}: it was changed in the database after its file was last imported, and ${inputPath} differs from it.`,
    `Nothing was imported for this file and the rest of source ${sourceId} synced. Ask the user which version wins: to keep the database edit, update the file to match the page (gbrain get ${slug} --source-id ${sourceId}) and sync again; to keep the file, import it explicitly with gbrain import ${inputPath} --source ${sourceId}.`,
    { reason: 'plain_directory', why: 'A plain directory has no Git history, so sync cannot prove the file is newer than the database edit; importing it would overwrite that edit.',
      fix: { argv: ['gbrain', 'import', inputPath, '--source', sourceId], consent: [], actor: 'user', ask_user: true, requires_exclusive: false,
        user_message: `Page ${slug} was edited in the database, and its file ${inputPath} still holds a different version. Should I keep the database edit (I will update the file) or import the file over it?`,
        why: 'Imports the file as it is now over the database edit; run it only after the user picks the file.' } });
}

/** After an import screen found the file and `snapshot` agree, records that agreement when no file write made that revision, so a later file edit syncs. */
export async function recordPlainDirectoryAgreement(engine: Exec, sourceId: string, incarnation: string, snapshot: PageSnapshot): Promise<void> {
  await engine.executeRaw(`INSERT INTO op_checkpoints(op,fingerprint,completed_keys)
    SELECT $3,$4,jsonb_build_array(jsonb_build_object('source_id',$5::text,'incarnation',$6::text,'page_id',p.id,'revision',p.knowledge_revision::text)) ${FROM_PAGE}
      AND NOT ${IN_STEP} AND NOT ${AGREED}
    ON CONFLICT(op,fingerprint) DO UPDATE SET completed_keys=EXCLUDED.completed_keys,updated_at=now()`, [...params(sourceId, incarnation, snapshot), sourceId, incarnation]);
}
