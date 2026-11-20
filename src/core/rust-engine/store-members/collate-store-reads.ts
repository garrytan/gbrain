/**
 * The decision, OAuth, feedback, question and credential reads of engine-sql/collate-store-reads.ts, served by the store
 * (rust/docs/store/oauth-clients.md). Every listing answers in byte order, as the SQL's `COLLATE "C"` does.
 */
import type { BrainEngine } from '../../engine.ts';
import { storeCall, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

export const listClientsReferencingSource: Member<'listClientsReferencingSource'> = (brain, sourceId) =>
  storeCall({ member: 'listClientsReferencingSource' }, () => brain.listClientsReferencingSource(sourceId)) as Promise<Awaited<ReturnType<BrainEngine['listClientsReferencingSource']>>>;
