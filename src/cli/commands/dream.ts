/**
 * `gbrain dream`: pre-connect dispatch (opens its own engine), run by
 * handleCliOnly before the connectEngine() terminator. Moved verbatim from
 * src/cli.ts (refactor wave 1, W4 cli); the record lives in src/cli/command-table.ts.
 */
import { finishCliTeardown } from '../../core/cli-force-exit.ts';
import type { BrainEngine } from '../../core/engine.ts';
import type { CliDispatchContext } from '../command-table.ts';

export async function run(args: string[], ctx: CliDispatchContext): Promise<void> {
  const { connectEngine } = ctx;
  // Dream mirrors doctor's pattern: filesystem phases run without a DB,
  // so an engine connection failure is non-fatal. runCycle honestly
  // reports DB phases as skipped when engine is null. v0.41.13 (#1422):
  // bind + surface the error on stderr so the user knows WHY DB phases
  // were skipped instead of seeing a silent "lint + backlinks done"
  // and assuming the cycle actually ran. Pre-fix, foxhoundinc reported
  // the cycle exiting 0 on PostgreSQL with every DB phase silently no-op.
  const { runDream } = await import('../../commands/dream.ts');
  let eng: BrainEngine | null = null;
  try {
    eng = await connectEngine();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[dream] WARNING: could not connect to DB (${msg}). ` +
      `Running filesystem-only phases (lint, backlinks, extract). ` +
      `DB-dependent phases (sync, embed, synthesize, etc.) will report as skipped.\n`
    );
  }
  try {
    await runDream(eng, args);
  } finally {
    // #1471 invariant tripwire (the dream-cycle owner): `eng` created the
    // module singleton (first module connector) and is torn down LAST,
    // here, after the whole cycle. The ownership fix relies on this owner's
    // lifetime strictly dominating every borrower (lint/doctor probe engines
    // created mid-cycle). Do NOT tear down `eng` before runDream returns, or
    // a borrower could outlive the owner and lose the shared singleton.
    // #2084: routed through the shared bounded teardown — dream runs as an
    // overnight cron, where a lingering-socket hang is a silent zombie
    // (closes the TODOS.md drain-before-owner-disconnect item).
    if (eng) await finishCliTeardown({ engine: eng });
  }
}
