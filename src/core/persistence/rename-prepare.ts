import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import { OperationError, opError } from '../ops/contract.ts';
import { assertPageRevision } from '../page-state/types.ts';
import { sealPageTextProjection } from '../page-state/projections.ts';
import { assertKnowledgePublicationAllowed } from '../shared-skills/knowledge-guard.ts';
import { engineMutationPrecondition, parseMutationPrecondition } from './preconditions.ts';
import { getWorktreeBinding } from './ownership.ts';
import { pageIdentityError } from './page-identity.ts';
import { pageFix, pageRefusal } from './page-prepare.ts';
import type { PreparedMutation } from './coordinator.ts';
import type { WriteRequest } from './model.ts';

/**
 * rename_page moves a page row to a new slug in the database only. A source
 * with a working tree (sources.local_path, sync.repo_path for `default`, or a
 * canonical worktree binding) keeps its pages as files whose paths ARE their
 * slugs; renaming the row without moving the file would make the next sync
 * re-import the old file as a new page. Those sources rename through Git
 * (`git mv`, commit, sync), whose rename detection runs this same updateSlug.
 */
export async function sourceHasWorkingTree(engine: BrainEngine, sourceId: string): Promise<boolean> {
  const [source] = await engine.executeRaw<{ local_path: string | null }>('SELECT local_path FROM sources WHERE id=$1', [sourceId]);
  if (source?.local_path) return true;
  if (sourceId === 'default' && await engine.getConfig('sync.repo_path')) return true;
  return (await getWorktreeBinding(engine, sourceId, null)) !== null;
}

export function renameWorkingTreeRefusal(sourceId: string): OperationError {
  const error = new OperationError('source_writeback_required',
    `rename_page renames database-canonical pages only; source '${sourceId}' has a working tree whose file paths are its slugs.`,
    'Move the file in the working tree (git mv <old>.md <new>.md), commit, then run gbrain sync for this source: sync rename detection keeps the page id and records the old slug as an alias.');
  error.detail = 'rename_requires_file_move';
  return error;
}

/** The rename target, from the admitted intent. Submission normalizes it before admission. */
export function renameTargetSlug(row: WriteRequest): string {
  const target = row.intent?.new_slug;
  if (typeof target !== 'string' || !target) throw pageRefusal('storage_error', 'A pending rename lost its target slug.', row,
    `The stored intent for renaming ${row.slug} has no new_slug, so the rename cannot be published and moved nothing.`);
  return target;
}

/**
 * Refuse a target slug that is occupied in this source: by a live page, by a
 * soft-deleted page (the (source_id, slug) key is still held), or by a slug
 * alias that redirects somewhere other than the page being renamed (taking the
 * slug over would silently drop that redirect).
 */
async function assertRenameTargetFree(engine: BrainEngine, sourceId: string, oldSlug: string, newSlug: string): Promise<void> {
  const occupant = await engine.readPageSnapshot(newSlug, { sourceId, includeDeleted: true });
  if (occupant) {
    throw new OperationError('slug_conflict', occupant.page.deleted_at
      ? `Cannot rename to '${newSlug}': a soft-deleted page still holds that slug in source '${sourceId}'.`
      : `Cannot rename to '${newSlug}': a page with that slug already exists in source '${sourceId}'.`,
    occupant.page.deleted_at
      ? `Restore and rename or merge that page, or purge it (gbrain delete ${newSlug} --purge on the brain host), then retry with a new request_id.`
      : 'Choose a different new_slug, or merge the two pages with put_page and delete_page; retry with a new request_id.');
  }
  const aliases = await engine.executeRaw<{ canonical_slug: string }>(
    'SELECT canonical_slug FROM slug_aliases WHERE source_id=$1 AND alias_slug=$2', [sourceId, newSlug]);
  const foreign = aliases.find(alias => alias.canonical_slug !== oldSlug);
  if (foreign) {
    throw new OperationError('slug_conflict',
      `Cannot rename to '${newSlug}': it is a slug alias that redirects to '${foreign.canonical_slug}' in source '${sourceId}'.`,
      'Choose a different new_slug; renaming onto the alias would break the redirect. Retry with a new request_id.');
  }
}

