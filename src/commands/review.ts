import { randomBytes, timingSafeEqual } from 'crypto';
import { loadConfig } from '../core/config.ts';
import type { BrainEngine } from '../core/engine.ts';
import { DEFAULT_RUNTIME_CONFIG } from '../core/engine-factory.ts';
import { operationsByName, type OperationContext } from '../core/operations.ts';
import { startMcpHttpServer } from '../mcp/http-server.ts';

export interface ReviewServerOptions {
  engine: BrainEngine;
  host?: string;
  port?: number;
  token?: string;
  allowNonLoopback?: boolean;
}

export interface ReviewServerHandle {
  url: string;
  token: string;
  stop(): void;
}

export function startReviewServer(options: ReviewServerOptions): ReviewServerHandle {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 8791;
  if (!options.allowNonLoopback && !isLoopbackBindHost(host)) {
    throw new Error('mbrain review refuses non-loopback --host without --i-know.');
  }
  const token = options.token ?? randomBytes(24).toString('base64url');
  const server = startMcpHttpServer({
    engine: options.engine,
    config: loadConfig() ?? DEFAULT_RUNTIME_CONFIG,
    host,
    port,
    surfaceProfile: 'review_local',
    reviewRoutes: {
      handle: (request) => handleReviewRoute(options.engine, request, { token, bindHost: host }),
    },
  });
  return {
    url: `http://${server.hostname}:${server.port}`,
    token,
    stop: () => server.stop(true),
  };
}

