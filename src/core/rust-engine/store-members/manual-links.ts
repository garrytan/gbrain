/**
 * The managed link-edit and links-fence projection statements (BrainEngine manualLinkStore; SQL in
 * engine-sql/manual-links.ts), served from the store's link, page and link-transition records (gbrain-store
 * `link_queries::manual_links`).
 *
 * Each read is one `manualLinkRows({ kind, ... })` call and each write one `manualLinkWrite({ kind, ... })` call, with
 * the answers of the SQL they replace. `identityHasSource` is true: the store's link-transition identity always
 * carries the link source (schema v302's index).
 *
 * While the managed_persistence hold is on (every user's Rust brain), each call refuses exactly as the executeRaw it
 * replaced did (managed-hold.ts).
 */
import type { ManualLinkStore, ManualRelationship } from '../../engine-sql/manual-links.ts';
import type { RustEngine } from '../../rust-engine.ts';
import type { StoreBrain } from '../store.ts';
import { storeCall } from './common.ts';
import { heldStore } from './managed-hold.ts';

const MEMBER = 'manualLinkStore';

function rustManualLinkStore(brain: StoreBrain): ManualLinkStore {
  const call = <T>(run: () => Promise<T>): Promise<T> => storeCall({ member: MEMBER }, run);
  const rows = <T>(kind: string, args: Record<string, unknown>): Promise<T> => call<T>(() => brain.manualLinkRows({ kind, ...args }));
  const write = <T>(kind: string, args: Record<string, unknown>): Promise<T> => call<T>(() => brain.manualLinkWrite({ kind, ...args }));
  const relation = (rel: ManualRelationship) => ({ ...rel, managedSources: [...rel.managedSources] });
  return {
    fencedEdges: (pageId, originField) => rows('fenced_edges', { pageId, originField }),
    manualStatements: pageId => rows('manual_statements', { pageId }),
    fencedTargets: (pageId, originField) => rows('fenced_targets', { pageId, originField }),
    async deleteDatabaseOnly(rel) { await write('delete_database_only', { rel: relation(rel) }); },
    countRelationship: rel => rows('count_relationship', { rel: relation(rel) }),
    dropRelationship: (rel, withFenced) => write('drop_relationship', { rel: relation(rel), withFenced }),
    deleteRowTransitions: (pageId, originField, list) => write('delete_row_transitions', { pageId, originField, rows: [...list] }),
    derivedEdges: rel => rows('derived_edges', { rel: relation(rel) }),
    pageIds: (sourceId, slugs) => rows('page_ids', { sourceId, slugs: [...slugs] }),
    fenceEdges: (pageId, originField) => rows('fence_edges', { pageId, originField }),
    fenceTransitions: pageId => rows('fence_transitions', { pageId }),
    async deleteLinks(pageId, ids) { await write('delete_links', { pageId, ids: [...ids] }); },
    async updateContexts(pageId, list) { await write('update_contexts', { pageId, rows: [...list] }); },
    async insertFenceLinks(pageId, originField, list) { await write('insert_fence_links', { pageId, originField, rows: [...list] }); },
    async deleteTransitions(ids) { await write('delete_transitions', { ids: [...ids] }); },
    async insertTransitions(sourceId, pageId, list) { await write('insert_transitions', { sourceId, pageId, rows: [...list] }); },
    async identityHasSource() { return true; },
  };
}

/** `manualLinkStore()`: the store over this engine's store handle; called on a transaction, every call runs in it. */
export const manualLinkStore = async function manualLinkStore(this: RustEngine, brain: StoreBrain): Promise<ManualLinkStore> {
  return heldStore(this, rustManualLinkStore(brain));
};
