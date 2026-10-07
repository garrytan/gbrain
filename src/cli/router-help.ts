/**
 * Usage for router commands when help is requested (#6114). cli.ts calls
 * this before dispatch, so a help request reaches only the router's
 * `printUsage`, never a subcommand, a thin-client route or the engine.
 */
import { ROUTERS } from './subcommands.ts';

export interface RouterModule {
  SUBCOMMANDS: readonly string[];
  printUsage(): void;
}

/** The router modules, one per ROUTERS entry (the help gate checks they match). */
export const ROUTER_MODULES: Readonly<Record<string, () => Promise<RouterModule>>> = {
  pages: () => import('../commands/pages.ts'),
  cache: () => import('../commands/cache.ts'),
  integrity: () => import('../commands/integrity.ts'),
  hook: () => import('../commands/hook.ts'),
  search: () => import('../commands/search.ts'),
  'edge-proposals': () => import('../commands/edge-proposals.ts'),
  schema: () => import('../commands/schema.ts'),
  config: () => import('../commands/config.ts'),
};

/**
 * Prints the router's usage and returns true. `search` prints its dashboard
 * usage only for its dashboard subcommands; `search --help` alone keeps the
 * search operation's help.
 */
export async function printRouterHelp(command: string, subArgs: readonly string[]): Promise<boolean> {
  const router = ROUTERS[command];
  const load = ROUTER_MODULES[command];
  if (!router || !load) return false;
  if (!router.bareHelpFirst && !router.subcommands.includes(subArgs[0] ?? '')) return false;
  (await load()).printUsage();
  return true;
}
