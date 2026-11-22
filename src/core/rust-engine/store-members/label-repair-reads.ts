/**
 * The preview reads of `gbrain repair conversation-labels` (src/core/engine-sql/label-repair-reads.ts):
 * listLabelFactCandidates, listSegmentedLabelPages and hasActiveAuditMarker. The label line must have the shape
 * labelsOf reads (as countLabelFacts requires); any other pattern refuses, so the store evaluates no regular
 * expression. None applies a read policy, so none takes one. See rust/docs/store/facts.md.
 *
 * Export only BrainEngine members from this file, each a `StoreMember` named after the member it serves (see tags.ts):
 * index.ts spreads the whole module into STORE_MEMBERS, so every export is served. Helpers stay unexported.
 */
import type { BrainEngine } from '../../engine.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';
import { labelsOf } from './label-line.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

export const listLabelFactCandidates: Member<'listLabelFactCandidates'> = async (brain, sourceIds, slug, args) => {
  const m = 'listLabelFactCandidates';
  const labels = labelsOf(args.labelLine);
  if (labels === null) refuseMember(m, 'a label line other than literal labels between the fixed head and tail');
  const query = { sourceIds: [...sourceIds], slug, segmentSource: args.segmentSource, labels,
    terminalSource: args.terminalSource, nonExtractableSource: args.nonExtractableSource };
  const rows: Awaited<ReturnType<BrainEngine['listLabelFactCandidates']>> = await storeCall({ member: m }, () => brain.listLabelFactCandidates(query));
  return rows.map(row => ({ ...row, id: Number(row.id) }));
};

export const listSegmentedLabelPages: Member<'listSegmentedLabelPages'> = async (brain, sourceIds, args) => {
  const query = { sourceIds: [...sourceIds], segmentSource: args.segmentSource,
    terminalSource: args.terminalSource, nonExtractableSource: args.nonExtractableSource };
  const rows: Awaited<ReturnType<BrainEngine['listSegmentedLabelPages']>> = await storeCall({ member: 'listSegmentedLabelPages' }, () => brain.listSegmentedLabelPages(query));
  return rows.map(row => ({ source_id: row.source_id, slug: row.slug, n: Number(row.n) }));
};

export const hasActiveAuditMarker: Member<'hasActiveAuditMarker'> = (brain, sourceId, slug, sources) =>
  storeCall({ member: 'hasActiveAuditMarker' }, () => brain.hasActiveAuditMarker({ sourceId, slug, sources: [...sources] }));
