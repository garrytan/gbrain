/**
 * `gbrain facts`: pre-connect dispatch (opens its own engine), so `--help`
 * answers without a configured brain. The record lives in
 * src/cli/command-table.ts (thinClient: 'refuse': relink publishes onto the
 * brain host's entity pages).
 */
import { finishCliTeardown, setCliExitVerdict } from '../../core/cli-force-exit.ts';
import type { CliDispatchContext } from '../command-table.ts';

export async function run(args: string[], ctx: CliDispatchContext): Promise<void> {
  const facts = await import('../../commands/facts.ts');
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(facts.factsHelpText());
    return;
  }
  const eng = await ctx.connectEngine();
  try {
    const { resolveSourceId, ALL_SOURCES } = await import('../../core/source-resolver.ts');
    const flag = args.indexOf('--source');
    const sourceId = await resolveSourceId(eng, flag >= 0 ? args[flag + 1] : null);
    if (sourceId === ALL_SOURCES) {
      console.error('gbrain facts relink repairs one source at a time; pass --source <id>.');
      setCliExitVerdict(1);
      return;
    }
    const config = ctx.SELECTED_CONFIG_BY_ENGINE.get(eng) ?? ({ engine: eng.kind } as never);
    setCliExitVerdict(await facts.runFactsCommand(eng, args, config, sourceId));
  } finally {
    await finishCliTeardown({ engine: eng });
  }
}
