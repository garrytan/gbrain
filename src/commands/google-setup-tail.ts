/**
 * google-setup tail — source registration + first sync + first `waiting`
 * digest (the magical moment). Split from google-setup.ts so the connect
 * half stays engine-free.
 *
 * First-sync shape: runGoogleSync's backfill walks newest→oldest with a
 * batch-committed floor cursor, so the setup sync runs under a wall-clock
 * budget (default 90s) and whatever landed is the NEWEST mail — exactly
 * what `gbrain waiting` needs. The remainder resumes on every later sync
 * (autopilot, cron, or a queued background job when a worker is running);
 * nothing is lost by the budget, and setup says so honestly.
 */

import type { BrainEngine } from '../core/engine.ts';
import { deriveSourceId } from '../core/google/types.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';

export interface SetupTailInput {
  account: string;
  json: boolean;
  args: string[];
}

// deriveSourceId is shared with connect's next-step hint (types.ts) so the
// printed suggestion and the created id can never diverge.

export async function runGoogleSetupTail(input: SetupTailInput): Promise<void> {
  const { loadConfig, toEngineConfig } = await import('../core/config.ts');
  const cfg = loadConfig();
  if (!cfg) {
    const msg = 'No gbrain brain configured yet. Run `gbrain init` first, then re-run `gbrain google setup`.';
    if (input.json) {
      process.stdout.write(JSON.stringify({ ok: false, status: 'no_brain', next_action: { command: 'gbrain init' } }, null, 2) + '\n');
    } else {
      process.stderr.write(msg + '\n');
    }
    setCliExitVerdict(2);
    return;
  }
  const { createEngine } = await import('../core/engine-factory.ts');
  const engineConfig = toEngineConfig(cfg);
  const engine: BrainEngine = await createEngine(engineConfig);
  await engine.connect(engineConfig);
  try {
    // ── Step 2: source registration (idempotent) ──
    const rows = await engine.executeRaw<{ id: string; config: unknown }>(
      `SELECT id, config FROM sources WHERE archived IS NOT TRUE`,
      [],
    );
    let sourceId: string | null = null;
    for (const r of rows) {
      const c = typeof r.config === 'string' ? (JSON.parse(r.config) as Record<string, unknown>) : ((r.config ?? {}) as Record<string, unknown>);
      if (c.kind === 'google' && c.g_account === input.account) {
        sourceId = r.id;
        break;
      }
    }
    if (!sourceId) {
      sourceId = deriveSourceId(input.account);
      const historyIdx = input.args.indexOf('--history-days');
      const historyDays = historyIdx !== -1 ? Number(input.args[historyIdx + 1]) || 90 : 90;
      const { addSource, defaultCloneDir } = await import('../core/sources-ops.ts');
      // Register only the services the credential's grant actually covers —
      // a connect --scopes gmail must not create a source whose calendar/
      // contacts sweeps fail scope_missing forever.
      const { openVault, credentialId } = await import('../core/creds/vault.ts');
      const { GOOGLE_SERVICE_SCOPES } = await import('../core/creds/providers/google.ts');
      const entry = await openVault().get(credentialId('google', input.account));
      const granted = entry?.meta.scopes ?? [];
      const allServices = ['gmail', 'calendar', 'contacts'] as const;
      const services = granted.length > 0
        ? allServices.filter((svc) => granted.includes(GOOGLE_SERVICE_SCOPES[svc]))
        : [...allServices];
      await addSource(engine, {
        id: sourceId,
        google: {
          account: input.account,
          services: services.length > 0 ? [...services] : [...allServices],
          historyDays,
          dir: defaultCloneDir(`${sourceId}-google`),
        },
      });
      process.stderr.write(`Registered source "${sourceId}" for ${input.account}.\n`);
    }

    // ── Step 3: first sync under a wall-clock budget (newest-first, resumable) ──
    const budgetIdx = input.args.indexOf('--sync-budget-ms');
    const budgetMs = budgetIdx !== -1 ? Number(input.args[budgetIdx + 1]) || 90_000 : 90_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budgetMs);
    let partial = false;
    try {
      const { performSync } = await import('./sync.ts');
      const result = await performSync(engine, { sourceId, signal: controller.signal });
      partial = result.status === 'partial';
      process.stderr.write(
        `First sync: ${result.added + result.modified} pages (${result.status}).` +
          (partial ? ' The rest of the backfill resumes automatically on every future sync.\n' : '\n'),
      );
    } finally {
      clearTimeout(timer);
    }

    // Best-effort: queue the backfill remainder for a running worker.
    if (partial) {
      try {
        const { MinionQueue } = await import('../core/minions/queue.ts');
        await new MinionQueue(engine).add(
          'sync',
          { sourceId },
          { priority: 5, idempotency_key: `google-setup-backfill:${sourceId}`, maxWaiting: 1 },
        );
        process.stderr.write('Queued the backfill remainder as a background job.\n');
      } catch {
        process.stderr.write(`Backfill remainder: run \`gbrain sync --source ${sourceId}\` (or let autopilot pick it up).\n`);
      }
    }

    // ── Step 4: the magical moment ──
    const { runWaiting } = await import('./loops.ts');
    await runWaiting(engine, input.json ? ['--json', '--stale-ok'] : ['--stale-ok']);
    const { appendGoogleHeartbeat } = await import('./google.ts');
    appendGoogleHeartbeat('first_sync_ok', 'ok', { source_id: sourceId });
    appendGoogleHeartbeat('first_waiting_ok', 'ok');
  } finally {
    await engine.disconnect().catch(() => {});
  }
}
