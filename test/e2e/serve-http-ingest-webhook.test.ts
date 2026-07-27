/**
 * v0.38 — E2E HTTP contract tests for POST /ingest, the webhook ingestion
 * source registered inside `gbrain serve --http` per the plan-eng-review E1
 * decision (webhook source lives IN serve --http, NOT in the ingestion
 * daemon; uses Minion queue as the cross-process sync primitive).
 *
 * The pre-existing `test/e2e/ingestion-roundtrip.test.ts` covers the
 * end-to-end pipeline (event → daemon → ingest_capture → DB) using
 * in-process simulation; what it explicitly does NOT cover is "the real
 * HTTP route with real OAuth." This file fills that gap.
 *
 * Spawns a real `gbrain serve --http` against real Postgres, mints OAuth
 * tokens with various scopes, and exercises every documented
 * status-code branch of the route:
 *
 *   1. Auth: missing token → 401; read-only token → 403 (write scope
 *      required by the route)
 *   2. Body validation: empty body → 400 with `error: empty_body`
 *   3. Content-type allowlist: image/png → 415 with paste-ready
 *      processor-skillpack hint
 *   4. Happy path: text/markdown → 200/202 with job_id in response
 *   5. Header overrides: X-Gbrain-Slug is forwarded; X-Gbrain-Source-Id
 *      tags the event
 *   6. Idempotency: same content + same client → job_id returned twice
 *      should match (queue dedup on (client_id, content_hash))
 *
 * Mirrors the spawn + mint pattern from test/e2e/serve-http-oauth.test.ts
 * exactly so future maintainers see one pattern, not two.
 *
 * Run: GBRAIN_DATABASE_URL=... bun test test/e2e/serve-http-ingest-webhook.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { hasDatabase } from './helpers.ts';

const skip = !hasDatabase();
const describeE2E = skip ? describe.skip : describe;

if (skip) {
  console.log('Skipping E2E serve-http-ingest-webhook tests (DATABASE_URL not set)');
}

const PORT = 19138; // Distinct from sibling E2Es to avoid collision
const BASE = `http://localhost:${PORT}`;

describeE2E('serve-http POST /ingest webhook (v0.38)', () => {
  let serverProcess: ReturnType<typeof import('child_process').spawn> | null = null;
  let clientId: string | undefined;
  let clientSecret: string | undefined;

  beforeAll(async () => {
    const { execSync, spawn } = await import('child_process');

    // Register a confidential client with both read and write scopes.
    // The write scope is what POST /ingest gates on.
    const regOutput = execSync(
      'bun run src/cli.ts auth register-client e2e-webhook-test --grant-types client_credentials --scopes "read write"',
      { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env } },
    );
    const idMatch = regOutput.match(/Client ID:\s+(gbrain_cl_\S+)/);
    const secretMatch = regOutput.match(/Client Secret:\s+(gbrain_cs_\S+)/);
    if (!idMatch || !secretMatch) {
      throw new Error('Failed to register webhook test client:\n' + regOutput);
    }
    clientId = idMatch[1];
    clientSecret = secretMatch[1];

    serverProcess = spawn(
      'bun',
      [
        'run',
        'src/cli.ts',
        'serve',
        '--http',
        '--port',
        String(PORT),
        '--public-url',
        `http://localhost:${PORT}`,
      ],
      {
        cwd: process.cwd(),
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let stderr = '';
    serverProcess.stderr?.on('data', (d: Buffer) => {
      stderr += d.toString();
    });

    // Wait for /health to respond. Up to 15s.
    let ready = false;
    for (let i = 0; i < 30; i++) {
      try {
        const res = await fetch(`${BASE}/health`);
        if (res.ok) {
          ready = true;
          break;
        }
      } catch {
        /* not ready yet */
      }
      await new Promise(r => setTimeout(r, 500));
    }
    if (!ready) {
      throw new Error('Webhook E2E server failed to start within 15s.\nstderr: ' + stderr.slice(-500));
    }
  }, 30_000);

  afterAll(async () => {
    if (serverProcess) {
      serverProcess.kill('SIGTERM');
      await new Promise(r => setTimeout(r, 1000));
      if (!serverProcess.killed) serverProcess.kill('SIGKILL');
    }
    if (clientId) {
      try {
        const { execSync } = await import('child_process');
        execSync(`bun run src/cli.ts auth revoke-client "${clientId}"`, {
          cwd: process.cwd(),
          encoding: 'utf8',
          env: { ...process.env },
        });
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error(`[afterAll] revoke-client cleanup failed: ${(e as Error).message}`);
      }
    }
  }, 30_000);

  // Helper — mint a token with a specific scope subset.
  async function mintToken(scope = 'read write'): Promise<string> {
    const res = await fetch(`${BASE}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=client_credentials&client_id=${clientId}&client_secret=${clientSecret}&scope=${encodeURIComponent(scope)}`,
    });
    expect(res.ok).toBe(true);
    const data = (await res.json()) as { access_token: string };
    return data.access_token;
  }

  // Helper — POST to /ingest with the given Authorization + Content-Type.
  async function postIngest(
    token: string | null,
    contentType: string,
    body: string | Uint8Array,
    extraHeaders: Record<string, string> = {},
  ): Promise<Response> {
    const headers: Record<string, string> = {
      'Content-Type': contentType,
      ...extraHeaders,
    };
    if (token !== null) headers.Authorization = `Bearer ${token}`;
    return fetch(`${BASE}/ingest`, {
      method: 'POST',
      headers,
      body: body as BodyInit,
    });
  }

  // =========================================================================
  // Auth gate
  // =========================================================================

  test('missing Authorization header → 401 (route is OAuth-gated)', async () => {
    const res = await postIngest(null, 'text/markdown', '# unauth attempt');
    expect(res.status).toBe(401);
  });

  test('read-only token → 403 (route requires write scope)', async () => {
    const readToken = await mintToken('read');
    const res = await postIngest(readToken, 'text/markdown', '# read-only attempt');
    // Spec: requireBearerAuth with requiredScopes=['write'] returns 403
    // when the bearer scope set lacks write. SDK may return 401 or 403
    // depending on version; either is a refusal.
    expect([401, 403]).toContain(res.status);
    const body = await res.text();
    // Successful ingest would carry job_id; failure must not.
    expect(body).not.toMatch(/"job_id"\s*:\s*"?\d+/);
  });

  test('valid write-scope token accepts text/markdown → 200/202 with job_id', async () => {
    const token = await mintToken('read write');
    const res = await postIngest(
      token,
      'text/markdown',
      `# webhook happy path\n\nIngested at ${new Date().toISOString()}`,
    );
    expect([200, 202]).toContain(res.status);
    const body = (await res.json()) as { job_id?: number | string; ok?: boolean };
    expect(body.job_id).toBeDefined();
  });

  // =========================================================================
  // Body validation
  // =========================================================================

  test('empty body → 400 with error: empty_body', async () => {
    const token = await mintToken('read write');
    const res = await postIngest(token, 'text/markdown', '');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string; message?: string };
    expect(body.error).toBe('empty_body');
    expect(body.message?.toLowerCase()).toContain('non-empty');
  });

  // v0.39.3.0 BUG-2 regression: when express.raw() doesn't populate req.body
  // (no Content-Length / no body / specific middleware-chain conditions),
  // req.body is `undefined`. The pre-fix code's `else` branch fell through
  // to `Buffer.from(JSON.stringify(undefined), 'utf8')` — and
  // `JSON.stringify(undefined) === undefined` (literal), so Buffer.from
  // threw TypeError and the route returned an HTML 500 page instead of a
  // JSON envelope. The null-guard at the top of the handler now catches
  // this case and returns 400 `empty_body` like the empty-Buffer case.
  test('BUG-2: POST with no body (undefined req.body) → 400 JSON envelope (not 500 HTML)', async () => {
    const token = await mintToken('read write');
    // fetch with no `body:` field sends a request with no body bytes.
    // Combined with no Content-Length, this is the exact shape that
    // triggered the v0.38.0.0 TypeError.
    const res = await fetch(`${BASE}/ingest`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'text/markdown',
      },
    });
    // Must NOT be 500 (the pre-fix behavior).
    expect(res.status).not.toBe(500);
    // Must be a JSON 400 with the documented error shape.
    expect(res.status).toBe(400);
    const ct = res.headers.get('content-type') ?? '';
    expect(ct).toContain('application/json');
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('empty_body');
  });

  // =========================================================================
  // Content-type allowlist (the v0.38 webhook taxonomy)
  // =========================================================================

  test('binary image/png → 415 with paste-ready processor-skillpack hint', async () => {
    const token = await mintToken('read write');
    // PNG magic bytes — a real (tiny) PNG header
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    ]);
    const res = await postIngest(token, 'image/png', png);
    expect(res.status).toBe(415);
    const body = (await res.json()) as { error?: string; message?: string };
    expect(body.error).toBe('unsupported_content_type');
    // The hint should mention the path forward (skillpack processor).
    expect(body.message?.toLowerCase()).toMatch(/skillpack|processor|not yet supported/);
  });

  test('application/pdf → 415 (binary processor deferred)', async () => {
    const token = await mintToken('read write');
    const pdfMagic = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF
    const res = await postIngest(token, 'application/pdf', pdfMagic);
    expect(res.status).toBe(415);
  });

  test('text/plain accepted (in the v1 allowlist)', async () => {
    const token = await mintToken('read write');
    const res = await postIngest(
      token,
      'text/plain',
      `plain text webhook ${Date.now()}`,
    );
    expect([200, 202]).toContain(res.status);
    const body = (await res.json()) as { job_id?: number | string };
    expect(body.job_id).toBeDefined();
  });

  test('application/json accepted (in the v1 allowlist)', async () => {
    const token = await mintToken('read write');
    const res = await postIngest(
      token,
      'application/json',
      JSON.stringify({ kind: 'webhook-event', when: Date.now() }),
    );
    expect([200, 202]).toContain(res.status);
  });

  test('text/html accepted (in the v1 allowlist)', async () => {
    const token = await mintToken('read write');
    const res = await postIngest(
      token,
      'text/html',
      `<p>html webhook ${Date.now()}</p>`,
    );
    expect([200, 202]).toContain(res.status);
  });

  test('unknown text/* sub-type passes through as text/plain', async () => {
    const token = await mintToken('read write');
    const res = await postIngest(token, 'text/x-custom', 'unknown text variant');
    // The route maps unknown text/* to text/plain rather than 415.
    expect([200, 202]).toContain(res.status);
  });

  test('X-Gbrain-Content-Type header overrides request Content-Type', async () => {
    const token = await mintToken('read write');
    // Send as application/octet-stream (would 415) but override to text/markdown.
    const res = await postIngest(
      token,
      'application/octet-stream',
      '# override via header',
      { 'X-Gbrain-Content-Type': 'text/markdown' },
    );
    // With override: route should accept as markdown.
    expect([200, 202]).toContain(res.status);
  });

  // =========================================================================
  // Header overrides
  // =========================================================================

  test('X-Gbrain-Slug header is accepted (job receives the slug hint)', async () => {
    const token = await mintToken('read write');
    const slug = `webhook/test/header-${Date.now()}`;
    const res = await postIngest(
      token,
      'text/markdown',
      '# slug header test',
      { 'X-Gbrain-Slug': slug },
    );
    expect([200, 202]).toContain(res.status);
    // The route should accept the header without rejecting — actual slug
    // application happens inside the ingest_capture handler (covered by
    // test/ingestion/ingest-capture.test.ts).
  });

  test('X-Gbrain-Source-Id header is accepted', async () => {
    const token = await mintToken('read write');
    const res = await postIngest(
      token,
      'text/markdown',
      '# source-id header test',
      { 'X-Gbrain-Source-Id': 'zapier-webhook' },
    );
    expect([200, 202]).toContain(res.status);
  });

  test('X-Gbrain-Source-Uri header is accepted', async () => {
    const token = await mintToken('read write');
    const res = await postIngest(
      token,
      'text/markdown',
      '# source-uri header test',
      { 'X-Gbrain-Source-Uri': 'https://example.com/issue/123' },
    );
    expect([200, 202]).toContain(res.status);
  });

  // =========================================================================
  // Idempotency
  // =========================================================================

  test('same content from same client → identical job_id (queue dedup on content_hash)', async () => {
    const token = await mintToken('read write');
    const content = `# idempotency test ${Math.random()}`;
    const first = await postIngest(token, 'text/markdown', content);
    expect([200, 202]).toContain(first.status);
    const firstBody = (await first.json()) as { job_id?: number | string };

    const second = await postIngest(token, 'text/markdown', content);
    expect([200, 202]).toContain(second.status);
    const secondBody = (await second.json()) as { job_id?: number | string };

    // Queue idempotency_key: `ingest:webhook:${clientId}:${contentHash}` —
    // same input, same key, MinionQueue.add returns the existing job.
    expect(secondBody.job_id).toBe(firstBody.job_id!);
  });

  test('different content from same client → different job_id', async () => {
    const token = await mintToken('read write');
    const first = await postIngest(
      token,
      'text/markdown',
      `# distinct A ${Date.now()}`,
    );
    const second = await postIngest(
      token,
      'text/markdown',
      `# distinct B ${Date.now()}`,
    );
    const firstBody = (await first.json()) as { job_id?: number | string };
    const secondBody = (await second.json()) as { job_id?: number | string };
    expect(firstBody.job_id).toBeDefined();
    expect(secondBody.job_id).toBeDefined();
    expect(secondBody.job_id).not.toBe(firstBody.job_id);
  });
});
