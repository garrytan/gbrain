/**
 * Whether the code running now serves an agent-facing (remote) caller. Every finalized operation handler runs inside
 * this mark (operation-load.ts `finalizeOperation`), set from its own `ctx.remote`, wherever it is called from: MCP
 * dispatch, a subagent brain tool, a SkillOpt tool. `dispatchToolCall` (src/mcp/dispatch.ts) also marks its whole
 * call. So code far below the operation layer, which never sees the OperationContext, can still tell a remote caller
 * from the trusted local CLI. The Rust engine owner client reads it to keep a remote caller's writes off the owner
 * socket (owner-ipc/client.ts).
 *
 * Fail-closed like `OperationContext.remote`: anything but an explicit `false` marks the scope remote, and a handler
 * keeps an outer remote mark even when its own context says `remote: false`. Outside any scope the answer is false (a
 * CLI command, a worker job's own code, a test).
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
