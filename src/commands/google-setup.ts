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
import { GOOGLE_PROVIDER } from '../core/creds/providers/google.ts';
import { runGoogleConnect } from './google.ts';

export async function runGoogleSetup(args: string[]): Promise<void> {
  const json = args.includes('--json');
  const accountIdx = args.indexOf('--account');
  let account = accountIdx !== -1 ? args[accountIdx + 1]?.toLowerCase() : undefined;

  const vault = openVault();

  // Step 1 — connect (skipped when the account already has tokens).
  const existingAccount = account
    ? (await vault.get(credentialId(GOOGLE_PROVIDER, account)))?.meta.account ?? null
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
    // connect exits non-zero when it needs user input; a completed connect
    // falls through here. Re-resolve the account it landed.
    const metas = await vault.list({ provider: GOOGLE_PROVIDER });
    if (metas.length === 0) return; // connect handed back a next_action
    account = account ?? metas[0].account ?? metas[0].id.split(':')[1];
  } else {
    account = account ?? existingAccount;
  }
  if (!account) return;

  // Step 2 — register the source + first sync + waiting digest.
  const { runGoogleSetupTail } = await import('./google-setup-tail.ts');
  await runGoogleSetupTail({ account, json, args });
}
