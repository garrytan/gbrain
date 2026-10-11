/**
 * `gbrain embed`: post-connect dispatch, run by handleCliOnly with the
 * engine connectEngine() opened. Moved verbatim from the src/cli.ts
 * handleCliOnly switch (refactor wave 1, W4 cli); the record lives in
 * src/cli/command-table.ts.
 */
import { jsonRequested, setCliExitVerdict, writeStdoutFinal } from '../../core/cli-force-exit.ts';
import { lastBackgroundJob } from '../../core/cli-options.ts';
import { BUDGET_STOP_EXIT_CODE } from '../../core/exit-codes.ts';
import type { BrainEngine } from '../../core/engine.ts';
import type { Authorization } from '../../core/consent.ts';
import type { CliDispatchContext } from '../command-table.ts';

export async function run(engine: BrainEngine, args: string[], ctx: CliDispatchContext): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(EMBED_USAGE);
    return;
  }
  const { SELECTED_CONFIG_BY_ENGINE } = ctx;
  // A4: an explicit backfill is paid work; consent first, on the probe-only engine (startup: 'observational').
  const consent = await authorizeEmbed(engine, args);
  if (!consent) return;
  await ctx.completeStartup?.(engine);
  const { runEmbed } = await import('../../commands/embed.ts');
  // #3037: mirror the `import` case above — the CLI was discarding the
  // result, so a run where every chunk failed to embed still exited 0
  // and cron/CI/health gates read total silence as success. Surface
  // non-zero on failures > 0. (undefined = backgrounded via --background.)
  const embedResult = await runEmbed(engine, args, SELECTED_CONFIG_BY_ENGINE.get(engine) ?? null, consent);
  // D2: under --json the result is the one document (a budget stop carries
  // remaining_stale + resume_command and exits 11; --background names its job).
  if (jsonRequested(args)) {
    const job = lastBackgroundJob();
    await writeStdoutFinal(`${JSON.stringify(embedResult ?? { status: 'backgrounded', ...(job !== null ? { job_id: job } : {}) }, null, 2)}\n`);
  }
  if (embedResult && 'reason' in embedResult && embedResult.reason === 'cost_cap') {
    // Fix wave 13 P1.18: a stop at the approved cap is a budget stop, not a failure, even when earlier pages failed.
    setCliExitVerdict(BUDGET_STOP_EXIT_CODE);
  } else if (embedResult && embedResult.failures > 0) {
    setCliExitVerdict(1);
  } else if (embedResult && 'reason' in embedResult && embedResult.reason === 'time_budget') {
    setCliExitVerdict(BUDGET_STOP_EXIT_CODE);
  }
}

/**
 * Null when consent refused (exit 3 already reported); otherwise the approval
 * the run spends under (`authorization` null when the run cannot spend).
 * `--dry-run` and `--help` spend nothing.
 * Consent flags (read by requireConsent): --yes, --max-usd, --max-cost.
 */
async function authorizeEmbed(engine: BrainEngine, args: string[]): Promise<{ authorization: Authorization | null } | null> {
  const end = args.indexOf('--');
  const opts = end >= 0 ? args.slice(0, end) : args;
  if (opts.includes('--dry-run') || opts.includes('--help') || opts.includes('-h')) return { authorization: null };
  const { requireEmbedBackfillConsent } = await import('../../core/embed-consent.ts');
  const { isConsentRefusal, printConsentRefusal } = await import('../../core/consent.ts');
  const sourceAt = opts.indexOf('--source');
  const estimable = opts.includes('--stale') || opts.includes('--all');
  const argv = ['gbrain', 'embed', ...args.filter(a => a !== '--yes')];
  try {
    const authorization = await requireEmbedBackfillConsent(engine, {
      command: 'embed',
      argv,
      ...(estimable && !opts.includes('--images') && !opts.includes('--facts') ? { preview_argv: [...argv.filter(a => a !== '--background'), '--dry-run'] } : {}),
      args,
      scope: {
        all: opts.includes('--all'),
        ...(sourceAt >= 0 && opts[sourceAt + 1] ? { sourceId: opts[sourceAt + 1] } : {}),
        unestimated: !estimable || opts.includes('--slugs') || opts.includes('--facts') || opts.includes('--images'),
        ...(opts.includes('--images') ? { images: true } : {}),
      },
    });
    return { authorization };
  } catch (e) {
    if (isConsentRefusal(e)) { setCliExitVerdict(printConsentRefusal(e, { json: jsonRequested(args) })); return null; }
    throw e;
  }
}

/** `gbrain embed --help` (answered without a brain) and the usage error. */
const EMBED_USAGE = [
  'Usage: gbrain embed [<slug>|--all|--stale|--slugs s1 s2 ...] [--dry-run] [--batch-size N] [--priority recent] [--catch-up] [--include-null-signature] [--source <id>] [--yes | --max-usd N] [--json] | --stale --images | --facts',
  '  Embeds chunks without a vector (--stale; --catch-up keeps going until the backlog is empty) or re-embeds pages (--all, a slug, --slugs).',
  '  It calls the configured embedding provider, which bills per token: without a terminal it stops with exit 3 and the consent payload',
  '  unless --yes (cap: the estimate x1.5), --max-usd N, spend.posture=tokenmax or a per-run preapproval covers it. Pass those only after',
  '  the user agrees. --dry-run previews with no provider calls. Local providers that bill nothing (ollama, llama-server, lmstudio) need no approval.',
].join('\n');
