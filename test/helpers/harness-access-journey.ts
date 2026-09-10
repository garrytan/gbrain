import { expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer, type AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createEngine } from '../../src/core/engine-factory.ts';
import { verifyHarnessConnection } from '../../src/core/harness/verify.ts';
import { readCredentials } from '../../src/core/harness/credentials.ts';
import { runCli } from './cli-spawn.ts';
import { keylessBrainEnv } from './provider-env.ts';
import { withEnv } from './with-env.ts';
import { assertSafeE2eDatabaseUrl } from './db-guard.ts';

/** Same real CLI/admin/MCP journey on both engines. Temporary private homes,
 * randomized clients, no providers, no production database or native-app claim. */
export async function harnessAccessJourney(databaseUrl?: string) {
  if (databaseUrl) assertSafeE2eDatabaseUrl(databaseUrl);
  const root = mkdtempSync(join(tmpdir(), 'gbrain-harness-http-'));
  const seed = randomBytes(6).toString('hex');
  const name = `harness-${seed}`;
  const adminToken = `fixture-admin-${randomBytes(24).toString('hex')}`;
  const cfg = databaseUrl ? { engine: 'postgres' as const, database_url: databaseUrl }
    : { engine: 'pglite' as const, database_path: join(root, '.gbrain', 'brain.pglite') };
  const probe = createServer(); probe.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => probe.once('listening', resolve));
  const port = (probe.address() as AddressInfo).port; await new Promise<void>(resolve => probe.close(() => resolve()));
  const base = `http://127.0.0.1:${port}`;
  const env = keylessBrainEnv(process.env, root, { DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_REMOTE_CLIENT_SECRET: undefined,
    GBRAIN_BRAIN_ID: undefined, GBRAIN_SOURCE: undefined, GBRAIN_SKIP_STARTUP_HOOKS: '1', GBRAIN_ADMIN_BOOTSTRAP_TOKEN: adminToken });
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let client: Client | undefined;
  let stderr: Promise<string> | undefined;
  const clientIds: string[] = [];
  const blockedIngestClients: string[] = [];
  let legacyIngestClient: string | undefined;
  let ingestRequestsCompleted = false;
  try {
    mkdirSync(join(root, '.gbrain'), { mode: 0o700 });
    writeFileSync(join(root, '.gbrain', 'config.json'), JSON.stringify({ ...cfg, embedding_disabled: true }), { mode: 0o600 });
    await withEnv({ GBRAIN_HOME: root, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      const engine = await createEngine(cfg); await engine.connect(cfg);
      try { await engine.initSchema(); } finally { await engine.disconnect(); }
    });
    child = Bun.spawn({ cmd: [process.execPath, '--no-env-file', resolve(import.meta.dir, '../../src/cli.ts'), 'serve', '--http', '--port', String(port), '--public-url', base], env, stdin: 'ignore', stdout: 'ignore', stderr: 'pipe' });
    stderr = new Response(child.stderr as ReadableStream).text();
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { if ((await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) })).ok) { ready = true; break; } } catch {}
      if (child.exitCode !== null) throw new Error(`Server exited: ${(await stderr).slice(-2500)}`);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    expect(ready).toBe(true);
    const discovery = await (await fetch(`${base}/.well-known/gbrain`)).json() as any;
    expect(JSON.stringify(discovery)).toContain('memory-writer');
    expect(JSON.stringify(discovery)).not.toContain('client_secret');
    const denied = await fetch(`${base}/admin/api/grants`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(denied.status).toBe(401);
    const adminFile = join(root, 'admin-token'); writeFileSync(adminFile, adminToken, { mode: 0o600 });
    const handoff = join(root, 'handoff.json');
    const command = ['mcp', 'grant', name, '--harness', 'grok-bot', '--url', `${base}/mcp`, '--admin-token-file', adminFile, '--credentials-out', handoff, '--json'];
    const granted = await runCli(command, { home: root });
    expect(granted.exitCode).toBe(0);
    if (granted.exitCode !== 0) throw new Error(granted.stdout + granted.stderr);
    const receipt = JSON.parse(granted.stdout);
    const credentials = readCredentials(handoff); clientIds.push(credentials.client_id);
    expect(receipt.grant.profile).toBe('memory-writer');
    expect(receipt.grant.surface).toBe('full');
    expect(granted.stdout).not.toContain(credentials.client_secret!);
    expect(granted.stdout).not.toContain(credentials.access_token!);
    const recoveredFile = join(root, 'recovered.json');
    const recovered = await runCli(['mcp', 'grant', name, '--harness', 'grok-bot', '--url', `${base}/mcp`, '--admin-token-file', adminFile,
      '--resume', '--client', credentials.client_id, '--credentials-out', recoveredFile, '--json'], { home: root });
    expect(recovered.exitCode).toBe(0);
    expect(readCredentials(recoveredFile).client_secret).toBe(credentials.client_secret);
    const duplicate = await runCli([...command.slice(0, -3), '--credentials-out', join(root, 'duplicate.json'), '--json'], { home: root });
    expect(duplicate.exitCode).toBe(1);
    const report = await verifyHarnessConnection(credentials);
    expect(report.stages).toContainEqual({ name: 'authentication', status: 'passed' });
    expect(report.server_status).toBe('passed');
    expect(report.status).toBe('partial');
    expect(report.native_harness.status).toBe('unverified');
    const cliVerified = await runCli(['mcp', 'verify', '--client', credentials.client_id,
      '--harness', 'grok-bot', '--url', credentials.mcp_url, '--credentials-file', handoff, '--json'], { home: root });
    // Successful server probes cannot certify an unobserved native harness.
    expect(cliVerified.exitCode).toBe(2);
    const cliReport = JSON.parse(cliVerified.stdout);
    expect(cliReport.server_status).toBe('passed');
    expect(cliReport.native_harness.status).toBe('unverified');
    expect(cliVerified.stdout).not.toContain(credentials.client_secret!);
    const login = await fetch(`${base}/admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: adminToken }) });
    const cookie = login.headers.get('set-cookie')!.match(/gbrain_admin=[^;]+/)![0];
    const admin = async (body: Record<string, unknown>) => {
      const r = await fetch(`${base}/admin/api/grants`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) });
      return { status: r.status, value: await r.json() as any };
    };
    const ingest = (token: string) => fetch(`${base}/ingest`, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'text/plain' },
      body: `Snapshot admission fixture ${seed}`,
    });
    const empty = await admin({ name: `${name}-empty`, harness: 'generic', profile: 'memory-writer', url: `${base}/mcp`, patch: { allowedOperations: [] } });
    expect(empty.status).toBe(200); clientIds.push(empty.value.grant.clientId);
    for (const credential of [credentials, empty.value.credentials]) {
      blockedIngestClients.push(credential.client_id);
      const deniedIngest = await ingest(credential.access_token);
      expect(deniedIngest.status).toBe(403);
      const deniedBody = await deniedIngest.json() as any;
      expect(deniedBody.error).toBe('permission_denied');
      expect(deniedBody.message).toContain('operation snapshots');
      expect(deniedBody.job_id).toBeUndefined();
    }
    // Legacy NULL operation snapshots retain webhook behavior. This control
    // proves the previous assertions reach authenticated ingestion admission.
    const legacyResponse = await fetch(`${base}/admin/api/register-client`, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ name: `${name}-webhook`, scopes: 'read write' }) });
    expect(legacyResponse.status).toBe(200);
    const legacy = await legacyResponse.json() as any;
    legacyIngestClient = legacy.clientId; clientIds.push(legacy.clientId);
    const tokenResponse = await fetch(`${base}/token`, { method: 'POST',
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: legacy.clientId, client_secret: legacy.clientSecret }) });
    expect(tokenResponse.status).toBe(200);
    const legacyToken = await tokenResponse.json() as any;
    const acceptedIngest = await ingest(legacyToken.access_token);
    expect(acceptedIngest.status).toBe(202);
    expect((await acceptedIngest.json() as any).job_id).toBeDefined();
    ingestRequestsCompleted = true;
    const changed = await admin({ name, clientId: credentials.client_id, expectedRevision: receipt.grant.revision, harness: 'grok-bot', profile: 'memory-reader', url: `${base}/mcp`, patch: { surface: 'verbs' } });
    expect(changed.status).toBe(200);
    // Thin adapters remain full; a native adapter lets the operator select verbs.
    const verbs = await admin({ name, clientId: credentials.client_id, expectedRevision: changed.value.grant.revision, harness: 'generic', profile: 'memory-writer', url: `${base}/mcp`, patch: { surface: 'verbs' } });
    expect(verbs.status).toBe(200);
    client = new Client({ name: 'gbrain-harness-test', version: '1' }, { capabilities: {} });
    await client.connect(new StreamableHTTPClientTransport(new URL(credentials.mcp_url), { requestInit: { headers: { Authorization: `Bearer ${credentials.access_token}` } } }));
    const list = await client.listTools(); expect(list.tools).toHaveLength(7);
    const resource = await client.readResource({ uri: 'gbrain://capabilities' });
    const capability = JSON.parse((resource.contents[0] as { text: string }).text);
    expect(capability.available_operations.sort()).toEqual(list.tools.map(t => t.name).sort());
    const hidden = await client.callTool({ name: 'whoami', arguments: {} }); expect(hidden.isError).toBe(true);
    const stale = await admin({ name, clientId: credentials.client_id, expectedRevision: receipt.grant.revision, harness: 'generic', profile: 'operator', url: `${base}/mcp` });
    expect(stale.status).toBe(409);
    const narrow = await admin({ name, clientId: credentials.client_id, expectedRevision: verbs.value.grant.revision, harness: 'generic', profile: 'memory-reader', url: `${base}/mcp` });
    expect(narrow.status).toBe(200);
    const noWrite = await client.callTool({ name: 'remember', arguments: { fact: 'must not be stored', provenance: 'fixture' } }); expect(noWrite.isError).toBe(true);
    await client.close(); client = undefined;
    const delegated = await admin({ name: `${name}-delegate`, harness: 'generic', profile: 'delegating-agent', url: `${base}/mcp`, patch: { boundTools: ['search'] } });
    expect(delegated.status).toBe(200); clientIds.push(delegated.value.grant.clientId);
    expect(delegated.value.grant.budgetUsdPerDay).toBeNull();
    client = new Client({ name: 'gbrain-delegation-test', version: '1' }, { capabilities: {} });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${delegated.value.credentials.access_token}` } } }));
    const preview = await client.callTool({ name: 'submit_agent', arguments: { prompt: 'Return fixture only', dry_run: true } }); expect(preview.isError).not.toBe(true);
    const attempts = await Promise.all([1, 2, 3].map(i => client!.callTool({ name: 'submit_agent', arguments: { prompt: `Return fixture ${i}` } })));
    expect(attempts.filter(r => !r.isError)).toHaveLength(1);
    const accepted = attempts.find(r => !r.isError)!;
    const job = JSON.parse((accepted.content as { text: string }[])[0].text);
    const cancel = await client.callTool({ name: 'cancel_job', arguments: { id: job.job_id ?? job.id } }); expect(cancel.isError).not.toBe(true);
  } finally {
    await client?.close().catch(() => {});
    if (child) {
      child.kill('SIGTERM');
      const killTimer = setTimeout(() => child!.kill(9), 3000);
      await child.exited; clearTimeout(killTimer); await stderr;
    }
    if (clientIds.length) await withEnv({ GBRAIN_HOME: root }, async () => {
      const engine = await createEngine(cfg); await engine.connect(cfg);
      try {
        if (ingestRequestsCompleted) {
          const blockedJobs = await engine.executeRaw<{ count: number }>("SELECT COUNT(*)::int AS count FROM minion_jobs WHERE data->'event'->'metadata'->>'client_id' = ANY($1::text[])", [blockedIngestClients]);
          expect(blockedJobs[0].count).toBe(0);
          const legacyJobs = await engine.executeRaw<{ count: number }>("SELECT COUNT(*)::int AS count FROM minion_jobs WHERE data->'event'->'metadata'->>'client_id' = $1", [legacyIngestClient]);
          expect(legacyJobs[0].count).toBe(1);
        }
        await engine.executeRaw("DELETE FROM minion_jobs WHERE data->'event'->'metadata'->>'client_id' = ANY($1::text[])", [clientIds]);
        await engine.executeRaw("DELETE FROM minion_jobs WHERE data->>'__owner_client_id' = ANY($1::text[])", [clientIds]);
        const remaining = await engine.executeRaw<{ count: number }>("SELECT COUNT(*)::int AS count FROM minion_jobs WHERE data->>'__owner_client_id' = ANY($1::text[])", [clientIds]);
        expect(remaining[0].count).toBe(0);
        await engine.executeRaw('DELETE FROM oauth_clients WHERE client_id = ANY($1::text[])', [clientIds]);
      } finally { await engine.disconnect(); }
    });
    rmSync(root, { recursive: true, force: true });
  }
}
