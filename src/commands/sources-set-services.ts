/**
 * `gbrain sources set-services <source> --add|--remove <service> [--yes]`
 * (#6855): opt an Apple source in or out of one service (calendar, contacts,
 * mail). The write is updateSourceConfig's single-key merge of `a_services`.
 *
 * Removing a service stops sweeping it; pages already imported stay (a
 * disabled service is never deleted from, see docs/guides/apple-connect.md).
 * On a managed brain the connector cursor is keyed by the source's
 * configuration, so the change starts a fresh cursor for the whole source;
 * that needs `--yes` (confirmation_required, like set-calendar).
 */
import type { BrainEngine } from '../core/engine.ts';
import { exitCliError, usageError } from '../cli/cli-error.ts';
import { opError } from '../core/ops/contract.ts';
import { parseSourceConfig } from '../core/sources-load.ts';
import { parseAppleSourceConfig } from '../core/apple/source-config.ts';
import { mailConfirmationRequired } from './sources-apple-flags.ts';
import { ALL_APPLE_SERVICES, type AppleService } from '../core/apple/types.ts';
import { readManagedMode } from '../core/persistence/managed-mode.ts';
import { connectorIdentity } from '../core/persistence/connector-identity.ts';

const USAGE = `Usage: gbrain sources set-services <source> (--add <service> | --remove <service>) [--yes] [--confirm-mail]. Services: ${ALL_APPLE_SERVICES.join(', ')}`;

function serviceFlag(args: string[], flag: '--add' | '--remove'): AppleService | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const value = (args[index + 1] ?? '').trim().toLowerCase();
  if (!(ALL_APPLE_SERVICES as readonly string[]).includes(value)) {
    exitCliError(usageError(`"${value}" is not an Apple service.`, USAGE, { code: 'invalid_params' }), 'sources');
  }
  return value as AppleService;
}

export async function runSetServices(engine: BrainEngine, args: string[]): Promise<void> {
  const flagValues = new Set<string>();
  args.forEach((a, i) => { if (a === '--add' || a === '--remove') flagValues.add(String(i + 1)); });
  const id = args.find((a, i) => !a.startsWith('--') && !flagValues.has(String(i)));
  const add = serviceFlag(args, '--add');
  const remove = serviceFlag(args, '--remove');
  if (!id || (add === undefined) === (remove === undefined)) {
    exitCliError(usageError('gbrain sources set-services needs a source id and exactly one of --add or --remove.', USAGE), 'sources');
  }
  const [src] = await engine.executeRaw<{ config: unknown; local_path: string | null }>(
    'SELECT config, local_path FROM sources WHERE id=$1 AND archived IS NOT TRUE', [id]);
  if (!src) {
    console.error(`Source "${id}" not found. List sources with: gbrain sources list`);
    process.exit(4);
  }
  const config = parseSourceConfig(src!.config);
  if (config.kind !== 'apple') {
    exitCliError(usageError(`Source "${id}" is not an Apple source; only an Apple source has per-service settings.`, 'List sources and their kind with: gbrain sources list'), 'sources');
  }
  const apple = parseAppleSourceConfig(config, src!.local_path ?? '');
  const next = new Set<AppleService>(apple.services);
  if (add) next.add(add); else next.delete(remove!);
  const services = ALL_APPLE_SERVICES.filter((s) => next.has(s));
  if (services.length === 0) {
    exitCliError(usageError(`Removing ${remove} would leave "${id}" with no service.`,
      `A source with no service syncs nothing. Archive it instead: gbrain sources archive ${id}`), 'sources');
  }
  // Mail is the most sensitive service: turning it on needs the same explicit consent as `apple setup` / `sources add`.
  if (add === 'mail' && !apple.services.includes('mail') && !args.includes('--confirm-mail')) {
    const e = mailConfirmationRequired('set-services');
    console.error(`Error: ${e.message} (${e.code})`);
    console.error(e.suggestion);
    process.exit(2);
  }
  if (services.join(',') === apple.services.join(',')) {
    console.log(`Source "${id}" already ${add ? 'syncs' : 'omits'} ${add ?? remove}. Services: ${apple.services.join(', ')}.`);
    return;
  }
  const before = connectorIdentity('apple', config, src!.local_path).digest;
  const after = connectorIdentity('apple', { ...config, a_services: services.join(',') }, src!.local_path).digest;
  if (before !== after && !args.includes('--yes') && await readManagedMode(engine)) {
    const command = ['gbrain', 'sources', 'set-services', id!, add ? '--add' : '--remove', (add ?? remove)!, ...(add === 'mail' ? ['--confirm-mail'] : []), '--yes'];
    exitCliError(opError('confirmation_required', `Changing the services of "${id}" makes its next sync start a fresh cursor.`,
      `On this managed brain the source's sync cursor is keyed by its configuration, so the change re-reads the remaining services from the start (${services.join(', ')}); pages already imported stay and nothing is deleted. With the user's agreement, run ${command.join(' ')}.`, {
        fix: { argv: command, consent: [], actor: 'agent', why: 'Applies the service change after the user agrees to the re-read.', requires_exclusive: false,
          ask_user: true, user_message: `${add ? 'Add' : 'Remove'} ${add ?? remove} ${add ? 'to' : 'from'} ${id}? Its next sync re-reads ${services.join(', ')} (no cost; already imported pages stay).` },
      }), 'sources');
  }
  await engine.updateSourceConfig(id!, { a_services: services.join(',') });
  console.log(`Source "${id}" now syncs: ${services.join(', ')} (was ${apple.services.join(', ')}).`);
  if (remove) console.log(`  Pages already imported from ${remove} stay; they are no longer updated. Re-enable any time with --add ${remove}.`);
  console.log(`  Run it now: gbrain sync --source ${id}`);
}
