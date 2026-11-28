/**
 * The extract_atoms phase's reads, release and state-store gate (engine-sql/extract-atoms-reads.ts;
 * rust/docs/store/extract-atoms.md).
 *
 * listExtractablePages refuses by name (see below). listAtomSourceHashes and listSourcePageAtomTitles are served from
 * page records (link_queries/atom_discovery.rs); releasePartialAtomDispositions deletes the source's `managed-atoms`
 * checkpoints recorded below the cap (persistence/op_checkpoint.rs).
 *
 * From store format 17 the store keeps the extract_atoms page and transcript ledgers (atom_state.rs): the tombstone read,
 * the ledger writes and the transcript-key reads are served, and assertAtomStateStore passes.
 */
import type { BrainEngine } from '../../engine.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';
import type { AtomPagePin } from '../../engine-sql/extract-atoms-state.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

/**
 * Refuses by name. Sync 21's discovery (GST-4020 #10542, #9888 #10483) reads state the store does not keep: the
 * per-source opt-out, the still-current scan and atoms tests over `fact_withdrawals`, and the canonical snapshot body.
 * Answering from page and op-checkpoint records (link_queries/atom_discovery.rs, parked) would offer pages Postgres
 * leaves out, and the phase's later raw-SQL steps would refuse only after the model call. The phase discovers pages
 * before any model call, so a Rust brain refuses extract_atoms here and pays for nothing.
 */
export const listExtractablePages: Member<'listExtractablePages'> = async () =>
  refuseMember('listExtractablePages', 'the store keeps no sync-21 discovery state: source opt-out, still-current scans and canonical snapshots');

export const listAtomSourceHashes: Member<'listAtomSourceHashes'> = async (brain, sourceId, hashes) =>
  hashes.length === 0 ? [] : storeCall({ member: 'listAtomSourceHashes' }, () => brain.listAtomSourceHashes(sourceId, [...hashes]));

/** No rows: the store keeps no transcript state, and the gate refuses every run that could write one. */
export const listTombstonedTranscripts: Member<'listTombstonedTranscripts'> = async (brain, sourceId, hashes) =>
  hashes.length === 0 ? [] : storeCall({ member: 'listTombstonedTranscripts' }, () => brain.listTombstonedTranscripts(sourceId, [...hashes]));

export const listSourcePageAtomTitles: Member<'listSourcePageAtomTitles'> = (brain, sourceId, sourceSlug) =>
  storeCall({ member: 'listSourcePageAtomTitles' }, () => brain.listSourcePageAtomTitles(sourceId, sourceSlug));

export const releasePartialAtomDispositions: Member<'releasePartialAtomDispositions'> = async (brain, sourceId, maxInputChars) => {
  if (!Number.isSafeInteger(maxInputChars)) refuseMember('releasePartialAtomDispositions', 'an input cap that is not an integer');
  await storeCall({ member: 'releasePartialAtomDispositions' }, () => brain.releasePartialAtomDispositions(sourceId, maxInputChars));
};

/** Passes: from store format 17 the store keeps the extract_atoms page and transcript ledgers (atom_state.rs). */
export const assertAtomStateStore: Member<'assertAtomStateStore'> = async () => {};

const pinArg = (member: string, pin: AtomPagePin) => {
  if (!Number.isSafeInteger(pin.pageId)) refuseMember(member, 'a page id that is not an integer');
  return { pageId: pin.pageId, sourceIncarnation: pin.sourceIncarnation, sourceId: pin.sourceId, slug: pin.slug, contentHash: pin.contentHash, revision: pin.revision };
};
const int32 = (member: string, n: number, what: string) => {
  if (!Number.isInteger(n) || n < -2147483648 || n > 2147483647) refuseMember(member, `${what} that is not a 32-bit integer`);
  return n;
};

export const readAtomPageIdentity: Member<'readAtomPageIdentity'> = async (brain, sourceId, slug, contentHash) => {
  const row: Record<string, unknown> | null = await storeCall({ member: 'readAtomPageIdentity' }, () => brain.readAtomPageIdentity(sourceId, slug, contentHash));
  return row ? { id: Number(row.id), incarnation: String(row.incarnation), knowledge_revision: String(row.knowledge_revision) } : null;
};

