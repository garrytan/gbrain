import { createHash } from 'node:crypto';
import { OperationError, opError } from '../ops/contract.ts';
import { readFix } from '../ops/op-fix.ts';
import { isWriteReceipt } from '../persistence/types.ts';
import { isPersistenceIpcMutation } from '../persistence/ipc.ts';
import { replayWhilePending, WRITE_ADMISSION_HEADROOM_MS } from '../persistence/write-wait.ts';
import { WIRE_WRITE_WAIT_MAX_MS } from '../persistence/params.ts';
import { MaintenanceWriteWait } from '../persistence/maintenance-wait.ts';
import { abortableSleep, RetryAbortError } from '../retry.ts';

/** Bind a durable write to its persisted tool execution, including crash replay. */
export function retainToolWriteRequestId(input: unknown, jobId: number, messageIdx: number, ordinal: number, toolUseId: string, toolName: string): void {
  if (!isPersistenceIpcMutation(toolName.replace(/^brain_/, '')) || !input || typeof input !== 'object' || Array.isArray(input)) return;
  const params = input as Record<string, unknown>;
  if (params.request_id !== undefined || params.dry_run === true) return;
  const hex = createHash('sha256').update(JSON.stringify(['gbrain-tool-write-v1', jobId, messageIdx, ordinal, toolUseId])).digest('hex');
  // UUIDv8 uses the persisted execution coordinates as the application identity.
  params.request_id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${((parseInt(hex[16], 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** A queued mutation is durable work, never a completed tool-side write. */
export function assertToolWriteCommitted(output: unknown, toolName: string): void {
  if (!isPersistenceIpcMutation(toolName.replace(/^brain_/, '')) || !isWriteReceipt(output) || output.state === 'committed') return;
  const pending = ['queued', 'running', 'recovering'].includes(output.state);
  const code = pending ? 'write_pending' : 'storage_error';
  const error = opError(code, `Tool write ${output.request_id} is ${output.state}; inspect its durable receipt before retrying.`,
    pending ? `The tool write is accepted and still ${output.state}; read its receipt until it is terminal. Do not repeat the tool call: the same request id replays it.`
      : `The tool write ended ${output.state}; its receipt holds the recorded error. Read it before deciding whether a new write (with a new request id) is needed.`,
    { fix: readFix(`Reads tool write ${output.request_id}'s durable receipt, read-only.`, { argv: ['gbrain', 'write-request', '--', output.request_id] }) });
  error.writeRequest = output; error.writeError = code; throw error;
}

/** What a subagent tool dispatch needs from its job to bound a pending write. */
export interface ToolWriteJob { deadlineAtMs: number | null; signal?: AbortSignal }

/**
 * #5474: dispatch a subagent tool and, while its accepted write is still
 * pending, replay the same request id (nothing new is admitted, no model turn)
 * instead of failing the attempt. The replays stop when the write is terminal,
 * when the job is aborted, or once the job's deadline is closer than one more
 * longest tool wait plus admission headroom, so a retry still fits before the
 * runner times the job out. A job with no deadline gets the maintenance write
 * wait. Whatever is still pending then leaves as `write_pending` with its tool
 * row pending, exactly as before.
 */
export async function awaitCommittedToolWrite(job: ToolWriteJob, toolName: string, dispatch: () => Promise<unknown>): Promise<unknown> {
  const windowMs = job.deadlineAtMs == null ? new MaintenanceWriteWait().ms()
    : Math.max(0, job.deadlineAtMs - Date.now() - WIRE_WRITE_WAIT_MAX_MS - WRITE_ADMISSION_HEADROOM_MS);
  let lastFailure: unknown;
  const attempt = () => dispatch()
    .then(output => { assertToolWriteCommitted(output, toolName); return output; })
    .catch((failure: unknown) => { lastFailure = failure; throw failure; });
  try {
    return await replayWhilePending(attempt, windowMs, ms => abortableSleep(ms, job.signal));
  } catch (error) {
    throw error instanceof RetryAbortError && lastFailure !== undefined ? lastFailure : error;
  }
}

export function isPendingToolWrite(error: unknown): error is OperationError {
  return error instanceof OperationError && error.code === 'write_pending' && error.writeRequest !== undefined;
}
