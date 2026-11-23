/**
 * Whether the code running now serves an agent-facing (remote) caller. `dispatchToolCall` (src/mcp/dispatch.ts)
 * runs every operation handler inside `withRemoteCaller(ctx.remote !== false, …)`, so code far below the operation
 * layer, which never sees the OperationContext, can still tell a remote caller from the trusted local CLI. The Rust
 * engine owner client reads it to keep a remote caller's writes off the owner socket (owner-ipc/client.ts).
 *
 * Fail-closed like `OperationContext.remote`: anything but an explicit `false` marks the scope remote. Outside any
 * scope the answer is false (a CLI command, a worker job, a test).
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const store = new AsyncLocalStorage<boolean>();

/** Runs `fn` with the caller marked remote (true) or local (false); a nested call sets its own mark. */
export function withRemoteCaller<T>(remote: boolean, fn: () => T): T {
  return store.run(remote, fn);
}

/** True inside a `withRemoteCaller(true, …)` scope. */
export function isRemoteCaller(): boolean {
  return store.getStore() === true;
}
