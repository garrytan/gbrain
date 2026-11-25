/**
 * The count and list reads of takes, salience and code edges (engine-sql/takes-reads.ts), served by the store
 * (rust/docs/store/takes-reads.md).
 *
 * `countMcpResolvedTakes` reads the caller's source and holder scope. Under `excludePrivate` the SQL adds the page
 * policy of the caller in context (`privatePagesFilterForCaller('p')`): `storePagePolicy` sends the flags the store
 * applies, with the caller's reader identity and private-readable grant (the same caller the scorecard it decorates
 * serves), and refuses with `engine_capability_missing` for a caller whose folder rules, audience or lineage widen
 * the policy.
 *
 * The reads and the delete of `gbrain extract takes` (readLivePageIdBySlug through findTakeId) and stampTakeResolvedAt refuse a page, take or
 * row id that is not an integer, as the SQL's integer casts refuse it.
 */
import {
  checkTakePreimageRead, type AbandonedTakeRow, type AcceptedTakeRemoval, type HeldFenceTakeRow, type HeldFenceTakeSpec, type HolderResolvedTakeRow,
  type HorizonBasis, type HorizonScanRow, type McpResolvedSpec, type PageTierRef, type PurgeTakesSpec, type TakeGrade, type TakeGradeFilter,
  type TakeGradeKey, type TakeGradeRow, type TakeHorizonRow, type TakeNudgeFilter, type TakeNudgeInput, type TakeNudgeRow, type TakePreimage,
  type TakePreimageRead, type TakesLeavingFence, type TakeTrustRef,
} from '../../engine-sql/takes-reads.ts';
import { storedTrustTier } from '../../trust/tier.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';
import { storePagePolicy } from './private-provenance.ts';

export const countOffGridTakeWeights: StoreMember<[], { off_grid: number; total: number }> = (brain) =>
  storeCall({ member: 'countOffGridTakeWeights' }, () => brain.countOffGridTakeWeights());

export const countTakes: StoreMember<[], number> = (brain) =>
  storeCall({ member: 'countTakes' }, () => brain.countTakes());

export const planFactPurgeTakes: StoreMember<[spec: PurgeTakesSpec], Array<{ id: number; page_id: number }>> = (brain, spec) =>
  storeCall({ member: 'planFactPurgeTakes' }, () => brain.planFactPurgeTakes({
    sourceId: spec.sourceId, factIds: [...spec.factIds], factHash: spec.factHash, subject: spec.subject,
  }));

export const listTakeRowsForPage: StoreMember<[pageId: number], Array<{ row_num: number; claim: string }>> = (brain, pageId) =>
  storeCall({ member: 'listTakeRowsForPage' }, () => brain.listTakeRowsForPage(pageId));

/** The store reads the page's takes by row number and joins the incoming rows as the SQL does; the arguments are checked first. */
export const readTakePreimages: StoreMember<[read: TakePreimageRead], Array<{ preimage: TakePreimage; gone: boolean }>> = async (brain, read) => {
  checkTakePreimageRead(read);
  if (!read.gone.length && !read.incoming.length) return [];
  return storeCall({ member: 'readTakePreimages' }, () => brain.readTakePreimages({
    pageId: read.pageId, by: read.by, gone: [...read.gone], incoming: read.incoming.map(take => ({ ...take })),
  }));
};

/**
 * The page's takes by row number while its take_fence generation is held `fence_absent` in the store's generation
 * ledger (`derived_generations`), none otherwise. `resolved_at` comes back as a Date, as the SQL engines read it.
 */
export const listHeldFenceTakeRows: StoreMember<[spec: HeldFenceTakeSpec], HeldFenceTakeRow[]> = async (brain, spec) => {
  const rows = await storeCall<HeldFenceTakeRow[]>({ member: 'listHeldFenceTakeRows', sourceId: spec.sourceId }, () => brain.listHeldFenceTakeRows({
    sourceId: spec.sourceId, kind: spec.kind, ownerKey: spec.ownerKey, pageId: spec.pageId }));
  return rows.map(row => ({ ...row, resolved_at: row.resolved_at == null ? null : new Date(row.resolved_at) }));
};

