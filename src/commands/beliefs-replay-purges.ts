/**
 * `gbrain beliefs replay-purges` (docs/designs/BELIEF_LEDGER.md section 8): a
 * Postgres restore happens outside gbrain, so the purges made after the backup
 * are replayed into the restored database here, from a purge mirror
 * (`--purge-mirror <absolute path>`) or from the pre-restore database
 * (`--from-url-env <VAR>`, the URL never on argv). A dry run by default: the
 * replay runs and rolls back, and `--apply` writes it.
 */
import { isAbsolute } from 'node:path';
import type { BrainEngine } from '../core/engine.ts';
import { opError } from '../core/ops/contract.ts';
import { purgeLinesFromDatabase, readPurgeMirror, replayPurges, type PurgeReplayResult } from '../core/belief/purge-mirror.ts';

const flag = (args: string[], name: string): string | undefined => {
  const at = args.indexOf(name);
  if (at >= 0) return args[at + 1];
  return args.find(a => a.startsWith(`${name}=`))?.slice(name.length + 1);
};

export interface ReplayPurgesReport extends PurgeReplayResult { applied: boolean; archived_at: string; from: 'purge_mirror' | 'database'; apply_argv?: string[] }

export async function replayPurgesCli(engine: BrainEngine, args: string[]): Promise<{ value: ReplayPurgesReport; text: string }> {
  if (engine.kind !== 'postgres') {
    throw opError('invalid_params', 'gbrain beliefs replay-purges replays purges into a restored Postgres brain; a PGLite restore replays them itself.',
      'On PGLite, run gbrain backup restore --purge-mirror <absolute path> to name a purge mirror other than the brain home\'s.');
  }
  const archivedAt = flag(args, '--archived-at');
  if (!archivedAt || Number.isNaN(Date.parse(archivedAt))) {
    throw opError('invalid_params', '--archived-at <ISO time> is required: the time the restored backup was taken.', 'Pass the backup\'s creation time, e.g. --archived-at 2026-10-01T12:00:00Z.');
  }
  const mirror = flag(args, '--purge-mirror');
  const urlEnv = flag(args, '--from-url-env');
  if (!mirror === !urlEnv) {
    throw opError('invalid_params', 'Name exactly one replay source: --purge-mirror <absolute path> or --from-url-env <VAR>.',
      'The purge mirror is <brain home>/.gbrain/purge-events.jsonl on the host that ran the purges; --from-url-env names an environment variable holding the pre-restore database URL.');
  }
  if (mirror && !isAbsolute(mirror)) throw opError('invalid_params', `--purge-mirror must be an absolute path (got ${mirror}).`, 'Pass the mirror file\'s absolute path.');
  let lines;
  if (mirror) {
    lines = readPurgeMirror(mirror);
    if (!lines) throw opError('invalid_params', `The purge mirror ${mirror} does not exist or cannot be read.`, 'Check the path and its permissions (the mirror is 0600, owned by the brain\'s user).');
  } else {
    const url = process.env[urlEnv!];
    if (!url) throw opError('invalid_params', `Environment variable ${urlEnv} is not set.`, `Set ${urlEnv} to the pre-restore database URL, then run the command again.`);
    const { createEngine } = await import('../core/engine-factory.ts');
    const pre = await createEngine({ engine: 'postgres', database_url: url });
    try {
      await pre.connect({ engine: 'postgres', database_url: url });
      lines = await purgeLinesFromDatabase(pre);
    } finally { await pre.disconnect().catch(() => undefined); }
  }
  const apply = args.includes('--apply');
  const result = await replayPurges(engine, { lines, archivedAt, apply });
  const applyArgv = ['gbrain', 'beliefs', 'replay-purges', '--archived-at', archivedAt, ...(mirror ? ['--purge-mirror', mirror] : ['--from-url-env', urlEnv!]), '--apply'];
  const value: ReplayPurgesReport = { ...result, applied: apply, archived_at: new Date(archivedAt).toISOString(), from: mirror ? 'purge_mirror' : 'database', ...(apply ? {} : { apply_argv: applyArgv }) };
  const counts = `${result.replays.length} purge(s) (${result.state}${result.ledger === 'absent' ? ', no belief ledger in the restored database' : ''})`;
  const text = apply ? `Replayed ${counts} into the restored database.`
    : `Dry run: ${counts} would be replayed; nothing was written. Ask the user, then run ${applyArgv.join(' ')}.`;
  return { value, text };
}
