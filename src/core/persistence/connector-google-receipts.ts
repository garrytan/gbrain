import type { BrainEngine } from '../engine.ts';
import type { PageSnapshot } from '../page-state/types.ts';
import type { WriteRequest } from './model.ts';
import type { PreparedMutation } from './coordinator.ts';
import { opError, type OperationError } from '../ops/contract.ts';
import { digest } from './digest.ts';
import { contentHash } from '../utils.ts';
import { serializePageToMarkdown } from '../markdown.ts';
import { prepareFileTarget } from './page-prepare.ts';
import { installPageProjection, preparePageProjection, readProjectionSnapshot } from '../page-state/projections.ts';
import type { GmailThreadAttachmentReceipts } from '../google/types.ts';

export type GoogleReceipts = GmailThreadAttachmentReceipts;

/** A receipt patch refused on ownership or bounds: permanent for this page, so the next step is reading it, never repeating the repair. */
function receiptOwnershipRefusal(message: string, snapshot: PageSnapshot | null, cause: string): OperationError {
  const page = snapshot?.page;
  if (!page) return opError('revision_conflict', message, `${cause} The page is missing, so there is nothing to repair; repeating the repair does not change this.`);
  return opError('revision_conflict', message, `${cause} Page ${page.slug} in ${page.source_id} was left untouched and repeating the repair does not change this; `
    + 'read its frontmatter and tell the user if its attachment metadata needs a manual fix.', {
    fix: { argv: ['gbrain', 'get', '--source', page.source_id, '--', page.slug], consent: [], actor: 'agent', requires_exclusive: false,
      why: 'Shows the frontmatter the attachment repair refused to change.' },
  });
}

/** The Gmail page moved under an admitted receipt patch: the receipt is read first, then the repair re-reads the current page. */
function receiptRaceRefusal(message: string, row: WriteRequest): OperationError {
  return opError('revision_conflict', message, `Page ${row.slug} in ${row.source_id} changed while its attachment receipts were being patched, so request ${row.request_id} was refused and the content was preserved. `
    + `Read its receipt first (gbrain write-request -- ${row.request_id}); once it is final, gbrain google attachments backfill --source ${row.source_id} --retry-failed re-reads the current page.`, {
    fix: { argv: ['gbrain', 'write-request', '--', row.request_id], consent: [], actor: 'agent', requires_exclusive: false,
      why: 'The receipt confirms whether the metadata patch published before anything is resubmitted.' },
  });
}

/** `account` is the parsed connector account (connector-identity.ts), never read from raw source config. */
export function ownedGoogleReceipts(snapshot: PageSnapshot | null, account: string, receipts: GoogleReceipts): GoogleReceipts {
  const page = snapshot?.page;
  const fm = page?.frontmatter;
  if (!page || page.deleted_at || page.type !== 'email' || !page.source_path?.startsWith('emails/') ||
    !account || account !== receipts.account || fm?.account !== receipts.account ||
    fm.thread_id !== receipts.threadId || !Array.isArray(fm.message_ids) || !fm.message_ids.length ||
    !fm.message_ids.every(id => typeof id === 'string' && /^[A-Za-z0-9]{1,128}$/.test(id)) || fm.message_ids.length > 512 ||
    new Set(fm.message_ids).size !== fm.message_ids.length || receipts.version !== 1 || !Array.isArray(receipts.messages) ||
    (receipts.unavailable !== undefined && receipts.unavailable !== 'thread_not_found') ||
    (!receipts.messages.length && !receipts.unavailable) || receipts.messages.length > 512 || Buffer.byteLength(JSON.stringify(receipts)) > 131_072) {
    throw receiptOwnershipRefusal('Historical Gmail receipt ownership is unknown or metadata exceeds the repair bound. Content was preserved.', snapshot,
      'The page is not a connector-owned email of this Google account and thread, or its receipts exceed the repair bound (512 messages, 128 KiB).');
  }
  const prior = fm.gmail_attachment_receipts as GoogleReceipts | undefined;
  if (prior !== undefined && (prior?.version !== 1 || prior.account !== receipts.account || prior.threadId !== receipts.threadId || !Array.isArray(prior.messages) ||
    prior.messages.length > 512 || Buffer.byteLength(JSON.stringify(prior)) > 131_072)) {
    throw receiptOwnershipRefusal('The attachment metadata field is not connector-owned. Content was preserved.', snapshot,
      'The existing gmail_attachment_receipts field was not written by this connector for this account and thread.');
  }
  const messageIds = fm.message_ids as string[];
  for (const entries of [receipts.messages, prior?.messages ?? []]) {
    if (new Set(entries.map(m => m?.messageId)).size !== entries.length || entries.some(m =>
      !m || typeof m.messageId !== 'string' || !m.messageId ||
      (m.unavailable !== undefined && !['thread_not_found', 'message_not_found'].includes(m.unavailable)) ||
      !['not_inspected', 'incomplete', 'none', 'present'].includes(m.inspection?.state) || !Array.isArray(m.inspection.attachments) ||
      m.inspection.attachments.some(a => !a || a.account !== receipts.account || a.messageId !== m.messageId || a.fetched !== false || a.indexed !== false))) {
      throw receiptOwnershipRefusal('Gmail receipt identity or ownership is unknown. Content was preserved.', snapshot,
        'A message receipt is duplicated, malformed, or names attachments of another account or message.');
    }
  }
  if (prior?.messages.some(m => !messageIds.includes(m.messageId))) {
    throw receiptOwnershipRefusal('Existing Gmail receipts do not match the historical message identities. Content was preserved.', snapshot,
      'The stored receipts name messages that are not in the page\'s message_ids.');
  }
  if (!receipts.unavailable && messageIds.some(id => !receipts.messages.some(m => m.messageId === id)) &&
    receipts.messages.some(m => m.inspection.state === 'incomplete' || m.inspection.state === 'not_inspected')) {
    throw receiptOwnershipRefusal('Incomplete Gmail metadata cannot establish disappearance. Content was preserved.', snapshot,
      'Gmail returned incomplete metadata, so a missing message cannot be recorded as gone.');
  }
  const selected = messageIds.map(messageId => {
    const incoming = receipts.messages.find(m => m.messageId === messageId);
    if (incoming && !receipts.unavailable && !incoming.unavailable) return incoming;
    const previous = prior?.messages.find(m => m.messageId === messageId) ?? incoming;
    return { ...previous, messageId, inspection: previous?.inspection ?? { state: 'not_inspected' as const, attachments: [] },
      unavailable: receipts.unavailable ?? incoming?.unavailable ?? 'message_not_found' as const };
  });
  const merged = { ...prior, ...receipts, messages: selected };
  if (!receipts.unavailable) delete merged.unavailable;
  if (Buffer.byteLength(JSON.stringify(merged)) > 131_072) {
    throw receiptOwnershipRefusal('Preserved Gmail receipts exceed the repair bound. Content was preserved.', snapshot,
      'The merged receipts would exceed the 128 KiB repair bound.');
  }
  return merged;
}

