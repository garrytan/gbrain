/**
 * Redact secrets from sources.config before serializing (v0.40 D15.4).
 *
 * Codex outside-voice catch on the v0.40 plan: `webhook show` hides the
 * secret, but any OTHER surface that returns raw `sources.config` (the
 * sources list --json, an MCP get_source op, an HTTP admin API) would
 * leak it. This module is the single redaction primitive every serializer
 * routes through.
 *
 * `scripts/check-source-config-leak.sh` grep-guards against future drift.
 */

const SECRET_KEYS: ReadonlySet<string> = new Set([
  'webhook_secret',
]);

/**
 * Return a shallow copy of `config` with every key in SECRET_KEYS replaced
 * with the string '<redacted>'. Original input is not mutated.
 *
 * Non-object input returns an empty object (defensive — sources.config is
 * always a JSON object, but driver layer may briefly return a string mid-
 * parse on legacy brains).
 */
export function redactSourceConfig(
  config: unknown,
): Record<string, unknown> {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    return {};
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(config as Record<string, unknown>)) {
    if (SECRET_KEYS.has(k)) {
      out[k] = '<redacted>';
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** True iff the config object carries a webhook secret. */
export function hasWebhookSecret(config: unknown): boolean {
  if (!config || typeof config !== 'object') return false;
  const c = config as Record<string, unknown>;
  return typeof c.webhook_secret === 'string' && c.webhook_secret.length > 0;
}
