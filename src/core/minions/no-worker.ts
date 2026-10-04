/**
 * Queue honesty (agent-first operator wave, Lane E5): whether anything runs a
 * queue's waiting jobs, and the one Action that runs them when nothing does.
 *
 * PGLite has no background worker (the database is single-writer), so a job
 * queued there waits until `gbrain jobs work` drains the queue in the
 * foreground or `gbrain jobs submit --follow` runs it inline. A Postgres queue
 * needs a running worker (`gbrain jobs supervisor start`). `jobs submit`,
 * `submit_job`, `jobs stats` / `get_job_stats` and doctor's queue_health all
 * build their `no_worker` advice here so the surfaces cannot disagree.
 */
import type { Action, Notice } from '../agent-output.ts';
import { readWorkers } from './worker-registry.ts';

/**
 * True when a live registered worker (`gbrain jobs work`, supervised or a
 * PGLite drain) serves `queue` on this host; undefined when the registry
 * cannot be read (callers keep their pre-E5 behavior).
 */
export function queueWorkerAlive(queue: string, read: () => Array<{ queue: string }> = () => readWorkers(() => null)): boolean | undefined {
  try {
    return read().some(w => w.queue === queue);
  } catch {
    return undefined;
  }
}

/** The fix that runs a queue's waiting jobs: a foreground drain on PGLite, the supervisor on Postgres. */
export function runWaitingJobsFix(engineKind: string, queue: string): Action {
  const queueArgs = queue === 'default' ? [] : ['--queue', queue];
  const verify = { argv: ['gbrain', 'jobs', 'stats', '--json', ...queueArgs] };
  if (engineKind === 'pglite') {
    return {
      argv: ['gbrain', 'jobs', 'work', ...queueArgs], consent: [], actor: 'agent', requires_exclusive: true, verify,
      why: 'PGLite has no background worker: `gbrain jobs work` runs the waiting jobs in the foreground and exits once the queue is drained. It needs the brain to itself, so any running `gbrain serve` must stop first.',
    };
  }
  return {
    argv: ['gbrain', 'jobs', 'supervisor', 'start', ...queueArgs], consent: [], actor: 'agent', requires_exclusive: false, verify,
    why: 'Starts the job supervisor, which keeps a worker running for this queue and restarts it if it dies.',
  };
}

/** The `no_worker` notice: jobs are waiting (or were just queued) and nothing will run them until a worker does. */
export function noWorkerNotice(engineKind: string, queue: string, waiting: number, fix: Action = runWaitingJobsFix(engineKind, queue)): Notice {
  const pglite = engineKind === 'pglite';
  return {
    code: 'no_worker', kind: 'degraded', fix,
    why: `${waiting} job(s) are waiting on queue '${queue}' and no worker is running${pglite ? ' (PGLite has no background worker)' : ''}, so they will not run until one does.`,
    user_message: pglite
      ? 'Queued background jobs only run when gbrain is given the database to itself for a moment. Can I pause the gbrain server briefly to run them?'
      : 'Background jobs are queued but no gbrain worker is running. Can I start the job supervisor so they run?',
  };
}
