/**
 * `gbrain upgrade`: pre-connect dispatch (engine-free), run by
 * handleCliOnly before the connectEngine() terminator. Moved verbatim from
 * src/cli.ts (refactor wave 1, W4 cli); the record lives in src/cli/command-table.ts.
 * PR B: `--check-downgrade` (read-only) opens the brain and refuses while writes deferred behind a refresh wait.
 */
import type { CliDispatchContext } from '../command-table.ts';

export async function run(args: string[], ctx: CliDispatchContext): Promise<void> {
  if (args.includes('--check-downgrade')) {
    const [{ deferredBacklog }, { opError }, { finishCliTeardown, setCliExitVerdict }, { writeCliError }] = await Promise.all([
      import('../../core/persistence/refresh-barrier.ts'), import('../../core/ops/contract.ts'), import('../../core/cli-force-exit.ts'), import('../cli-error.ts')]);
    const engine = await ctx.connectEngine({ probeOnly: true });
    try {
      const backlog = await deferredBacklog(engine);
      if (backlog.count === 0) { console.log(args.includes('--json') ? JSON.stringify({ ok: true, deferred: 0 }) : 'No deferred writes are waiting; a downgrade leaves nothing undrained.'); return; }
      setCliExitVerdict(writeCliError(opError('downgrade_blocked_deferred_writes',
        `${backlog.count} write(s) deferred behind a worktree refresh are still waiting (oldest ${Math.round(backlog.oldest_age_ms / 1000)} s), and an older gbrain cannot drain them.`,
        'Turn the barrier off with gbrain config set persistence.refresh_barrier false; wait until gbrain upgrade --check-downgrade exits 0, then downgrade. A released write publishes only when a gbrain process runs the write consumer on the worktree\'s owner host (gbrain serve, gbrain jobs work, or any gbrain write or sync import there); polling gbrain write-request only reads its receipt.',
        { detail: `count=${backlog.count} oldest_age_ms=${backlog.oldest_age_ms}` }), 'upgrade', { argv: args }));
    } finally { await finishCliTeardown({ engine }); }
    return;
  }
  const { runUpgrade } = await import('../../commands/upgrade.ts');
  await runUpgrade(args);
}
