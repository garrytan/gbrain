/**
 * `gbrain archive-crawler`: pre-connect dispatch. `--help` and
 * `check --repo <dir>` read only gbrain.yml, so they answer without a
 * configured brain; without --repo the module opens its own engine to find
 * the current source's local path. The record lives in
 * src/cli/command-table.ts.
 */
import { finishCliTeardown } from '../../core/cli-force-exit.ts';
import type { CliDispatchContext } from '../command-table.ts';

export async function run(args: string[], ctx: CliDispatchContext): Promise<void> {
  const { runArchiveCrawler } = await import('../../commands/archive-crawler.ts');
  await runArchiveCrawler(args, () => ctx.connectEngine(), (engine) => finishCliTeardown({ engine }));
}
