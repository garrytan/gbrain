/**
 * The process-level queue for the first `chat_fallback_chain` hop's
 * `chat_fallback_hop` safety notice. `chatWithFallback` queues at most one
 * per process; MCP dispatch (stdio), the CLI op notice channel and CLI
 * teardown drain it. No imports beyond a type, so every drain site can load
 * it cheaply.
 */
import type { Notice } from '../agent-output.ts';

let queued = false;
const pending: Notice[] = [];

/** Queue the first hop's notice; every later call in this process is a no-op. Returns whether it queued. */
export function queueFirstFallbackHop(build: () => Notice): boolean {
  if (queued) return false;
  queued = true;
  pending.push(build());
  return true;
}

/** Drain the queued first-hop notice (at most one per process). */
export function takeChatFallbackHopNotices(): Notice[] {
  return pending.splice(0);
}

/** Test seam: re-arm the once-per-process first-hop notice. */
export function __resetChatFallbackHopNoticeForTests(): void {
  queued = false;
  pending.splice(0);
}
