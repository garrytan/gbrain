/**
 * #6696 B2: the ops tier for agents and remote clients.
 *
 * - `get_brain_health` (read scope) answers bands only, scoped to the caller's
 *   sources, cached 60 s per engine and scope.
 * - `run_doctor` takes `tier: "ops"` and `only`, runs only the ops sections and
 *   refuses other tiers and unknown names.
 * - The thin client's `gbrain doctor --tier ops` / `--only persistence_capacity`
 *   asks the serve what it lists: run_doctor with the parameters, else the
 *   read-scope bands, else the structured handoff `doctor_tier_unavailable`.
 * - `/admin/api/ops` is served from one ops run a minute.
 * - Capacity fixes verify through MCP `get_brain_health` as well as the CLI.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { createServer, type Server } from 'http';
import { randomUUID } from 'crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { operations } from '../src/core/operations.ts';
import { BRAIN_HEALTH_TTL_MS, countBand, readBrainHealthBands } from '../src/commands/doctor/brain-health-bands.ts';
import { runRemoteDoctorTier } from '../src/commands/doctor/remote-tier.ts';
import { cachedOpsSnapshot, OPS_SNAPSHOT_TTL_MS } from '../src/commands/doctor/ops-snapshot.ts';
import { opsCheckNames } from '../src/commands/doctor/registry.ts';
import { capacityVerify } from '../src/core/persistence/capacity-view.ts';
import { runScopedRemoteDoctor } from '../src/core/doctor-remote-tier.ts';
import { _resetCliExitVerdictForTests, currentExitCode } from '../src/core/cli-force-exit.ts';
import type { GBrainConfig } from '../src/core/config.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw("INSERT INTO sources(id,name) VALUES('acme-a','acme-a'),('fund-b','fund-b') ON CONFLICT DO NOTHING");
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
});

async function seedFailures(source: string, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await engine.executeRaw(`INSERT INTO persistence_requests(principal_kind,principal_id,request_id,operation,source_id,source_incarnation,slug,digest,authority,intent_bytes,terminal_reservation,
        state,error_code,error_message,intent,completed_at,updated_at,admitter_version)
      VALUES('local_cli','fixture',$1::uuid,'put_page',$2,(SELECT incarnation FROM sources WHERE id=$2),$3,$4,'{}'::jsonb,0,0,'failed','made_up_code','fixture failure','{"content":"x"}'::jsonb,
        now()-interval '1 hour',now()-interval '1 hour','0.60.229.0')`,
      [randomUUID(), source, `notes/alice-example-${source}-${i}`, randomUUID()]);
  }
}

function ctx(o: Partial<OperationContext> = {}): OperationContext {
  return { engine, remote: true, transport: 'http', sourceId: 'default', config: {} as never,
    logger: { info() {}, warn() {}, error() {} }, ...o } as unknown as OperationContext;
}

describe('get_brain_health bands', () => {
  test('the operation is read scope, takes no parameters and is not admin-only', () => {
    const op = operations.find((o) => o.name === 'get_brain_health')!;
    expect(op.scope).toBe('read');
    expect(op.mutating).toBe(false);
    expect(Object.keys(op.params)).toEqual([]);
    const runDoctor = operations.find((o) => o.name === 'run_doctor')!;
    expect(runDoctor.scope).toBe('admin');
    expect(Object.keys(runDoctor.params)).toEqual(expect.arrayContaining(['tier', 'only']));
  });

  test('countBand never leaks an exact count', () => {
    expect([0, 1, 9, 10, 99, 100, 999, 1000, 50_000].map(countBand)).toEqual(['none', '1-9', '1-9', '10-99', '10-99', '100-999', '100-999', '1000+', '1000+']);
    expect(countBand(null)).toBe('unknown');
    expect(countBand(Number.NaN)).toBe('unknown');
  });

  test('write failures are banded per readable source; no slug, request id or exact count leaves', async () => {
    await engine.executeRaw('DELETE FROM persistence_requests');
    await seedFailures('acme-a', 12);
    await seedFailures('fund-b', 3);
    const t = Date.now() + 10 * BRAIN_HEALTH_TTL_MS;
    const acme = await readBrainHealthBands(engine, { sourceIds: ['acme-a'] }, t);
    const fund = await readBrainHealthBands(engine, { sourceIds: ['fund-b'] }, t);
    const all = await readBrainHealthBands(engine, {}, t);
    expect(acme.write_failures.band).toBe('10-99');
    expect(fund.write_failures.band).toBe('1-9');
    expect(all.write_failures.band).toBe('10-99');
    expect(['ok', 'low', 'critical', 'unknown']).toContain(acme.capacity.band);
    expect(acme.capacity.forecast).toBe('available');
    expect(acme.capacity.days).toBe('over_365');
    expect(acme.capacity.band).toBe('ok');
    expect(['none', '1-9', '10-99', '100-999', '1000+', 'unknown']).toContain(acme.unsearchable.band);
    expect(typeof acme.unsearchable.lower_bound).toBe('boolean');
    expect(['none', '1-9', '10-99', '100-999', '1000+', 'unknown']).toContain(acme.ghost_pages.band);
    expect(acme.host_command).toEqual(['gbrain', 'doctor', '--tier', 'ops', '--json']);
    const wire = JSON.stringify([acme, fund, all]);
    expect(wire).not.toMatch(/alice-example|"12"|:12\b|:15\b|:3\b/);
  });

  test('cached 60 s per engine and scope', async () => {
    const t = Date.now() + 100 * BRAIN_HEALTH_TTL_MS;
    const first = readBrainHealthBands(engine, { sourceIds: ['acme-a'] }, t);
    expect(readBrainHealthBands(engine, { sourceIds: ['acme-a'] }, t + BRAIN_HEALTH_TTL_MS - 1)).toBe(first);
    expect(readBrainHealthBands(engine, { sourceIds: ['fund-b'] }, t)).not.toBe(first);
    expect(readBrainHealthBands(engine, { sourceIds: ['acme-a'] }, t + BRAIN_HEALTH_TTL_MS)).not.toBe(first);
    await first;
  });

  test('the handler scopes to the caller grant', async () => {
    const op = operations.find((o) => o.name === 'get_brain_health')!;
    const out = await op.handler(ctx({ sourceId: 'fund-b' }), {}) as { write_failures: { band: string } };
    expect(['1-9', 'unknown']).toContain(out.write_failures.band);
  });

  test('a federated grant scopes the bands to its sources, never the brain', async () => {
    const op = operations.find((o) => o.name === 'get_brain_health')!;
    const band = async (allowedSources: string[]) => ((await op.handler(ctx({ sourceId: undefined, auth: { allowedSources } as never }), {})) as { write_failures: { band: string } }).write_failures.band;
    expect(await band(['fund-b'])).toBe('1-9');
    expect(await band(['acme-a'])).toBe('10-99');
  });

  test('capacity fixes verify through MCP get_brain_health and the CLI', () => {
    expect(capacityVerify()).toMatchObject({ argv: ['gbrain', 'doctor', '--only', 'persistence_capacity', '--json'], mcp: { tool: 'get_brain_health', arguments: {} } });
  });
});

describe('run_doctor tier / only', () => {
  test('tier ops runs only the ops sections on the serve', async () => {
    const report = await runRemoteDoctorTier(ctx({ remote: false }), { tier: 'ops' });
    const ops = opsCheckNames();
    expect(report.checks.length).toBeGreaterThan(0);
    expect(report.checks.every((c) => ops.has(c.name) || c.name === 'connection')).toBe(true);
    expect(report.tier).toBe('ops');
    expect(report.complete).toBe(true);
  });

  test('only narrows to the named section', async () => {
    const report = await runRemoteDoctorTier(ctx(), { only: ['persistence_capacity'] });
    expect(report.checks.map((c) => c.name)).toEqual(['persistence_capacity']);
  });

  test('other tiers and unknown names are invalid_params', async () => {
    await expect(runRemoteDoctorTier(ctx(), { tier: 'deep' })).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(runRemoteDoctorTier(ctx(), { only: ['no_such_check'] })).rejects.toMatchObject({ code: 'invalid_params' });
    await expect(runRemoteDoctorTier(ctx(), { only: [] })).rejects.toMatchObject({ code: 'invalid_params' });
  });
});

describe('/admin/api/ops snapshot', () => {
  test('one ops run per engine a minute', async () => {
    const t = Date.now();
    const first = cachedOpsSnapshot(engine, t);
    expect(cachedOpsSnapshot(engine, t + OPS_SNAPSHOT_TTL_MS - 1)).toBe(first);
    const snap = await first;
    expect(snap.report.tier).toBe('ops');
    expect(cachedOpsSnapshot(engine, t + OPS_SNAPSHOT_TTL_MS)).not.toBe(first);
  });
});

// ---- thin client against a scripted serve ----------------------------------
let server: Server;
let port: number;
let listed: Array<{ name: string; inputSchema: Record<string, unknown> }> = [];
let results: Record<string, unknown> = {};
let calls: Array<{ name: string; args: unknown }> = [];

describe('thin-client doctor --tier ops / --only routing', () => {
  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/.well-known/oauth-authorization-server') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ token_endpoint: `http://localhost:${port}/token` }));
        return;
      }
      if (req.url === '/token') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ access_token: `t-${randomUUID()}`, token_type: 'bearer', expires_in: 3600, scope: 'read' }));
        return;
      }
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const msg = JSON.parse(body || '{}') as { id?: number; method?: string; params?: { name?: string; arguments?: unknown } };
        if (msg.id === undefined) { res.statusCode = 202; res.end(); return; }
        res.setHeader('Content-Type', 'application/json');
        const reply = (result: unknown) => res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
        if (msg.method === 'initialize') return reply({ protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } });
        if (msg.method === 'tools/list') return reply({ tools: listed });
        if (msg.method === 'tools/call') {
          calls.push({ name: msg.params!.name!, args: msg.params!.arguments });
          return reply({ content: [{ type: 'text', text: JSON.stringify(results[msg.params!.name!] ?? {}) }] });
        }
        reply({});
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    port = (server.address() as { port: number }).port;
  });
  afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

  let out = '';
  const restore: Array<() => void> = [];
  beforeEach(() => {
    listed = []; results = {}; calls = []; out = '';
    _resetCliExitVerdictForTests();
    const so = process.stdout.write.bind(process.stdout), se = process.stderr.write.bind(process.stderr), log = console.log;
    process.stdout.write = ((s: string) => { out += s; return true; }) as typeof process.stdout.write;
    process.stderr.write = ((s: string) => { out += s; return true; }) as typeof process.stderr.write;
    console.log = (...a: unknown[]) => { out += a.join(' ') + '\n'; };
    restore.push(() => { process.stdout.write = so; process.stderr.write = se; console.log = log; });
  });
  afterEach(() => { while (restore.length) restore.pop()!(); _resetCliExitVerdictForTests(); });

  const config = (): GBrainConfig => ({ engine: 'postgres', remote_mcp: { issuer_url: `http://localhost:${port}`, mcp_url: `http://localhost:${port}/mcp`,
    oauth_client_id: `client-${randomUUID()}`, oauth_client_secret: 's' } } as GBrainConfig);
  const tool = (name: string, props: string[] = []) => ({ name, inputSchema: { type: 'object', properties: Object.fromEntries(props.map((p) => [p, { type: 'string' }])) } });
  const bands = { schema_version: 1, status: 'attention', capacity: { band: 'low', days: '7_to_30', max_pct_band: '80-95', forecast: 'available' },
    write_failures: { band: '1-9', active_blockers: 'none', window_days: 30 }, host_command: ['gbrain', 'doctor', '--tier', 'ops', '--json'] };

  test('an admin token on a current serve: run_doctor with tier ops', async () => {
    listed = [tool('run_doctor', ['tier', 'only']), tool('get_brain_health')];
    results.run_doctor = { status: 'healthy', tier: 'ops', checks: [{ name: 'persistence_capacity', status: 'ok', message: 'fine' }] };
    await runScopedRemoteDoctor(config(), { tier: 'ops', only: null, json: true, label: '--tier ops' });
    expect(calls).toEqual([{ name: 'run_doctor', args: { tier: 'ops' } }]);
    expect(JSON.parse(out)).toMatchObject({ tier: 'ops', checks: [{ name: 'persistence_capacity' }] });
    expect(currentExitCode()).toBe(0);
  });

  test('a read token (run_doctor not listed): --only persistence_capacity answers from get_brain_health bands', async () => {
    listed = [tool('get_brain_health')];
    results.get_brain_health = bands;
    await runScopedRemoteDoctor(config(), { only: new Set(['persistence_capacity']), json: true, label: '--only persistence_capacity' });
    expect(calls.map((c) => c.name)).toEqual(['get_brain_health']);
    const report = JSON.parse(out);
    expect(report).toMatchObject({ mode: 'bands', source: 'get_brain_health', status: 'warnings' });
    expect(report.checks).toEqual([expect.objectContaining({ name: 'persistence_capacity', status: 'warn', details: expect.objectContaining({ band: 'low' }) })]);
  });

  test('an older serve: structured handoff doctor_tier_unavailable, never the full report', async () => {
    listed = [tool('run_doctor'), tool('get_brain_identity')];
    await runScopedRemoteDoctor(config(), { tier: 'ops', only: null, json: true, label: '--tier ops' });
    expect(calls).toEqual([]);
    expect(out).toContain('doctor_tier_unavailable');
    expect(out).toContain('gbrain doctor --tier ops --json');
    expect(currentExitCode()).not.toBe(0);
  });

  test('a read token asking for a check the bands do not cover: handoff', async () => {
    listed = [tool('get_brain_health')];
    await runScopedRemoteDoctor(config(), { only: new Set(['persistence_compaction']), json: true, label: '--only persistence_compaction' });
    expect(calls).toEqual([]);
    expect(out).toContain('doctor_tier_unavailable');
  });

  test('--tier deep is never served remotely', async () => {
    await runScopedRemoteDoctor(config(), { tier: 'deep', only: null, json: true, label: '--tier deep' });
    expect(out).toContain('doctor_tier_unavailable');
  });
});
