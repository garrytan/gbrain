import { createHash } from 'node:crypto';
import { OperationError } from '../ops/contract.ts';
import { isWriteReceipt } from '../persistence/types.ts';
import { isPersistenceIpcMutation } from '../persistence/ipc.ts';

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
  const error = new OperationError(code, `Tool write ${output.request_id} is ${output.state}; inspect its durable receipt before retrying.`);
  error.writeRequest = output; error.writeError = code; throw error;
}
export function isPendingToolWrite(error: unknown): error is OperationError {
  return error instanceof OperationError && error.code === 'write_pending' && error.writeRequest !== undefined;
}
