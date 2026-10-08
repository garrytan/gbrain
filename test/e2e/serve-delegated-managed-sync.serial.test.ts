/**
 * #6317 (D1 a′) on real Postgres: a spawned `gbrain serve` owns the host (its
 * B3 heartbeat row says so), and `gbrain sync --source <id> --no-pull --no-embed
 * --json` from a second process hands the managed catch-up to it over the
 * resolve-IPC socket as the CLI's verified writer. Asserts the CLI's exit code
 * and JSON envelope are the in-process ones, the drain's own lines reached the
 * CLI, the serve (not the CLI) published every page, and `--no-delegate` keeps
 * the CLI's own consumer beside the same serve.
 *
 * Measurement (the plan asks for it before rejecting the approach): while the
 * delegated drain runs, the test sends MCP `tools/call` requests to the serve's
 * stdio session every 250 ms and prints the request-latency percentiles. Set
 * GBRAIN_E2E_DELEGATION_PAGES=1000 for the 1k-page fixture (the default keeps
 * CI short); the numbers are printed, never asserted.
 *
 * Lane 1 owns the `persistence_consumers` migration and the serve's heartbeat;
 * until they land this test creates the agreed table when absent and renews
 * the spawned serve's row itself.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { hookResolveSocketForConfig, socketHasLiveListener } from '../../src/core/context/resolve-ipc.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { keylessBrainEnv } from '../helpers/provider-env.ts';
import { withEnv } from '../helpers/with-env.ts';

const REPO_ROOT = resolve(import.meta.dir, '..', '..');
const PAGES = Number(process.env.GBRAIN_E2E_DELEGATION_PAGES ?? '60');
const SOURCE = 'workspace';
const describeWithDb = process.env.DATABASE_URL ? describe : describe.skip;

let home: string, repo: string, databaseUrl: string;
let engine: Awaited<ReturnType<typeof isolatedPersistencePostgres>>['engine'];
let closeDb: (() => Promise<void>) | undefined;
let serve: StdioServe | undefined;
let heartbeat: ReturnType<typeof setInterval> | undefined;

function git(...args: string[]): string { return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }

function childEnv(extra: Record<string, string | undefined> = {}): Record<string, string> {
  return keylessBrainEnv(process.env, home, {
    DATABASE_URL: databaseUrl, GBRAIN_DATABASE_URL: undefined, GBRAIN_DIRECT_DATABASE_URL: undefined,
    GBRAIN_BRAIN_ID: 'host', GBRAIN_SOURCE: SOURCE, GBRAIN_SWEEP: '0', GBRAIN_HOOKS: undefined,
    GBRAIN_SKIP_STARTUP_HOOKS: '1', GBRAIN_NO_SKILL_NAG: '1', GBRAIN_SERVE_BOOT_TIMEOUT_SECONDS: '300', GBRAIN_SYNC_NO_DELEGATE: undefined,
    ...extra,
  });
}

/** One stdio MCP session against the spawned `gbrain serve` (ndjson JSON-RPC). */
class StdioServe {
  readonly child: ChildProcess;
  stderr = '';
  private buf = '';
  private nextId = 1;
  private pending = new Map<number, (msg: Record<string, unknown>) => void>();
  constructor(env: Record<string, string>) {
    this.child = spawn(process.execPath, [join(REPO_ROOT, 'src/cli.ts'), 'serve'], { cwd: REPO_ROOT, env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.stderr!.on('data', (d: Buffer) => { this.stderr += d.toString('utf8'); });
    this.child.stdout!.on('data', (d: Buffer) => {
      this.buf += d.toString('utf8');
      let idx: number;
      while ((idx = this.buf.indexOf('\n')) !== -1) {
        const line = this.buf.slice(0, idx).trim(); this.buf = this.buf.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line) as Record<string, unknown>;
          const id = msg.id as number | undefined;
          if (id !== undefined && this.pending.has(id)) { this.pending.get(id)!(msg); this.pending.delete(id); }
        } catch { /* serve chatter */ }
      }
    });
  }
  get pid(): number { return this.child.pid!; }
  request(method: string, params: Record<string, unknown>, timeoutMs = 60_000): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    return new Promise((resolvePromise, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error(`rpc ${id} (${method}) timed out`)); }, timeoutMs);
      this.pending.set(id, (msg) => { clearTimeout(t); resolvePromise(msg); });
      this.child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  async start(): Promise<void> {
    await this.request('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'delegation-e2e', version: '1' } }, 240_000);
    this.child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  }
  async call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.request('tools/call', { name, arguments: args });
  }
  async stop(): Promise<void> {
    this.child.kill('SIGTERM');
    await new Promise<void>((done) => { const t = setTimeout(() => { this.child.kill('SIGKILL'); done(); }, 8000); this.child.once('exit', () => { clearTimeout(t); done(); }); });
  }
}

