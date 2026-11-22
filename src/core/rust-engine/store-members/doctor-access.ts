/**
 * Doctor access reads (src/core/engine-sql/doctor-access.ts) and the owner-only trigger state on the Rust engine
 * (rust/crates/gbrain-store/src/access_doctor.rs, rust/docs/store/access-doctor.md).
 *
 * Served from the store: the pages no enabled member reads remotely (doctor access_pages_read_by_nobody), which read the
 * page records and their normalized readers, and the owner-only guard behind ownerOnlyMarkTriggers.
 *
 * ownerOnlyMarkTriggers: SQL marks the rows an owner-only delete leaves derived through five BEFORE DELETE triggers,
 * which a role that does not own a table cannot create, and reports the missing ones. The store has no triggers to miss:
 * every delete it serves marks inline in the same write (owner_only_marks.rs `mark_before_delete`), and it has no
 * database logins, row-level security or held flag that a restore could leave unset. So nothing is missing, lineage never
 * reads closed, no login is denied, and `held` is the guard a delete tests now (an owner-only source or a mark).
 * `ensure` and `installing` change nothing here: there is nothing to create.
 *
 * Empty, no writer: the member-source bindings (`access_member_sources`) are written only through `executeRaw`
 * (src/core/access/member-sources.ts), which a Rust brain refuses, so it holds none; the read answers `[]` in TypeScript
 * without a store call, which is what the same read finds on a PGLite brain nothing has bound a source on.
 * test/engine-parity/doctor-access.test.ts pins the refused binding write, so serving it has to serve this read too.
 */
import type { BrainEngine } from '../../engine.ts';
import { storeCall, takeOptions, type StoreMember } from './common.ts';

type Member<K extends keyof BrainEngine> = BrainEngine[K] extends (...args: infer A) => Promise<infer R> ? StoreMember<A, R> : never;

export const listAccessMemberSources: Member<'listAccessMemberSources'> = async () => [];

export const listPagesReadByNobody: Member<'listPagesReadByNobody'> = async (brain, spec, opts) => {
  // The statement bound is Postgres's: the store runs the read to its end, as PGLite does.
  takeOptions('listPagesReadByNobody', opts, [], ['timeoutMs', 'signal']);
  const body = spec.by === 'labelled'
    ? { by: 'labelled', live: [...spec.live] }
    : { by: 'rule', sourceId: spec.sourceId, prefix: spec.prefix, admitted: [...spec.admitted] };
  return await storeCall({ member: 'listPagesReadByNobody' }, () => brain.listPagesReadByNobody(body)) as Awaited<ReturnType<BrainEngine['listPagesReadByNobody']>>;
};

export const ownerOnlyMarkTriggers: Member<'ownerOnlyMarkTriggers'> = async (brain, opts) => {
  takeOptions('ownerOnlyMarkTriggers', opts, [], ['ensure', 'installing']);
  const held = await storeCall({ member: 'ownerOnlyMarkTriggers' }, () => brain.ownerOnlyGuarded()) as boolean;
  return { missing: [], role: '', closed: false, rowSecurity: false, held, unflagged: false, deniedLogins: [], closedLogins: [] };
};
