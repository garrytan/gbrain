/**
 * gbrain facts — fact-store maintenance surface (#1867).
 *
 * `fence-backfill` re-runs the v0_32_2 fence-backfill phase on demand.
 * Remote `extract_facts` deposits that predate the fence-write backstop
 * (and any legacy DB-only insert) leave `row_num IS NULL` rows that the
 * cycle extract_facts guard refuses to reconcile past — previously the
 * only remedy was the one-shot v0_32_2 migration, which the ledger marks
 * complete and never re-runs. The phase is idempotent (only touches
 * `row_num IS NULL` rows), so exposing it as a command is safe to re-run
 * any time the backlog reappears.
 */
import type { BrainEngine } from '../core/engine.ts';
import { phaseBFenceFacts } from './migrations/v0_32_2.ts';

function printHelp(): void {
  process.stderr.write(
    `Usage: gbrain facts fence-backfill [--dry-run]\n\n` +
      `Fence-backfill: appends every legacy fact row (row_num IS NULL) to its\n` +
      `entity page's \`## Facts\` fence and stamps row_num + source_markdown_slug\n` +
      `back onto the DB row. Idempotent — re-runs only pick up rows still\n` +
      `missing a fence assignment. Clears the backlog that makes the cycle's\n` +
      `extract_facts phase skip fence→DB reconciliation.\n\n` +
      `  --dry-run   report what would be fenced; no FS or DB writes\n`,
  );
}

export async function runFactsCommand(engine: BrainEngine, args: string[]): Promise<void> {
  const sub = args[0];
  if (!sub || sub === '--help' || sub === '-h') {
    printHelp();
    return;
  }
  if (sub !== 'fence-backfill') {
    process.stderr.write(`Unknown facts subcommand: ${sub}\n`);
    printHelp();
    process.exitCode = 1;
    return;
  }

  const dryRun = args.includes('--dry-run');
  const result = await phaseBFenceFacts(engine, { dryRun });
  process.stderr.write(
    `fence-backfill: ${result.status}${result.detail ? ` — ${result.detail}` : ''}\n`,
  );
  if (result.status === 'failed') process.exitCode = 1;
}
