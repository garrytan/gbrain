#!/usr/bin/env bun

import { spawnSync } from 'node:child_process';

import { collectReceipt } from './gbrain-offramp-receipt.ts';

type ReceiptSummary = Awaited<ReturnType<typeof collectReceipt>>;
type MaintenanceCommand = string[];
type MaintenanceDeps = {
  collectReceipt: () => Promise<ReceiptSummary>;
  runCommand: (command: MaintenanceCommand) => void | Promise<void>;
  writeStdout: (text: string) => void;
  writeStderr: (text: string) => void;
};

export type MaintenancePlan = {
  blocked: boolean;
  reason: string | null;
  commands: MaintenanceCommand[];
};

const MAINTENANCE_COMMANDS: MaintenanceCommand[] = [
  ['gbrain', 'sync', '--all', '--parallel', '4', '--workers', '4', '--skip-failed'],
  ['gbrain', 'embed', '--stale'],
  ['gbrain', 'extract', 'all'],
];

export function buildMaintenancePlan(
  before: ReceiptSummary,
  options: { allowDefaultBacklog?: boolean } = {},
): MaintenancePlan {
  const defaultBacklog = before.defaultSource?.chunksUnembedded ?? 0;

  if (defaultBacklog > 0 && !options.allowDefaultBacklog) {
    return {
      blocked: true,
      reason: `Default source still has ${defaultBacklog} unembedded chunks. Run \`gbrain embed --stale\` before maintenance or pass --allow-default-backlog.`,
      commands: [],
    };
  }

  return {
    blocked: false,
    reason: null,
    commands: MAINTENANCE_COMMANDS.map((command) => [...command]),
  };
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

export function runCommand(command: MaintenanceCommand): void {
  const result = spawnSync(command[0], command.slice(1), {
    cwd: process.cwd(),
    stdio: 'inherit',
    env: process.env,
  });

  if (result.error) {
    throw new Error(`Command failed to start: ${command.join(' ')} (${result.error.message})`);
  }

  if (result.status !== 0) {
    throw new Error(`Command failed (${result.status ?? 'unknown'}): ${command.join(' ')}`);
  }
}

function defaultDeps(): MaintenanceDeps {
  return {
    collectReceipt,
    runCommand,
    writeStdout: (text) => {
      process.stdout.write(text);
    },
    writeStderr: (text) => {
      process.stderr.write(text);
    },
  };
}

export async function main(
  args: string[],
  deps: Partial<MaintenanceDeps> = {},
): Promise<number> {
  const resolvedDeps: MaintenanceDeps = {
    ...defaultDeps(),
    ...deps,
  };
  const allowDefaultBacklog = hasFlag(args, '--allow-default-backlog');
  const dryRun = hasFlag(args, '--dry-run');
  const before = await resolvedDeps.collectReceipt();
  const plan = buildMaintenancePlan(before, { allowDefaultBacklog });

  if (dryRun) {
    if (plan.blocked && plan.reason) {
      resolvedDeps.writeStderr(`${plan.reason}\n`);
    }
    resolvedDeps.writeStdout(`${JSON.stringify({ before, plan }, null, 2)}\n`);
    return plan.blocked ? 1 : 0;
  }

  if (plan.blocked) {
    resolvedDeps.writeStderr(`${plan.reason}\n`);
    return 1;
  }

  for (const command of plan.commands) {
    await resolvedDeps.runCommand(command);
  }

  const after = await resolvedDeps.collectReceipt();
  resolvedDeps.writeStdout(`${JSON.stringify({ before, after }, null, 2)}\n`);
  return 0;
}

if (import.meta.main) {
  const code = await main(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[offramp:maintain] ${message}\n`);
    return 1;
  });
  process.exit(code);
}
