/**
 * `GBRAIN_AI_CALL_LOG=<path>`: append one JSON line per model call made by this
 * process (and by child processes, which inherit the variable). The ledger
 * records what was called, by which write request, effect, job or cycle phase,
 * how many tokens the provider reported and how long it took. It never records
 * prompt or response text. Observation does not change how calls execute.
 * Used by write-cost measurements; off unless the variable is set.
 */
import { appendFileSync } from 'node:fs';
import { observeAIInvocations, type AIInvocationEvent } from './invocation-guard.ts';

let installed: { path: string; dispose: () => void } | null = null;
let warned = false;

export function callLogLine(event: AIInvocationEvent): Record<string, unknown> {
  const u = event.usage;
  return {
    ts: new Date(event.startedAt).toISOString(),
    pid: process.pid,
    kind: event.call.kind === 'multimodal' ? 'embedding' : event.call.kind,
    raw_kind: event.call.kind,
    operation: event.call.operation,
    model: event.call.model,
    outcome: event.outcome,
    ms: event.ms,
    input_tokens: u ? u.inputTokens : 'unknown',
    output_tokens: u ? u.outputTokens : 'unknown',
    cache_read_tokens: u ? u.cacheReadTokens ?? 0 : 'unknown',
    cache_write_tokens: u ? u.cacheWriteTokens ?? 0 : 'unknown',
    ...(event.attribution ?? {}),
  };
}

/** Idempotent: re-running with the same path keeps one observer. */
export function installAICallLogFromEnv(env: NodeJS.ProcessEnv = process.env): void {
  const path = env.GBRAIN_AI_CALL_LOG?.trim();
  if (!path) {
    installed?.dispose();
    installed = null;
    return;
  }
  if (installed?.path === path) return;
  installed?.dispose();
  const dispose = observeAIInvocations(event => {
    try { appendFileSync(path, JSON.stringify(callLogLine(event)) + '\n'); }
    catch (error) {
      if (!warned) {
        warned = true;
        process.stderr.write(`[gbrain] GBRAIN_AI_CALL_LOG: cannot write ${path} (${error instanceof Error ? error.message : String(error)}); model-call lines are being dropped. Fix the path or unset the variable.\n`);
      }
    }
  });
  installed = { path, dispose };
}
