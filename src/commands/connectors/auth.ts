/**
 * commands/connectors/auth.ts — store + verify a provider session credential.
 *
 * Cookie paste-in is the primary lane. `--cookie -` reads the raw Cookie header
 * from stdin so the secret never lands in argv/`ps`. `--try-oauth` (chatgpt)
 * attempts the best-effort OAuth PKCE loopback first, then probes and falls back
 * to cookie guidance. Every path ends with a probe + a one-line verdict; nothing
 * is saved on a failed probe unless `--force`.
 */

import type { BrainEngine } from '../../core/engine.ts';
import { setCliExitVerdict } from '../../core/cli-force-exit.ts';
import { ConnectorClient } from '../../core/connectors/client.ts';
import type { ConnectorFetch } from '../../core/connectors/client.ts';
import { deleteCredential, saveCredential } from '../../core/connectors/credentials.ts';
import { getConnectorProvider, isConnectorProviderName } from '../../core/connectors/registry.ts';
import type { ChatHistoryProvider, ConnectorCredential } from '../../core/connectors/types.ts';

interface AuthFlags {
  cookie?: string;
  token?: string;
  tryOauth: boolean;
  noBrowser: boolean;
  force: boolean;
}

function parseFlags(args: string[]): { provider: string; flags: AuthFlags } {
  const flags: AuthFlags = { tryOauth: false, noBrowser: false, force: false };
  let provider = '';
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--cookie') flags.cookie = args[++i];
    else if (a === '--token') flags.token = args[++i];
    else if (a === '--try-oauth') flags.tryOauth = true;
    else if (a === '--no-browser') flags.noBrowser = true;
    else if (a === '--force') flags.force = true;
    else if (!a.startsWith('-')) provider = a;
  }
  return { provider, flags };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').trim();
}

function makeProbeClient(provider: ChatHistoryProvider, cred: ConnectorCredential): ConnectorClient {
  return new ConnectorClient({
    baseUrl: provider.baseUrl,
    headers: () => provider.authHeaders(cred),
    refresh: provider.refreshAccessToken
      ? () => provider.refreshAccessToken!(cred, fetch as unknown as ConnectorFetch)
      : undefined,
  });
}

async function probeAndReport(provider: ChatHistoryProvider, cred: ConnectorCredential): Promise<boolean> {
  const client = makeProbeClient(provider, cred);
  const r = await provider.probe(client);
  if (r.ok) {
    console.log(`✓ ${provider.name}: credential verified — conversation history is reachable.`);
    return true;
  }
  if (r.kind === 'forbidden_fingerprint') {
    console.error(
      `✗ ${provider.name}: blocked by a bot/Cloudflare challenge (${r.detail}).\n` +
        '  Server-side fetch may be blocked from this machine. Use the official export instead:\n' +
        '  ' + provider.sessionInstructions().split('\n').slice(-2).join(' '),
    );
  } else if (r.kind === 'unauthorized') {
    console.error(`✗ ${provider.name}: credential rejected (${r.detail}). Re-copy a fresh cookie.`);
  } else {
    console.error(`✗ ${provider.name}: probe failed (${r.kind}: ${r.detail}).`);
  }
  return false;
}

function printFirstRun(provider: string): void {
  console.log(
    [
      '',
      'Next steps:',
      `  gbrain connectors sync ${provider} --dry-run     # preview how many conversations`,
      `  gbrain connectors sync ${provider} --limit 5      # import a small sample first`,
      `  gbrain conversation-parser scan conversations/${provider === 'chatgpt' ? 'chatgpt' : 'claude'}/<slug>  # validate one page`,
      `  gbrain connectors sync ${provider} --full         # import everything`,
      '',
      `To keep it synced automatically (opt-in; polls your account on a schedule):`,
      `  gbrain config set connectors.${provider}.auto_sync true`,
      `  gbrain autopilot --install`,
    ].join('\n'),
  );
}

