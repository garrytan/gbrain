/** `gbrain jobs run-child` (dispatched by runJobs in src/commands/jobs.ts). */
import { hasFlag, parseFlag, type JobsCommandContext } from './shared.ts';
import { loadConfig } from '../../core/config.ts';
import { JOB_CHILD_EXIT_USAGE } from '../../core/minions/worker-exit-codes.ts';
import { CHILD_ENV } from '../../core/minions/job-isolation.ts';
import { MinionWorker } from '../../core/minions/worker.ts';
import { runChildJobEntry, writeChildBootstrapError } from '../../core/minions/run-child.ts';

export async function runJobsRunChild({ args, engine }: JobsCommandContext): Promise<void> {
  // Lazy: jobs.ts imports this module statically, so a static import back would be a cycle.
  const { registerBuiltinHandlers } = await import('../jobs.ts');
  // INTERNAL (issue #5 process isolation): spawned by `jobs work` with
  // process isolation enabled. One job, one process: validate the claim,
  // run the handler with the child's own engine, write ONE outcome file,
  // exit. Deliberately absent from user-facing help. The CLI layer owns
  // engine.disconnect() + process.exit() (engine-ownership invariant).
  {
    // --allow-shell-jobs (buildChildArgs pass-through): same re-assert as
    // `work` — this child's preflight re-ran the cwd-.env quarantine.
    if (hasFlag(args, '--allow-shell-jobs')) process.env.GBRAIN_ALLOW_SHELL_JOBS = '1';
    const config = loadConfig();
    if (config?.engine === 'pglite') {
      console.error('[run-child] process isolation requires the Postgres engine.');
      await engine.disconnect();
      process.exit(JOB_CHILD_EXIT_USAGE);
    }
    const jobIdRaw = parseFlag(args, '--job-id');
    const jobId = jobIdRaw != null ? parseInt(jobIdRaw, 10) : NaN;
    const lockToken = process.env[CHILD_ENV.lockToken];
    const resultPath = process.env[CHILD_ENV.resultPath];
    const parentPidRaw = parseInt(process.env[CHILD_ENV.parentPid] ?? '0', 10);
    if (!Number.isInteger(jobId) || jobId <= 0 || !lockToken || !resultPath) {
      console.error(
        '[run-child] internal command spawned by the jobs worker; requires ' +
        `a numeric job id plus ${CHILD_ENV.lockToken} and ${CHILD_ENV.resultPath} in env.`,
      );
      await engine.disconnect();
      process.exit(JOB_CHILD_EXIT_USAGE);
    }

    // Same handler surface as the worker: registerBuiltinHandlers also
    // performs plugin discovery, so plugin subagent jobs isolate too.
    const throwaway = new MinionWorker(engine, { queue: 'default', concurrency: 1 });

    let code: number;
    try {
      await registerBuiltinHandlers(throwaway, engine, { quiet: true });
      code = await runChildJobEntry(
        engine,
        {
          jobId,
          lockToken,
          resultPath,
          parentPid: Number.isInteger(parentPidRaw) && parentPidRaw > 0 ? parentPidRaw : 0,
        },
        { resolveHandler: (name) => throwaway.getHandler(name) },
      );
    } catch (e) {
      code = writeChildBootstrapError(resultPath, e);
      console.error('[run-child] bootstrap failed; the parent will inspect the structured outcome.');
    }
    await engine.disconnect();
    process.exit(code);
  }
}
