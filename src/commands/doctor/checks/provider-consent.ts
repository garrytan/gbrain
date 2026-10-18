/**
 * `provider_consent` doctor check (Cat 41 wave 2): the provider-use decision
 * `gbrain setup` recorded for this install, and what it does to provider
 * calls. A recorded `declined` means gbrain contacts no model provider it was
 * not asked to use, even with provider keys in the environment: OpenAI model
 * discovery is skipped (src/core/ai/openai-latest.ts) and the opt-in
 * embedding probe reports itself skipped by consent. This check only reads
 * the receipts (src/core/setup/local-receipts.ts) and names the environment
 * keys it sees, never their values; it sends nothing. Engine-free
 * filesystem-lane entry (also under `--fast`).
 */
import type { Action } from '../../../core/agent-output.ts';
import { CONFIG_API_KEY_ENV } from '../../../core/ai/provider-env.ts';
import { localSetupRecords, type LocalSetupRecord } from '../../../core/setup/local-receipts.ts';
import type { Check } from '../../doctor.ts';
import { checkError, doctorVerify, infoCheck } from '../check-fix.ts';
import type { DoctorContext, DoctorEntry } from '../context.ts';

const DOCS = 'docs/guides/setup.md#provider-use-declined';

/** The user's way back: re-run setup with `--providers`, which records provider use as accepted. */
export function providerConsentFix(record: LocalSetupRecord): Action {
  const argv = ['gbrain', 'setup', record.harness, '--providers',
    ...(record.name === 'gbrain' ? [] : ['--name', record.name]),
    ...(record.scope === 'project' ? ['--scope', 'project'] : [])];
  return {
    argv,
    consent: ['paid', 'egress'],
    actor: 'user',
    why: 'Setup recorded provider use as declined, so gbrain contacts no model provider. Re-running setup with --providers records it as accepted; provider calls then follow the configured keys.',
    user_message: `gbrain is not contacting any AI provider because you declined provider use at setup. To allow it, run \`${argv.join(' ')}\`${record.scope === 'project' ? ' in that project directory' : ''}.`,
    verify: doctorVerify('provider_consent'),
    docs: DOCS,
    requires_exclusive: false,
  };
}

/** Provider key variables set in `env` (names only). */
export function providerKeysInEnv(env: Record<string, string | undefined>): string[] {
  const names = [...CONFIG_API_KEY_ENV.map(([, name]) => name), 'GEMINI_API_KEY'];
  return [...new Set(names)].filter((name) => !!env[name]);
}

async function runProviderConsent(_ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  let records: LocalSetupRecord[];
  try {
    records = localSetupRecords().filter((r) => r.providers !== undefined);
  } catch (e) {
    checks.push(checkError('provider_consent', 'read the gbrain setup receipts', e));
    return checks;
  }
  const keys = providerKeysInEnv(process.env);
  const declined = records.find((r) => r.providers === 'declined');
  if (declined) {
    const env = keys.length ? ` even though ${keys.join(', ')} ${keys.length === 1 ? 'is' : 'are'} set in this environment` : '';
    const fix = providerConsentFix(declined);
    checks.push(infoCheck('provider_consent',
      `Provider check skipped by consent: gbrain setup recorded provider use as declined (${declined.path}), so gbrain sends no request to a model provider${env}, model discovery and the embedding probe included. The user decides; to allow provider use they run: ${fix.argv!.join(' ')}`,
      'disabled_by_choice', fix,
      { decision: 'declined', receipt: declined.path, harness: declined.harness, provider_env: keys, probed: false }));
    return checks;
  }
  if (records.length) {
    checks.push({ name: 'provider_consent', status: 'ok', message: `gbrain setup recorded provider use as accepted (${records[0]!.path}); provider calls follow the configured keys.`,
      details: { decision: 'accepted', receipt: records[0]!.path, harness: records[0]!.harness, provider_env: keys } });
    return checks;
  }
  checks.push(infoCheck('provider_consent', 'No gbrain setup receipt records a provider-use decision for this install; provider calls follow the configured keys.', 'not_applicable',
    undefined, { decision: null, provider_env: keys }));
  return checks;
}

export const providerConsentEntry: DoctorEntry = {
  name: 'provider_consent',
  emits: ['provider_consent'],
  run: runProviderConsent,
};
