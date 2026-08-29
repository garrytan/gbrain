/**
 * gbrain creds — the generic credential-vault surface.
 *
 * Provider-agnostic: lists/inspects/removes vault entries and produces the
 * encrypted transfer bundle for hosted-upgrade moves. Provider-SPECIFIC
 * connect flows live in their own commands (gbrain google connect); this
 * command never prints a secret.
 *
 *   gbrain creds list [--provider p] [--json]
 *   gbrain creds remove <id> [--json]
 *   gbrain creds export --out <file> [--ids a,b] [--passphrase-env VAR]
 *   gbrain creds import <file> [--passphrase-env VAR] [--json]
 *
 * Export custody rules (approved D3-A): per-credential confirmation lives in
 * the calling flow; a byo Google entry whose consent screen is not known to
 * be published-to-Production gets a loud warning (its 7-day Testing expiry
 * travels with the tokens).
 */

import { readFileSync, writeFileSync } from 'node:fs';

import { exportBundle, importBundle, type EncryptedBundle } from '../core/creds/export.ts';
import {
  openVault,
  type CredentialEntry,
  type ProviderClientRecord,
} from '../core/creds/vault.ts';
import { readLineSafe } from './init.ts';
import { setCliExitVerdict } from '../core/cli-force-exit.ts';

async function passphraseFrom(args: string[]): Promise<string> {
  const envIdx = args.indexOf('--passphrase-env');
  if (envIdx !== -1) {
    const name = args[envIdx + 1];
    const v = name ? process.env[name] : undefined;
    if (!v) {
      console.error(`--passphrase-env ${name ?? ''}: env var is unset.`);
      process.exit(2);
    }
    return v;
  }
  const typed = await readLineSafe('Bundle passphrase (min 8 chars): ', '', 120_000);
  if (typed.length < 8) {
    console.error('Passphrase required (>= 8 chars). Non-TTY: pass --passphrase-env <VAR>.');
    process.exit(2);
  }
  return typed;
}

async function runList(args: string[]): Promise<void> {
  const json = args.includes('--json');
  const pIdx = args.indexOf('--provider');
  const provider = pIdx !== -1 ? args[pIdx + 1] : undefined;
  const vault = openVault();
  const metas = await vault.list(provider ? { provider } : undefined);
  if (json) {
    process.stdout.write(JSON.stringify({ ok: true, status: 'ok', credentials: metas }, null, 2) + '\n');
    return;
  }
  if (metas.length === 0) {
    process.stdout.write('Credential vault is empty. Connect a provider first (e.g. `gbrain google connect`).\n');
    return;
  }
  for (const m of metas) {
    process.stdout.write(
      `${m.id}  kind=${m.kind}  client_ref=${m.client_ref}  connected=${m.connected_at.slice(0, 10)}${
        m.last_refresh_ok_at ? `  last_refresh=${m.last_refresh_ok_at.slice(0, 10)}` : ''
      }\n`,
    );
  }
}

async function runRemove(args: string[]): Promise<void> {
  const json = args.includes('--json');
  const id = args.find((a) => !a.startsWith('--'));
  if (!id) {
    console.error('Usage: gbrain creds remove <id>   (ids from `gbrain creds list`)');
    process.exit(2);
  }
  const vault = openVault();
  const deleted = await vault.delete(id);
  if (json) {
    process.stdout.write(JSON.stringify({ ok: deleted, status: deleted ? 'removed' : 'not_found' }, null, 2) + '\n');
  } else {
    process.stdout.write(deleted ? `Removed ${id}.\n` : `No credential ${id}.\n`);
  }
  if (!deleted) setCliExitVerdict(1);
}

