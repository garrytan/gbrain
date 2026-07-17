import { BrainRegistry, loadMounts, validateMountId } from '../core/brain-registry.ts';
import {
  buildRecoverySnapshot,
  RecoverySnapshotError,
} from '../core/recovery-snapshot.ts';
import { assertValidSourceId } from '../core/source-id.ts';

export const RECOVERY_HELP = `gbrain recovery snapshot --brain <id> --source <id> --json

Emit one strict, deterministic, read-only recovery snapshot for an explicitly
selected brain and source. The command never migrates, repairs, restores, or
writes database state. A snapshot is emitted only when every required section
can be read and validated.
`;

export class RecoveryUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecoveryUsageError';
  }
}

export interface RecoveryCommandOptions {
  brainId: string;
  sourceId: string;
}

function readFlagValue(args: string[], index: number, name: string): { value: string; next: number } {
  const value = args[index + 1];
  if (!value || value.startsWith('-')) throw new RecoveryUsageError(`${name} requires a value`);
  return { value, next: index + 1 };
}

export function parseRecoveryArgs(args: string[]): RecoveryCommandOptions | 'help' {
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) return 'help';
  if (args[0] !== 'snapshot') throw new RecoveryUsageError('Expected the snapshot subcommand');

  let brainId: string | null = null;
  let sourceId: string | null = null;
  let json = false;
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--json') {
      if (json) throw new RecoveryUsageError('--json may be specified only once');
      json = true;
      continue;
    }
    if (arg === '--brain') {
      if (brainId !== null) throw new RecoveryUsageError('--brain may be specified only once');
      const parsed = readFlagValue(args, index, '--brain');
      brainId = parsed.value;
      index = parsed.next;
      continue;
    }
    if (arg === '--source') {
      if (sourceId !== null) throw new RecoveryUsageError('--source may be specified only once');
      const parsed = readFlagValue(args, index, '--source');
      sourceId = parsed.value;
      index = parsed.next;
      continue;
    }
    if (arg === '--help' || arg === '-h') return 'help';
    throw new RecoveryUsageError(`Unknown recovery argument: ${arg}`);
  }

  if (!json) throw new RecoveryUsageError('--json is required');
  if (brainId === null) throw new RecoveryUsageError('--brain is required');
  if (sourceId === null) throw new RecoveryUsageError('--source is required');
  if (brainId !== 'host') validateMountId(brainId, 'brain id');
  assertValidSourceId(sourceId);
  return { brainId, sourceId };
}

export interface RecoveryCommandDependencies {
  registry?: BrainRegistry;
  writeStdout?: (value: string) => void;
  writeStderr?: (value: string) => void;
  now?: () => Date;
}

export async function runRecovery(
  args: string[],
  dependencies: RecoveryCommandDependencies = {},
): Promise<number> {
  const writeStdout = dependencies.writeStdout ?? ((value: string) => process.stdout.write(value));
  const writeStderr = dependencies.writeStderr ?? ((value: string) => process.stderr.write(value));

  let parsed: RecoveryCommandOptions | 'help';
  try {
    parsed = parseRecoveryArgs(args);
  } catch {
    writeStderr('Recovery snapshot refused: invalid arguments. Run `gbrain recovery --help`.\n');
    return 2;
  }
  if (parsed === 'help') {
    writeStdout(RECOVERY_HELP);
    return 0;
  }

  let registry = dependencies.registry;
  try {
    registry ??= new BrainRegistry(loadMounts());
    const handle = await registry.getBrain(parsed.brainId);
    const snapshot = await buildRecoverySnapshot(handle.engine, {
      brainId: parsed.brainId,
      sourceId: parsed.sourceId,
      config: handle.config,
      now: dependencies.now,
    });
    writeStdout(`${JSON.stringify(snapshot)}\n`);
    return 0;
  } catch (error) {
    if (error instanceof RecoverySnapshotError) {
      writeStderr(`Recovery snapshot refused: ${error.message}\n`);
    } else {
      writeStderr('Recovery snapshot failed closed.\n');
    }
    return 1;
  } finally {
    if (registry) await registry.disconnectAll();
  }
}
