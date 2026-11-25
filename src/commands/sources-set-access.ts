/**
 * `gbrain sources set-access <source> vault [--yes] [--json]`: moves a Google
 * source off the shared gbrain.io relay (`g_access: gbrainio`) onto the
 * account's own OAuth client in the credential vault, read by the Gmail REST
 * reader. The source keeps its id, its private-senders list and its calendar
 * and contacts settings; ingest tiers that were on (the gbrain.io default, or
 * an explicit `g_ingest_tiers`) are written explicitly so the move never drops
 * tiering or private classification, and a source with no stored
 * `g_services` keeps syncing Gmail only.
 *
 * Refuses before any write unless the vault holds a byo entry with a refresh
 * token for the source's account (a `hosted-relay` entry is still the shared
 * relay). updateSourceConfig merges keys and cannot delete one, so
 * `g_access` and `g_gbrainio_command` are written null, which
 * parseGoogleSourceConfig reads as the vault default. The Gmail cursor carries
 * over; the REST sweep anchors Gmail's change feed and fetches again from
 * about a day below the newest imported message, onto the same slugs. On a
 * managed brain the move needs `--yes` (exit 3 without it).
 */
import type { BrainEngine } from '../core/engine.ts';
import { exitCliError, usageError } from '../cli/cli-error.ts';
import { opError } from '../core/ops/contract.ts';
import { parseSourceConfig } from '../core/sources-load.ts';
import { parseGoogleSourceConfig } from '../core/google/source-config.ts';
import { readManagedMode } from '../core/persistence/managed-mode.ts';
import { credentialId, openVault, type CredentialVault } from '../core/creds/vault.ts';
import { GOOGLE_SERVICE_SCOPES } from '../core/creds/providers/google.ts';
import type { GoogleSourceConfig } from '../core/google/types.ts';

export interface SetAccessResult {
  source_id: string;
  requested_access: 'vault';
  previous_access: GoogleSourceConfig['access'];
  effective_access: GoogleSourceConfig['access'];
  changed: boolean;
  ingest_tiers: boolean;
  private_senders_file: string | null;
  services: string[];
}

const USAGE = 'Usage: gbrain sources set-access <source> vault [--yes] [--json]';

async function readGoogleSource(engine: BrainEngine, id: string): Promise<{ config: Record<string, unknown>; google: GoogleSourceConfig }> {
  const src = (await engine.listAllSources()).find((s) => s.id === id);
  if (!src) throw opError('not_found', `Source "${id}" not found.`, 'List sources with: gbrain sources list');
  const config = parseSourceConfig(src.config);
  if (config.kind !== 'google') {
    throw usageError(`Source "${id}" is not a Google source; only a Google source has an access mode.`, 'List sources and their kind with: gbrain sources list');
  }
  return { config, google: parseGoogleSourceConfig(config, '') };
}

