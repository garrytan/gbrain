/**
 * The extract_atoms phase's reads, release and state-store gate (engine-sql/extract-atoms-reads.ts;
 * rust/docs/store/extract-atoms.md).
 *
 * listExtractablePages, listAtomSourceHashes and listSourcePageAtomTitles are served from page and op-checkpoint
 * records (link_queries/atom_discovery.rs); releasePartialAtomDispositions deletes the source's `managed-atoms`
 * checkpoints recorded below the cap (persistence/op_checkpoint.rs).
 *
 * The store keeps no extract_atoms page or transcript state. So the tombstone read has no rows to find (no writer
 * exists: the phase refuses at the gate before it could write one), and assertAtomStateStore refuses by name before
 * any work: a run that cannot record what it settles would spend the model on the same items every cycle. The
 * records wait for a store format change (RUST_ENGINE.md, lane 7).
 */
import type { BrainEngine } from '../../engine.ts';
import { refuseMember, storeCall, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

export const listExtractablePages: Member<'listExtractablePages'> = async (brain, query) => {
  if (!Number.isSafeInteger(query.limit) || !Number.isSafeInteger(query.minChars)) {
    refuseMember('listExtractablePages', 'a limit or minimum length that is not an integer');
  }
  const rows = await storeCall({ member: 'listExtractablePages' }, () => brain.listExtractablePages({ ...query, limit: Math.max(0, query.limit), minChars: Math.max(0, query.minChars) }));
  return (rows as Array<Record<string, unknown>>).map(r => ({
    id: Number(r.id), knowledge_revision: String(r.knowledge_revision), source_incarnation: String(r.source_incarnation),
    slug: String(r.slug), compiled_truth: String(r.compiled_truth), content_hash: String(r.content_hash),
  }));
};

export const listAtomSourceHashes: Member<'listAtomSourceHashes'> = async (brain, sourceId, hashes) =>
  hashes.length === 0 ? [] : storeCall({ member: 'listAtomSourceHashes' }, () => brain.listAtomSourceHashes(sourceId, [...hashes]));

/** No rows: the store keeps no transcript state, and the gate refuses every run that could write one. */
export const listTombstonedTranscripts: Member<'listTombstonedTranscripts'> = async () => [];

export const listSourcePageAtomTitles: Member<'listSourcePageAtomTitles'> = (brain, sourceId, sourceSlug) =>
  storeCall({ member: 'listSourcePageAtomTitles' }, () => brain.listSourcePageAtomTitles(sourceId, sourceSlug));

export const releasePartialAtomDispositions: Member<'releasePartialAtomDispositions'> = async (brain, sourceId, maxInputChars) => {
  if (!Number.isSafeInteger(maxInputChars)) refuseMember('releasePartialAtomDispositions', 'an input cap that is not an integer');
  await storeCall({ member: 'releasePartialAtomDispositions' }, () => brain.releasePartialAtomDispositions(sourceId, maxInputChars));
};

export const assertAtomStateStore: Member<'assertAtomStateStore'> = async () =>
  refuseMember('assertAtomStateStore', 'the store keeps no extract_atoms page or transcript state');