async function runSync(args: string[], env: Record<string, string | undefined> = {}, timeoutMs = 600_000): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn([process.execPath, join(REPO_ROOT, 'src/cli.ts'), 'sync', ...args], { cwd: REPO_ROOT, env: childEnv(env), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => proc.kill('SIGKILL'), timeoutMs);
  try {
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { code, out, err };
  } finally { clearTimeout(timer); }
}

async function until(check: () => boolean | Promise<boolean>, label: string, timeoutMs = 240_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    if (serve && serve.child.exitCode !== null) throw new Error(`serve exited while waiting for ${label}: ${serve.stderr}`);
    await Bun.sleep(100);
  }
  throw new Error(`timed out waiting for ${label}: ${serve?.stderr}`);
}

const percentile = (sorted: number[], p: number): number => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : NaN;

describeWithDb('serve-delegated managed sync on Postgres (#6317 D1 a′)', () => {
  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'gb-sdm-'));
    mkdirSync(join(home, '.gbrain'));
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engine = pg.engine; databaseUrl = pg.databaseUrl; closeDb = pg.close;
    writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'postgres', database_url: databaseUrl, embedding_disabled: true }));
    repo = mkdtempSync(join(tmpdir(), 'gb-sdm-repo-'));
    git('init', '-q'); git('config', 'user.email', 'example@example.invalid'); git('config', 'user.name', 'Example');
    mkdirSync(join(repo, 'notes'));
    for (let i = 0; i < PAGES; i++) writeFileSync(join(repo, 'notes', `note-${String(i).padStart(4, '0')}.md`), `---\ntype: concept\ntitle: Note ${i} Example\n---\n\nBody for note ${i}, an observation about acme-example.\n`);
    git('add', '-A'); git('commit', '-qm', 'notes');
    await withEnv({ GBRAIN_HOME: home }, async () => {
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,\'{}\')', [SOURCE, repo]);
      // A second, unclaimed source for the source_mismatch case (the managed-writer guard refuses topology writes once enabled).
      await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,\'{}\')', ['other', repo]);
      await claimWorktree(engine, SOURCE, repo);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    });
    // Lane 1's table, by the agreed columns, when the migration is not in this tree yet.
    await engine.executeRaw(`CREATE TABLE IF NOT EXISTS persistence_consumers (
      host_id uuid NOT NULL, pid integer NOT NULL, nonce text NOT NULL, pid_ns text, kind text NOT NULL, mode text NOT NULL,
      started_at timestamptz NOT NULL DEFAULT now(), renewed_at timestamptz NOT NULL DEFAULT now(), restart_required boolean NOT NULL DEFAULT false,
      root_barrier_age_ms integer, pool jsonb, host_json_path text, persistence_home text, minted_under jsonb, version text,
      PRIMARY KEY (host_id, pid, nonce))`);
    serve = new StdioServe(childEnv());
    await serve.start();
    // The serve keys its socket under GBRAIN_HOME; resolve the same path here.
    const sock = await withEnv({ GBRAIN_HOME: home }, () => hookResolveSocketForConfig({ engine: 'postgres', database_url: databaseUrl }, SOURCE));
    await until(async () => !!sock && await socketHasLiveListener(sock), 'the serve\'s resolve-IPC socket');
    const { localHostId } = await import('../../src/core/persistence/identity.ts');
    const hostId = await withEnv({ GBRAIN_HOME: home }, async () => localHostId());
    const renew = () => engine.executeRaw(`INSERT INTO persistence_consumers(host_id,pid,nonce,kind,mode,version) VALUES($1::uuid,$2,'e2e','serve','full','e2e')
      ON CONFLICT (host_id,pid,nonce) DO UPDATE SET renewed_at=now()`, [hostId, serve!.pid]).catch(() => undefined);
    await renew();
    heartbeat = setInterval(() => { void renew(); }, 5_000);
    heartbeat.unref?.();
  }, 400_000);

  afterAll(async () => {
    if (heartbeat) clearInterval(heartbeat);
    await serve?.stop();
    try { await engine?.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1'); } catch { /* noop */ }
    await closeDb?.();
    rmSync(home, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  });

  test('the CLI hands the managed catch-up to the resident serve and prints the in-process result; MCP latency under the drain is measured', async () => {
    // Baseline: the same call against the idle serve, so the drain's cost reads as a delta.
    const idle: number[] = [];
    for (let i = 0; i < 12; i++) { const at = performance.now(); await serve!.call('get_stats', {}); idle.push(performance.now() - at); await Bun.sleep(100); }
    idle.sort((a, b) => a - b);
    const latencies: number[] = [];
    let stopProbing = false;
    const probing = (async () => {
      while (!stopProbing) {
        const at = performance.now();
        try { await serve!.call('get_stats', {}); latencies.push(performance.now() - at); } catch { latencies.push(Number.POSITIVE_INFINITY); }
        await Bun.sleep(250);
      }
    })();
    const started = performance.now();
    const result = await runSync(['--source', SOURCE, '--no-pull', '--no-embed', '--json']);
    const elapsedMs = performance.now() - started;
    stopProbing = true; await probing;
    if (result.code !== 0) throw new Error(`sync exited ${result.code}\nstdout:\n${result.out}\nstderr:\n${result.err}\nserve stderr:\n${serve!.stderr}`);
    expect(result.err).toMatch(new RegExp(`a live gbrain serve \\(PID ${serve!.pid}\\) owns this host's writes — running the managed catch-up inside it as this CLI's writer`));
    expect(result.err).toMatch(new RegExp(`\\[sync\\] managed catch-up: ${PAGES} entries frozen`));
    expect(serve!.stderr).toMatch(/\[serve-sync\] start job=.* managed=true/);
    expect(serve!.stderr).toMatch(/\[serve-sync\] done job=.* drain=synced/);
    const envelope = JSON.parse(result.out.trim().split('\n').pop()!) as Record<string, unknown>;
    expect(envelope).toMatchObject({ schema_version: 1, source_id: SOURCE, sync_status: 'first_sync', added: PAGES, outcome: 'synced' });
    expect(envelope.drain).toMatchObject({ outcome: 'synced', written: PAGES, remaining: 0 });
    expect(envelope.next).toBeUndefined();
    // The serve, never this CLI, held every claim: the owner stamps on the committed requests name its pid only.
    const owners = await engine.executeRaw<{ pid: string | null; n: number }>(
      `SELECT claim_phase->'owner'->>'pid' AS pid, count(*)::int AS n FROM persistence_requests WHERE source_id=$1 AND state='committed' GROUP BY 1`, [SOURCE]);
    const stamped = owners.filter(o => o.pid !== null);
    expect(stamped.length).toBeGreaterThan(0);
    expect(stamped.map(o => Number(o.pid))).toEqual([serve!.pid]);
    const finite = latencies.filter(Number.isFinite).sort((a, b) => a - b);
    const line = `[measure] serve-delegated drain of ${PAGES} pages in ${Math.round(elapsedMs / 1000)}s: ${latencies.length} MCP get_stats calls during it, ` +
      `p50 ${percentile(finite, 0.5).toFixed(0)}ms p95 ${percentile(finite, 0.95).toFixed(0)}ms max ${(finite.at(-1) ?? NaN).toFixed(0)}ms, ${latencies.length - finite.length} timed out; ` +
      `idle serve baseline p50 ${percentile(idle, 0.5).toFixed(0)}ms p95 ${percentile(idle, 0.95).toFixed(0)}ms`;
    console.error(line);
    expect(latencies.length).toBeGreaterThan(0);
  }, 900_000);

  test('--no-delegate keeps this process\'s own consumer beside the same serve and still converges', async () => {
    writeFileSync(join(repo, 'notes', 'late-note.md'), '---\ntype: concept\ntitle: Late Note Example\n---\n\nA page added after the first catch-up.\n');
    git('add', '-A'); git('commit', '-qm', 'late');
    const result = await runSync(['--source', SOURCE, '--no-pull', '--no-embed', '--no-delegate', '--json']);
    if (result.code !== 0) throw new Error(`sync exited ${result.code}\nstdout:\n${result.out}\nstderr:\n${result.err}`);
    expect(result.err).not.toMatch(/running the managed catch-up inside it/);
    const envelope = JSON.parse(result.out.trim().split('\n').pop()!) as Record<string, unknown>;
    expect(envelope).toMatchObject({ source_id: SOURCE, outcome: 'synced', added: 1 });
  }, 600_000);

  test('a serve bound to another source keeps this process\'s own consumer with one line (source_mismatch)', async () => {
    const result = await runSync(['--source', 'other', '--no-pull', '--no-embed', '--json'], { GBRAIN_SOURCE: 'other' }, 120_000);
    // The ladder reached the serve (through the legacy URL-keyed socket), was told source_mismatch, and kept the own consumer;
    // what the unclaimed source does after that is the in-process path's business.
    expect(result.err).toMatch(/\[sync\] the serve is bound to a different source than this sync targets.*this run uses its own consumer beside the serve \(PID \d+\)/);
    expect(result.err).not.toMatch(/running the managed catch-up inside it/);
  }, 300_000);
});
