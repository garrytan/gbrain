/**
 * The subagent transcript and tool ledger (engine-sql/jobs-subagent.ts), served by the store
 * (rust/docs/store/jobs-subagent.md). JSON columns go over as JSON text and come back as values; timestamps cross the
 * binding as ISO strings and come back as `Date`s, as PGLite returns them.
 */
import type {
  SubagentFailureFallback, SubagentMessageInsert, SubagentMessageRow, SubagentOneshotLedgerRow, SubagentRetainedPutPage,
  SubagentToolInsert, SubagentToolOrder, SubagentToolRow, SubagentToolStart, SubagentToolTarget, SubagentWriteOutcome,
} from '../../engine-sql/jobs-subagent.ts';
import { withDates } from '../store-codec.ts';
import { storeCall, type StoreMember } from './common.ts';

const call = <T>(member: string, run: () => Promise<T>): Promise<T> => storeCall({ member }, run);

export const listSubagentMessages: StoreMember<[jobId: number, opts?: { last?: boolean }], SubagentMessageRow[]> = async (brain, jobId, opts) =>
  (await call('listSubagentMessages', () => brain.listSubagentMessages(jobId, opts?.last === true)) as SubagentMessageRow[])
    .map(r => withDates(r, ['ended_at']));

export const countSubagentMessages: StoreMember<[jobId: number], number> = (brain, jobId) =>
  call('countSubagentMessages', () => brain.countSubagentMessages(jobId));

export const insertSubagentMessage: StoreMember<[jobId: number, message: SubagentMessageInsert], void> = async (brain, jobId, message) => {
  await call('insertSubagentMessage', () => brain.insertSubagentMessage(jobId, message));
};

export const listSubagentToolExecutions: StoreMember<[jobId: number, order: SubagentToolOrder], SubagentToolRow[]> = async (brain, jobId, order) =>
  (await call('listSubagentToolExecutions', () => brain.listSubagentToolExecutions(jobId, order === 'replay')) as SubagentToolRow[])
    .map(r => withDates(r, ['started_at', 'ended_at']));

export const hasSubagentToolExecution: StoreMember<[jobId: number, opts?: { status?: string; toolUseIdPrefix?: string }], boolean> = (brain, jobId, opts) =>
  call('hasSubagentToolExecution', () => brain.hasSubagentToolExecution(jobId, opts?.status ?? null, opts?.toolUseIdPrefix ?? null));

export const listSubagentWriteOutcomes: StoreMember<[jobId: number, toolUseIdPrefix?: string], SubagentWriteOutcome[]> = (brain, jobId, toolUseIdPrefix) =>
  call('listSubagentWriteOutcomes', () => brain.listSubagentWriteOutcomes(jobId, toolUseIdPrefix ?? null));

export const listSubagentOneshotLedger: StoreMember<[jobId: number, toolUseIdPrefix: string], SubagentOneshotLedgerRow[]> = (brain, jobId, toolUseIdPrefix) =>
  call('listSubagentOneshotLedger', () => brain.listSubagentOneshotLedger(jobId, toolUseIdPrefix));

export const summarizeSubagentToolExecutions: StoreMember<[jobIds: readonly number[], spec: { toolName: string; status: string }], { count: number; output_bytes: number }> =
  (brain, jobIds, spec) => call('summarizeSubagentToolExecutions', () => brain.summarizeSubagentToolExecutions([...jobIds], spec.toolName, spec.status));

export const listSubagentPutPageSlugs: StoreMember<[jobIds: readonly number[]], Array<string | null>> = (brain, jobIds) =>
  call('listSubagentPutPageSlugs', () => brain.listSubagentPutPageSlugs([...jobIds]));

export const listSubagentPutPageWrites: StoreMember<[jobIds: readonly number[]], Array<{ job_id: number; slug: string | null; started_at: Date }>> = async (brain, jobIds) =>
  (await call('listSubagentPutPageWrites', () => brain.listSubagentPutPageWrites([...jobIds])) as Array<{ job_id: number; slug: string | null; started_at: Date }>)
    .map(r => withDates(r, ['started_at']));

export const listSubagentRetainedPutPages: StoreMember<[jobIds: readonly number[]], SubagentRetainedPutPage[]> = async (brain, jobIds) =>
  (await call('listSubagentRetainedPutPages', () => brain.listSubagentRetainedPutPages([...jobIds])) as SubagentRetainedPutPage[])
    .map(r => withDates(r, ['started_at']));

export const listSubagentStagedPages: StoreMember<[jobId: number], Array<{ slug: string | null; content: string | null }>> = (brain, jobId) =>
  call('listSubagentStagedPages', () => brain.listSubagentStagedPages(jobId));

export const listSubagentTimelineAppendCalls: StoreMember<[jobIds: readonly number[], sourceId: string], Array<{ request_id: string; slug: string; input: unknown }>> =
  (brain, jobIds, sourceId) => call('listSubagentTimelineAppendCalls', () => brain.listSubagentTimelineAppendCalls([...jobIds], sourceId));

export const recordSubagentToolExecutions: StoreMember<[jobId: number, rows: readonly SubagentToolInsert[], opts?: { legacyGuard?: boolean }], void> = async (brain, jobId, rows, opts) => {
  await call('recordSubagentToolExecutions', () => brain.recordSubagentToolExecutions(jobId, [...rows], opts?.legacyGuard === true));
};

export const startSubagentToolExecution: StoreMember<[jobId: number, row: SubagentToolStart], string | null> = (brain, jobId, row) =>
  call('startSubagentToolExecution', () => brain.startSubagentToolExecution(jobId, row));

export const completeSubagentToolExecution: StoreMember<[target: SubagentToolTarget, output: string], number> = (brain, target, output) =>
  call('completeSubagentToolExecution', () => brain.completeSubagentToolExecution(target, output));

export const failSubagentToolExecution: StoreMember<[target: SubagentToolTarget, error: string, fallback?: SubagentFailureFallback], number> = (brain, target, error, fallback) =>
  call('failSubagentToolExecution', () => brain.failSubagentToolExecution(target, error, fallback ?? null));
