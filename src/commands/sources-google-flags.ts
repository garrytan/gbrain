/**
 * The Google-kind tuning flags of the legacy `gbrain sources add` parser
 * (`--history-days`, `--future-days`, `--loops-exclude-labels`,
 * `--contacts-dir`, `--calendar-id`, `--gbrainio-command`, `--private-senders-file`): one value each, validated the moment they are read.
 * The connected-source parser (sources-lifecycle-args.ts) validates the same
 * flags through the operation contract; this module keeps the legacy path's
 * exit-2 behaviour without growing runAdd.
 */
import { CALENDAR_FUTURE_DAYS_MAX } from '../core/google/calendar-window.ts';
import { parseExcludeLabelTokens } from '../core/google/loops-exclusion.ts';
import { parseContactsDir } from '../core/google/source-config.ts';
import { resolve } from 'node:path';

import { DEFAULT_CALENDAR_ID } from '../core/google/types.ts';

export interface GoogleAddTuning {
  historyDays: number;
  calendarId: string;
  contactsDir?: string;
  futureDays?: number;
  loopsExcludeLabels?: string[];
  gbrainioCommand?: string;
  privateSendersFile?: string;
  ingestTiers?: boolean;
}

export const defaultGoogleAddTuning = (): GoogleAddTuning => ({ historyDays: 90, calendarId: DEFAULT_CALENDAR_ID });

const refuse = (message: string): never => {
  console.error(message);
  process.exit(2);
};

/** Consumes `flag` with its `value` into `tuning`; false when the flag is not a Google tuning flag. */
export function parseGoogleAddFlag(flag: string, value: string | undefined, tuning: GoogleAddTuning): boolean {
  switch (flag) {
    case '--history-days': {
      const v = Number(value);
      if (!Number.isInteger(v) || v <= 0) refuse('--history-days must be a positive integer.');
      tuning.historyDays = v;
      return true;
    }
    case '--future-days': {
      const v = Number(value);
      if (!Number.isInteger(v) || v <= 0 || v > CALENDAR_FUTURE_DAYS_MAX) refuse(`--future-days must be a whole number between 1 and ${CALENDAR_FUTURE_DAYS_MAX}.`);
      tuning.futureDays = v;
      return true;
    }
    case '--loops-exclude-labels': {
      const labels = parseExcludeLabelTokens(value);
      if (labels.length === 0) refuse('--loops-exclude-labels needs a comma-separated list of Gmail label names or ids.');
      tuning.loopsExcludeLabels = labels;
      return true;
    }
    case '--contacts-dir': {
      const dir = parseContactsDir(value);
      if (!dir) refuse('--contacts-dir must be a relative directory of lower-case segments (a-z, 0-9, -, _), e.g. --contacts-dir contacts.');
      tuning.contactsDir = dir!;
      return true;
    }
    case '--calendar-id': {
      const v = (value ?? '').trim();
      if (!v) refuse('--calendar-id needs a value (see: gbrain google calendars).');
      tuning.calendarId = v;
      return true;
    }
    case '--gbrainio-command': {
      const v = (value ?? '').trim();
      if (!v) refuse('--gbrainio-command needs the gbrainio command or its full path.');
      tuning.gbrainioCommand = v;
      return true;
    }
    case '--private-senders-file': {
      const v = (value ?? '').trim();
      if (!v) refuse('--private-senders-file needs a path (one address or @domain per line).');
      tuning.privateSendersFile = resolve(v);
      return true;
    }
    default:
      return false;
  }
}

/** Consumes `--ingest-tiers` or `--no-ingest-tiers` (no value) into `tuning`; false for any other flag. Both together refuse. */
export function parseGoogleIngestTiersFlag(flag: string, tuning: GoogleAddTuning): boolean {
  if (flag !== '--ingest-tiers' && flag !== '--no-ingest-tiers') return false;
  const on = flag === '--ingest-tiers';
  if (tuning.ingestTiers === !on) refuse('Pass --ingest-tiers or --no-ingest-tiers, not both.');
  tuning.ingestTiers = on;
  return true;
}

