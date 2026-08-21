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
 *      cannot override the OAuth client's trusted write source
 *   6. Idempotency: same content + same client → job_id returned twice
 *      should match (queue dedup on (client_id, write_source_id, content_hash))
 *
 * Mirrors the spawn + mint pattern from test/e2e/serve-http-oauth.test.ts
 * exactly so future maintainers see one pattern, not two.
 *
 * Run: GBRAIN_DATABASE_URL=... bun test test/e2e/serve-http-ingest-webhook.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execSync } from 'child_process';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { assertSafeE2eDatabaseUrl, hasDatabase } from './helpers.ts';

const skip = !hasDatabase();
const describeE2E = skip ? describe.skip : describe;

if (skip) {
  console.log('Skipping E2E serve-http-ingest-webhook tests (DATABASE_URL not set)');
}

const PORT = 19138; // Distinct from sibling E2Es to avoid collision
const BASE = `http://localhost:${PORT}`;

describeE2E('serve-http POST /ingest webhook (v0.38)', () => {
  let serverProcess: ReturnType<typeof import('child_process').spawn> | null = null;
  let workerProcess: ReturnType<typeof import('child_process').spawn> | null = null;
  let queryEngine: PostgresEngine | null = null;
  let clientId: string | undefined;
  let clientSecret: string | undefined;
  let scopedClient: { clientId: string; clientSecret: string } | undefined;
  let archivedClient: { clientId: string; clientSecret: string } | undefined;
  const registeredClientIds: string[] = [];
  const liveSourceId = 'e2e-webhook-live';
  const archivedSourceId = 'e2e-webhook-archived';
  const rescopeTargetSourceId = 'e2e-webhook-rescope-target';
  const fixtureSourceIds = [liveSourceId, archivedSourceId, rescopeTargetSourceId];

  // Hoisted out of beforeAll so the rescope test can register its own client
  // mid-run (it needs a client it is free to move between sources).
  function registerClientForRescope(name: string, sourceId?: string): { clientId: string; clientSecret: string } {
    const sourceArg = sourceId ? ` --source "${sourceId}"` : '';
    const regOutput = execSync(
      `bun run src/cli.ts auth register-client "${name}" --grant-types client_credentials --scopes "read write"${sourceArg}`,
      { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env } },
    );
    const idMatch = regOutput.match(/Client ID:\s+(gbrain_cl_\S+)/);
    const secretMatch = regOutput.match(/Client Secret:\s+(gbrain_cs_\S+)/);
    if (!idMatch || !secretMatch) {
      throw new Error('Failed to register webhook test client:\n' + regOutput);
    }
    registeredClientIds.push(idMatch[1]);
    return { clientId: idMatch[1], clientSecret: secretMatch[1] };
  }

  beforeAll(async () => {
    const { spawn } = await import('child_process');

    // This file connects a PostgresEngine to the ambient DATABASE_URL and runs
    // destructive SQL (initSchema, plus the afterAll fixture cleanup) without
    // going through setupDB(), so it calls the production guard itself.
    assertSafeE2eDatabaseUrl(process.env.DATABASE_URL!);
    queryEngine = new PostgresEngine();
    await queryEngine.connect({ database_url: process.env.DATABASE_URL! });
    await queryEngine.initSchema();
    await queryEngine.executeRaw(
      `INSERT INTO sources (id, name, archived)
       VALUES ($1, $1, false), ($2, $2, true), ($3, $3, false)
       ON CONFLICT (id) DO UPDATE
       SET name = EXCLUDED.name, archived = EXCLUDED.archived`,
      [liveSourceId, archivedSourceId, rescopeTargetSourceId],
    );

    const registerClient = registerClientForRescope;

    // Register unscoped, live-source-scoped, and archived-source-scoped clients.
    // The write scope is what POST /ingest gates on.
    const suffix = Date.now();
    const defaultClient = registerClient(`e2e-webhook-default-${suffix}`);
    clientId = defaultClient.clientId;
    clientSecret = defaultClient.clientSecret;
    scopedClient = registerClient(`e2e-webhook-scoped-${suffix}`, liveSourceId);
    archivedClient = registerClient(`e2e-webhook-archived-${suffix}`, archivedSourceId);

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

    workerProcess = spawn(
      'bun',
      ['run', 'src/cli.ts', 'jobs', 'work', '--concurrency', '1'],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          DATABASE_URL: process.env.DATABASE_URL ?? '',
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    );
    let workerStderr = '';
    workerProcess.stderr?.on('data', (d: Buffer) => {
      workerStderr += d.toString();
    });
    await new Promise(r => setTimeout(r, 1000));
    if (workerProcess.exitCode !== null) {
      throw new Error(`Webhook E2E worker exited during startup: ${workerStderr.slice(-500)}`);
    }
  }, 30_000);

  afterAll(async () => {
    if (serverProcess) {
      serverProcess.kill('SIGTERM');
      await new Promise(r => setTimeout(r, 1000));
      if (!serverProcess.killed) serverProcess.kill('SIGKILL');
    }
    if (workerProcess && workerProcess.exitCode === null) {
      workerProcess.kill('SIGTERM');
      await new Promise(r => setTimeout(r, 1000));
      if (workerProcess.exitCode === null) workerProcess.kill('SIGKILL');
    }
    for (const registeredClientId of registeredClientIds) {
      try {
        const { execSync } = await import('child_process');
        execSync(`bun run src/cli.ts auth revoke-client "${registeredClientId}"`, {
          cwd: process.cwd(),
          encoding: 'utf8',
          env: { ...process.env },
        });
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error(`[afterAll] revoke-client cleanup failed: ${(e as Error).message}`);
      }
    }
    // Fixture rows live in the shared DATABASE_URL brain, so leaving them
    // behind leaks into every other e2e suite (one of them is permanently
    // archived) and into later runs of this file. Pages first: the scoped ones
    // would cascade with their source, but the default-source ones would not.
    try {
      await queryEngine?.executeRaw(`DELETE FROM pages WHERE slug LIKE 'webhook/test/%'`);
      await queryEngine?.executeRaw(`DELETE FROM sources WHERE id = ANY($1::text[])`, [fixtureSourceIds]);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`[afterAll] fixture cleanup failed: ${(e as Error).message}`);
    }
    await queryEngine?.disconnect();
  }, 30_000);

  // Helper — mint a token with a specific scope subset.
  async function mintToken(
    scope = 'read write',
    credentials?: { clientId: string; clientSecret: string },
  ): Promise<string> {
    const tokenClientId = credentials?.clientId ?? clientId;
    const tokenClientSecret = credentials?.clientSecret ?? clientSecret;
    const res = await fetch(`${BASE}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=client_credentials&client_id=${tokenClientId}&client_secret=${tokenClientSecret}&scope=${encodeURIComponent(scope)}`,
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

  async function waitForPage(
    slug: string,
    timeoutMs = 15_000,
  ): Promise<{ source_id: string; source_kind: string | null; source_uri: string | null; ingested_via: string | null }> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const rows = await queryEngine!.executeRaw<{
        source_id: string;
        source_kind: string | null;
        source_uri: string | null;
        ingested_via: string | null;
      }>(
        `SELECT source_id, source_kind, source_uri, ingested_via
         FROM pages WHERE slug = $1`,
        [slug],
      );
      if (rows[0]) return rows[0];
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error(`Timed out waiting for ingested page '${slug}'`);
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

  test('X-Gbrain-Source-Id header is accepted but non-authoritative', async () => {
    const token = await mintToken('read write', scopedClient);
    const slug = `webhook/test/header-source-${Date.now()}`;
    const res = await postIngest(
      token,
      'text/markdown',
      '# source-id header test',
      {
        'X-Gbrain-Slug': slug,
        'X-Gbrain-Source-Id': 'other',
      },
    );
    expect([200, 202]).toContain(res.status);
    expect((await waitForPage(slug)).source_id).toBe(liveSourceId);
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
  // Trusted OAuth write-source attribution
  // =========================================================================

  test('source-scoped client writes the page under its trusted source', async () => {
    const token = await mintToken('read write', scopedClient);
    const slug = `webhook/test/scoped-${Date.now()}`;
    const sourceUri = `https://example.com/scoped/${Date.now()}`;
    const res = await postIngest(
      token,
      'text/markdown',
      '# scoped OAuth source',
      {
        'X-Gbrain-Slug': slug,
        'X-Gbrain-Source-Uri': sourceUri,
      },
    );
    expect([200, 202]).toContain(res.status);

    // The 202 names the routed destination in `write_source_id`; the legacy
    // `source_id` field stays the EMITTER identity for back-compat. Asserting
    // both pins the split — collapsing them would silently break either the
    // new routing contract or the old field's meaning.
    const body = (await res.json()) as { source_id: string; write_source_id: string };
    expect(body.write_source_id).toBe(liveSourceId);
    expect(body.source_id).toMatch(/^webhook-gbrain_cl_/);

    const page = await waitForPage(slug);
    expect(page.source_id).toBe(liveSourceId);
    expect(page.source_kind).toBe('webhook');
    expect(page.source_uri).toBe(sourceUri);
    expect(page.ingested_via).toBe('ingest_capture');
  });

  test('unscoped client writes under default', async () => {
    const token = await mintToken('read write');
    const slug = `webhook/test/default-${Date.now()}`;
    const res = await postIngest(
      token,
      'text/markdown',
      '# unscoped OAuth source',
      { 'X-Gbrain-Slug': slug },
    );
    expect([200, 202]).toContain(res.status);
    expect(((await res.json()) as { write_source_id: string }).write_source_id).toBe('default');
    expect((await waitForPage(slug)).source_id).toBe('default');
  });

  test('archived-source client falls back to default', async () => {
    const token = await mintToken('read write', archivedClient);
    const slug = `webhook/test/archived-${Date.now()}`;
    const res = await postIngest(
      token,
      'text/markdown',
      '# archived OAuth source',
      { 'X-Gbrain-Slug': slug },
    );
    expect([200, 202]).toContain(res.status);
    // Enqueue-time intent is the client's scoped source; the archived-source
    // redirect happens later, in the job. The 202 therefore still names the
    // requested source while the page lands under default.
    expect(((await res.json()) as { write_source_id: string }).write_source_id).toBe(archivedSourceId);
    expect((await waitForPage(slug)).source_id).toBe('default');
  });

  test('an unscoped client cannot opt into a real source via X-Gbrain-Source-Id', async () => {
    // Sharper than the header test above: the header names a genuinely
    // REGISTERED, LIVE source the caller was never granted. If the header ever
    // regains routing power, this is the privilege escalation it buys.
    const token = await mintToken('read write');
    const slug = `webhook/test/header-escalation-${Date.now()}`;
    const res = await postIngest(
      token,
      'text/markdown',
      '# header escalation attempt',
      { 'X-Gbrain-Slug': slug, 'X-Gbrain-Source-Id': liveSourceId },
    );
    expect([200, 202]).toContain(res.status);
    expect(((await res.json()) as { write_source_id: string }).write_source_id).toBe('default');
    expect((await waitForPage(slug)).source_id).toBe('default');
  });

  test('rescoping a client makes identical content land a NEW capture', async () => {
    // The write source is part of the queue idempotency key. Without it, a
    // client moved from source X to source Y would be deduped against its old
    // X-bound job and its first post-rescope capture would never reach Y.
    const rescoped = registerClientForRescope(`e2e-webhook-rescope-${Date.now()}`, liveSourceId);
    const content = `# rescope dedup ${Date.now()}`;
    const slugA = `webhook/test/rescope-a-${Date.now()}`;

    const first = await postIngest(
      await mintToken('read write', rescoped),
      'text/markdown',
      content,
      { 'X-Gbrain-Slug': slugA },
    );
    expect([200, 202]).toContain(first.status);
    const firstBody = (await first.json()) as { job_id: number | string; write_source_id: string };
    expect(firstBody.write_source_id).toBe(liveSourceId);
    expect((await waitForPage(slugA)).source_id).toBe(liveSourceId);

    execSync(
      `bun run src/cli.ts auth rescope-client "${rescoped.clientId}" --source "${rescopeTargetSourceId}"`,
      { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env } },
    );

    const slugB = `webhook/test/rescope-b-${Date.now()}`;
    const second = await postIngest(
      await mintToken('read write', rescoped),
      'text/markdown',
      content,
      { 'X-Gbrain-Slug': slugB },
    );
    expect([200, 202]).toContain(second.status);
    const secondBody = (await second.json()) as { job_id: number | string; write_source_id: string };

    expect(secondBody.job_id).not.toBe(firstBody.job_id);
    expect(secondBody.write_source_id).toBe(rescopeTargetSourceId);
    expect((await waitForPage(slugB)).source_id).toBe(rescopeTargetSourceId);
  }, 40_000);

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

    // Queue idempotency_key:
    // `ingest:webhook:${clientId}:${writeSourceId}:${contentHash}` — same input
    // and same write source, same key, MinionQueue.add returns the existing job.
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
