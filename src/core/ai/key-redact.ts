/**
 * #5137: scrub provider key material from upstream error text before it
 * reaches the CLI, `--json` or a persisted job error. Providers echo keys in
 * auth failures, whole or masked (`sk-...****abcd`).
 */
import { redactSecretsInText } from '../minions/handlers/shell-redact.ts';

const SECRET_ENV = /(?:_API_KEY|_TOKEN|_SECRET|_PASSWORD)$/;

export function redactProviderKeys(text: string, env: Record<string, string | undefined>): string {
  if (!text) return text;
  const secrets = Object.entries(env)
    .filter((entry): entry is [string, string] => SECRET_ENV.test(entry[0]) && typeof entry[1] === 'string' && entry[1].length >= 8)
    .sort(([, a], [, b]) => b.length - a.length);
  return redactSecretsInText(text, secrets)
    .replace(/[A-Za-z0-9_-]*\*{3,}[A-Za-z0-9_-]*/g, '<REDACTED:masked_key>')
    .replace(/[A-Za-z0-9_-]{8,}/g, token => secrets.some(([, value]) => value.includes(token)) ? '<REDACTED:key_fragment>' : token);
}
