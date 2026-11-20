/**
 * Doctor facts, fence and trust reads (src/core/engine-sql/doctor-facts-trust.ts) on the Rust engine
 * (rust/crates/gbrain-store/src/cli_reads/doctor_facts_trust.rs, rust/docs/store/cli-reads-doctor-facts-trust.md).
 *
 * Served from the store: the conversation-pipeline page count (the page records) and the persistent writer contention
 * (the `facts:absorb` ingest rows against the completed `facts-absorb` jobs).
 */
import type { BrainEngine } from '../../engine.ts';
import { storeCall, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

export const countConversationPipelinePages: Member<'countConversationPipelinePages'> = (brain, types, slugPatterns) =>
  storeCall({ member: 'countConversationPipelinePages' }, async () =>
    Number(await brain.countConversationPipelinePages({ types: [...types], slug_patterns: [...slugPatterns] })));

export const listPersistentWriterContention: Member<'listPersistentWriterContention'> = (brain, reason) =>
  storeCall({ member: 'listPersistentWriterContention' }, () => brain.listPersistentWriterContention(reason));
