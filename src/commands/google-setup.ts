/**
 * gbrain google setup — the one-command orchestrator (approved D1-A).
 *
 * connect (skipped when tokens exist) → register the google source (if
 * needed) → wall-clock-budgeted first sync (newest mail first; the
 * remainder resumes automatically on later syncs) → the first
 * `gbrain waiting` digest. The magical moment arrives in the same session
 * as consent; every step is idempotent, so re-running resumes wherever the
 * last run stopped.
 */

import { credentialId, openVault } from '../core/creds/vault.ts';
import { GOOGLE_PROVIDER, GoogleTokenProvider } from '../core/creds/providers/google.ts';
import { ALL_GOOGLE_SERVICES } from '../core/google/types.ts';
import { currentExitCode, setCliExitVerdict } from '../core/cli-force-exit.ts';
import { parseServicesCsv, runGoogleConnect } from './google.ts';

export async function runGoogleSetup(args: string[]): Promise<void> {
  const json = args.includes('--json');
  const accountIdx = args.indexOf('--account');
  let account = accountIdx !== -1 ? args[accountIdx + 1]?.toLowerCase() : undefined;

  const vault = openVault();

  // Step 1 — connect (skipped when the account already has tokens). With
  // --personal, an account still on a shared (byo or relay) client reconnects
  // onto its own Personal-mode client; its source and pages stay as they are.
  const personal = args.includes('--personal');
  const existingEntry = account ? await vault.get(credentialId(GOOGLE_PROVIDER, account)) : null;
  const existingAccount = account
    ? (personal && existingEntry?.meta.client_mode !== 'personal' ? null : existingEntry?.meta.account ?? null)
    : ((await vault.list({ provider: GOOGLE_PROVIDER }))[0]?.account ?? null);
  if (!existingAccount) {
    // Strip tail-only flags before delegating: parseConnectFlags hard-exits
    // on unknown flags, so `setup --history-days 180` must not kill connect.
    const TAIL_FLAGS = new Set(['--history-days', '--sync-budget-ms']);
    const connectArgs: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (TAIL_FLAGS.has(args[i])) { i++; continue; }
      connectArgs.push(args[i]);
    }
    await runGoogleConnect(connectArgs);
    // Connect that still waits on the user (a client, a consent) leaves its exit
    // verdict set; the old entry must not be probed or synced in the meantime.
    if (currentExitCode() !== 0) return;
    // connect exits non-zero when it needs user input; a completed connect
    // falls through here. Re-resolve the account it landed.
    const metas = await vault.list({ provider: GOOGLE_PROVIDER });
    if (metas.length === 0) return; // connect handed back a next_action
    account = account ?? metas[0].account ?? metas[0].id.split(':')[1];
  } else {
    account = account ?? existingAccount;
  }
  if (!account) return;

  // Step 2 (#7073) — probe every requested service before registering anything,
  // so each disabled API or missing scope is named at once instead of one per sync.
  const entry = await vault.get(credentialId(GOOGLE_PROVIDER, account));
  if (entry) {
    const servicesIdx = args.indexOf('--services');
    const services = servicesIdx !== -1 ? parseServicesCsv(args[servicesIdx + 1] ?? '') : [...ALL_GOOGLE_SERVICES];
    const { googleIdentityClients, probeGoogleApiAccess } = await import('../core/google/api-access.ts');
    const access = await probeGoogleApiAccess(googleIdentityClients(new GoogleTokenProvider(vault, entry.id), entry.meta.client_id),
      account, services, entry.meta.scopes ?? []);
    if (access.fix) {
      const { cliRenderContext, renderAction } = await import('../core/agent-output.ts');
      const fix = renderAction(access.fix, cliRenderContext());
      const reachable = services.filter((service) => access.services[service]?.status === 'ok');
      const narrower = reachable.length > 0 ? `gbrain google setup --account ${account} --services ${reachable.join(',')}` : null;
      if (json) {
        process.stdout.write(JSON.stringify({ ok: false, status: 'api_access_blocked', account, api_access: { ...access, fix },
          ...(narrower ? { reachable_services_command: narrower } : {}) }, null, 2) + '\n');
      } else {
        const { agentBlock } = await import('../core/agent-markers.ts');
        process.stderr.write([`Google account ${account} cannot reach every service yet; nothing was registered or synced.`,
          ...access.problems.map((p) => p.code === 'api_not_enabled'
            ? `  - ${p.api_title} (${p.api}) is disabled for Google Cloud project ${p.project ?? 'unknown'}. Enable it: ${p.enable_url}`
            : `  - ${p.service}: access was not granted. Run: gbrain google connect --reauth ${account}`),
          'Then re-run: gbrain google setup', ...(narrower ? [`Or set up only the services it can reach now: ${narrower}`] : [])].join('\n') + '\n'
          + agentBlock({ why: fix.why, actor: fix.actor, next: fix.next, verify: 'gbrain google status --json' }, { showUser: fix.user_message ?? '' }));
      }
      setCliExitVerdict(2);
      return;
    }
  }

  // Step 3 — register the source + first sync + waiting digest.
  const { runGoogleSetupTail } = await import('./google-setup-tail.ts');
  await runGoogleSetupTail({ account, json, args });
}
