/**
 * The reads of get_write_attribution (BrainEngine readWriteAttributionNames through readRowAttribution; SQL in
 * engine-sql/write-attribution.ts), served by gbrain-store `write_attribution`. Every page, version, fact, take and
 * timeline write on the store stamps the receipts PGLite's attribution triggers stamp, so the reads answer the same rows.
 *
 * Names come from the store's `oauth_clients` and `access_tokens` rows (revoked tokens included, as the SQL reads
 * them). Takes keep no trust tier or write origin and read the column defaults. What each member answers: rust/docs/store/write_attribution.md.
 */
import type {
  ActorAttributionRow, PageRevisionAttributionRow, RowAttributionRow, RowAttributionTarget, VersionAttributionRow, VersionRef,
  WriteAttributionNameIds, WriteAttributionNames, WriteRequestAttributionRow,
} from '../../engine-sql/write-attribution.ts';
import { ownerOnlyTakeAllowedSql, ownerOnlyTimelineAllowedSql, privateFactFilterForReader } from '../../search/private-visibility.ts';
import { withDates } from '../store-codec.ts';
import { storeCall, type StoreMember } from './common.ts';
import { ownerOnlyFormIn, storePrivacyPolicy, type StoreOwnerOnlyForm } from './private-provenance.ts';

/** Names requests, OAuth clients, legacy tokens (revoked ones included) and local writers; an unknown id has no name. */
export const readWriteAttributionNames: StoreMember<[ids: WriteAttributionNameIds], WriteAttributionNames> = async (brain, ids) => {
  const member = 'readWriteAttributionNames';
  type Name = { id: string; name: string };
  const [requests, clients, tokens, writers] = await Promise.all([
    ids.requestIds.length
      ? storeCall({ member }, () => brain.readWriteRequestAttributions([...ids.requestIds])) as Promise<WriteRequestAttributionRow[]> : [],
    ids.oauthClientIds.length
      ? storeCall({ member }, () => brain.readOauthClientNames([...ids.oauthClientIds])) as Promise<Name[]> : [],
    ids.legacyTokenIds.length
      ? storeCall({ member }, () => brain.readAccessTokenNames([...ids.legacyTokenIds])) as Promise<Name[]> : [],
    ids.localWriterIds.length
      ? storeCall({ member }, () => brain.readLocalWriterLanes([...ids.localWriterIds])) as Promise<Array<{ id: string; lane: string }>> : [],
  ]);
  return { requests: requests.map(r => withDates(r, ['completed_at'])), clients, tokens, writers };
};

export const readPageRevisionAttribution: StoreMember<[pageId: number], PageRevisionAttributionRow | null> = (brain, pageId) =>
  storeCall({ member: 'readPageRevisionAttribution' }, () => brain.readPageRevisionAttribution(pageId));

/** Each version is looked up under its page: the store keys versions by page. */
export const readVersionAttributions: StoreMember<[versions: VersionRef[]], VersionAttributionRow[]> = async (brain, versions) => {
  if (!versions.length) return [];
  return storeCall({ member: 'readVersionAttributions' }, () =>
    brain.readVersionAttributions(versions.map(v => [Number(v.page_id), Number(v.id)])));
};

export const readOldestVersionAttribution: StoreMember<[pageId: number], ActorAttributionRow | null> = (brain, pageId) =>
  storeCall({ member: 'readOldestVersionAttribution' }, () => brain.readOldestVersionAttribution(pageId));

/**
 * The owner-only form a take or timeline row is read under (`ownerOnlyTakeAllowedSql` / `ownerOnlyTimelineAllowedSql`):
 * 'off' for the owner or a read without excludePrivate.
 */
function rowOwnerOnly(excludePrivate: boolean | undefined, table: 'takes' | 'timeline_entries'): StoreOwnerOnlyForm {
  if (!excludePrivate) return 'off';
  return ownerOnlyFormIn(table === 'takes' ? ownerOnlyTakeAllowedSql(table) : ownerOnlyTimelineAllowedSql(table), table, table);
}

/** The row the target names; a fact read under excludePrivate takes the reader's policy, or refuses one the store cannot judge. */
export const readRowAttribution: StoreMember<[target: RowAttributionTarget], RowAttributionRow | null> = async (brain, target) => {
  const member = 'readRowAttribution';
  const wire = target.kind === 'fact'
    ? { kind: 'fact', id: target.id, sourceId: target.sourceId, slug: target.slug, worldOnly: target.worldOnly,
        excludePrivate: storePrivacyPolicy(member, target.excludePrivate, () => privateFactFilterForReader('facts'), { callerReaders: true }) ?? null }
    : target.kind === 'take'
      ? { kind: 'take', pageId: target.pageId, rowNum: target.rowNum, holders: target.holders ? [...target.holders] : null,
          ownerOnly: rowOwnerOnly(target.excludePrivate, 'takes') }
      : { kind: 'timeline', id: target.id, pageId: target.pageId, ownerOnly: rowOwnerOnly(target.excludePrivate, 'timeline_entries') };
  const row: RowAttributionRow | null = await storeCall({ member }, () => brain.readRowAttribution(wire));
  return row ? withDates(row, ['created_at', 'last_written_at']) : null;
};