export const readTakeRowTrust: StoreMember<[pageId: number, rowNum: number], { id: number; claim: string; trust_tier: string } | null> =
  (brain, pageId, rowNum) => storeCall({ member: 'readTakeRowTrust' }, () => brain.readTakeRowTrust(pageId, rowNum));

export const readTakeTrustRef: StoreMember<[id: number], TakeTrustRef | null> = (brain, id) =>
  storeCall({ member: 'readTakeTrustRef' }, () => brain.readTakeTrustRef(id));

export const countMcpResolvedTakes: StoreMember<[spec: McpResolvedSpec], number> = (brain, spec) => {
  const excludePrivate = storePagePolicy('countMcpResolvedTakes', spec.excludePrivate, { callerReaders: true });
  return storeCall({ member: 'countMcpResolvedTakes' }, () => brain.countMcpResolvedTakes({
    sourceIds: spec.sourceIds ? [...spec.sourceIds] : null,
    holders: spec.holders ? [...spec.holders] : null,
    excludePrivate: excludePrivate ?? null,
  }));
};

export const listTakeSupersessionCandidates: StoreMember<[sourceIds: readonly string[]], Array<{ id: number; source_id: string; slug: string }>> =
  (brain, sourceIds) => storeCall({ member: 'listTakeSupersessionCandidates' }, () => brain.listTakeSupersessionCandidates([...sourceIds]));

export const listTakePointers: StoreMember<[pageId: number], Array<{ row_num: number; superseded_by: number | null }>> = (brain, pageId) => {
  if (!Number.isSafeInteger(pageId)) refuseMember('listTakePointers', 'a page id that is not an integer');
  return storeCall({ member: 'listTakePointers' }, () => brain.listTakePointers(pageId));
};

export const listTakeSupersedeReceipts: StoreMember<[sourceId: string, pageId: number, slug: string], Array<{ old_row: string | null; new_row: string | null }>> =
  (brain, sourceId, pageId, slug) => {
    if (!Number.isSafeInteger(pageId)) refuseMember('listTakeSupersedeReceipts', 'a page id that is not an integer');
    return storeCall({ member: 'listTakeSupersedeReceipts' }, () => brain.listTakeSupersedeReceipts(sourceId, pageId, slug));
  };

export const setTakeSupersededBy: StoreMember<[pageId: number, rowNum: number, supersededBy: number | null], void> = (brain, pageId, rowNum, supersededBy) => {
  if (!Number.isSafeInteger(pageId) || !Number.isSafeInteger(rowNum) || (supersededBy !== null && !Number.isSafeInteger(supersededBy))) {
    refuseMember('setTakeSupersededBy', 'a page id or row number that is not an integer');
  }
  return storeCall({ member: 'setTakeSupersededBy' }, () => brain.setTakeSupersededBy(pageId, rowNum, supersededBy));
};

/** The accepted take removals of the sources, by proposal id (trust/proposals.rs, read with the journal's committed requests). */
export const listAcceptedTakeRemovals: StoreMember<[sourceIds: readonly string[], proposalId: number | null], AcceptedTakeRemoval[]> = (brain, sourceIds, proposalId) => {
  if (proposalId !== null && !Number.isSafeInteger(proposalId)) refuseMember('listAcceptedTakeRemovals', 'a proposal id that is not an integer');
  return storeCall({ member: 'listAcceptedTakeRemovals' }, () => brain.listAcceptedTakeRemovals({ sourceIds: [...sourceIds], proposalId }));
};

export const readTakeRowTier: StoreMember<[pageId: number, rowNum: number], { id: number; trust_tier: string } | null> = (brain, pageId, rowNum) => {
  if (!Number.isSafeInteger(pageId) || !Number.isSafeInteger(rowNum)) refuseMember('readTakeRowTier', 'a page id or row number that is not an integer');
  return storeCall({ member: 'readTakeRowTier' }, () => brain.readTakeRowTier(pageId, rowNum));
};

