/**
 * Consent for `gbrain bootstrap harness` (agent operator wave C6). The user
 * decides: `--yes` is the approval; otherwise a TTY prompt (EOF/timeout =
 * decline) when a human can answer, and with no human at the terminal
 * nothing is written and the refusal (exit 3, consent payload) is printed.
 * The approved argv never repeats a `--token` value.
 */
import { consentGate } from '../consent-cli.ts';
import type { HarnessFlags } from './harness.ts';

export interface HarnessConsentInput {
  flags: Pick<HarnessFlags, 'raw' | 'token' | 'tokenName' | 'yes' | 'json'>;
  url: string;
  /** Human list of the harnesses being wired, e.g. "Claude Code, Codex". */
  harnesses: string;
  skillsPolicy: 'follow' | 'memory-only';
  wireHooks: boolean;
  hookScope: string;
}

/** Resolves true when authorized; false after the refusal was printed. */
export async function askHarnessConsent(input: HarnessConsentInput, d: { isTTY: boolean; prompt: (q: string) => Promise<string> }): Promise<boolean> {
  const { flags, url, harnesses, wireHooks, hookScope } = input;
  const argv = ['gbrain', 'bootstrap', 'harness'];
  for (let i = 0; i < flags.raw.length; i++) {
    const a = flags.raw[i]!;
    if (a === '--yes') continue;
    if (a === '--token') { i++; continue; }
    argv.push(a);
  }
  const scopes = input.skillsPolicy === 'follow' ? 'read, write, skills_member_self' : 'read, write';
  const auth = await consentGate({
    command: 'bootstrap harness',
    effects: flags.token === undefined ? ['persistent_install', 'credentials'] : ['persistent_install'],
    actor: 'agent',
    what: `Wire ${harnesses} to the gbrain serve at ${url}`,
    why: 'Registers the brain\'s memory tools (and the session hooks) in the agent harness so new sessions recall from and save to this brain.',
    risk: `${flags.token === undefined ? `Mints a bearer token "${flags.tokenName}" with scopes ${scopes} and stores it in the harness config. ` : 'Stores the supplied token in the harness config (pass the same --token again). '}`
      + `Changes the harness configuration persistently${wireHooks ? `, including session hooks (${hookScope})` : ''}. Undo: gbrain bootstrap harness --remove.`,
    user_message: `Connect ${harnesses} to your brain at ${url}? It adds gbrain's memory tools${wireHooks ? ' and session hooks' : ''} to the harness configuration; gbrain bootstrap harness --remove undoes it.`,
    argv,
    args: flags.yes ? ['--yes'] : [],
  }, {
    json: flags.json,
    env: { interactive: d.isTTY, readLine: async ({ prompt }) => ({ kind: 'line', text: (await d.prompt(prompt)).trim() }) },
  });
  return auth !== null;
}