/**
 * Validates the Google access flags of the legacy `sources add` and probes the chosen access once, so a missing
 * vault entry, an unreadable private-senders file or a bad flag combination exits 2 here, before the source exists.
 * `services` is the --services list when it was passed, else null.
 */
export async function preflightGoogleAccess(o: { access: string | undefined; tokenCommand: string | undefined; tokenEnv: string | undefined;
  account: string; services: string[] | null; tuning: GoogleAddTuning }): Promise<void> {
  // Access-mode validation (default vault). command/env let a stack that
  // already holds Google access (gog, gcloud, a credential gateway) drive
  // this source without gbrain's OAuth flow; --account stays required as
  // the IDENTITY (From/To matching, deep-link authuser).
  if (o.access !== undefined && !['vault', 'command', 'env', 'gbrainio'].includes(o.access)) {
    console.error(`Error: unknown --access "${o.access}". Valid: vault, command, env, gbrainio.`);
    process.exit(2);
  }
  if (o.tuning.gbrainioCommand && o.access !== 'gbrainio') {
    console.error('Error: --gbrainio-command requires --access gbrainio.');
    process.exit(2);
  }
  if (o.access === 'gbrainio' && (o.services ?? []).some((svc) => svc !== 'gmail')) {
    console.error('Error: --access gbrainio reads Gmail only; pass --services gmail or leave --services out.');
    process.exit(2);
  }
  if (o.tuning.privateSendersFile) {
    try {
      const { loadPrivateSenders } = await import('../core/google/google-source.ts');
      loadPrivateSenders(o.tuning.privateSendersFile);
    } catch (e) {
      console.error(`Error: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
      process.exit(2);
    }
  }
  if (o.access === 'command' && !o.tokenCommand?.trim()) {
    console.error('Error: --access command requires --token-command "<cmd that prints an access token>".');
    process.exit(2);
  }
  if (o.access === 'env' && !o.tokenEnv?.trim()) {
    console.error('Error: --access env requires --token-env <ENV_VAR_NAME>.');
    process.exit(2);
  }
  if ((o.tokenCommand || o.tokenEnv) && (o.access === undefined || o.access === 'vault' || o.access === 'gbrainio')) {
    console.error('Error: --token-command/--token-env require --access command or --access env.');
    process.exit(2);
  }
  if (o.access === undefined || o.access === 'vault') {
    // Fail fast at registration when the account has no vault entry — the
    // alternative is a source that errors on every sync.
    const { openVault, credentialId } = await import('../core/creds/vault.ts');
    const entry = await openVault().get(credentialId('google', o.account!));
    if (!entry) {
      console.error(
        `Error: no connected Google account "${o.account}" in the credential vault.\n` +
          `Connect it first: gbrain google connect --account ${o.account}\n` +
          `(or use another access mode: --access command --token-command "<cmd>" | --access env --token-env <VAR>)`,
      );
      process.exit(2);
    }
  } else if (o.access === 'command') {
    // Probe the command once at registration so a typo fails HERE, not on
    // every future sync. Best-effort: a transient failure only warns.
    try {
      const { CommandAccessProvider } = await import('../core/google/access.ts');
      await new CommandAccessProvider(o.tokenCommand!).getAccessToken();
    } catch (e) {
      console.error(`Warning: token command probe failed (${e instanceof Error ? e.message.split('\n')[0] : String(e)}) — the source is registered, but sync will fail until the command works.`);
    }
  } else if (o.access === 'gbrainio') {
    // Probe the terminal once so a missing client or an unapproved terminal shows HERE. Best-effort: a failure only warns.
    try {
      const { GbrainioGmailReader } = await import('../core/google/gbrainio-gmail.ts');
      await new GbrainioGmailReader(o.tuning.gbrainioCommand ?? 'gbrainio', o.account!).getProfile();
    } catch (e) {
      console.error(`Warning: gbrain.io probe failed (${e instanceof Error ? e.message.split('\n')[0] : String(e)}) — the source is registered, but sync will fail until the terminal can read this mailbox.`);
    }
  } else if (o.access === 'env' && !(process.env[o.tokenEnv!] ?? '').trim()) {
    console.error(`Warning: $${o.tokenEnv} is not set in this shell — sync will fail until it carries a live access token.`);
  }
}