export async function runReview(engine: BrainEngine, args: string[]): Promise<void> {
  const host = readFlag(args, '--host') ?? '127.0.0.1';
  const port = Number(readFlag(args, '--port') ?? '8791');
  const allowNonLoopback = args.includes('--i-know') || args.includes('--allow-non-loopback');
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('--port must be an integer between 0 and 65535');
  }
  const handle = startReviewServer({ engine, host, port, allowNonLoopback });
  if (!isLoopbackBindHost(host)) {
    console.warn('Warning: mbrain review is bound to a non-loopback host. Keep the printed token private.');
  }
  console.log(`mbrain review listening on ${handle.url}`);
  console.log(`mbrain review token: ${handle.token}`);
  console.log(`Open: ${handle.url}/?review_token=${encodeURIComponent(handle.token)}`);
  await new Promise<void>((resolve) => {
    const stop = () => {
      handle.stop();
      resolve();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

async function handleReviewRoute(engine: BrainEngine, request: Request, guard: ReviewRouteGuard): Promise<Response | null> {
  const url = new URL(request.url);
  try {
    if (request.method === 'GET' && url.pathname === '/') {
      const auth = await authorizeReviewRequest(request, guard);
      if (!auth.ok) return forbidden(auth.message);
      const candidates = await listCandidates(engine, {
        status: url.searchParams.get('status') ?? 'candidate',
      });
      return html(renderReviewPage(candidates, guard.token));
    }
    if (request.method === 'GET' && url.pathname === '/api/candidates') {
      const auth = await authorizeReviewRequest(request, guard);
      if (!auth.ok) return forbidden(auth.message);
      const result = await listCandidates(engine, {
        status: url.searchParams.get('status') ?? 'candidate',
      });
      return json({ candidates: result });
    }
    const formReviewMatch = url.pathname.match(/^\/candidates\/([^/]+)\/(verify|refute)$/);
    if (request.method === 'POST' && formReviewMatch) {
      const auth = await authorizeReviewRequest(request, guard, { mutating: true, allowFormToken: true });
      if (!auth.ok) return forbidden(auth.message);
      const id = decodeURIComponent(formReviewMatch[1]!);
      const verificationStatus = formReviewMatch[2] === 'verify' ? 'verified' : 'refuted';
      await reviewCandidate(engine, {
        id,
        verification_status: verificationStatus,
        verification_method: 'user_confirmation',
        verification_evidence: `Reviewed in mbrain review UI at ${new Date().toISOString()}.`,
        verification_source_refs: ['mbrain-review-ui'],
      });
      return redirect('/?status=candidate');
    }
    const apiReviewMatch = url.pathname.match(/^\/api\/candidates\/([^/]+)\/(verify|refute)$/);
    if (request.method === 'POST' && apiReviewMatch) {
      const auth = await authorizeReviewRequest(request, guard, { mutating: true });
      if (!auth.ok) return forbidden(auth.message);
      const id = decodeURIComponent(apiReviewMatch[1]!);
      const body = await request.json() as Record<string, unknown>;
      const candidate = await reviewCandidate(engine, {
        id,
        verification_status: body.verification_status ?? (apiReviewMatch[2] === 'verify' ? 'verified' : 'refuted'),
        verification_method: body.verification_method,
        verification_evidence: body.verification_evidence,
        verification_source_refs: body.verification_source_refs,
      });
      return json({ candidate });
    }
    return null;
  } catch (error) {
    return json({
      error: error instanceof Error ? error.name : 'Error',
      message: error instanceof Error ? error.message : String(error),
    }, 400);
  }
}

interface ReviewRouteGuard {
  token: string;
  bindHost: string;
}

async function authorizeReviewRequest(
  request: Request,
  guard: ReviewRouteGuard,
  options: { mutating?: boolean; allowFormToken?: boolean } = {},
): Promise<{ ok: true } | { ok: false; message: string }> {
  const url = new URL(request.url);
  const requestHost = reviewRequestHost(request, url);
  if (!requestHost || !isAllowedReviewHost(requestHost, guard.bindHost)) {
    return { ok: false, message: 'review_host_not_allowed' };
  }
  if (options.mutating && !isAllowedReviewOrigin(request)) {
    return { ok: false, message: 'review_origin_not_allowed' };
  }
  const token = await readReviewToken(request, { allowFormToken: options.allowFormToken === true });
  if (!token || !constantTimeEqual(token, guard.token)) {
    return { ok: false, message: 'review_token_required' };
  }
  return { ok: true };
}

async function readReviewToken(
  request: Request,
  options: { allowFormToken: boolean },
): Promise<string | null> {
  const auth = request.headers.get('authorization');
  const bearer = auth?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (bearer) return bearer;
  const headerToken = request.headers.get('x-mbrain-review-token')?.trim();
  if (headerToken) return headerToken;
  const url = new URL(request.url);
  const queryToken = url.searchParams.get('review_token')?.trim();
  if (queryToken) return queryToken;
  if (!options.allowFormToken) return null;
  const contentType = request.headers.get('content-type') ?? '';
  if (!/application\/x-www-form-urlencoded|multipart\/form-data/i.test(contentType)) return null;
  const form = await request.formData();
  const formToken = form.get('review_token');
  return typeof formToken === 'string' ? formToken.trim() : null;
}

function forbidden(message: string): Response {
  return json({ error: 'forbidden', message }, 403);
}

async function reviewCandidate(
  engine: BrainEngine,
  input: {
    id: string;
    verification_status: unknown;
    verification_method: unknown;
    verification_evidence: unknown;
    verification_source_refs: unknown;
  },
): Promise<unknown> {
  return operationsByName.verify_memory_candidate_entry.handler(ctx(engine), input) as unknown;
}

async function listCandidates(
  engine: BrainEngine,
  input: { status: string | null },
): Promise<Record<string, unknown>[]> {
  const result = await operationsByName.list_memory_candidate_entries.handler(ctx(engine), {
    status: input.status ?? 'candidate',
    limit: 50,
  }) as Record<string, unknown>[] | { entries?: Record<string, unknown>[] };
  return Array.isArray(result) ? result : (result.entries ?? []);
}

function renderReviewPage(candidates: Record<string, unknown>[], token: string): string {
  const rows = candidates.map((candidate) => {
    const id = String(candidate.id ?? '');
    const content = String(candidate.proposed_content ?? '');
    const target = `${candidate.target_object_type ?? 'unknown'}:${candidate.target_object_id ?? 'unbound'}`;
    const sourceRefs = stringList(candidate.source_refs).join(', ') || 'none';
    const generatedBy = String(candidate.generated_by ?? 'unknown');
    const confidence = formatScore(candidate.confidence_score);
    const verificationEvidence = optionalString(candidate.verification_evidence);
    const reviewReason = optionalString(candidate.review_reason);
    return [
      '<article class="candidate">',
      `<h2>${escapeHtml(id)}</h2>`,
      `<p>${escapeHtml(content)}</p>`,
      `<p class="meta">${escapeHtml(target)}</p>`,
      `<p class="evidence">sources: ${escapeHtml(sourceRefs)}</p>`,
      `<p class="meta">generated_by: ${escapeHtml(generatedBy)} · confidence: ${escapeHtml(confidence)}</p>`,
      verificationEvidence ? `<p class="evidence">verification: ${escapeHtml(verificationEvidence)}</p>` : '',
      reviewReason ? `<p class="evidence">review: ${escapeHtml(reviewReason)}</p>` : '',
      '<div class="actions">',
      `<form method="post" action="/candidates/${encodeURIComponent(id)}/verify">`,
      `<input type="hidden" name="review_token" value="${escapeHtml(token)}">`,
      '<button type="submit">Verify</button>',
      '</form>',
      `<form method="post" action="/candidates/${encodeURIComponent(id)}/refute">`,
      `<input type="hidden" name="review_token" value="${escapeHtml(token)}">`,
      '<button type="submit">Refute</button>',
      '</form>',
      '</div>',
      '</article>',
    ].join('');
  }).join('');
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>mbrain review</title>
  <style>
    body { font: 14px/1.45 system-ui, sans-serif; margin: 24px; max-width: 960px; }
    header { border-bottom: 1px solid #ddd; margin-bottom: 16px; }
    .candidate { border: 1px solid #ddd; border-radius: 8px; padding: 12px; margin: 12px 0; }
    .meta { color: #555; font-family: ui-monospace, monospace; }
    .evidence { color: #333; font-family: ui-monospace, monospace; overflow-wrap: anywhere; }
    .actions { display: flex; gap: 8px; }
    button { margin-right: 8px; }
  </style>
</head>
<body>
  <header><h1>mbrain review</h1></header>
  <main>${rows || '<p>No pending candidates.</p>'}</main>
</body>
</html>`;
}

function isLoopbackBindHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return normalized === 'localhost'
    || normalized === '127.0.0.1'
    || normalized === '::1';
}

function isAllowedReviewHost(requestHost: string, bindHost: string): boolean {
  const normalizedRequestHost = requestHost.trim().toLowerCase().replace(/^\[|\]$/g, '');
  const normalizedBindHost = bindHost.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (isLoopbackBindHost(normalizedBindHost)) {
    return isLoopbackBindHost(normalizedRequestHost);
  }
  return normalizedRequestHost === normalizedBindHost;
}

function reviewRequestHost(request: Request, url: URL): string | null {
  const hostHeader = request.headers.get('host')?.trim();
  if (!hostHeader) return url.hostname;
  try {
    return new URL(`${url.protocol}//${hostHeader}`).hostname;
  } catch {
    const bracketedIpv6 = hostHeader.match(/^\[([^\]]+)\](?::\d+)?$/)?.[1];
    if (bracketedIpv6) return bracketedIpv6;
    const [hostname] = hostHeader.split(':');
    return hostname?.trim() || null;
  }
}

function isAllowedReviewOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return true;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function html(value: string): Response {
  return new Response(value, {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

function redirect(location: string): Response {
  return new Response(null, {
    status: 303,
    headers: { location },
  });
}

function ctx(engine: BrainEngine): OperationContext {
  return {
    engine,
    config: loadConfig() ?? DEFAULT_RUNTIME_CONFIG,
    logger: { info: console.log, warn: console.warn, error: console.error },
    dryRun: false,
  };
}

function readFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  return args[index + 1];
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function formatScore(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : 'unknown';
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
