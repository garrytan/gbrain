/**
 * The drift-conflict audit reads the Rust store answers (gbrain-store `persistence/drift_conflicts.rs`): the window
 * bounds, the totals and slug groups of the `source_changed` conflicts, the newest committed receipt per slug and the
 * recorded source paths. A `floor` filter sends the remote read floor (`remoteReadFloorSql('p')`) as a store page
 * policy; a floor that widens past the no-caller policy refuses typed.
 */
import type {
  CommittedReceiptRow, DriftConflictBounds, DriftConflictFilter, DriftConflictGroupRow, DriftConflictTotals, PageSourcePathRow,
} from '../../engine-sql/drift-conflicts.ts';
import { FILE_DRIFT_MESSAGE } from '../../persistence/drift-conflict-sql.ts';
import { remoteReadFloorSql } from '../../search/private-visibility.ts';
import { storePageTextPolicy } from './private-provenance.ts';
import { storeCall, takeOptions, type StoreMember } from './common.ts';

const FILTER_KEYS = ['sourceId', 'incarnation', 'floor', 'through', 'slugPrefixes', 'visibility'] as const;

function storeFilter(member: string, filter: DriftConflictFilter) {
  takeOptions(member, filter, FILTER_KEYS);
  const policy = filter.visibility === 'floor' ? storePageTextPolicy(member, () => remoteReadFloorSql('p'), { noReaders: true }) : null;
  return {
    filter: {
      sourceId: filter.sourceId, incarnation: filter.incarnation, floor: filter.floor, through: filter.through,
      slugPrefixes: filter.slugPrefixes ? [...filter.slugPrefixes] : null, live: filter.visibility !== 'none',
    },
    policy,
  };
}

export const readDriftConflictBounds: StoreMember<[sourceId: string], DriftConflictBounds | null> = (brain, sourceId) =>
  storeCall({ member: 'readDriftConflictBounds', sourceId }, () => brain.readDriftConflictBounds(sourceId));

export const countDriftConflicts: StoreMember<[filter: DriftConflictFilter], DriftConflictTotals> = (brain, filter) => {
  const { filter: f, policy } = storeFilter('countDriftConflicts', filter);
  return storeCall({ member: 'countDriftConflicts', sourceId: filter.sourceId }, () => brain.countDriftConflicts(f, policy));
};

export const listDriftConflictGroups: StoreMember<[filter: DriftConflictFilter, page: { after: string; fetch: number }], DriftConflictGroupRow[]> =
  (brain, filter, page) => {
    const { filter: f, policy } = storeFilter('listDriftConflictGroups', filter);
    takeOptions('listDriftConflictGroups', page, ['after', 'fetch']);
    return storeCall({ member: 'listDriftConflictGroups', sourceId: filter.sourceId }, () =>
      brain.listDriftConflictGroups(f, { after: page.after, fetch: Math.max(0, Math.floor(page.fetch)) }, policy, FILE_DRIFT_MESSAGE));
  };

export const readNewestCommittedReceipts: StoreMember<[sourceId: string, slugs: readonly string[]], CommittedReceiptRow[]> = (brain, sourceId, slugs) =>
  storeCall({ member: 'readNewestCommittedReceipts', sourceId }, () => brain.readNewestCommittedReceipts(sourceId, [...slugs]));

export const readPageSourcePaths: StoreMember<[sourceId: string, slugs: readonly string[]], PageSourcePathRow[]> = (brain, sourceId, slugs) =>
  storeCall({ member: 'readPageSourcePaths', sourceId }, () => brain.readPageSourcePaths(sourceId, [...slugs]));
