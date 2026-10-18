/**
 * `gbrain quarantine`: post-connect dispatch, run by handleCliOnly with the
 * engine connectEngine() opened. Moved verbatim from the src/cli.ts
 * handleCliOnly switch (refactor wave 1, W4 cli); the record lives in
 * src/cli/command-table.ts.
 *
 * #5575 DX-7: `quarantine release|drop <h<id>>` are aliases of
 * `gbrain trust release|drop`: they print the canonical form and run the same
 * owner action (release raises trust, so it asks for the typed token).
 * `quarantine clear` keeps its behavior and points at `gbrain trust release`
 * for held writes; clearing a page marker never raises the page's tier.
 */
import type { BrainEngine } from '../../core/engine.ts';
import type { CliDispatchContext } from '../command-table.ts';

export async function run(engine: BrainEngine, args: string[], ctx?: CliDispatchContext): Promise<void> {
  const [sub, ...rest] = args;
  if ((sub === 'release' || sub === 'drop') && !rest.includes('--help') && !rest.includes('-h')) {
    const { localTrustBackend, runTrustOwnerCommand } = await import('../../commands/trust.ts');
    console.error(`[quarantine] ${sub} is an alias: gbrain trust ${sub} ${rest.join(' ')}`.trimEnd());
    await runTrustOwnerCommand(localTrustBackend(engine, ctx?.SELECTED_CONFIG_BY_ENGINE.get(engine)), sub, rest);
    return;
  }
  if (sub === 'clear') {
    console.error('[quarantine] clear removes page markers only; facts and takes the write gate held are released with gbrain trust release <h<id>> (gbrain trust review lists them).');
  }
  // v0.42 (#1699): content-quality gate operator surface.
  const { runQuarantine } = await import('../../commands/quarantine.ts');
  await runQuarantine(engine, args);
}
