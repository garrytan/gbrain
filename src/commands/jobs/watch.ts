/** `gbrain jobs watch` (dispatched by runJobs in src/commands/jobs.ts). */
import { hasFlag, parseFlag, type JobsCommandContext } from './shared.ts';

/** `--refresh-ms <n>` or `--refresh-ms=<n>` (#7624); 1000 when absent. */
export function parseRefreshMs(args: string[]): number {
  const raw = args.find(a => a.startsWith('--refresh-ms='))?.slice('--refresh-ms='.length) ?? parseFlag(args, '--refresh-ms');
  return raw === undefined ? 1000 : parseInt(raw, 10);
}

export async function runJobsWatch({ args, engine, queue }: JobsCommandContext): Promise<void> {
  // v0.41 D2 — live dashboard; v0.42.11.0 (#1784) decoupled output from TTY.
  // Flags: --json (FORMAT, human default), --follow (LOOP, default=isTTY so
  // non-TTY one-shots), --refresh-ms N (or =N). Non-TTY no-flag → one human snapshot.
  try { await queue.ensureSchema(); }
  catch (e) { console.error(e instanceof Error ? e.message : String(e)); process.exit(1); }
  const { runWatch } = await import('../jobs-watch.ts');
  const refreshMs = parseRefreshMs(args);
  const json = hasFlag(args, '--json');
  const follow = hasFlag(args, '--follow') ? true : undefined; // undefined → default to isTTY
  await runWatch(engine, { refreshMs, json, follow });
}
