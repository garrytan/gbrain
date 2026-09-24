import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { keylessBrainEnv } from './helpers/provider-env.ts';

const CLI = new URL('../src/cli.ts', import.meta.url).pathname;
const FIXTURE = new URL('./fixtures/managed-atoms-cli-brain.ts', import.meta.url).pathname;

interface Result { exitCode: number; stdout: string; stderr: string; timedOut: boolean; }
async function run(command: string[], env: Record<string, string>, home: string, timeoutMs = 60_000): Promise<Result> {
  const child = Bun.spawn([process.execPath, ...command], { cwd: home, env, stdout: 'pipe', stderr: 'pipe' });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, exitCode, timedOut };
  } finally { clearTimeout(timer); }
}

test('disk PGLite CLI atom retry requires a safely stopped owner and persists across owner restart', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-managed-atoms-cli-'));
  let malformed = true;
  let providerCalls = 0;
  const routes: string[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    routes.push(new URL(request.url).pathname);
    if (request.method !== 'POST' || !new URL(request.url).pathname.endsWith('/messages')) return new Response('Unexpected fixture provider route', { status: 400 });
    await request.json();
    providerCalls++;
    return Response.json({ id: 'msg_fixture', type: 'message', role: 'assistant', model: 'claude-haiku-4-5',
      content: [{ type: 'text', text: malformed ? 'This is not valid extraction JSON.' :
        '[{"title":"CLI verified atom","atom_type":"insight","body":"A lampreyfixture benchmark requires measured delivery before rollout."}]' }],
      stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } });
  } });
  const env = keylessBrainEnv({ PATH: process.env.PATH, TZ: 'UTC' }, home, {
    NODE_ENV: 'test', GBRAIN_SKIP_STARTUP_HOOKS: '1', GBRAIN_SWEEP: '0', GBRAIN_SOURCE: 'default', GBRAIN_BRAIN_ID: 'host',
    GBRAIN_AUDIT_DIR: join(home, 'audit'), ANTHROPIC_API_KEY: 'test', ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`,
  });
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: join(home, 'db'),
    embedding_disabled: true, embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536,
    provider_base_urls: { anthropic: `http://127.0.0.1:${server.port}` } }));
  type Owner = ReturnType<typeof Bun.spawn>;
  let owner: Owner | undefined;
  const startOwner = async () => {
    let ready!: (message: { enabled: boolean }) => void;
    const readiness = new Promise<{ enabled: boolean }>(resolve => { ready = resolve; });
    owner = Bun.spawn([process.execPath, FIXTURE, 'hold'], { cwd: home, env, stdout: 'ignore', stderr: 'inherit',
      ipc(message) { if (message?.ready) ready(message); } });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const status = await Promise.race([readiness, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Owner fixture did not become ready')), 30_000); })]);
      expect(status.enabled).toBe(true);
    } finally { if (timer) clearTimeout(timer); }
  };
  const stopOwner = async () => {
    if (!owner || owner.exitCode !== null) return;
    owner.send('stop');
    const timer = setTimeout(() => owner?.kill('SIGKILL'), 15_000);
    try { expect(await owner.exited).toBe(0); } finally { clearTimeout(timer); owner = undefined; }
  };
  const readback = async () => {
    const result = await run([FIXTURE, 'read'], env, home);
    expect(result.exitCode, result.stderr).toBe(0);
    const line = result.stdout.split('\n').find(value => value.startsWith('FIXTURE_RESULT '));
    expect(line).toBeDefined();
    return JSON.parse(line!.slice('FIXTURE_RESULT '.length)) as {
      enabled: boolean; atoms: Array<{ slug: string; visibility: string }>; chunks: number; searchSlugs: string[]; pending: number; leases: number;
      receipts: Array<{ request_id: string; state: string; outcome: Record<string, unknown> }>; files: Array<{ slug: string; content: string }>;
    };
  };
  try {
    const seeded = await run([FIXTURE, 'seed'], env, home);
    expect(seeded.exitCode, seeded.stderr).toBe(0);
    await startOwner();
    const args = [CLI, 'jobs', 'submit', 'extract-atoms-drain', '--params', JSON.stringify({ sourceId: 'default', window: 2 }), '--follow', '--max-attempts', '1'];
    const refused = await run(args, env, home, 45_000);
    expect(refused.timedOut).toBe(false);
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toMatch(/lock|already open|another gbrain/i);
    expect(owner?.exitCode).toBeNull();
    expect(providerCalls).toBe(0);
    await stopOwner();
    const stopped = await readback();
    expect(stopped.enabled).toBe(true);
    expect(stopped.atoms).toHaveLength(0);
    expect(stopped.receipts).toHaveLength(0);

    const failed = await run(args, env, home);
    expect(failed.exitCode).not.toBe(0);
    expect(providerCalls).toBe(1);
    const failure = await readback();
    expect(failure.enabled).toBe(true);
    expect(failure.atoms).toHaveLength(0);
    const original = failure.receipts.find(receipt => receipt.outcome.failure);
    expect(original).toBeDefined();

    malformed = false;
    const retryArgs = [CLI, 'jobs', 'submit', 'extract-atoms-drain', '--params', JSON.stringify({ sourceId: 'default', retryRequestId: original!.request_id }),
      '--follow', '--max-attempts', '1', '--idempotency-key', 'explicit-cli-atom-retry'];
    const retried = await run(retryArgs, env, home);
    expect(retried.exitCode, `${retried.stderr}\n${retried.stdout}`).toBe(0);
    expect(providerCalls).toBe(2);
    const complete = await readback();
    expect(complete.enabled).toBe(true);
    expect(complete.atoms).toHaveLength(1);
    expect(complete.atoms[0].visibility).toBe('private');
    expect(complete.chunks).toBeGreaterThan(0);
    expect(complete.searchSlugs).toContain(complete.atoms[0].slug);
    expect(complete.files[0].content).toContain('lampreyfixture');
    expect(complete.pending).toBe(0);
    expect(complete.leases).toBe(0);
    expect(complete.receipts.find(receipt => receipt.request_id === original!.request_id)).toEqual(original);
    expect(complete.receipts.some(receipt => receipt.state === 'committed' && receipt.outcome.status === 'completed' && !receipt.outcome.failure)).toBe(true);

    const replay = await run(retryArgs, env, home);
    expect(replay.exitCode, `${replay.stderr}\n${replay.stdout}`).toBe(0);
    expect(providerCalls).toBe(2);
    await startOwner();
    await stopOwner();
    const restarted = await readback();
    expect(restarted).toEqual(complete);
    expect(routes).toHaveLength(2);
    console.log(`CLI_ATOM_RECOVERY_PROOF ${JSON.stringify({ live_owner_refusal_exit: refused.exitCode, malformed_exit: failed.exitCode,
      retry_exit: retried.exitCode, replay_exit: replay.exitCode, provider_calls: providerCalls,
      managed_enabled_snapshots: [stopped.enabled, failure.enabled, complete.enabled, restarted.enabled],
      atom_slug: complete.atoms[0].slug, chunks: complete.chunks, search_match: complete.searchSlugs.includes(complete.atoms[0].slug),
      canonical_pending: complete.pending, cycle_leases: complete.leases, retained_receipts: complete.receipts.length })}`);
  } finally { await stopOwner(); await server.stop(true); rmSync(home, { recursive: true, force: true }); }
}, 180_000);