export async function setSourceAccess(engine: BrainEngine, opts: { id: string; target: string; yes?: boolean; vault?: CredentialVault }): Promise<SetAccessResult> {
  const { id, target } = opts;
  if (target !== 'vault') {
    throw usageError(`"${target}" is not a supported access target; only vault is supported.`, `${USAGE}. vault reads the account through its own OAuth client in the credential vault.`);
  }
  const { config, google: before } = await readGoogleSource(engine, id);
  const report = (google: GoogleSourceConfig, changed: boolean): SetAccessResult => ({
    source_id: id, requested_access: 'vault', previous_access: before.access, effective_access: google.access, changed,
    ingest_tiers: google.ingestTiers === true, private_senders_file: google.privateSendersFile ?? null, services: google.services,
  });
  if (before.access === 'vault') return report(before, false);

  const setup = ['gbrain', 'google', 'setup', '--personal', '--account', before.account || '<email>'];
  const connectFix = { argv: setup, consent: [], actor: 'user' as const, requires_exclusive: false,
    why: 'Connects the account through its own OAuth client, so the vault holds a refresh token the REST reader can use.' };
  const entry = before.account ? await (opts.vault ?? openVault()).get(credentialId('google', before.account)) : null;
  if (!entry || entry.client_ref !== 'byo') {
    throw opError('not_connected', `The credential vault holds no personal Google connection for ${before.account || `source "${id}"`}${entry ? ' (its entry is the shared hosted relay)' : ''}.`,
      `Moving "${id}" to vault needs the account's own OAuth client. Run: ${setup.join(' ')}, then run gbrain sources set-access ${id} vault again.`, { fix: connectFix });
  }
  const granted = new Set(entry.meta.scopes ?? []);
  const missing = before.services.filter((s) => s in GOOGLE_SERVICE_SCOPES && !granted.has(GOOGLE_SERVICE_SCOPES[s as keyof typeof GOOGLE_SERVICE_SCOPES]));
  if (missing.length > 0) {
    throw opError('scope_missing', `The vault connection for ${before.account} does not grant read access to ${missing.join(', ')}, which source "${id}" syncs.`,
      `Reconnect the account with those services so the move keeps them working: ${setup.join(' ')}, then run gbrain sources set-access ${id} vault again.`, { fix: connectFix });
  }
  if (!entry.secret.refresh_token) {
    throw opError('no_refresh_token', `The vault entry for ${before.account} has no refresh token.`,
      `Reconnect the account so Google issues a refresh token: ${setup.join(' ')}, then run gbrain sources set-access ${id} vault again.`, { fix: connectFix });
  }

  if (!opts.yes && await readManagedMode(engine)) {
    const argv = ['gbrain', 'sources', 'set-access', id, 'vault', '--yes'];
    throw opError('confirmation_required', `Moving "${id}" off the shared gbrain.io relay changes who reads its mail.`,
      `From the next sync gbrain reads this mailbox with the account's own Google connection instead of gbrain.io. Pages already imported stay; mail from about a day before the newest imported message is fetched again onto the same pages, then Gmail's change feed takes over. With the user's agreement, run ${argv.join(' ')}.`, {
        fix: { argv, consent: [], actor: 'agent', why: 'Moves the source to its own OAuth client after the user agrees.', requires_exclusive: false,
          ask_user: true, user_message: `Move ${id} off the shared gbrain.io relay onto your own Google connection? Already imported pages stay; the next sync fetches the last day of mail again.` },
      });
  }

  await engine.updateSourceConfig(id, {
    g_access: null,
    g_gbrainio_command: null,
    ...(before.ingestTiers ? { g_ingest_tiers: true } : {}),
    ...(typeof config.g_services === 'string' ? {} : { g_services: before.services.join(',') }),
  });

  const { google: after } = await readGoogleSource(engine, id);
  if (after.access !== 'vault' || after.ingestTiers !== before.ingestTiers || after.privateSendersFile !== before.privateSendersFile
    || after.calendarId !== before.calendarId || after.contactsDir !== before.contactsDir) {
    throw opError('source_changed', `Source "${id}" did not read back as vault with its settings unchanged.`,
      `Read the source's configuration with gbrain sources list --json, then run gbrain sources set-access ${id} vault again.`);
  }
  return report(after, true);
}

export async function runSetAccess(engine: BrainEngine, args: string[]): Promise<void> {
  const [id, target] = args.filter((a) => !a.startsWith('--'));
  if (!id || !target) exitCliError(usageError('gbrain sources set-access needs a source id and an access target.', USAGE), 'sources');
  const json = args.includes('--json');
  let result: SetAccessResult;
  try {
    result = await setSourceAccess(engine, { id: id!, target: target!, yes: args.includes('--yes') });
  } catch (e) {
    exitCliError(e, 'sources', { json });
  }
  if (json) {
    console.log(JSON.stringify(result));
    return;
  }
  if (!result.changed) {
    console.log(`Source "${id}" already reads through the credential vault.`);
    return;
  }
  console.log(`Source "${id}" now reads through the credential vault (was ${result.previous_access}).`);
  console.log(`  Ingest tiers: ${result.ingest_tiers ? 'on' : 'off'}; private senders: ${result.private_senders_file ?? 'none'}; services: ${result.services.join(', ')}.`);
  console.log(`  The next sync fetches mail from about a day before the newest imported message onto the same pages, then follows Gmail's change feed. Run it now: gbrain sync --source ${id}`);
}
