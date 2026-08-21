#!/usr/bin/env bun

/**
 * Public executable entrypoint. Keep this module dependency-light: hooks run
 * once per agent event and must not pay to evaluate the full CLI graph. The
 * legacy CLI remains in cli-main.ts and is loaded only for non-hook commands.
 */
import { parseGlobalFlags } from './core/cli-options.ts';

async function dispatch(): Promise<void> {
  const { rest } = parseGlobalFlags(process.argv.slice(2));

  if (rest[0] === 'hook') {
    const { runHook } = await import('./commands/hook.ts');
    process.exit(await runHook(rest.slice(1)));
  }

  if (rest[0] === 'bootstrap' && rest[1] === 'hooks' &&
      rest.includes('--dry-run') && rest[rest.indexOf('--harness') + 1] === 'all') {
    process.env.GBRAIN_SKIP_STARTUP_HOOKS = '1';
  }

  const { runCliMain } = await import('./cli-main.ts');
  await runCliMain();
}

if (import.meta.main) {
  void dispatch().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
