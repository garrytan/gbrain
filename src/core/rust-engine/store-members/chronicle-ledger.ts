/**
 * The chronicle ledger members (BrainEngine upsertChronicleRow, reserveChronicleJudgeSlot; SQL in
 * engine-sql/chronicle-ledger.ts), served from the store's ledger records (rust/crates/gbrain-store/src/chronicle_ledger.rs,
 * rust/docs/store/chronicle-ledger.md). The campaign, retry and prune writers stay raw SQL and refuse on a Rust brain.
 */
import type { ChronicleJudgeKey, ChronicleRowUpsert } from '../../engine-sql/chronicle-ledger.ts';
import { storeCall, type StoreMember } from './common.ts';

export const upsertChronicleRow: StoreMember<[w: ChronicleRowUpsert], boolean> = async (brain, w) =>
  await storeCall({ member: 'upsertChronicleRow', sourceId: w.sourceId }, () => brain.upsertChronicleRow({
    sourceId: w.sourceId, pageId: w.pageId, contentHash: w.contentHash, extractorVersion: w.extractorVersion, slug: w.slug, state: w.state,
    reason: w.reason, trigger: w.trigger, principalKind: w.principalKind, principalId: w.principalId, requestId: w.requestId,
    noExtract: w.noExtract, nextAttemptAt: w.nextAttemptAt,
  })) as boolean;

export const reserveChronicleJudgeSlot: StoreMember<[limit: number, key: ChronicleJudgeKey], boolean> = async (brain, limit, key) =>
  await storeCall({ member: 'reserveChronicleJudgeSlot', sourceId: key.sourceId }, () => brain.reserveChronicleJudgeSlot(limit, {
    sourceId: key.sourceId, pageId: key.pageId, contentHash: key.contentHash,
  })) as boolean;
