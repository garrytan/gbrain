/**
 * Doctor reads (src/core/engine-sql/doctor-reads.ts), served from the store records each check reads
 * (rust/crates/gbrain-store/src/cli_reads/doctor.rs, rust/docs/store/cli-reads-doctor.md).
 */
import type { BrainEngine } from '../../engine.ts';
import { storeCall, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

export const countPageChildOrphans: Member<'countPageChildOrphans'> = async (brain, target) =>
  Number(await storeCall({ member: 'countPageChildOrphans' }, () => brain.countPageChildOrphans(target)));
