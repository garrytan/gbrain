import { loadConfig } from '../core/config.ts';
import type { BrainEngine } from '../core/engine.ts';
import { DEFAULT_RUNTIME_CONFIG } from '../core/engine-factory.ts';
import { operationsByName, type OperationContext } from '../core/operations.ts';

export interface ReviewServerOptions {
  engine: BrainEngine;
  host?: string;
  port?: number;
}

export interface ReviewServerHandle {
  url: string;
  stop(): void;
}

export function startReviewServer(options: ReviewServerOptions): ReviewServerHandle {
  const host = options.host ?? '127.0.0.1';
  const port = options.port ?? 8791;
  const server = Bun.serve({
    hostname: host,
    port,
    fetch: (request) => handleReviewRequest(options.engine, request),
  });
  return {
    url: `http://${server.hostname}:${server.port}`,
    stop: () => server.stop(true),
  };
}

export async function runReview(engine: BrainEngine, args: string[]): Promise<void> {
  const host = readFlag(args, '--host') ?? '127.0.0.1';
  const port = Number(readFlag(args, '--port') ?? '8791');
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('--port must be an integer between 0 and 65535');
  }
  const handle = startReviewServer({ engine, host, port });
  console.log(`mbrain review listening on ${handle.url}`);
  await new Promise<void>((resolve) => {
    const stop = () => {
      handle.stop();
      resolve();
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

async function handleReviewRequest(engine: BrainEngine, request: Request): Promise<Response> {
  const url = new URL(request.url);
  try {
    if (request.method === 'GET' && url.pathname === '/') {
      const candidates = await listCandidates(engine, {
        status: url.searchParams.get('status') ?? 'candidate',
      });
      return html(renderReviewPage(candidates));
    }
    if (request.method === 'GET' && url.pathname === '/api/candidates') {
      const result = await listCandidates(engine, {
        status: url.searchParams.get('status') ?? 'candidate',
      });
      return json({ candidates: result });
    }
    const formReviewMatch = url.pathname.match(/^\/candidates\/([^/]+)\/(verify|refute)$/);
    if (request.method === 'POST' && formReviewMatch) {
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
    return json({ error: 'not_found' }, 404);
  } catch (error) {
    return json({
      error: error instanceof Error ? error.name : 'Error',
      message: error instanceof Error ? error.message : String(error),
    }, 400);
  }
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

function renderReviewPage(candidates: Record<string, unknown>[]): string {
  const rows = candidates.map((candidate) => {
    const id = String(candidate.id ?? '');
    const content = String(candidate.proposed_content ?? '');
    const target = `${candidate.target_object_type ?? 'unknown'}:${candidate.target_object_id ?? 'unbound'}`;
    return [
      '<article class="candidate">',
      `<h2>${escapeHtml(id)}</h2>`,
      `<p>${escapeHtml(content)}</p>`,
      `<p class="meta">${escapeHtml(target)}</p>`,
      '<div class="actions">',
      `<form method="post" action="/candidates/${encodeURIComponent(id)}/verify">`,
      '<button type="submit">Verify</button>',
      '</form>',
      `<form method="post" action="/candidates/${encodeURIComponent(id)}/refute">`,
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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
