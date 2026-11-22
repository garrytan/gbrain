/**
 * `gbrain waiting`: pre-connect dispatch that opens its own engine. When a live
 * `gbrain serve` owns this PGLite brain, the open_loops read goes through that
 * serve's persistence socket instead of failing on its lock; otherwise it runs
 * on a local engine as before. The record lives in src/cli/command-table.ts.
 */
import type { BrainEngine } from '../../core/engine.ts';
import { finishCliTeardown } from '../../core/cli-force-exit.ts';
import type { CliDispatchContext } from '../command-table.ts';

export async function run(args: string[], ctx: CliDispatchContext): Promise<void> {
  const { runWaiting } = await import('../../commands/loops.ts');
  let engine: BrainEngine | null = null;
  try {
    await runWaiting(async (params, sourceId) => {
      const { loadConfig } = await import('../../core/config.ts');
      const { getCliOptions } = await import('../../core/cli-options.ts');
      const { maybeDelegateLocalOperation } = await import('../../core/persistence/local-client.ts');
      const { DEFAULT_READ_WALLCLOCK_MS } = await import('../../core/cli-socket/protocol.ts');
      const cli = getCliOptions();
      const delegated = await maybeDelegateLocalOperation('open_loops', params, loadConfig(), { brain: cli.brain, source: sourceId, timeoutMs: cli.timeoutMs ?? DEFAULT_READ_WALLCLOCK_MS });
      if (delegated.handled) return delegated.result;
      engine = await ctx.connectEngine();
      const { handleToolCall } = await import('../../mcp/server.ts');
      return handleToolCall(engine, 'open_loops', params, { sourceId });
    }, args);
  } catch (error) {
    const { reportPersistenceCliError } = await import('../../commands/persistence-delegate.ts');
    if (!(await reportPersistenceCliError(error, args.includes('--json')))) throw error;
  } finally {
    if (engine) await finishCliTeardown({ engine });
  }
}
