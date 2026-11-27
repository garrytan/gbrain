/**
 * The facts write-path, repair and fence-cycle members (src/core/engine-sql/facts-trust.ts, facts-repair.ts and
 * facts-cycle.ts), served from the facts store (rust/crates/gbrain-store/src/facts/write_path.rs):
 * `listLivePageTitles`, `listPageAliasNames`, `listCaptureDuplicateCandidates`, `computeFactFingerprints`,
 * `listOversizedStaleFacts`, `listLivePersonTitles`, `listFenceRowClaims`, `adoptFactIntoFence`,
 * `readSourceCheckoutPath`, `listPageStates` and `countSegmentedVersionsOfPage`, plus `readPendingWriteReceipt` (the
 * persistence request store) and `lockSourceShared`.
 *
 * `lockSourceShared` resolves at once: the store's writer gate already serializes every write against the source row,
 * so a shared row lock holds nothing more. `readFactsFtsIndexState` and `swapFactsFtsIndex` stay refused: they read
 * and rebuild a Postgres catalog index (`pg_index`, `pg_get_indexdef`), which a store brain does not have.
 */
import type { BrainEngine } from '../../engine.ts';
import { storeCall, type StoreMember } from './common.ts';
import { readWriteRequest } from './persistence.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

const PENDING_STATES = new Set(['queued', 'running', 'recovering']);

export const listLivePageTitles: Member<'listLivePageTitles'> = async (brain, sourceId, slugs) => {
  if (!slugs.length) return [];
  return storeCall({ member: 'listLivePageTitles' }, () => brain.listLivePageTitles({ sourceId, slugs: [...slugs] }));
};

export const listPageAliasNames: Member<'listPageAliasNames'> = async (brain, sourceId, slugs) => {
  if (!slugs.length) return [];
  return storeCall({ member: 'listPageAliasNames' }, () => brain.listPageAliasNames({ sourceId, slugs: [...slugs] }));
};

export const listLivePersonTitles: Member<'listLivePersonTitles'> = async (brain, sourceId, slugs) => {
  if (!slugs.length) return [];
  return storeCall({ member: 'listLivePersonTitles' }, () => brain.listLivePersonTitles({ sourceId, slugs: [...slugs] }));
};

export const listCaptureDuplicateCandidates: Member<'listCaptureDuplicateCandidates'> = async (brain, opts) => {
  if (!Number.isFinite(opts.scanLimit)) throw new Error('listCaptureDuplicateCandidates: scanLimit must be a number');
  const rows: Array<{ id: number; entity_slug: string | null; source: string; source_session: string | null; created_at: string }> =
    await storeCall({ member: 'listCaptureDuplicateCandidates' }, () => brain.listCaptureDuplicateCandidates({
      sourceId: opts.sourceId,
      visibilities: [...opts.visibilities],
      fact: opts.fact,
      attributedTo: opts.attributedTo ?? null,
      replacingPage: opts.replacingPage ?? null,
      scanLimit: opts.scanLimit,
    }));
  return rows.map(row => ({ ...row, created_at: new Date(row.created_at) }));
};

export const computeFactFingerprints: Member<'computeFactFingerprints'> = async (brain, texts) => {
  if (!texts.length) return [];
  return storeCall({ member: 'computeFactFingerprints' }, () => brain.computeFactFingerprints([...texts]));
};

export const listOversizedStaleFacts: Member<'listOversizedStaleFacts'> = (brain, opts) =>
  storeCall({ member: 'listOversizedStaleFacts' }, () => brain.listOversizedStaleFacts({
    ...(opts.sourceId === undefined ? {} : { sourceId: opts.sourceId }),
    model: opts.model,
    dims: opts.dims,
    maxTokens: opts.maxTokens,
  }));

export const listFenceRowClaims: Member<'listFenceRowClaims'> = (brain, sourceId, slug) =>
  storeCall({ member: 'listFenceRowClaims' }, () => brain.listFenceRowClaims({ sourceId, slug }));

export const adoptFactIntoFence: Member<'adoptFactIntoFence'> = async (brain, sourceId, id, rowNum, slug, fact) => {
  await storeCall({ member: 'adoptFactIntoFence' }, () => brain.adoptFactIntoFence({ sourceId, id: String(id), rowNum, slug, fact }));
};

export const readSourceCheckoutPath: Member<'readSourceCheckoutPath'> = (brain, sourceId) =>
  storeCall({ member: 'readSourceCheckoutPath' }, () => brain.readSourceCheckoutPath(sourceId));

export const listPageStates: Member<'listPageStates'> = (brain, sourceId, slug) =>
  storeCall({ member: 'listPageStates' }, () => brain.listPageStates({ sourceId, slug }));

export const countSegmentedVersionsOfPage: Member<'countSegmentedVersionsOfPage'> = async (brain, sourceId, slug) =>
  Number(await storeCall({ member: 'countSegmentedVersionsOfPage' }, () => brain.countSegmentedVersionsOfPage({ sourceId, slug })));

/** The request still queued, running or recovering under `requestId`, or null (a `write_pending` error's request). */
export const readPendingWriteReceipt: Member<'readPendingWriteReceipt'> = async (brain, principalKind, principalId, requestId) => {
  const row = await readWriteRequest(brain, principalKind, principalId, requestId);
  return row && PENDING_STATES.has(row.state) ? { request_id: String(row.request_id), state: row.state } : null;
};

/** See the module note: the writer gate already serializes writes against the source. */
export const lockSourceShared: Member<'lockSourceShared'> = async () => undefined;
