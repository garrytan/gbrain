/**
 * `foresights jobs wait <id> [--timeout <dur>] [--json]` (#7242): block until the job is completed, failed, dead or
 * cancelled, then print it like `jobs get`. Exit codes follow the agent operator protocol: 0 completed,
 * 1 failed, dead or cancelled (the job's outcome, not a wait error), 124 the --timeout elapsed and the job is
 * still running (it is NOT cancelled; wait again or `foresights jobs get <id>`), 2 usage. A thin client waits
 * through the wait_job MCP op in chunks of at most WAIT_JOB_MAX_S.
 */
import { hasFlag, parseFlag, rehydrateJobDates, type JobsCommandContext } from './shared.ts';
import { isThinClient, loadConfig } from '../../core/config.ts';
import type { MinionJob } from '../../core/minions/types.ts';
import { callRemoteTool, unpackToolResult } from '../../core/mcp-client.ts';
import { parseDurationSeconds } from '../../core/sync-concurrency.ts';
import { isTerminalJobStatus, TimeoutError, waitForCompletion } from '../../core/minions/wait-for-completion.ts';
import { printJob } from './get.ts';

export const JOBS_WAIT_EXIT = { completed: 0, unsuccessful: 1, usage: 2, timeout: 124 } as const;

export async function runJobsWait({ args, queue, engine }: JobsCommandContext): Promise<void> {
  const id = Number(args[1]);
  if (!Number.isSafeInteger(id) || id <= 0) {
    console.error('Error: job ID required. Usage: foresights jobs wait <id> [--timeout 10m] [--json]');
    process.exit(JOBS_WAIT_EXIT.usage);
  }
  let timeoutS: number | undefined;
  try { timeoutS = parseDurationSeconds(parseFlag(args, '--timeout'), '--timeout'); }
  catch (e) { console.error(`Error: ${(e as Error).message}`); process.exit(JOBS_WAIT_EXIT.usage); }
  const json = hasFlag(args, '--json');
  const timeoutMs = (timeoutS ?? 24 * 3600) * 1000;
  const cfg = loadConfig();
  const thin = isThinClient(cfg);

  let job: MinionJob | null;
  let timedOut = false;
  if (thin) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = Math.max(0, deadline - Date.now());
      let doc: (MinionJob & { terminal?: boolean }) | null;
      try {
        doc = unpackToolResult<MinionJob & { terminal?: boolean }>(await callRemoteTool(cfg!, 'wait_job', { id, timeout_s: Math.min(55, Math.ceil(remaining / 1000)) }, { timeoutMs: 75_000 }));
      } catch (e) {
        if (/not found/i.test(e instanceof Error ? e.message : String(e))) { console.error(`Job #${id} not found.`); process.exit(JOBS_WAIT_EXIT.unsuccessful); }
        throw e;
      }
      job = rehydrateJobDates(doc);
      if (doc.terminal === true || isTerminalJobStatus(doc.status)) break;
      if (Date.now() >= deadline) { timedOut = true; break; }
    }
  } else {
    try { await queue.ensureSchema(); }
    catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(JOBS_WAIT_EXIT.unsuccessful); }
    try {
      job = await waitForCompletion(queue, id, { timeoutMs, pollMs: engine.kind === 'pglite' ? 250 : 1000 });
    } catch (e) {
      if (!(e instanceof TimeoutError)) {
        if (/not found|disappeared/.test((e as Error).message)) { console.error(`Job #${id} not found.`); process.exit(JOBS_WAIT_EXIT.unsuccessful); }
        throw e;
      }
      timedOut = true;
      job = await queue.getJob(id);
      if (!job) { console.error(`Job #${id} not found.`); process.exit(JOBS_WAIT_EXIT.unsuccessful); }
    }
  }
  await printJob(job!, json, thin ? null : engine);
  if (timedOut) {
    console.error(`Job #${id} is still ${job!.status} after ${Math.round(timeoutMs / 1000)}s; it keeps running. Wait again: foresights jobs wait ${id}, or check it: foresights jobs get ${id}`);
    process.exit(JOBS_WAIT_EXIT.timeout);
  }
  if (job!.status !== 'completed') {
    console.error(`Job #${id} ended ${job!.status}${job!.error_text ? `: ${job!.error_text.slice(0, 300)}` : ''}`);
    process.exit(JOBS_WAIT_EXIT.unsuccessful);
  }
}