export const countZeroWeightWithTakes: StoreMember<[], { zero_weight_with_takes: number; nonzero_weight: number }> = (brain) =>
  storeCall({ member: 'countZeroWeightWithTakes' }, () => brain.countZeroWeightWithTakes());

export const hasCodeEdgesSymbol: StoreMember<[sourceId: string], boolean> = (brain, sourceId) =>
  storeCall({ member: 'hasCodeEdgesSymbol' }, () => brain.hasCodeEdgesSymbol(sourceId));

/** The holder's 25 heaviest active resolved takes (the calibration pattern drill-down). */
export const listTopResolvedTakesForHolder: StoreMember<[holder: string], HolderResolvedTakeRow[]> =
  (brain, holder) => storeCall({ member: 'listTopResolvedTakesForHolder' }, () => brain.listTopResolvedTakesForHolder(holder));

/** The five oldest abandoned high-conviction takes (the calibration abandoned-threads card). */
export const listAbandonedTakes: StoreMember<[], AbandonedTakeRow[]> =
  (brain) => storeCall({ member: 'listAbandonedTakes' }, () => brain.listAbandonedTakes());

// ---- The reads and the delete of `gbrain extract takes` ----

function ints(member: string, values: readonly number[]): number[] {
  if (!values.every(Number.isSafeInteger)) refuseMember(member, 'an id or row number that is not an integer');
  return [...values];
}

export const readLivePageIdBySlug: StoreMember<[slug: string, sourceId: string], number | null> = async (brain, slug, sourceId) => {
  const id = await storeCall({ member: 'readLivePageIdBySlug', slug, sourceId }, () => brain.readLivePageIdBySlug(slug, sourceId)) as number | null;
  return id === null || id === undefined ? null : Number(id);
};

export const readPageTierRef: StoreMember<[pageId: number], PageTierRef | null> = async (brain, pageId) => {
  ints('readPageTierRef', [pageId]);
  const page = await storeCall({ member: 'readPageTierRef' }, () => brain.readPageTierRef(pageId)) as { source_id: string; slug: string; trust_tier: string } | null;
  return page ? { source_id: page.source_id, slug: page.slug, trust_tier: storedTrustTier(page.trust_tier) } : null;
};

export const readPageTierRows: StoreMember<[ids: readonly number[]], Array<PageTierRef & { id: number }>> = async (brain, ids) => {
  const wanted = ints('readPageTierRows', ids);
  const rows = await storeCall({ member: 'readPageTierRows' }, () => brain.readPageTierRows(wanted)) as Array<{ id: number; source_id: string; slug: string; trust_tier: string }>;
  return rows.map(r => ({ id: Number(r.id), source_id: r.source_id, slug: r.slug, trust_tier: storedTrustTier(r.trust_tier) }));
};

export const pageHasFrontmatterKey: StoreMember<[pageId: number, key: string], boolean> = async (brain, pageId, key) => {
  ints('pageHasFrontmatterKey', [pageId]);
  return (await storeCall({ member: 'pageHasFrontmatterKey' }, () => brain.pageHasFrontmatterKey(pageId, key))) === true;
};

export const listTakeIdsLeavingFence: StoreMember<[pageId: number, fence: TakesLeavingFence], number[]> = async (brain, pageId, fence) => {
  const member = 'listTakeIdsLeavingFence';
  ints(member, [pageId]);
  const arg = fence.change === 'removed'
    ? { change: 'removed', rowNums: ints(member, fence.rowNums) }
    : { change: 'replaced', rows: fence.rows.map(r => ({ row_num: ints(member, [r.row_num])[0], claim: r.claim })) };
  const ids = await storeCall({ member }, () => brain.listTakeIdsLeavingFence(pageId, arg)) as number[];
  return ids.map(Number);
};

