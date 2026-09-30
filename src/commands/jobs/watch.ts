/** `gbrain jobs watch` (dispatched by runJobs in src/commands/jobs.ts). */
import { hasFlag, type JobsCommandContext } from './shared.ts';

export async function runJobsWatch({ args, engine, queue }: JobsCommandContext): Promise<void> {
  // v0.41 D2 — live dashboard; v0.42.11.0 (#1784) decoupled output from TTY.
  // Flags: --json (FORMAT, human default), --follow (LOOP, default=isTTY so
  // non-TTY one-shots), --refresh-ms=N. Non-TTY no-flag → one human snapshot.
  try { await queue.ensureSchema(); }
  catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); }
  const { runWatch } = await import('../jobs-watch.ts');
  const refreshArg = args.find(a => a.startsWith('--refresh-ms='));
  const refreshMs = refreshArg ? parseInt(refreshArg.split('=')[1] ?? '1000', 10) : 1000;
  const json = hasFlag(args, '--json');
  const follow = hasFlag(args, '--follow') ? true : undefined; // undefined → default to isTTY
  await runWatch(engine, { refreshMs, json, follow });
}