async function runExport(args: string[]): Promise<void> {
  const json = args.includes('--json');
  const outIdx = args.indexOf('--out');
  const out = outIdx !== -1 ? args[outIdx + 1] : undefined;
  if (!out) {
    console.error('Usage: gbrain creds export --out <file> [--ids a,b] [--passphrase-env VAR]');
    process.exit(2);
  }
  const idsIdx = args.indexOf('--ids');
  const onlyIds = idsIdx !== -1 ? (args[idsIdx + 1] ?? '').split(',').map((s) => s.trim()).filter(Boolean) : null;

  const vault = openVault();
  const metas = await vault.list();
  const chosen = metas.filter((m) => !onlyIds || onlyIds.includes(m.id));
  if (chosen.length === 0) {
    console.error(onlyIds ? `No matching credentials for --ids ${onlyIds.join(',')}.` : 'Vault is empty; nothing to export.');
    process.exit(1);
  }

  const entries: CredentialEntry[] = [];
  const providers = new Set<string>();
  for (const m of chosen) {
    // Testing-mode custody warning (D3-A): the 7-day expiry travels with the tokens.
    if (m.provider === 'google' && m.client_ref === 'byo' && m.consent_publish_state !== 'production') {
      process.stderr.write(
        `warning: ${m.id} — consent screen not known to be published to Production; ` +
          `if it's still in Testing, the transferred refresh token dies within 7 days. ` +
          `Publish first (https://console.cloud.google.com/auth/audience) or expect weekly re-auth on the target.\n`,
      );
    }
    const full = await vault.get(m.id);
    if (full) {
      entries.push(full);
      providers.add(full.provider);
    }
  }
  // Refresh tokens are bound to the client that minted them: byo clients
  // MUST travel with their tokens or the bundle imports dead credentials.
  const clients: ProviderClientRecord[] = [];
  for (const p of providers) {
    const c = await vault.getClient(p);
    if (c) clients.push(c);
  }

  const passphrase = await passphraseFrom(args);
  const bundle = exportBundle({ credentials: entries, clients }, passphrase);
  writeFileSync(out, JSON.stringify(bundle, null, 2) + '\n', { mode: 0o600 });
  if (json) {
    process.stdout.write(
      JSON.stringify({
        ok: true,
        status: 'exported',
        out,
        credentials: entries.map((e) => e.id),
        clients: clients.map((c) => c.provider),
        next_action: { command: `gbrain creds import ${out}` },
      }, null, 2) + '\n',
    );
    return;
  }
  process.stdout.write(
    `Exported ${entries.length} credential(s) + ${clients.length} client record(s) to ${out} (encrypted).\n` +
      `Import on the target with: gbrain creds import ${out}\n`,
  );
}

async function runImport(args: string[]): Promise<void> {
  const json = args.includes('--json');
  // Positional = first non-flag token that is NOT a valued flag's value
  // (`--passphrase-env VAR bundle.json` must not pick up `VAR` as the file).
  const VALUED_FLAGS = new Set(['--passphrase-env']);
  let file: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (VALUED_FLAGS.has(a)) {
      i++;
      continue;
    }
    if (a.startsWith('--')) continue;
    file = a;
    break;
  }
  if (!file) {
    console.error('Usage: gbrain creds import <bundle-file> [--passphrase-env VAR] [--json]');
    process.exit(2);
  }
  const fail = (message: string): never => {
    if (json) {
      process.stdout.write(JSON.stringify({ ok: false, status: 'error', error: { message } }, null, 2) + '\n');
    } else {
      console.error(message);
    }
    process.exit(1);
  };
  let bundle: EncryptedBundle;
  try {
    bundle = JSON.parse(readFileSync(file, 'utf-8')) as EncryptedBundle;
  } catch (e) {
    return fail(`Could not read bundle: ${e instanceof Error ? e.message : String(e)}`);
  }
  const passphrase = await passphraseFrom(args);
  let payload;
  try {
    payload = importBundle(bundle, passphrase);
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  }
  const vault = openVault();
  for (const c of payload.clients) await vault.putClient(c);
  for (const e of payload.credentials) await vault.put(e);
  if (json) {
    process.stdout.write(
      JSON.stringify({
        ok: true,
        status: 'imported',
        imported: payload.credentials.map((c) => c.id),
        clients: payload.clients.map((c) => c.provider),
      }, null, 2) + '\n',
    );
  } else {
    process.stdout.write(
      `Imported ${payload.credentials.length} credential(s): ${payload.credentials.map((c) => c.id).join(', ')}\n`,
    );
  }
}

const HELP = `gbrain creds — the credential vault (provider-agnostic)

  list     [--provider p] [--json]        redacted inventory
  remove   <id> [--json]                  delete one credential
  export   --out <file> [--ids a,b] [--passphrase-env VAR] [--json]
                                          encrypted transfer bundle (hosted upgrade)
  import   <file> [--passphrase-env VAR]  inverse of export

Secrets live in ~/.gbrain/credentials.json (0600). Provider connect flows:
  gbrain google connect`;

export async function runCreds(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  if (!sub || sub === '--help' || sub === '-h' || sub === 'help') {
    process.stdout.write(HELP + '\n');
    return;
  }
  if (sub === 'list') return runList(rest);
  if (sub === 'remove') return runRemove(rest);
  if (sub === 'export') return runExport(rest);
  if (sub === 'import') return runImport(rest);
  console.error(`Unknown subcommand: ${sub}\n`);
  process.stdout.write(HELP + '\n');
  process.exit(2);
}