export const listTakePreimages: StoreMember<[pageId: number, ids: readonly number[], incoming: ReadonlyArray<{ row_num: number; claim: string; kind: string; holder: string }>], Array<{ preimage: TakePreimage; gone: boolean }>> =
  async (brain, pageId, ids, incoming) => {
    const member = 'listTakePreimages';
    ints(member, [pageId, ...incoming.map(t => t.row_num)]);
    const rows = await storeCall({ member }, () => brain.listTakePreimages(pageId, ints(member, ids),
      incoming.map(t => ({ row_num: t.row_num, claim: t.claim, kind: t.kind, holder: t.holder })))) as Array<{ preimage: TakePreimage; gone: boolean }>;
    return rows.map(r => ({ preimage: r.preimage, gone: r.gone === true }));
  };

export const deleteTakesByIds: StoreMember<[ids: readonly number[]], void> = async (brain, ids) => {
  const wanted = ints('deleteTakesByIds', ids);
  if (!wanted.length) return;
  await storeCall({ member: 'deleteTakesByIds' }, () => brain.deleteTakesByIds(wanted));
};

export const findTakeId: StoreMember<[pageId: number, rowNum: number], number | null> = async (brain, pageId, rowNum) => {
  ints('findTakeId', [pageId, rowNum]);
  const id = await storeCall({ member: 'findTakeId' }, () => brain.findTakeId(pageId, rowNum)) as number | null;
  return id === null || id === undefined ? null : Number(id);
};

/** A remote takes write's holder check (persistence/authority.ts): the distinct holders of the takes at those rows. */
export const listTakeHoldersAtRows: StoreMember<[pageId: number, rowNums: readonly number[]], string[]> = async (brain, pageId, rowNums) => {
  ints('listTakeHoldersAtRows', [pageId, ...rowNums]);
  return await storeCall({ member: 'listTakeHoldersAtRows' }, () => brain.listTakeHoldersAtRows(pageId, [...rowNums])) as string[];
};

/** The takes publication's prepare step: `resolved_at` of the take at a row number (carried from 098c048ad6). */
export const stampTakeResolvedAt: StoreMember<[pageId: number, rowNum: number, resolvedAt: string], void> =
  async (brain, pageId, rowNum, resolvedAt) => {
    ints('stampTakeResolvedAt', [pageId, rowNum]);
    await storeCall({ member: 'stampTakeResolvedAt' }, () => brain.stampTakeResolvedAt(pageId, rowNum, resolvedAt));
  };

/** The takes publication's prepare step: the holders a request used, kept in its authority. */
export const recordTakeHoldersUsed: StoreMember<[requestId: string, holders: readonly string[]], void> = async (brain, requestId, holders) => {
  await storeCall({ member: 'recordTakeHoldersUsed' }, () => brain.recordTakeHoldersUsed(requestId, [...holders]));
};

// The grade_takes verdict cache (take_grade_cache) and `gbrain takes grades`. A take id that is not an integer is
// refused, as the SQL's bigint cast refuses it.
const gradeKey = (member: string, key: TakeGradeKey): TakeGradeKey => {
  ints(member, [key.takeId]);
  return { takeId: key.takeId, promptVersion: key.promptVersion, judgeModelId: key.judgeModelId, evidenceSignature: key.evidenceSignature };
};

export const readTakeGrade: StoreMember<[key: TakeGradeKey], TakeGrade | null> = async (brain, key) => {
  const row = await storeCall({ member: 'readTakeGrade' }, () => brain.readTakeGrade(gradeKey('readTakeGrade', key))) as TakeGrade | null;
  return row ? { verdict: row.verdict, confidence: Number(row.confidence), applied: row.applied } : null;
};

export const insertTakeGrade: StoreMember<[row: TakeGradeKey & TakeGrade & { gradedAt?: string; waveVersion?: string }], void> = async (brain, row) => {
  const input = {
    ...gradeKey('insertTakeGrade', row), verdict: row.verdict, confidence: row.confidence, applied: row.applied,
    ...(row.gradedAt === undefined ? {} : { gradedAt: row.gradedAt }),
    ...(row.waveVersion === undefined ? {} : { waveVersion: row.waveVersion }),
  };
  await storeCall({ member: 'insertTakeGrade' }, () => brain.insertTakeGrade(input));
};

