/**
 * The operation seam of shadow replay capture (docs/guides/shadow-replay.md). The MCP dispatcher and the CLI operation
 * lane call `recordOperation` / `enterOperation`; both are a null check when capture is off, and this module imports
 * nothing heavy. Engine calls made while an operation runs carry its id as `parent`, so the replay runs the operation
 * once and does not replay those calls on their own.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

/** What the replay needs to run an operation again, with no credential: the caller's shape, not its secret. */
export interface OpCall {
  surface: 'cli' | 'mcp';
  op: string;
  params: Record<string, unknown> | undefined;
  remote: boolean;
  transport?: string;
  source_id?: string;
  federated_source_ids?: string[];
  /** The call carried a credential (HTTP MCP) or a member identity (--as, an enforced member): not replayed as an operation. */
  bound_caller: boolean;
}

export interface OpRecorder {
  /** Starts an operation record and returns its id. */
  begin(call: OpCall): string;
  /** Ends it with a hash of what the caller saw (the CLI output text, or the MCP tool result). */
  end(id: string, output: unknown, threw?: string): void;
}

const store = new AsyncLocalStorage<{ id: string }>();
let recorder: OpRecorder | null = null;

export function setOpRecorder(r: OpRecorder | null): void { recorder = r; }
export function currentOperationId(): string | undefined { return store.getStore()?.id; }

/** True when an operation started now would be recorded: capture is on and no operation is already running. */
export function operationRecording(): boolean { return recorder !== null && store.getStore() === undefined; }

/** The credential-free shape of an MCP call (the dispatcher's options, read by name; the credential itself is never kept). */
export function mcpOperationCall(op: string, params: Record<string, unknown> | undefined, o: {
  remote?: boolean; transport?: string; sourceId?: string; localFederatedSourceIds?: string[]; auth?: unknown; actor?: unknown; onBehalfOf?: unknown; enforcedMember?: unknown; stdioMember?: unknown;
}): OpCall {
  return { surface: 'mcp', op, params, remote: o.remote !== false, transport: o.transport, source_id: o.sourceId, federated_source_ids: o.localFederatedSourceIds,
    bound_caller: !!(o.auth || o.actor || o.onBehalfOf || o.enforcedMember || o.stdioMember) };
}

/** Runs `fn` as one recorded operation (the MCP dispatcher). */
export async function recordOperation<T>(call: () => OpCall, fn: () => Promise<T>): Promise<T> {
  const r = recorder;
  if (!r) return fn();
  let id: string;
  try { id = r.begin(call()); } catch { return fn(); }
  try {
    const out = await store.run({ id }, fn);
    try { r.end(id, out); } catch { /* capture never fails a call */ }
    return out;
  } catch (e) {
    try { r.end(id, undefined, (e as { code?: string })?.code ?? 'error'); } catch { /* never fails a call */ }
    throw e;
  }
}

/** Marks the rest of this one-shot CLI process as one operation; returns the function that records its output. */
export function enterOperation(call: () => OpCall): (output: unknown) => void {
  const r = recorder;
  if (!r) return () => {};
  try {
    const id = r.begin(call());
    store.enterWith({ id });
    return (output: unknown) => { try { r.end(id, output); } catch { /* never fails a call */ } };
  } catch {
    return () => {};
  }
}