export const writeAtomPageState: Member<'writeAtomPageState'> = async (brain, pin, failIncrement, tombstone) => {
  const args = pinArg('writeAtomPageState', pin);
  const row = await storeCall({ member: 'writeAtomPageState' }, () => brain.writeAtomPageState(args, int32('writeAtomPageState', failIncrement, 'a failure count'), tombstone));
  return row === null || row === undefined ? null : Number(row);
};

export const recordAtomPagePartial: Member<'recordAtomPagePartial'> = async (brain, pin, maxInputChars) => {
  const args = pinArg('recordAtomPagePartial', pin);
  const row = await storeCall({ member: 'recordAtomPagePartial' }, () => brain.recordAtomPagePartial(args, int32('recordAtomPagePartial', maxInputChars, 'an input cap')));
  return row !== null && row !== undefined;
};

export const recordAtomTranscriptPartial: Member<'recordAtomTranscriptPartial'> = async (brain, sourceId, filePath, contentHash, maxInputChars) => {
  const cap = int32('recordAtomTranscriptPartial', maxInputChars, 'an input cap');
  await storeCall({ member: 'recordAtomTranscriptPartial' }, () => brain.recordAtomTranscriptPartial(sourceId, filePath, contentHash, cap));
};

export const stampAtomTranscriptTombstone: Member<'stampAtomTranscriptTombstone'> = async (brain, sourceId, filePath, contentHash) => {
  await storeCall({ member: 'stampAtomTranscriptTombstone' }, () => brain.stampAtomTranscriptTombstone(sourceId, filePath, contentHash));
};

export const strikeAtomTranscript: Member<'strikeAtomTranscript'> = async (brain, sourceId, filePath, contentHash) =>
  Number(await storeCall({ member: 'strikeAtomTranscript' }, () => brain.strikeAtomTranscript(sourceId, filePath, contentHash)));

export const listLiveTranscriptGenerations: Member<'listLiveTranscriptGenerations'> = async (brain, sourceId, kind, keyPrefix) => {
  if (/[%_\\]/.test(keyPrefix)) refuseMember('listLiveTranscriptGenerations', 'a key prefix with a LIKE wildcard or escape');
  const rows = await storeCall({ member: 'listLiveTranscriptGenerations' }, () => brain.listLiveTranscriptGenerations(sourceId, kind, keyPrefix));
  return (rows as Array<Record<string, unknown>>).map(r => ({
    id: Number(r.id), owner_key: String(r.owner_key), locator: r.locator == null ? null : String(r.locator), input_pin: r.input_pin == null ? null : String(r.input_pin),
  }));
};

export const moveGenerationLocator: Member<'moveGenerationLocator'> = async (brain, id, locator) => {
  if (!Number.isSafeInteger(id)) refuseMember('moveGenerationLocator', 'a generation id that is not an integer');
  await storeCall({ member: 'moveGenerationLocator' }, () => brain.moveGenerationLocator(id, locator));
};

export const readLivePageSourcePath: Member<'readLivePageSourcePath'> = async (brain, sourceId, slug) => {
  const row: Record<string, unknown> | null = await storeCall({ member: 'readLivePageSourcePath' }, () => brain.readLivePageSourcePath(sourceId, slug));
  return row ? { source_path: row.source_path == null ? null : String(row.source_path) } : undefined;
};

export const readLiveGenerationLocator: Member<'readLiveGenerationLocator'> = async (brain, sourceId, kind, ownerKey) => {
  const row: Record<string, unknown> | null = await storeCall({ member: 'readLiveGenerationLocator' }, () => brain.readLiveGenerationLocator(sourceId, kind, ownerKey));
  return row ? { locator: row.locator == null ? null : String(row.locator) } : undefined;
};

export const listConversationPageFrontmatter: Member<'listConversationPageFrontmatter'> = async (brain, sourceId) =>
  (await storeCall({ member: 'listConversationPageFrontmatter' }, () => brain.listConversationPageFrontmatter(sourceId)) as Array<{ slug: string; frontmatter: unknown }>)
    .map(r => ({ slug: String(r.slug), frontmatter: r.frontmatter }));