export const deleteTakeGrade: StoreMember<[key: TakeGradeKey], void> = async (brain, key) => {
  await storeCall({ member: 'deleteTakeGrade' }, () => brain.deleteTakeGrade(gradeKey('deleteTakeGrade', key)));
};

export const listLatestTakeGrades: StoreMember<[filter: TakeGradeFilter], TakeGradeRow[]> = async (brain, f) => {
  ints('listLatestTakeGrades', [f.limit]);
  const rows = await storeCall({ member: 'listLatestTakeGrades' }, () =>
    brain.listLatestTakeGrades({ verdict: f.verdict, minConfidence: f.minConfidence, applied: f.applied, limit: f.limit })) as TakeGradeRow[];
  return rows.map((r) => ({
    take_id: Number(r.take_id), source_id: r.source_id, page_slug: r.page_slug, row_num: Number(r.row_num), claim: r.claim,
    holder: r.holder, since_date: r.since_date, verdict: r.verdict, confidence: Number(r.confidence), applied: r.applied,
    judge_model_id: r.judge_model_id, prompt_version: r.prompt_version, graded_at: new Date(r.graded_at).toISOString(),
  }));
};

// grade_takes' managed resolve: a page, row or take id that is not an integer is refused, as the SQL's casts refuse it.
export const readLiveTakePage: StoreMember<[at: { pageId: number; rowNum: number; claim: string }], { slug: string; source_id: string } | null> =
  async (brain, at) => {
    ints('readLiveTakePage', [at.pageId, at.rowNum]);
    const page = await storeCall({ member: 'readLiveTakePage' }, () =>
      brain.readLiveTakePage({ pageId: at.pageId, rowNum: at.rowNum, claim: at.claim })) as { slug: string; source_id: string } | null;
    return page ? { slug: page.slug, source_id: page.source_id } : null;
  };

// take_horizons (store A 0x06, takes/horizons.rs): `gbrain takes horizon` and the forecast journal.
export const readTakeClaim: StoreMember<[takeId: number], string | null> = async (brain, takeId) => {
  ints('readTakeClaim', [takeId]);
  const claim = await storeCall({ member: 'readTakeClaim' }, () => brain.readTakeClaim(takeId)) as string | null;
  return claim ?? null;
};

export const upsertTakeHorizon: StoreMember<[h: { takeId: number; claimSha256: string; horizonDate: string; basis: HorizonBasis }], void> =
  async (brain, h) => {
    ints('upsertTakeHorizon', [h.takeId]);
    await storeCall({ member: 'upsertTakeHorizon' }, () =>
      brain.upsertTakeHorizon({ takeId: h.takeId, claimSha256: h.claimSha256, horizonDate: h.horizonDate, basis: h.basis }));
  };

export const deleteTakeHorizon: StoreMember<[takeId: number], boolean> = async (brain, takeId) => {
  ints('deleteTakeHorizon', [takeId]);
  return (await storeCall({ member: 'deleteTakeHorizon' }, () => brain.deleteTakeHorizon(takeId))) === true;
};

export const listTakeHorizons: StoreMember<[takeIds: readonly number[] | null], TakeHorizonRow[]> = async (brain, takeIds) => {
  const ids = takeIds === null ? null : ints('listTakeHorizons', takeIds);
  const rows = await storeCall({ member: 'listTakeHorizons' }, () => brain.listTakeHorizons(ids)) as TakeHorizonRow[];
  return rows.map(r => ({
    take_id: Number(r.take_id), horizon_date: r.horizon_date, basis: r.basis, set_at: new Date(r.set_at).toISOString(),
    claim_sha256: r.claim_sha256, claim: r.claim,
  }));
};

