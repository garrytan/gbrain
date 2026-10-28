/**
 * The CLI surface skill-drift checks against: the dispatcher's own
 * validators (command table, router subcommand inventories, the global-flag
 * parser and validateCommandFlags), imported rather than re-parsed, so a skill
 * passes exactly when the CLI would accept its invocation.
 */
import type { CliSurface } from '../core/skill-drift.ts';
import { CLI_ONLY } from './command-table.ts';
import { ROUTERS } from './subcommands.ts';
import { OPERATION_MANIFEST, cliOps } from './op-manifest.ts';
import { cliAliases, validateCommandFlags } from './flag-validation.ts';
import { findUnknownFlag } from './flag-equals.ts';
import { parseGlobalFlags } from '../core/cli-options.ts';
import { CLI_FLAG_REGISTRY } from '../core/cli-flag-registry.generated.ts';

export function cliSurface(): CliSurface {
  const opNames = OPERATION_MANIFEST.map(op => op.name);
  const opSet = new Set(opNames);
  return {
    isCommand: name => CLI_ONLY.has(name) || cliOps.has(name) || cliAliases.has(name),
    subcommands: command => ROUTERS[command]?.bareHelpFirst ? ROUTERS[command]!.subcommands : undefined,
    stripGlobalFlags: argv => parseGlobalFlags(argv).rest,
    unknownFlag: (command, args) => {
      if (!CLI_ONLY.has(command) && ROUTERS[command]?.subcommands.includes(args[0] ?? '')) {
        const legal = CLI_FLAG_REGISTRY[command];
        return legal ? findUnknownFlag(args, new Set(legal)) : null;
      }
      return validateCommandFlags(command, args);
    },
    legalFlags: command => {
      const op = cliOps.get(command) ?? cliAliases.get(command);
      return CLI_FLAG_REGISTRY[command] ?? Object.keys(op?.params ?? {}).map(k => `--${k.replace(/_/g, '-')}`);
    },
    isOperation: name => opSet.has(name),
    operationNames: () => opNames,
  };
}
