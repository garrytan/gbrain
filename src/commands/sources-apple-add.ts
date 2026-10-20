/**
 * `gbrain sources add <id> --kind apple ...` on the legacy (unmanaged) path
 * (#6855). Delegated to from `runAdd` (sources.ts) so the façade grows by one
 * line; the managed-brain path parses the same flags in
 * sources-lifecycle-args.ts. Both validate through sources-apple-flags.ts.
 *
 * Registering is local and credential-free; a non-macOS host gets a warning,
 * not a refusal, so a source can be registered from a CI or sync-only host.
 */
import type { BrainEngine } from '../core/engine.ts';
import { addSource, defaultCloneDir, type SourceRow } from '../core/sources-ops.ts';
import { AppleAddFlagError, appleAddPlatformWarning, buildAppleAddOptions, type AppleAddRaw } from './sources-apple-flags.ts';

const VALUED: Record<string, keyof AppleAddRaw | 'name'> = {
  '--services': 'services', '--account': 'account', '--history-days': 'historyDays', '--future-days': 'futureDays',
  '--calendar-ids': 'calendarIds', '--contacts-dir': 'contactsDir', '--mail-mailboxes': 'mailMailboxes', '--mail-days': 'mailDays', '--mail-owner-addresses': 'mailOwnerAddresses',
  '--dir': 'dir', '--name': 'name',
};
const BOOLEAN_APPLE: Record<string, 'confirmMail' | 'loopsExtractConsent'> = { '--confirm-mail': 'confirmMail', '--consent-loops-extraction': 'loopsExtractConsent' };

const USAGE = 'Usage: gbrain sources add <id> --kind apple [--services calendar,contacts[,mail --confirm-mail]] [--account <label>] [--history-days <n>] [--future-days <n>]\n'
  + '       [--calendar-ids <a,b>] [--contacts-dir <dir>] [--mail-mailboxes INBOX,Sent] [--mail-days <n>] [--mail-owner-addresses <a@x,b@y> [--consent-loops-extraction]] [--dir <path>] [--name <display>] [--federated|--no-federated]\n'
  + '       (macOS only; permissions: gbrain apple setup)';

function refuse(message: string, suggestion?: string): never {
  console.error(`Error: ${message}`);
  if (suggestion) console.error(suggestion);
  process.exit(2);
}

export async function runAddApple(engine: BrainEngine, args: string[]): Promise<void> {
  const id = args[0]!;
  const raw: Partial<AppleAddRaw> & { name?: string } = {};
  let federated: boolean | null = null;
  for (let i = 1; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--kind') { i++; continue; }
    if (a === '--federated') { federated = true; continue; }
    if (a === '--no-federated') { federated = false; continue; }
    if (BOOLEAN_APPLE[a]) { raw[BOOLEAN_APPLE[a]!] = true; continue; }
    const key = VALUED[a];
    if (key) {
      const value = args[++i];
      if (value === undefined || value.startsWith('--')) refuse(`${a} requires a value.`, USAGE);
      (raw as Record<string, string>)[key] = value;
      continue;
    }
    if (a === '--path' || a === '--url' || a === '--clone-dir') refuse(`${a} cannot be combined with --kind apple.`, USAGE);
    refuse(`Unknown or unsupported flag for --kind apple: ${a}`, USAGE);
  }
  let apple;
  try {
    apple = buildAppleAddOptions({ ...raw, dir: raw.dir ?? defaultCloneDir(`${id}-apple`) });
  } catch (error) {
    if (error instanceof AppleAddFlagError) refuse(`${error.message} (${error.code})`, error.suggestion);
    throw error;
  }
  const warning = appleAddPlatformWarning();
  if (warning) console.error(warning);
  const created: SourceRow = await addSource(engine, { id, name: raw.name, localPath: null, federated, apple });
  console.log(`Created source "${id}"${raw.name && raw.name !== id ? ` (name: ${raw.name})` : ''} → ${created.local_path}`);
  console.log(`  services: ${apple.services.join(', ')}  (change later: gbrain sources set-services ${id} --add|--remove <service>)`);
  console.log(`  sync: grant macOS access with \`gbrain apple setup\`, then run \`gbrain sync --source ${id}\`; autopilot keeps it synced after its first sync.`);
}