export const listHorizonScanRows: StoreMember<[sourceId: string | null], HorizonScanRow[]> = async (brain, sourceId) => {
  const rows = await storeCall({ member: 'listHorizonScanRows' }, () => brain.listHorizonScanRows(sourceId)) as HorizonScanRow[];
  return rows.map(r => ({
    id: Number(r.id), claim: r.claim, since_date: r.since_date ?? null, basis: r.basis ?? null,
    claim_sha256: r.claim_sha256 ?? null, horizon_date: r.horizon_date ?? null,
  }));
};

// `gbrain calibration --undo-wave`: a wave's verdicts (A 0x05), resolutions (A 0x01) and nudges (A 0x07, takes/nudges.rs).
export const listWaveAppliedTakeIds: StoreMember<[waveVersion: string], number[]> = async (brain, waveVersion) => {
  const ids = await storeCall({ member: 'listWaveAppliedTakeIds' }, () => brain.listWaveAppliedTakeIds(waveVersion)) as number[];
  return ids.map(Number);
};

export const revertWaveTakeResolutions: StoreMember<[spec: { takeIds: readonly number[]; resolvedBy: string; dryRun: boolean }], number> =
  async (brain, spec) => {
    const takeIds = ints('revertWaveTakeResolutions', spec.takeIds);
    return Number(await storeCall({ member: 'revertWaveTakeResolutions' }, () =>
      brain.revertWaveTakeResolutions({ takeIds, resolvedBy: spec.resolvedBy, dryRun: spec.dryRun })));
  };

export const unapplyWaveTakeGrades: StoreMember<[spec: { waveVersion: string; dryRun: boolean }], number> = async (brain, spec) =>
  Number(await storeCall({ member: 'unapplyWaveTakeGrades' }, () =>
    brain.unapplyWaveTakeGrades({ waveVersion: spec.waveVersion, dryRun: spec.dryRun })));

export const purgeTakeNudgesByWave: StoreMember<[spec: { waveVersion: string; dryRun: boolean }], number> = async (brain, spec) =>
  Number(await storeCall({ member: 'purgeTakeNudgesByWave' }, () =>
    brain.purgeTakeNudgesByWave({ waveVersion: spec.waveVersion, dryRun: spec.dryRun })));

export const insertTakeNudge: StoreMember<[n: TakeNudgeInput], number> = async (brain, n) => {
  ints('insertTakeNudge', [n.takeId, n.proposalId].filter((v): v is number => v !== null && v !== undefined));
  const input: Record<string, unknown> = { sourceId: n.sourceId, takeId: n.takeId ?? null, proposalId: n.proposalId ?? null, nudgePattern: n.nudgePattern };
  if (n.channel !== undefined) input.channel = n.channel;
  if (n.waveVersion !== undefined) input.waveVersion = n.waveVersion;
  if (n.firedAt !== undefined) input.firedAt = n.firedAt;
  return Number(await storeCall({ member: 'insertTakeNudge' }, () => brain.insertTakeNudge(input)));
};

export const listTakeNudges: StoreMember<[f: TakeNudgeFilter], TakeNudgeRow[]> = async (brain, f) => {
  ints('listTakeNudges', [f.takeId, f.proposalId].filter((v): v is number => v !== null && v !== undefined));
  const rows = await storeCall({ member: 'listTakeNudges' }, () => brain.listTakeNudges({
    sourceId: f.sourceId, takeId: f.takeId ?? null, proposalId: f.proposalId ?? null, nudgePattern: f.nudgePattern ?? null, waveVersion: f.waveVersion ?? null,
  })) as TakeNudgeRow[];
  return rows.map(r => ({
    id: Number(r.id), source_id: r.source_id, take_id: r.take_id === null ? null : Number(r.take_id),
    proposal_id: r.proposal_id === null ? null : Number(r.proposal_id), nudge_pattern: r.nudge_pattern,
    fired_at: new Date(r.fired_at).toISOString(), channel: r.channel, wave_version: r.wave_version,
  }));
};
