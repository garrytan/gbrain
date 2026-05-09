/**
 * E2E: default HTTP access-tier enforcement gates a Work-tier OAuth client
 * at the MCP dispatch layer.
 *
 * Boots `gbrain serve --http` against real Postgres,
 * registers two OAuth clients (one Full, one Work), seeds a `personal/`
 * page and a `people/` page via the Full client, then asserts that the
 * Work client gets `page_not_found` on the personal slug and an empty
 * `resolve_slugs("personal")` enumeration. Regression test for the inert
 * filters that earlier versions of access-tier.ts shipped against
 * get_chunks / find_orphans / resolve_slugs.
 *
 * Run: DATABASE_URL=... bun test test/e2e/access-tier-enforce.test.ts
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';

const skip = !hasDatabase();
const describeE2E = skip ? describe.skip : describe;

if (skip) {
  console.log('Skipping E2E access-tier-enforce tests (DATABASE_URL not set)');
}

const PORT = 19132;
const BASE = `http://localhost:${PORT}`;

describeE2E('serve-http default access-tier enforcement (runtime MCP access control)', () => {
  let serverProcess: ReturnType<typeof import('child_process').spawn> | null = null;
  let fullClientId: string | undefined;
  let fullClientSecret: string | undefined;
  let workClientId: string | undefined;
  let workClientSecret: string | undefined;

  beforeAll(async () => {
    const { execSync, spawn } = await import('child_process');
    const env = { ...process.env };

    await setupDB();

    // Full-tier admin client (default tier when --tier omitted is Full).
    const fullOut = execSync(
      'bun run src/cli.ts auth register-client e2e-tier-full --grant-types client_credentials --scopes "read write admin"',
      { cwd: process.cwd(), encoding: 'utf8', env }
    );
    fullClientId = fullOut.match(/Client ID:\s+(gbrain_cl_\S+)/)?.[1];
    fullClientSecret = fullOut.match(/Client Secret:\s+(gbrain_cs_\S+)/)?.[1];
    if (!fullClientId || !fullClientSecret) throw new Error('register Full client failed:\n' + fullOut);

    // Work-tier client. The --tier flag is what this test actually exercises;
    // a Work client must not see slugs outside the visible prefix set.
    const workOut = execSync(
      'bun run src/cli.ts auth register-client e2e-tier-work --grant-types client_credentials --scopes "read write" --tier Work',
      { cwd: process.cwd(), encoding: 'utf8', env }
    );
    workClientId = workOut.match(/Client ID:\s+(gbrain_cl_\S+)/)?.[1];
    workClientSecret = workOut.match(/Client Secret:\s+(gbrain_cs_\S+)/)?.[1];
    if (!workClientId || !workClientSecret) throw new Error('register Work client failed:\n' + workOut);

    serverProcess = spawn('bun', [
      'run', 'src/cli.ts', 'serve', '--http',
      '--port', String(PORT),
      '--public-url', `http://localhost:${PORT}`,
    ], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    serverProcess.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });

    let ready = false;
    for (let i = 0; i < 30; i++) {
      try {
        const res = await fetch(`${BASE}/health`);
        if (res.ok) { ready = true; break; }
      } catch {}
      await new Promise(r => setTimeout(r, 500));
    }
    if (!ready) throw new Error('Server failed to start within 15s.\nstderr: ' + stderr.slice(-500));

    // Seed pages via the Full-tier client. put_page is mutating, so it needs
    // write scope; a personal/diary slug is what the Work client must NOT see.
    const fullToken = await mintToken(fullClientId, fullClientSecret, 'read write admin');
    await mcpToolCall(fullToken, 'put_page', {
      slug: 'personal/diary',
      content: '---\ntitle: Diary\n---\nprivate diary entry',
    });
    await mcpToolCall(fullToken, 'put_page', {
      slug: 'people/alice',
      content: '---\ntitle: Alice\n---\nAlice is a person',
    });
  }, 45_000);

  afterAll(async () => {
    if (serverProcess) {
      serverProcess.kill('SIGTERM');
      await new Promise(r => setTimeout(r, 1000));
      if (!serverProcess.killed) serverProcess.kill('SIGKILL');
    }
    const { execSync } = await import('child_process');
    for (const id of [fullClientId, workClientId].filter(Boolean) as string[]) {
      try {
        execSync(`bun run src/cli.ts auth revoke-client "${id}"`,
          { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env } });
      } catch (e: any) {
        // eslint-disable-next-line no-console
        console.error(`[afterAll] revoke-client cleanup failed for ${id}: ${e.message}`);
      }
    }
    await teardownDB();
  });

  async function mintToken(id: string, secret: string, scope: string): Promise<string> {
    const res = await fetch(`${BASE}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=client_credentials&client_id=${id}&client_secret=${secret}&scope=${encodeURIComponent(scope)}`,
    });
    if (!res.ok) throw new Error(`mintToken failed: ${res.status} ${await res.text()}`);
    const data = await res.json() as { access_token: string };
    return data.access_token;
  }

  async function mcpToolCall(token: string, name: string, args: unknown): Promise<any> {
    const res = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Math.floor(Math.random() * 1e9),
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    });
    const text = await res.text();
    // SSE-or-JSON envelope; parse data: lines if SSE.
    if (text.includes('event:') || text.startsWith('event:')) {
      for (const line of text.split('\n')) {
        if (line.startsWith('data:')) {
          try {
            const data = JSON.parse(line.slice(5));
            if (data.result) return data.result;
            if (data.error) return data;
          } catch {}
        }
      }
    }
    try { return JSON.parse(text); } catch { return text; }
  }

  function unwrapToolText(result: any): any {
    // tools/call response shape: { content: [{type:'text', text: <JSON-string>}], isError?: bool }
    const inner = result?.result ?? result;
    const t = inner?.content?.[0]?.text;
    if (typeof t !== 'string') return inner;
    try { return JSON.parse(t); } catch { return t; }
  }

  test('Work-tier client: get_page on personal/ returns page_not_found', async () => {
    const token = await mintToken(workClientId!, workClientSecret!, 'read');
    const result = await mcpToolCall(token, 'get_page', { slug: 'personal/diary' });
    const inner = result?.result ?? result;
    // Filter throws OperationError so isError is set on the envelope.
    expect(inner?.isError).toBe(true);
    const body = unwrapToolText(result);
    // The wire shape is the same as a real engine not-found.
    expect(JSON.stringify(body)).toMatch(/page_not_found/);
  });

  test('Work-tier client: get_page on people/ returns the page', async () => {
    const token = await mintToken(workClientId!, workClientSecret!, 'read');
    const result = await mcpToolCall(token, 'get_page', { slug: 'people/alice' });
    const inner = result?.result ?? result;
    expect(inner?.isError).toBeFalsy();
    const body = unwrapToolText(result);
    expect(body?.slug).toBe('people/alice');
  });

  test('Work-tier client: list_pages drops personal/ slugs', async () => {
    const token = await mintToken(workClientId!, workClientSecret!, 'read');
    const result = await mcpToolCall(token, 'list_pages', {});
    const body = unwrapToolText(result);
    expect(Array.isArray(body)).toBe(true);
    const slugs = (body as Array<{ slug: string }>).map(r => r.slug);
    expect(slugs).toContain('people/alice');
    expect(slugs.find(s => s.startsWith('personal/'))).toBeUndefined();
  });

  test('Work-tier client: resolve_slugs("personal") returns empty array', async () => {
    // Slug-existence probe defense. Pre-fix, resolve_slugs returned bare
    // strings which the response filter no-op'd on, leaking the full
    // personal/ namespace to any Work-tier caller.
    const token = await mintToken(workClientId!, workClientSecret!, 'read');
    const result = await mcpToolCall(token, 'resolve_slugs', { partial: 'personal' });
    const body = unwrapToolText(result);
    expect(Array.isArray(body)).toBe(true);
    expect(body).toEqual([]);
  });

  test('Work-tier client: get_chunks on personal/ returns empty array', async () => {
    // Input-side gate (chunks rows have no slug, so response-side filter
    // is structurally inert). Hidden and absent slugs both return [] to
    // avoid an existence oracle.
    const token = await mintToken(workClientId!, workClientSecret!, 'read');
    const result = await mcpToolCall(token, 'get_chunks', { slug: 'personal/diary' });
    const inner = result?.result ?? result;
    expect(inner?.isError).toBeFalsy();
    const body = unwrapToolText(result);
    expect(body).toEqual([]);
  });

  test('Full-tier client: get_page on personal/ returns the page (control)', async () => {
    // Sanity: the page exists and is readable; the Work-tier 404 above is
    // about visibility, not absence.
    const token = await mintToken(fullClientId!, fullClientSecret!, 'read');
    const result = await mcpToolCall(token, 'get_page', { slug: 'personal/diary' });
    const inner = result?.result ?? result;
    expect(inner?.isError).toBeFalsy();
    const body = unwrapToolText(result);
    expect(body?.slug).toBe('personal/diary');
  });
});
