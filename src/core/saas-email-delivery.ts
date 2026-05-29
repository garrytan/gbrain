import type { BrainEngine } from './engine.ts';
import {
  claimEmailDeliveries,
  markEmailDeliveryResult,
  type SaasEmailDelivery,
} from './saas-control-plane.ts';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface InviteEmailProviderConfig {
  provider: 'resend';
  apiKey: string;
  from: string;
  endpoint: string;
  fetcher: FetchLike;
}

export interface InviteEmailDeliveryResult {
  delivery_id: string;
  email: string;
  status: 'sent' | 'failed';
  provider: string;
  provider_message_id: string | null;
  last_error: string | null;
}

export interface InviteEmailDeliveryDrainResult {
  provider: string;
  configured: boolean;
  claimed: number;
  sent: number;
  failed: number;
  skipped: number;
  required_env: string[];
  message?: string;
  deliveries: SaasEmailDelivery[];
  results: InviteEmailDeliveryResult[];
}

export interface DrainInviteEmailDeliveriesInput {
  orgId?: string | null;
  inviteId?: string | null;
  provider?: string | null;
  recordProvider?: string | null;
  statuses?: unknown[] | null;
  limit?: number | null;
  apiKey?: string | null;
  from?: string | null;
  endpoint?: string | null;
  fetcher?: FetchLike;
}

function envFirst(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

function normalizeProvider(value: string | null | undefined): string {
  return (value || envFirst('CORTEX_EMAIL_PROVIDER') || 'resend').trim().toLowerCase();
}

export function resolveInviteEmailProviderConfig(
  input: Pick<DrainInviteEmailDeliveriesInput, 'provider' | 'apiKey' | 'from' | 'endpoint' | 'fetcher'> = {},
): InviteEmailProviderConfig | null {
  const provider = normalizeProvider(input.provider);
  if (provider !== 'resend') return null;
  const apiKey = input.apiKey?.trim() || envFirst('CORTEX_RESEND_API_KEY', 'RESEND_API_KEY') || '';
  const from = input.from?.trim() || envFirst('CORTEX_EMAIL_FROM', 'RESEND_FROM_EMAIL', 'RESEND_FROM') || '';
  if (!apiKey || !from) return null;
  return {
    provider: 'resend',
    apiKey,
    from,
    endpoint: input.endpoint?.trim() || envFirst('CORTEX_RESEND_ENDPOINT') || 'https://api.resend.com/emails',
    fetcher: input.fetcher || fetch,
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function deliveryHtml(delivery: SaasEmailDelivery): string {
  const paragraphs = delivery.body_text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      if (delivery.onboarding_url && line.includes(delivery.onboarding_url)) {
        return `<p><a href="${escapeHtml(delivery.onboarding_url)}">${escapeHtml(delivery.onboarding_url)}</a></p>`;
      }
      return `<p>${escapeHtml(line)}</p>`;
    })
    .join('\n');
  return `<!doctype html>
<html>
  <body style="margin:0;background:#f6f7f9;color:#111827;font-family:Inter,Arial,sans-serif;">
    <main style="max-width:640px;margin:0 auto;padding:32px 20px;">
      <section style="background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:28px;">
        <h1 style="font-size:22px;line-height:1.25;margin:0 0 18px;">${escapeHtml(delivery.subject)}</h1>
        <div style="font-size:15px;line-height:1.6;color:#374151;">${paragraphs}</div>
      </section>
    </main>
  </body>
</html>`;
}

function parseJsonObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function providerError(status: number, body: string): string {
  const parsed = parseJsonObject(body);
  const errorObject = parsed.error && typeof parsed.error === 'object'
    ? parsed.error as Record<string, unknown>
    : {};
  const message = parsed.message
    || (typeof parsed.error === 'string' ? parsed.error : undefined)
    || errorObject.message;
  return typeof message === 'string' && message.trim()
    ? message.trim()
    : `resend_http_${status}`;
}

export async function sendInviteDeliveryWithResend(
  delivery: SaasEmailDelivery,
  config: InviteEmailProviderConfig,
): Promise<string> {
  const response = await config.fetcher(config.endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      'content-type': 'application/json',
      'idempotency-key': `cortex-invite-${delivery.id}`,
    },
    body: JSON.stringify({
      from: config.from,
      to: [delivery.email],
      subject: delivery.subject,
      text: delivery.body_text,
      html: deliveryHtml(delivery),
      headers: {
        'X-Cortex-Delivery-Id': delivery.id,
        'X-Cortex-Org-Id': delivery.org_id,
      },
    }),
  });
  const text = await response.text();
  const body = parseJsonObject(text);
  if (!response.ok) throw new Error(providerError(response.status, text));
  const id = body.id || (body.data && typeof body.data === 'object' ? (body.data as Record<string, unknown>).id : undefined);
  return typeof id === 'string' && id.trim() ? id.trim() : `resend-${delivery.id}`;
}

export async function drainInviteEmailDeliveries(
  engine: BrainEngine,
  input: DrainInviteEmailDeliveriesInput = {},
): Promise<InviteEmailDeliveryDrainResult> {
  const provider = normalizeProvider(input.provider);
  const requiredEnv = provider === 'resend'
    ? ['RESEND_API_KEY or CORTEX_RESEND_API_KEY', 'CORTEX_EMAIL_FROM or RESEND_FROM_EMAIL']
    : ['CORTEX_EMAIL_PROVIDER=resend'];
  const config = resolveInviteEmailProviderConfig(input);
  if (!config) {
    return {
      provider,
      configured: false,
      claimed: 0,
      sent: 0,
      failed: 0,
      skipped: 0,
      required_env: requiredEnv,
      message: provider === 'resend'
        ? 'Set a Resend API key and Cortex sender address before draining invite delivery.'
        : `Unsupported email provider "${provider}". Cortex currently ships a Resend drain worker.`,
      deliveries: [],
      results: [],
    };
  }

  const deliveries = await claimEmailDeliveries(engine, {
    orgId: input.orgId || null,
    inviteId: input.inviteId || null,
    provider: input.recordProvider?.trim() || null,
    statuses: Array.isArray(input.statuses) ? input.statuses : null,
    limit: input.limit,
  });
  const results: InviteEmailDeliveryResult[] = [];
  const updated: SaasEmailDelivery[] = [];

  for (const delivery of deliveries) {
    try {
      const providerMessageId = await sendInviteDeliveryWithResend(delivery, config);
      const marked = await markEmailDeliveryResult(engine, {
        id: delivery.id,
        status: 'sent',
        provider: config.provider,
        providerMessageId,
      });
      updated.push(marked);
      results.push({
        delivery_id: delivery.id,
        email: delivery.email,
        status: 'sent',
        provider: config.provider,
        provider_message_id: providerMessageId,
        last_error: null,
      });
    } catch (error) {
      const lastError = error instanceof Error ? error.message : String(error);
      const marked = await markEmailDeliveryResult(engine, {
        id: delivery.id,
        status: 'failed',
        provider: config.provider,
        lastError,
      });
      updated.push(marked);
      results.push({
        delivery_id: delivery.id,
        email: delivery.email,
        status: 'failed',
        provider: config.provider,
        provider_message_id: null,
        last_error: lastError,
      });
    }
  }

  const sent = results.filter((row) => row.status === 'sent').length;
  const failed = results.filter((row) => row.status === 'failed').length;
  return {
    provider: config.provider,
    configured: true,
    claimed: deliveries.length,
    sent,
    failed,
    skipped: 0,
    required_env: [],
    deliveries: updated,
    results,
  };
}
