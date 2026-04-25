/**
 * gbrain dream-cycle — Nightly episodic-to-semantic promotion.
 *
 * Scans recent timeline entries, detects recurring patterns, promotes
 * durable patterns into semantic memory (compiled_truth).
 *
 * Usage:
 *   gbrain dream-cycle [--repo <path>] [--dry-run] [--json]
 *   gbrain dream-cycle --window 7 --min-recurrence 4
 */

import type { BrainEngine } from '../core/engine.ts';
import { runDreamCycle, type PromotionConfig, type PromotionReport } from '../core/promotion.ts';

function parseArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

export async function runDreamCycleCommand(engine: BrainEngine, args: string[]) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`Usage: gbrain dream-cycle [options]

Nightly episodic-to-semantic promotion. Scans recent timeline entries
for recurring patterns and promotes them into semantic memory.

Options:
  --dry-run              Run without writing (default in non-interactive)
  --json                 Output structured JSON
  --window <days>        Evidence window in days (default: 14)
  --min-recurrence <n>   Minimum recurrences to promote (default: 3)
  --max-promotions <n>   Max promotions per run (default: 10)
  --help                 Show this help`);
    return;
  }

  const jsonMode = args.includes('--json');
  // Default to dry-run only in non-interactive contexts for safety
  const dryRun = args.includes('--dry-run') || (!args.includes('--no-dry-run') && !process.stdin.isTTY);

  const config: Partial<PromotionConfig> = {};
  const window = parseArg(args, '--window');
  if (window) config.evidenceWindowDays = parseInt(window, 10);
  const minRec = parseArg(args, '--min-recurrence');
  if (minRec) config.minRecurrence = parseInt(minRec, 10);
  const maxProm = parseArg(args, '--max-promotions');
  if (maxProm) config.maxPromotions = parseInt(maxProm, 10);

  if (!jsonMode) {
    console.log(`Dream cycle starting (${dryRun ? 'dry-run' : 'live'}, window: ${config.evidenceWindowDays ?? 14} days)...`);
  }

  try {
    const report = await runDreamCycle(engine, config, dryRun);

    if (jsonMode) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    // Human-readable output
    console.log('');
    console.log(`Evidence window: ${report.evidenceWindowDays} days`);
    console.log(`Total candidates: ${report.candidates.length}`);
    console.log(`Promotable: ${report.promoted.length}`);
    console.log(`Skipped: ${report.skipped.length}`);
    console.log(`Mode: ${report.dryRun ? 'dry-run' : 'live'}`);
    console.log(`Run at: ${report.runAt}`);

    if (report.promoted.length > 0) {
      console.log('\n--- Promoted ---');
      for (const p of report.promoted) {
        console.log(`  [${p.score.toFixed(2)}] "${p.pattern}"`);
        console.log(`    → ${p.slugs.join(', ')} (${p.recurrence}x, last: ${p.lastSeen})`);
        console.log(`    ${p.reason}`);
      }
    }

    if (report.skipped.length > 0 && report.skipped.length <= 20) {
      console.log('\n--- Skipped ---');
      for (const s of report.skipped.slice(0, 20)) {
        console.log(`  "${s.pattern}" — ${s.reason}`);
      }
    } else if (report.skipped.length > 20) {
      console.log(`\n--- Skipped (${report.skipped.length}, showing first 10) ---`);
      for (const s of report.skipped.slice(0, 10)) {
        console.log(`  "${s.pattern}" — ${s.reason}`);
      }
    }

    console.log('');

    // Log this run to the ingest log
    if (!dryRun) {
      await engine.logIngest({
        source_type: 'dream-cycle',
        source_ref: report.runAt,
        pages_updated: report.promoted.map(p => p.slugs[0]),
        summary: `Dream cycle: ${report.promoted.length} promoted, ${report.skipped.length} skipped`,
      });
    }
  } catch (e) {
    console.error(`Dream cycle failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
