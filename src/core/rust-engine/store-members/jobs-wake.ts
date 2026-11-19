/**
 * The Wakeshift report-back tables (engine-sql/jobs-wake.ts): watches, crons and their runs, terms acceptances and
 * forgets. The store keeps the rows (rust/docs/store/jobs-wake.md); the rows it returns carry timestamps as ISO text,
 * which these members turn into the `Date`s PGLite returns.
 *
 * A time that crosses to the store is the ISO text `Date#toISOString` gives (the store reads that one form), so a
 * spooled run's `finishedAt` written another way is normalized here first; one that is no time at all is passed on
 * and refused by the store, as the SQL engines refuse a bad `timestamptz`.
 */
import type {
  EndedWakeWatch, EndWakeWatches, WakeCronRow, WakeDoctorRead, WakeForgetClaim, WakeForgetSettle, WakeRow, WakeWatchFilter,
  WakeCredentialKind, WakeWatchInsert, WakeWatchRow, WakeWatchSettle,
} from '../../engine-sql/jobs-wake.ts';
import { withDates } from '../store-codec.ts';
import { storeCall, type StoreMember } from './common.ts';

const call = <T>(member: string, run: () => Promise<T>): Promise<T> => storeCall({ member }, run);

const isoText = (at: string): string => {
  const ms = Date.parse(at);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : at;
};

const DUE_DATES = ['started_at', 'finished_at', 'req_created_at', 'req_settled_at', 'run_finished_at'] as const;

export const openWakeWatch: StoreMember<[watch: WakeWatchInsert], number> = (brain, watch) =>
  call('openWakeWatch', () => brain.openWakeWatch({ ...watch, expiresAt: isoText(watch.expiresAt) }));

export const listWakeWatches: StoreMember<[filter: WakeWatchFilter], WakeWatchRow[]> = async (brain, filter) =>
  (await call<WakeWatchRow[]>('listWakeWatches', () => brain.listWakeWatches(filter))).map(r => withDates(r, ['created_at', 'expires_at'] as const));

export const endWakeWatches: StoreMember<[spec: EndWakeWatches], EndedWakeWatch[]> = (brain, spec) =>
  call('endWakeWatches', () => brain.endWakeWatches(spec));

export const countWakeWatches: StoreMember<[], Array<{ state: string; last_error: string | null; n: number }>> = brain =>
  call('countWakeWatches', () => brain.countWakeWatches());

export const readWakeDoctor: StoreMember<[], WakeDoctorRead> = brain =>
  call('readWakeDoctor', () => brain.readWakeDoctor());

export const countPendingWakeForgets: StoreMember<[], number> = brain =>
  call('countPendingWakeForgets', () => brain.countPendingWakeForgets());

export const listWakeCrons: StoreMember<[], WakeCronRow[]> = async brain =>
  (await call<WakeCronRow[]>('listWakeCrons', () => brain.listWakeCrons())).map(r => withDates(r, ['created_at', 'last_finished_at'] as const));

export const addWakeCron: StoreMember<[name: string], void> = async (brain, name) => {
  await call('addWakeCron', () => brain.addWakeCron(name));
};

export const removeWakeCron: StoreMember<[name: string], EndedWakeWatch[]> = (brain, name) =>
  call('removeWakeCron', () => brain.removeWakeCron(name));

export const hasWakeCron: StoreMember<[name: string], boolean> = (brain, name) =>
  call('hasWakeCron', () => brain.hasWakeCron(name));

export const recordWakeCronRun: StoreMember<[run: { name: string; status: string; finishedAt: string | null }], { registered: boolean }> = (brain, run) =>
  call('recordWakeCronRun', () => brain.recordWakeCronRun({ ...run, finishedAt: run.finishedAt === null ? null : isoText(run.finishedAt) }));

export const hasWakeTermsAcceptance: StoreMember<[principalKey: string, termsVersion: string], boolean> = (brain, principalKey, termsVersion) =>
  call('hasWakeTermsAcceptance', () => brain.hasWakeTermsAcceptance(principalKey, termsVersion));

export const recordWakeTermsAcceptance: StoreMember<[principalKey: string, termsVersion: string], void> = async (brain, principalKey, termsVersion) => {
  await call('recordWakeTermsAcceptance', () => brain.recordWakeTermsAcceptance(principalKey, termsVersion));
};

export const listDueWakeWatches: StoreMember<[spec?: { ids?: readonly number[] }], WakeRow[]> = async (brain, spec) =>
  (await call<WakeRow[]>('listDueWakeWatches', () => brain.listDueWakeWatches(spec?.ids ? [...spec.ids] : null))).map(r => withDates(r, DUE_DATES));

export const claimWakeWatch: StoreMember<[id: number, leaseSeconds: number], { lease: string; attempts: number } | null> = (brain, id, leaseSeconds) =>
  call('claimWakeWatch', () => brain.claimWakeWatch(id, leaseSeconds));

export const settleWakeWatch: StoreMember<[settle: WakeWatchSettle], boolean> = (brain, settle) =>
  call('settleWakeWatch', () => brain.settleWakeWatch(settle));

export const queueWakeForget: StoreMember<[wakeUser: string, memberId: string | null], void> = async (brain, wakeUser, memberId) => {
  await call('queueWakeForget', () => brain.queueWakeForget(wakeUser, memberId));
};

export const forgetWakeMember: StoreMember<[memberId: string], { ended: number; queued: number }> = (brain, memberId) =>
  call('forgetWakeMember', () => brain.forgetWakeMember(memberId));

export const forgetWakeCredential: StoreMember<[kind: WakeCredentialKind, id: string], { ended: number; queued: number }> = (brain, kind, id) =>
  call('forgetWakeCredential', () => brain.forgetWakeCredential(kind, id));

export const claimWakeForgets: StoreMember<[spec: { leaseSeconds: number; limit: number }], WakeForgetClaim[]> = (brain, spec) =>
  call('claimWakeForgets', () => brain.claimWakeForgets(spec));

export const settleWakeForget: StoreMember<[settle: WakeForgetSettle], boolean> = (brain, settle) =>
  call('settleWakeForget', () => brain.settleWakeForget(settle));
