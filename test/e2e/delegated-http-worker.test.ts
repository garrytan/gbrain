import { expect, test } from 'bun:test';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createEngine } from '../../src/core/engine-factory.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { assertSafeE2eDatabaseUrl } from '../helpers/db-guard.ts';
import { keylessBrainEnv } from '../helpers/provider-env.ts';
import { withEnv } from '../helpers/with-env.ts';

const databaseUrl = process.env.DATABASE_URL;

// This proves the deployed HTTP -> queue -> real CLI worker path with a local
// provider fixture. It makes no claim about a native harness or live provider.
(databaseUrl ? test : test.skip)('HTTP delegation completes in a real worker with a bound tool and attributed spend', async () => {
  assertSafeE2eDatabaseUrl(databaseUrl!);
  const root = mkdtempSync(join(tmpdir(), 'gbrain-http-worker-'));
  const seed = randomBytes(8).toString('hex');
  const queue = `http-worker-${seed}`;
  const slug = `notes/worker-${seed}`;
  const foreignSource = `foreign-${seed}`;
  const privateSlug = `notes/private-${seed}`;
  const pageChallenge = `page-proof-${randomBytes(16).toString('hex')}`;
  const finalChallenge = `finished-${randomBytes(16).toString('hex')}`;
  const hiddenChallenge = `hidden-proof-${randomBytes(16).toString('hex')}`;
  const fixtureKey = `fixture-provider-${seed}`;
  const adminToken = `fixture-admin-${randomBytes(24).toString('hex')}`;
  const cfg = { engine: 'postgres' as const, database_url: databaseUrl! };
  const cli = resolve(import.meta.dir, '../../src/cli.ts');
  const children: { child: ReturnType<typeof Bun.spawn>; stderr: Promise<string> }[] = [];
  const requests: Record<string, any>[] = [];
  const providerErrors: string[] = [];
  let client: Client | undefined;
  let clientId: string | undefined;
  let jobId: number | undefined;
  let engine: Awaited<ReturnType<typeof createEngine>> | undefined;
  const provider = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    try {
      if (new URL(request.url).pathname !== '/v1/messages' || request.method !== 'POST') throw new Error('Unexpected provider route');
      if (request.headers.get('x-api-key') !== fixtureKey) throw new Error('Unexpected provider credential');
      const body = await request.json() as Record<string, any>;
      requests.push(body);
      if (body.model !== 'claude-sonnet-4-6') throw new Error('Unexpected provider model');
      if (JSON.stringify(body.tools.map((tool: any) => tool.name)) !== JSON.stringify(['brain_get_page'])) throw new Error('Delegated tool list widened');
      if (requests.length > 2) throw new Error('Unexpected extra provider invocation');
      if (requests.length === 2 && !JSON.stringify(body.messages).includes(pageChallenge)) throw new Error('Real page tool result was not returned to provider');
      if (requests.length === 2 && JSON.stringify(body.messages).includes(hiddenChallenge)) throw new Error('Private or foreign page reached provider');
      if (requests.length === 2 && !JSON.stringify(body.messages).includes('outside your granted sources')) throw new Error('Foreign source override was not refused');
      return Response.json({
        id: `msg-${seed}-${requests.length}`, type: 'message', role: 'assistant', model: body.model,
        content: requests.length === 1
          ? [
              { type: 'tool_use', id: `tool-${seed}`, name: 'brain_get_page', input: { slug } },
              { type: 'tool_use', id: `foreign-${seed}`, name: 'brain_get_page', input: { slug, source_id: foreignSource } },
              { type: 'tool_use', id: `private-${seed}`, name: 'brain_get_page', input: { slug: privateSlug } },
            ]
          : [{ type: 'text', text: finalChallenge }],
        stop_reason: requests.length === 1 ? 'tool_use' : 'end_turn', stop_sequence: null,
        usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      });
    } catch (error) {
      providerErrors.push(String(error));
      return Response.json({ type: 'error', error: { type: 'invalid_request_error', message: 'Local provider fixture rejected request' } }, { status: 400 });
    }
  } });
  try {
    mkdirSync(join(root, '.gbrain'), { mode: 0o700 });
    writeFileSync(join(root, '.gbrain', 'config.json'), JSON.stringify({ ...cfg, embedding_disabled: true }), { mode: 0o600 });
    await withEnv({ GBRAIN_HOME: root, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      engine = await createEngine(cfg); await engine.connect(cfg); await engine.initSchema();
      await importFromContent(engine, slug, `---\ntitle: Worker fixture\ntype: note\n---\n${pageChallenge}`, { noEmbed: true, sourceId: 'default' });
      await engine.executeRaw('INSERT INTO sources(id,name) VALUES ($1,$1)', [foreignSource]);
      await importFromContent(engine, slug, `---\ntitle: Foreign fixture\ntype: note\n---\n${hiddenChallenge}`, { noEmbed: true, sourceId: foreignSource });
      await importFromContent(engine, privateSlug, `---\ntitle: Private fixture\ntype: note\nvisibility: private\n---\n${hiddenChallenge}`, { noEmbed: true, sourceId: 'default' });
    });
    const probe = createServer(); probe.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => probe.once('listening', resolve));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>(resolve => probe.close(() => resolve()));
    const base = `http://127.0.0.1:${port}`;
    const env = keylessBrainEnv(process.env, root, {
      DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_ENGINE: undefined,
      GBRAIN_BRAIN_ID: undefined, GBRAIN_SOURCE: undefined, GBRAIN_REMOTE_CLIENT_SECRET: undefined,
      GBRAIN_SKIP_STARTUP_HOOKS: '1', GBRAIN_ADMIN_BOOTSTRAP_TOKEN: adminToken,
    });
    const spawn = (args: string[], childEnv = env) => {
      const child = Bun.spawn({ cmd: [process.execPath, '--no-env-file', cli, ...args], env: childEnv, stdin: 'ignore', stdout: 'ignore', stderr: 'pipe' });
      const entry = { child, stderr: new Response(child.stderr as ReadableStream).text() };
      children.push(entry); return entry;
    };
    const http = spawn(['serve', '--http', '--port', String(port), '--public-url', base]);
    let ready = false;
    for (let i = 0; i < 150; i++) {
      try { if ((await fetch(`${base}/health`, { signal: AbortSignal.timeout(500) })).ok) { ready = true; break; } } catch {}
      if (http.child.exitCode !== null) throw new Error(`HTTP server exited: ${(await http.stderr).slice(-3000)}`);
      await Bun.sleep(100);
    }
    expect(ready).toBe(true);
    const login = await fetch(`${base}/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: adminToken }) });
    expect(login.status).toBe(200);
    const cookie = login.headers.get('set-cookie')!.match(/gbrain_admin=[^;]+/)![0];
    const grantResponse = await fetch(`${base}/admin/api/grants`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ name: queue, harness: 'generic', profile: 'delegating-agent', url: `${base}/mcp`, patch: { boundTools: ['get_page'] } }),
    });
    expect(grantResponse.status).toBe(200);
    const { grant, credentials } = await grantResponse.json() as any;
    clientId = grant.clientId;
    if (typeof clientId !== 'string') throw new Error('Grant did not return a client identity');
    expect(grant.boundMaxConcurrent).toBe(1);
    expect(grant.budgetUsdPerDay).toBeNull();
    client = new Client({ name: 'gbrain-worker-fixture', version: '1' }, { capabilities: {} });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${credentials.access_token}` } } }));
    const submitted = await client.callTool({ name: 'submit_agent', arguments: {
      prompt: `Read ${slug} with get_page and return its result.`, model: 'anthropic:claude-sonnet-4-6', queue, max_turns: 2,
    } });
    expect(submitted.isError).not.toBe(true);
    const accepted = JSON.parse((submitted.content as { text: string }[])[0].text);
    jobId = accepted.id ?? accepted.job_id;
    expect(Number.isSafeInteger(jobId)).toBe(true);
    const worker = spawn(['jobs', 'work', '--queue', queue, '--concurrency', '1', '--job-isolation', 'inline', '--max-rss', '0', '--health-interval', '0'], {
      ...env, ANTHROPIC_API_KEY: fixtureKey, ANTHROPIC_BASE_URL: `http://127.0.0.1:${provider.port}`,
    });
    let finished: any;
    for (let i = 0; i < 200; i++) {
      const polled = await client.callTool({ name: 'get_agent_job', arguments: { id: jobId } });
      expect(polled.isError).not.toBe(true);
      finished = JSON.parse((polled.content as { text: string }[])[0].text);
      if (['completed', 'failed', 'dead', 'cancelled'].includes(finished.status)) break;
      if (worker.child.exitCode !== null) throw new Error(`Worker exited: ${(await worker.stderr).slice(-3000)}`);
      await Bun.sleep(100);
    }
    expect(providerErrors).toEqual([]);
    expect(finished.status).toBe('completed');
    expect(finished.result.result).toBe(finalChallenge);
    expect(finished.result.turns_count).toBe(2);
    expect(requests).toHaveLength(2);
    const ledger = await engine!.executeRaw<{ tool_name: string; status: string; output: unknown; error: string }>(
      'SELECT tool_name,status,output,error FROM subagent_tool_executions WHERE job_id=$1', [jobId]);
    expect(ledger).toHaveLength(3);
    expect(ledger.every(row => row.tool_name === 'brain_get_page')).toBe(true);
    expect(ledger.filter(row => row.status === 'complete')).toHaveLength(1);
    expect(ledger.filter(row => row.status === 'failed')).toHaveLength(2);
    expect(JSON.stringify(ledger)).toContain(pageChallenge);
    expect(JSON.stringify(ledger)).not.toContain(hiddenChallenge);
    const holds = await engine!.executeRaw<{ client_id: string; status: string; actual_cents: string }>(
      'SELECT client_id,status,actual_cents FROM mcp_spend_reservations WHERE job_id=$1', [jobId]);
    expect(holds).toHaveLength(2);
    for (const hold of holds) {
      expect(hold.client_id).toBe(clientId); expect(hold.status).toBe('settled'); expect(Number(hold.actual_cents)).toBeGreaterThan(0);
    }
    const spend = await engine!.executeRaw<{ n: number; cents: string }>(
      'SELECT count(*)::int AS n,sum(spend_cents) AS cents FROM mcp_spend_log WHERE client_id=$1', [clientId]);
    expect(spend[0].n).toBe(2);
    expect(Number(spend[0].cents)).toBeCloseTo(holds.reduce((sum, hold) => sum + Number(hold.actual_cents), 0), 4);
  } finally {
    await client?.close().catch(() => {});
    for (const { child, stderr } of children.reverse()) {
      if (child.exitCode === null) child.kill('SIGTERM');
      const killTimer = setTimeout(() => { if (child.exitCode === null) child.kill(9); }, 3000);
      await child.exited; clearTimeout(killTimer); await stderr;
    }
    provider.stop(true);
    if (engine) {
      try {
        await engine.executeRaw('DELETE FROM minion_jobs WHERE queue=$1', [queue]);
        if (clientId) for (const table of ['mcp_spend_reservations', 'mcp_spend_log', 'oauth_clients']) {
          await engine.executeRaw(`DELETE FROM ${table} WHERE client_id=$1`, [clientId]);
        }
        await engine.executeRaw('DELETE FROM pages WHERE slug=ANY($1::text[])', [[slug, privateSlug]]);
        await engine.executeRaw('DELETE FROM sources WHERE id=$1', [foreignSource]);
      } finally { await engine.disconnect(); }
    }
    rmSync(root, { recursive: true, force: true });
  }
});