export async function prepareGoogleReceiptPatch(engine: BrainEngine, row: WriteRequest, snapshot: PageSnapshot | null,
  account: string, supplied: GoogleReceipts): Promise<PreparedMutation> {
  const receipts = ownedGoogleReceipts(snapshot, account, supplied);
  const current = snapshot!;
  const frontmatter = { ...current.page.frontmatter, gmail_attachment_receipts: receipts };
  const page = { ...current.page, frontmatter };
  const noop = digest(current.page.frontmatter.gmail_attachment_receipts ?? null) === digest(receipts);
  const target = await prepareFileTarget(engine, row, current, serializePageToMarkdown(page, current.tags));
  const file = target && { ...target, publishMode: 0o600 };
  const projection = noop ? null : await readProjectionSnapshot(engine, row.slug, row.source_id, { allowUnsealed: true });
  if (!noop && (!projection || projection.snapshot.revision !== current.revision)) throw receiptRaceRefusal('The Gmail page changed during receipt preparation.', row);
  const chunks = projection ? await preparePageProjection(projection) : null;
  return { observedRevision: current.revision, sourceExclusive: true, deferEmbedding: true, noop, file,
    apply: async tx => {
      if (!noop) {
        const liveProjection = await readProjectionSnapshot(tx, row.slug, row.source_id, { allowUnsealed: true });
        if (!liveProjection || liveProjection.indexingContext !== projection!.indexingContext ||
          digest(liveProjection.chunks) !== digest(projection!.chunks)) {
          throw receiptRaceRefusal('The Gmail projection changed during receipt preparation.', row);
        }
        await tx.createVersion(row.slug, { sourceId: row.source_id });
        const changed = await tx.executeRaw(`UPDATE pages SET frontmatter=jsonb_set(frontmatter,'{gmail_attachment_receipts}',$3::text::jsonb),content_hash=$4,updated_at=now()
          WHERE source_id=$1 AND slug=$2 AND id=$5 AND knowledge_revision=$6::uuid AND deleted_at IS NULL RETURNING id`,
        [row.source_id, row.slug, JSON.stringify(receipts), contentHash({ ...page, tags: current.tags }), current.page.id, current.revision]);
        if (changed.length !== 1) throw receiptRaceRefusal('The Gmail page changed before metadata publication.', row);
        const next = await readProjectionSnapshot(tx, row.slug, row.source_id, { allowUnsealed: true });
        if (!next || !chunks) throw receiptRaceRefusal('The Gmail receipt projection is unavailable.', row);
        await installPageProjection(tx, next, chunks.chunks, { seal: true, preserveEmbeddings: true, code: chunks.code });
      }
      return { status: noop ? 'skipped' : 'updated', slug: row.slug, source_id: row.source_id, noop, attachment_metadata_only: true };
    } };
}
