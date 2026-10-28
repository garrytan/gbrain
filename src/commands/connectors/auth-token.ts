/**
 * commands/connectors/auth-token.ts — the API-token lane for providers that back
 * a source kind (`gbrain connectors auth fireflies --token -`).
 *
 * The key arrives on stdin only: a key in argv lands in shell history and the
 * process list, so `--token <value>` is refused before anything is read. The
 * key is probed against the provider before it is saved (0600, never in
 * `sources.config`, the database or a log); a failed probe saves nothing
 * unless `--force`.
 */

import { setCliExitVerdict } from '../../core/cli-force-exit.ts';
import { shellQuote } from '../../core/agent-output.ts';
import { agentBlock } from '../../core/agent-markers.ts';
import { isInteractive } from '../../core/interaction.ts';
import { readStdinPayload } from '../../core/stdin-read.ts';
import { ConnectorAccessDeniedError, ConnectorAuthError, ConnectorRateLimitedError, type ConnectorFetch } from '../../core/connectors/client.ts';
import { credentialPath, saveCredential } from '../../core/connectors/credentials.ts';
import type { ConnectorCredential, TokenProviderName } from '../../core/connectors/types.ts';
import { meetingProvider } from '../../core/meetings/providers/index.ts';
import type { MeetingAccount } from '../../core/meetings/types.ts';
import { VERSION } from '../../version.ts';
import { CREDENTIAL_INACTIVITY_MS, CREDENTIAL_MAX_BYTES } from './auth.ts';

export interface ApiTokenAuthFlags { token?: string; cookie?: string; tryOauth: boolean; force: boolean }
export interface ApiTokenAuthDeps { fetchImpl?: ConnectorFetch; interactive?: boolean }

const PASTE_WAIT_MS = 300_000;

function stdinArgv(provider: TokenProviderName): string[] {
  return ['gbrain', 'connectors', 'auth', provider, '--token', '-'];
}

async function probe(provider: TokenProviderName, token: string, deps: ApiTokenAuthDeps): Promise<{ ok: true; account: MeetingAccount } | { ok: false; detail: string }> {
  const client = meetingProvider(provider, { token, userAgent: `gbrain/${VERSION} (+https://github.com/garrytan/gbrain)`, maxRequests: 3,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) });
  try {
    return { ok: true, account: await client.probe() };
  } catch (error) {
    if (error instanceof ConnectorAuthError) return { ok: false, detail: 'the key was rejected; copy a fresh API key' };
    if (error instanceof ConnectorAccessDeniedError) return { ok: false, detail: 'the key may not read this account' };
    if (error instanceof ConnectorRateLimitedError) return { ok: false, detail: 'the provider rate-limited the check; try again later' };
    return { ok: false, detail: error instanceof Error ? error.message.slice(0, 200) : 'the check failed' };
  }
}

export async function runApiTokenAuth(provider: TokenProviderName, flags: ApiTokenAuthFlags, deps: ApiTokenAuthDeps = {}): Promise<void> {
  const example = `printf '%s' "$KEY" | ${shellQuote(stdinArgv(provider))}`;
  if (flags.cookie !== undefined || flags.tryOauth) {
    console.error(`${provider} uses an API key, not a cookie or OAuth. Pipe the key on stdin: ${example}`);
    setCliExitVerdict(1);
    return;
  }
  if (flags.token !== undefined && flags.token !== '-') {
    console.error(`A ${provider} API key on the command line lands in shell history and the process list, so it was not used or saved. Pipe it on stdin instead: ${example}`);
    setCliExitVerdict(1);
    return;
  }
  const interactive = deps.interactive ?? isInteractive();
  if (flags.token !== '-' && !interactive) {
    process.stdout.write(agentBlock({
      ask: `Ask the user for their ${provider} API key (in ${provider}'s settings, under Developer settings or API), then pass it on stdin.`,
      why: `Syncing ${provider} meetings needs the user's own API key, and only the user can copy it.`,
      risk: `The key reads the user's ${provider} meetings; gbrain stores it only on this machine (0600) and sends it only to ${provider}.`,
      consent: 'credentials',
      actor: 'user',
      next: 'tell_user_to_run',
      if_yes: example,
      if_no: 'Nothing was saved.',
      verify: `gbrain connectors status ${provider}`,
    }));
    setCliExitVerdict(1);
    return;
  }
  if (flags.token !== '-') console.error(`Paste your ${provider} API key, then Ctrl-D:`);
  const read = await readStdinPayload(example, { credential: true, maxBytes: CREDENTIAL_MAX_BYTES, inactivityMs: CREDENTIAL_INACTIVITY_MS,
    ...(flags.token !== '-' ? { firstByteMs: PASTE_WAIT_MS } : {}) });
  if (!read.ok) { console.error(read.message); setCliExitVerdict(1); return; }
  const token = read.text.trim();
  if (!token) { console.error(`No API key arrived on stdin. ${example}`); setCliExitVerdict(1); return; }
  if (!await verifyAndSaveApiToken(provider, token, { force: flags.force, ...deps })) setCliExitVerdict(1);
}

/** Probes the key, then saves it 0600; a failed probe saves nothing unless `force`. Returns whether it was saved. */
export async function verifyAndSaveApiToken(provider: TokenProviderName, token: string, opts: ApiTokenAuthDeps & { force: boolean }): Promise<boolean> {
  const verdict = await probe(provider, token, opts);
  if (verdict.ok) console.log(`✓ ${provider}: API key verified for ${verdict.account.email ?? verdict.account.name ?? 'the account'}.`);
  else console.error(`✗ ${provider}: ${verdict.detail}.`);
  if (!verdict.ok && !opts.force) {
    console.error('API key NOT saved (the check failed). Re-run with --force to save it anyway.');
    return false;
  }
  const cred: ConnectorCredential = {
    provider, strategy: 'api-token', accessToken: token, savedAt: new Date().toISOString(),
    ...(verdict.ok ? { accountId: verdict.account.userId, ...(verdict.account.email ?? verdict.account.name ? { accountLabel: (verdict.account.email ?? verdict.account.name)! } : {}) } : {}),
  };
  saveCredential(cred);
  console.log(`Saved the ${provider} API key to ${credentialPath(provider)} (0600).`);
  console.log(['', 'Next steps:',
    `  gbrain sources add meetings --kind meetings --provider ${provider}   # add the source (nothing syncs yet)`,
    '  gbrain sync --source meetings                                      # the first sync; autopilot keeps it fresh after that',
  ].join('\n'));
  return true;
}