/**
 * Coordinated rename: the page row moves with engine.updateSlug inside the
 * journal publication transaction, so page_id (and with it chunks, links,
 * tags, timeline, versions and takes) is unchanged; updateSlug records
 * `old -> new` in slug_aliases and moves slug-keyed facts, fact withdrawals
 * and page_aliases in the same transaction. Nothing is deleted or recreated.
 */
export async function prepareRenameMutation(engine: BrainEngine, row: WriteRequest, _config: GBrainConfig, signal?: AbortSignal): Promise<PreparedMutation> {
  signal?.throwIfAborted();
  if (!row.intent) throw pageRefusal('storage_error', 'A pending write lost its normalized intent.', row,
    `The request has no stored intent for ${row.slug} (its payload was compacted or never recorded), so it cannot be published and wrote nothing.`);
  const newSlug = renameTargetSlug(row);
  const source = { sourceId: row.source_id };
  await assertKnowledgePublicationAllowed(engine, row);
  await assertKnowledgePublicationAllowed(engine, { ...row, slug: newSlug });
  if (row.worktree_id || await sourceHasWorkingTree(engine, row.source_id)) throw renameWorkingTreeRefusal(row.source_id);
  const snapshot = await engine.readPageSnapshot(row.slug, { ...source, includeDeleted: true });
  signal?.throwIfAborted();
  assertPageRevision(snapshot, engineMutationPrecondition(parseMutationPrecondition(row.intent)));
  if ((snapshot?.page.id ?? null) !== row.page_id) throw pageIdentityError(snapshot != null || row.page_id === null, 'The accepted page identity changed.');
  if (!snapshot) throw pageRefusal('page_not_found', 'Page not found.', row,
    `Page ${row.slug} does not exist in source ${row.source_id}, so nothing was renamed. Check the slug and the source.`, pageFix(row.source_id, row.slug));
  if (snapshot.page.deleted_at) {
    throw new OperationError('page_not_found', `Page '${row.slug}' is soft-deleted; only live pages can be renamed.`,
      'Restore it with restore_page first, then rename it with its new revision.');
  }
  await assertRenameTargetFree(engine, row.source_id, row.slug, newSlug);
  return {
    observedRevision: snapshot.revision,
    additionalPageKeys: [{ sourceId: row.source_id, slug: newSlug }],
    // The coordinator already holds both page keys here and has rechecked the
    // old page's identity and revision; the target is rechecked under the lock.
    validate: async tx => { await assertRenameTargetFree(tx, row.source_id, row.slug, newSlug); },
    apply: async tx => {
      const moved = await tx.updateSlug(row.slug, newSlug, source);
      if (moved !== 1) throw opError('page_identity_changed', 'The page could not move to its new slug.',
        `No page was at ${row.slug} when the rename ran, so nothing was committed. Read the page and its revision before deciding to submit the rename again with a new request_id.`);
      // A slug change advances the knowledge revision; reseal the text
      // projection so search does not queue a reindex of unchanged content.
      await sealPageTextProjection(tx, newSlug, row.source_id);
      const renamed = await tx.readPageSnapshot(newSlug, source);
      if (!renamed || renamed.page.id !== snapshot.page.id) throw opError('page_identity_changed', 'The renamed page is not readable at its new slug.',
        `Page ${row.slug} could not be read back as the same page at ${newSlug}, so the rename rolled back and nothing was committed. Read both slugs before deciding to submit the rename again with a new request_id.`);
      // The redirect is the point of a rename: read it back rather than trust
      // updateSlug, which skips the alias on a schema without slug_aliases.
      const [alias] = await tx.executeRaw<{ canonical_slug: string }>(
        'SELECT canonical_slug FROM slug_aliases WHERE source_id=$1 AND alias_slug=$2', [row.source_id, row.slug]);
      if (alias?.canonical_slug !== newSlug) throw opError('storage_error', 'The rename did not record a redirect from the old slug; nothing was committed.',
        `Page ${row.slug} keeps its slug: its redirect to ${newSlug} was not stored in slug_aliases, so the rename rolled back. Doctor on the brain host reports a schema behind this gbrain; otherwise something on that table (a trigger or rule) dropped the insert. Submit the rename again with a new request_id once the redirect can be stored.`);
      return { status: 'renamed', slug: newSlug, renamed_from: row.slug, source_id: row.source_id, page_id: renamed.page.id,
        revision: renamed.revision, alias: { alias_slug: row.slug, canonical_slug: alias.canonical_slug } };
    },
  };
}
