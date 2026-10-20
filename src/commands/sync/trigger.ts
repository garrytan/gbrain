/** `gbrain sync trigger`: ask for a sync of one source without waiting for it (GBRA-133 PR 2a). */
import type { BrainEngine } from '../../core/engine.ts';
import { cliRenderContext, renderNotice, type Notice } from '../../core/agent-output.ts';

export type TriggerAction = 'queued' | 'nudged' | 'coalesced';

/** The resident that syncs the source (its notifier drains the marker), or null when none is running. */
export interface TriggerResident { kind: string; pid: number | null }

export interface TriggerOutcome {
  action: TriggerAction;
  source_id: string;
  intent: 'freshness' | 'pull' | 'full';
  wanted_head: string | null;
  marker_generation: number;
  job_id?: number;
  resident: TriggerResident | null;
}

const USAGE = 'Usage: gbrain sync trigger --source <id> [--priority high|normal|low] [--json]';

export function printSyncTriggerHelp(): void {
  console.log(`${USAGE}

Ask for a sync of one source without waiting for it. The request is recorded
as a wanted marker (one per source and intent: freshness for a managed source,
its checkout's HEAD; pull for a classic source), so it is never lost while
another sync runs: whoever drains the source re-checks the marker afterwards.

Outcomes (stdout keeps job_id=N whenever a job is queued; --json prints
{action, job_id?, wanted_head, resident, ...}):
  queued      a sync job was queued (a jobs worker or autopilot runs it)
  coalesced   a sync job for this source is already waiting or running; the
              marker makes it (or the notifier) run once more if needed
  nudged      the running gbrain serve recorded the request and its notifier
              starts the sync (PGLite)

When no resident (gbrain serve, gbrain jobs work or the autopilot daemon)
watches the source, the outcome carries resident: null and the notice
no_resident with the fix gbrain sync --source <id> --no-pull (one stderr line,
or notice in --json). Exit 0 for every outcome.

See also:
  gbrain sources webhook set <id>   Set up GitHub-signed push webhook
  gbrain sync status --source <id>  The notifier block: who syncs it, its state
`);
}

/** The no_resident notice: the request is recorded, but nothing watches the source to run it on its own. */
export function noResidentNotice(sourceId: string): Notice {
  return {
    code: 'no_resident', kind: 'degraded',
    why: `No resident (gbrain serve, gbrain jobs work or the autopilot daemon) watches source ${sourceId}; the request is recorded and runs when one starts, or when a sync reaches it.`,
    fix: { argv: ['gbrain', 'sync', '--source', sourceId, '--no-pull'], consent: [], actor: 'agent', requires_exclusive: false,
      why: 'Syncs the checkout HEAD now; the recorded request clears once last_commit reaches it.' },
  };
}

export function printTriggerOutcome(o: TriggerOutcome, json: boolean): void {
  const notice = o.resident ? null : noResidentNotice(o.source_id);
  if (json) {
    console.log(JSON.stringify({ ...o, ...(notice ? { notice: renderNotice(notice, cliRenderContext()) } : {}) }));
    return;
  }
  const head = o.wanted_head ? o.wanted_head.slice(0, 8) : 'upstream';
  if (o.job_id !== undefined) console.log(`job_id=${o.job_id}`);
  else console.log(`action=${o.action}`);
  const line: Record<TriggerAction, string> = {
    queued: `queued sync job ${o.job_id} for ${o.source_id} (${o.intent}, wanted ${head})`,
    coalesced: `a sync job for ${o.source_id} is already waiting or running (job ${o.job_id}); the request is recorded and runs once more if that job does not reach ${head}`,
    nudged: `the running serve recorded the request for ${o.source_id} (${o.intent}, wanted ${head})${o.resident ? ' and its notifier starts the sync' : ''}`,
  };
  console.error(`[sync trigger] ${line[o.action]}`);
  if (notice) console.error(`[gbrain notice no_resident] ${notice.why} Run: ${notice.fix!.argv!.join(' ')}`);
}

/**
 * The engine path: records the marker and queues a job on either engine (single flight per source through maxPending
 * 1; the marker replaces the old 30 s idempotency bucket). On PGLite a live serve would have taken the request over its
 * IPC socket before this process could open the brain (commands/sync-delegate.ts). The outcome names the source's
 * resident, or none with the no_resident notice.
 */
export async function runSyncTrigger(engine: BrainEngine, args: string[]): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) return printSyncTriggerHelp();
  const sourceIdArg = args.find((a, i) => args[i - 1] === '--source') ?? null;
  if (!sourceIdArg) {
    console.error('Error: --source <id> is required');
    console.error(USAGE);
    process.exit(2);
  }
  const priorityArg = args.find((a, i) => args[i - 1] === '--priority') ?? 'high';
  const priorityMap: Record<string, number> = { high: -10, normal: 0, low: 5 };
  const priority = priorityMap[priorityArg];
  if (priority === undefined) {
    console.error(`Invalid --priority value: "${priorityArg}". Must be high|normal|low.`);
    process.exit(2);
  }
  const json = args.includes('--json');
  const { recordTriggerMarker } = await import('../../core/notifier/nudge.ts');
  const recorded = await recordTriggerMarker(engine, { sourceId: sourceIdArg, requestedBy: 'sync_trigger' });
  if (!recorded) {
    console.error(`Source "${sourceIdArg}" not found. List with: gbrain sources list`);
    process.exit(1);
  }
  const { marker, managed } = recorded;
  const base = { source_id: marker.source_id, intent: marker.intent, wanted_head: marker.wanted_head, marker_generation: marker.generation };
  const { MinionQueue } = await import('../../core/minions/queue.ts');
  const job = await new MinionQueue(engine).add('sync', {
    sourceId: marker.source_id,
    ...(managed || marker.intent === 'freshness' ? { noPull: true } : {}),
    noExtract: false,
    auto_embed_backfill: true,
    embed_reason: 'sync_trigger',
  }, { priority, maxPending: 1 });
  const { attachMarkerJob } = await import('../../core/notifier/store.ts');
  await attachMarkerJob(engine, marker.source_id, marker.intent, marker.generation, job.id);
  const { readNotifierBlock } = await import('../../core/notifier/status.ts');
  const live = (await readNotifierBlock(engine, marker.source_id).catch(() => null))?.resident ?? null;
  printTriggerOutcome({ action: job.coalesced ? 'coalesced' : 'queued', ...base, job_id: job.id, resident: live ? { kind: live.kind, pid: live.pid } : null }, json);
}
