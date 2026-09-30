/** `gbrain sync trigger`: queue a push-triggered sync job. */
import type { BrainEngine } from '../../core/engine.ts';

/**
 * v0.40 Federated Sync v2: `gbrain sync trigger --source <id> [--priority high|normal|low]`
 *
 * Push-trigger entry point. Wraps `queue.add('sync', ...)` with priority -10
 * (above autopilot's 0) so push-triggered syncs preempt scheduled ones.
 * Use cases: GitHub webhook handler (POST /webhooks/github), CLI nudge after
 * a manual git pull, scripted dispatch from `gbrain sources federate`.
 *
 * Sets `auto_embed_backfill: true` so the extended sync handler (T6/T7)
 * auto-enqueues an embed-backfill job after the sync settles.
 *
 * Output: prints `job_id=N` to stdout for shell composition. Errors exit 1.
 */
export async function runSyncTrigger(engine: BrainEngine, args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`Usage: gbrain sync trigger --source <id> [--priority high|normal|low]

Queue a push-triggered sync job for one source. Prints the resulting job id
on stdout. The autopilot worker picks it up and runs performSync against the
named source; if the sync added/modified pages, an embed-backfill job is
auto-enqueued (subject to D6 budget cap + D19 source-level cooldown).

Use cases:
  - GitHub webhook → 'gbrain sync trigger --source <repo>'
  - Manual nudge after 'git pull' inside a federated source
  - Programmatic triggers from CI / shell automation

See also:
  gbrain sources webhook set <id>   Set up GitHub-signed push webhook
  gbrain sources status             Per-source sync + embed coverage
`);
    return;
  }

  const sourceIdArg = args.find((a, i) => args[i - 1] === '--source') ?? null;
  if (!sourceIdArg) {
    console.error('Error: --source <id> is required');
    console.error("Usage: gbrain sync trigger --source <id> [--priority high|normal|low]");
    process.exit(2);
  }

  const priorityArg = args.find((a, i) => args[i - 1] === '--priority') ?? 'high';
  const priorityMap: Record<string, number> = { high: -10, normal: 0, low: 5 };
  const priority = priorityMap[priorityArg];
  if (priority === undefined) {
    console.error(`Invalid --priority value: "${priorityArg}". Must be high|normal|low.`);
    process.exit(2);
  }

  // Verify source exists before submitting
  const { fetchSource } = await import('../../core/sources-load.ts');
  const source = await fetchSource(engine, sourceIdArg);
  if (!source) {
    console.error(`Source "${sourceIdArg}" not found. List with: gbrain sources list`);
    process.exit(1);
  }

  const { MinionQueue } = await import('../../core/minions/queue.ts');
  const queue = new MinionQueue(engine);
  const job = await queue.add(
    'sync',
    {
      sourceId: sourceIdArg,
      repoPath: source.local_path,
      noExtract: false,
      auto_embed_backfill: true,
      embed_reason: 'sync_trigger',
    },
    {
      priority,
      idempotency_key: `sync-trigger:${sourceIdArg}:${Math.floor(Date.now() / 30_000)}`,
      maxWaiting: 1,
    },
  );

  // --json: stdout is JSON lines (the same contract runSync keeps).
  console.log(args.includes('--json') ? JSON.stringify({ job_id: job.id }) : `job_id=${job.id}`);
}