export async function runConnectorAuth(_engine: BrainEngine, args: string[]): Promise<void> {
  const { provider, flags } = parseFlags(args);
  if (!isConnectorProviderName(provider)) {
    console.error(`Usage: gbrain connectors auth <chatgpt|claude> [--cookie -|--token V] [--try-oauth] [--force]`);
    setCliExitVerdict(1);
    return;
  }
  const prov = getConnectorProvider(provider)!;

  // --try-oauth (chatgpt only, best-effort/forward-compat).
  if (flags.tryOauth && prov.oauth) {
    const ok = await tryOauth(prov, flags);
    if (ok) {
      printFirstRun(provider);
      return;
    }
    console.error('OAuth did not yield conversation-history access — falling back to the cookie lane.');
  } else if (flags.tryOauth && !prov.oauth) {
    console.error(`${provider} has no OAuth lane; use the cookie lane.`);
  }

  // Cookie / token lane (primary).
  let cookie = flags.cookie;
  let token = flags.token;
  if (cookie === '-') cookie = await readStdin();
  if (!cookie && !token) {
    console.error(prov.sessionInstructions());
    console.error('\nPaste the credential now (Cookie header, or `token:<accessToken>`), then Ctrl-D:');
    const pasted = await readStdin();
    if (pasted.startsWith('token:')) token = pasted.slice('token:'.length).trim();
    else cookie = pasted;
  }
  if (!cookie && !token) {
    console.error('No credential provided.');
    setCliExitVerdict(1);
    return;
  }

  const cred: ConnectorCredential = {
    provider,
    strategy: 'browser-session',
    cookie: cookie || undefined,
    accessToken: token || undefined,
    savedAt: new Date().toISOString(),
  };
  // chatgpt: mint an accessToken from the cookie up front so the first sync
  // doesn't start with a guaranteed 401→refresh round-trip.
  if (cred.cookie && prov.refreshAccessToken) {
    await prov.refreshAccessToken(cred, fetch as unknown as ConnectorFetch);
  }

  const ok = await probeAndReport(prov, cred);
  if (!ok && !flags.force) {
    console.error('Credential NOT saved (probe failed). Re-run with --force to save anyway.');
    setCliExitVerdict(1);
    return;
  }
  saveCredential(cred);
  console.log(`Saved ${provider} credential to ~/.gbrain/connectors/${provider}.json (0600).`);
  printFirstRun(provider);
}

async function tryOauth(prov: ChatHistoryProvider, flags: AuthFlags): Promise<boolean> {
  const { buildAuthorizeUrl, exchangeCode, generatePkcePair, generateState, runLoopbackFlow } = await import(
    '../../core/connectors/oauth-pkce.ts'
  );
  const cfg = prov.oauth!;
  const { verifier, challenge } = generatePkcePair();
  const state = generateState();
  const authorizeUrl = buildAuthorizeUrl(cfg, challenge, state);
  try {
    const { code } = await runLoopbackFlow(cfg, authorizeUrl, state, {
      openBrowser: !flags.noBrowser,
      log: (m) => console.error(m),
    });
    const tokens = await exchangeCode(cfg, code, verifier);
    const cred: ConnectorCredential = {
      provider: prov.name,
      strategy: 'oauth-pkce',
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      savedAt: new Date().toISOString(),
    };
    const ok = await probeAndReport(prov, cred);
    if (ok) {
      saveCredential(cred);
      console.log(`Saved ${prov.name} OAuth credential (0600).`);
      return true;
    }
    return false;
  } catch (e) {
    console.error(`OAuth flow failed: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

export async function runConnectorLogout(args: string[]): Promise<void> {
  const provider = args.find((a) => !a.startsWith('-')) ?? '';
  if (!isConnectorProviderName(provider)) {
    console.error('Usage: gbrain connectors logout <chatgpt|claude>');
    setCliExitVerdict(1);
    return;
  }
  const removed = deleteCredential(provider);
  console.log(removed ? `Removed ${provider} credential.` : `No ${provider} credential to remove.`);
}
