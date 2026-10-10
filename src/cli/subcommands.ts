/**
 * Subcommand inventories and the help grammar (#6114).
 *
 * Each router command exports its inventory as `SUBCOMMANDS` (re-exported
 * from here, so cli.ts can read them without loading the routers). The
 * router types its dispatch over the inventory, so a subcommand the router
 * handles but the inventory omits fails typecheck, and the help gate
 * (test/cli-help-no-side-effects*.serial.test.ts) runs every listed
 * subcommand's help.
 *
 * Help grammar: `--help` / `-h` anywhere before `--` asks for help, even in
 * a flag-value slot (`--older-than --help`). A bare `help` asks for help only
 * as the first token after a router command (`pages help`) or after one of
 * its subcommands (`pages purge-deleted help`); anywhere else (a free-text
 * query such as `search help`, a flag value) it is an ordinary argument.
 * Help never runs the subcommand: cli.ts prints the router's usage and
 * returns before startup side effects, strict argument checks and engine
 * access.
 */
export const PAGES_SUBCOMMANDS = ['purge-deleted', 'purges', 'unpurge'] as const;
export const CACHE_SUBCOMMANDS = ['stats', 'clear', 'prune'] as const;
export const INTEGRITY_SUBCOMMANDS = ['check', 'auto', 'review', 'reset-progress'] as const;
export const HOOK_SUBCOMMANDS = ['session-start', 'user-prompt', 'stop', 'session-end', 'compact'] as const;
export const SEARCH_SUBCOMMANDS = ['modes', 'stats', 'tune', 'diagnose'] as const;
export const EDGE_PROPOSALS_SUBCOMMANDS = ['list', 'show', 'accept', 'reject', 'undo', 'date'] as const;
export const CONFIG_SUBCOMMANDS = ['show', 'get', 'set', 'unset'] as const;
export const QUARANTINE_SUBCOMMANDS = ['list', 'clear', 'scan', 'release', 'drop'] as const;
export const SCHEMA_SUBCOMMANDS = [
  'active', 'list', 'show', 'validate', 'use', 'detect', 'suggest', 'review-candidates', 'init', 'fork', 'edit',
  'diff', 'graph', 'lint', 'explain', 'review-orphans', 'downgrade', 'usage', 'stats', 'cardinality-preview',
  'sync', 'reload', 'add-type', 'remove-type', 'update-type', 'add-alias', 'remove-alias', 'add-prefix',
  'remove-prefix', 'add-link-type', 'remove-link-type', 'set-extractable', 'set-expert-routing', 'scaffold-extractable',
] as const;

export interface RouterInventory {
  subcommands: readonly string[];
  /**
   * The router's first argument is a subcommand, so a bare `help` there asks
   * for help. False for `search`, whose first argument is otherwise a query.
   */
  bareHelpFirst: boolean;
}

/** Every router command with an inventory, keyed by command name. */
export const ROUTERS: Readonly<Record<string, RouterInventory>> = {
  pages: { subcommands: PAGES_SUBCOMMANDS, bareHelpFirst: true },
  cache: { subcommands: CACHE_SUBCOMMANDS, bareHelpFirst: true },
  integrity: { subcommands: INTEGRITY_SUBCOMMANDS, bareHelpFirst: true },
  hook: { subcommands: HOOK_SUBCOMMANDS, bareHelpFirst: true },
  search: { subcommands: SEARCH_SUBCOMMANDS, bareHelpFirst: false },
  'edge-proposals': { subcommands: EDGE_PROPOSALS_SUBCOMMANDS, bareHelpFirst: true },
  schema: { subcommands: SCHEMA_SUBCOMMANDS, bareHelpFirst: true },
  config: { subcommands: CONFIG_SUBCOMMANDS, bareHelpFirst: true },
  quarantine: { subcommands: QUARANTINE_SUBCOMMANDS, bareHelpFirst: true },
};

/** `--help` / `-h` before any `--` terminator. */
export function helpFlagRequested(args: readonly string[]): boolean {
  for (const a of args) {
    if (a === '--') return false;
    if (a === '--help' || a === '-h') return true;
  }
  return false;
}

/**
 * True when `args` (the tokens after the command) ask for help under the
 * grammar above. `router` is the command's inventory, or undefined for a
 * command without subcommands (only the flags count there).
 */
export function subcommandHelpRequested(args: readonly string[], router?: RouterInventory): boolean {
  if (helpFlagRequested(args)) return true;
  if (!router) return false;
  if (router.bareHelpFirst && args[0] === 'help') return true;
  return router.subcommands.includes(args[0] ?? '') && args[1] === 'help';
}

/** The help decision for `gbrain <command> ...args`, made once in cli.ts before any side effect. */
export function cliHelpRequested(command: string, args: readonly string[]): boolean {
  return subcommandHelpRequested(args, ROUTERS[command]);
}
