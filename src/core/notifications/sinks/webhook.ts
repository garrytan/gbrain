/**
 * The `webhook` sink: POSTs each event's JSON payload to a URL, so any other system can subscribe without a gbrain
 * change. The URL and the signing secret come from environment variables the config names (`url_env`, `secret_env`),
 * never from the config itself. Headers: `X-Gbrain-Event`, `X-Gbrain-Delivery` (the outbox row id, stable across
 * retries: dedupe on it), and with a secret `X-Gbrain-Signature: sha256=<hex HMAC-SHA256 of the body>`. A 2xx
 * delivers; 408, 429 and 5xx retry with backoff; any other status fails the row.
 */
import { createHmac } from 'node:crypto';
import type { SinkConfig } from '../config.ts';
import { NonRetryableSinkError, type NotificationSink } from '../types.ts';

const TIMEOUT_MS = 10_000;

export function createWebhookSink(config: SinkConfig): NotificationSink {
  const urlEnv = typeof config.url_env === 'string' ? config.url_env.trim() : '';
  if (!urlEnv) throw new NonRetryableSinkError(`webhook sink '${config.name}': url_env (the variable holding the URL) is required`);
  const secretEnv = typeof config.secret_env === 'string' && config.secret_env.trim() ? config.secret_env.trim() : null;
  const url = () => process.env[urlEnv]?.trim() || null;
  return {
    name: config.name,
    type: 'webhook',
    ready: () => {
      const value = url();
      if (!value) return `${urlEnv} is not set`;
      return /^https:\/\//.test(value) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//.test(value) ? null : `${urlEnv} must be an https URL`;
    },
    async deliver(row, ctx) {
      const target = url();
      if (!target) throw new NonRetryableSinkError(`${urlEnv} is not set`);
      const body = JSON.stringify({ id: row.id, event: row.event, subject: row.subject, ...row.payload });
      const secret = secretEnv ? process.env[secretEnv]?.trim() : undefined;
      const headers: Record<string, string> = {
        'content-type': 'application/json', 'x-gbrain-event': row.event, 'x-gbrain-delivery': String(row.id),
        ...(secret ? { 'x-gbrain-signature': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}` } : {}),
      };
      const doFetch = (ctx.fetchImpl ?? fetch) as typeof fetch;
      const res = await doFetch(target, { method: 'POST', headers, body, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error' });
      if (res.ok) return { status: 'delivered', delivery: { status: res.status } };
      if (res.status === 408 || res.status === 429 || res.status >= 500) throw new Error(`webhook answered ${res.status}`);
      throw new NonRetryableSinkError(`webhook answered ${res.status}`);
    },
  };
}
