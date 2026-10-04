/**
 * Release-gate fixes from the Cat 41 after-pass (agent operator wave): the
 * consent violations and the false "no notes" answer real agents produced on
 * the candidate, each pinned against the real CLI / stdio MCP server.
 *
 *   1. Plain `gbrain doctor` (and --only, --remediation-plan) sends no provider
 *      request; the live embedding probe needs `--probe` plus authorization.
 *   2. Every remediation-plan step carries a fix with its effects; an explicit
 *      embedding backfill (`embed`, `jobs submit embed`) refuses unauthorized
 *      (exit 3) and runs under a preapproval; ordinary writes still embed.
 *   3. A brain whose automatic PGLite repair failed is never opened again:
 *      every command exits 3 with the consented repair, and the data dir stays
 *      byte-identical (zero writes) until the user runs the repair.
 *   4. A stdio agent learns that local transcripts exist (notice + readiness)
 *      and `gbrain transcripts recent --json` reads them through the live serve.
 *
 * Paid calls go to a local fake OpenAI endpoint that counts requests.
 * Serial: real subprocesses, PGLite brains in temp homes, a bound local port.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO, body, call, gb, journeyEnv, mcp, noticeBlocks, oneDocument, type McpSession } from './helpers/agent-journey.ts';

const DIMS = 1536;

function fakeProvider() {
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      requests.push(url.pathname);
      if (url.pathname.endsWith('/embeddings')) {
        const b = await req.json() as { input: string | string[] };
        const inputs = Array.isArray(b.input) ? b.input : [b.input];
        return Response.json({ object: 'list', model: 'text-embedding-3-small',
          data: inputs.map((_, index) => ({ object: 'embedding', index, embedding: Array.from({ length: DIMS }, () => 0.01) })),
          usage: { prompt_tokens: 9, total_tokens: 9 } });
      }
      return Response.json({ error: { message: 'not handled' } }, { status: 404 });
    },
  });
  return { server, embedCalls: () => requests.filter(p => p.endsWith('/embeddings')).length };
}

function writeNotes(home: string, n = 3): string {
  const dir = join(home, 'notes');
  mkdirSync(dir, { recursive: true });
  for (let i = 1; i <= n; i++) writeFileSync(join(dir, `gate-note-${i}.md`), `---\ntitle: Gate note ${i}\n---\n\n# Gate note ${i}\n\nThe heron-gate marker ${i} lives here.\n`);
  return dir;
}

describe('paid provider calls need authorization (doctor probe, remediation plan, embed backfills)', () => {
  let home = '';
  let provider: ReturnType<typeof fakeProvider>;
  let env: Record<string, string> = {};
  const cli = (args: string[], extra: Record<string, string> = {}) => gb(home, args, { env: { ...env, ...extra }, timeoutMs: 180_000 });

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'gbrain-gate-paid-'));
    provider = fakeProvider();
    env = { OPENAI_API_KEY: 'sk-gate-fake-provider-key', OPENAI_BASE_URL: `http://127.0.0.1:${provider.server.port}/v1` };
    expect((await cli(['init', '--pglite', '--embedding-model', 'openai:text-embedding-3-small', '--non-interactive', '--json'])).exitCode).toBe(0);
    const imp = await cli(['import', writeNotes(home), '--no-embed']);
    expect(imp.exitCode, imp.stderr).toBe(0);
  }, 300_000);

  afterAll(() => {
    provider?.server.stop(true);
    rmSync(home, { recursive: true, force: true });
  });

  test('plain doctor, doctor --only and the remediation plan send no provider request', async () => {
    const before = provider.embedCalls();
    const doctor = await cli(['doctor', '--json']);
    const report = oneDocument(doctor, 'doctor --json');
    const check = (report.checks as Array<Record<string, any>>).find(c => c.name === 'embedding_provider')!;
    expect(check.details).toMatchObject({ probed: false });
    expect(check.fix.consent).toEqual(['paid', 'egress']);
    expect(check.fix.next).toBe('ask_user');
    expect(check.fix.argv).toEqual(expect.arrayContaining(['doctor', '--only', 'embedding_provider', '--probe', '--yes']));

    const only = await cli(['doctor', '--only', 'embedding_provider', '--json']);
    expect(oneDocument(only, 'doctor --only').checks[0].details.probed).toBe(false);

    const plan = oneDocument(await cli(['doctor', '--remediation-plan', '--json']), 'remediation plan');
    expect(provider.embedCalls()).toBe(before);

    const steps = plan.plan as Array<Record<string, any>>;
    expect(steps.length).toBeGreaterThan(0);
    for (const step of steps) {
      expect(step.fix, `${step.id} carries a fix`).toBeTruthy();
      expect(step.fix.consent, `${step.id} declares its effects`).toBeArray();
      expect(['run', 'ask_user']).toContain(step.fix.next);
    }
    const embedStep = steps.find(s => s.job === 'embed')!;
    expect(embedStep.est_usd_cost).toBeGreaterThan(0);
    expect(embedStep.fix.consent).toEqual(['paid']);
    expect(embedStep.fix.next).toBe('ask_user');
    expect(embedStep.fix.argv).toContain('--yes');
    expect(embedStep.fix.user_message).toBeTruthy();
  }, 300_000);

  test('doctor --probe refuses without authorization (exit 3) and probes once with --yes', async () => {
    const before = provider.embedCalls();
    const refused = await cli(['doctor', '--only', 'embedding_provider', '--probe', '--json']);
    expect(refused.exitCode).toBe(3);
    const payload = oneDocument(refused, 'probe refusal');
    expect(payload).toMatchObject({ code: 'confirmation_required', effects: ['paid', 'egress'] });
    expect(payload.fix.argv).toContain('--yes');
    expect(provider.embedCalls()).toBe(before);

    const probed = await cli(['doctor', '--only', 'embedding_provider', '--probe', '--yes', '--json']);
    const check = oneDocument(probed, 'probe --yes').checks[0];
    expect(check.message).toContain('DB aligned');
    expect(provider.embedCalls()).toBe(before + 1);
  }, 180_000);

  test('explicit embedding backfills refuse unauthorized (exit 3) and spend nothing', async () => {
    const before = provider.embedCalls();
    const stale = await cli(['embed', '--stale', '--catch-up', '--json']);
    expect(stale.exitCode).toBe(3);
    const payload = oneDocument(stale, 'embed refusal');
    expect(payload).toMatchObject({ code: 'confirmation_required', effects: ['paid'] });
    expect(payload.est_usd).toBeGreaterThan(0);
    expect(payload.fix.next).toBe('ask_user');
    expect(payload.fix.argv.slice(0, 6)).toEqual(['gbrain', 'embed', '--stale', '--catch-up', '--json', '--yes']);
    expect(payload.preview.argv).toContain('--dry-run');

    const human = await cli(['embed', '--stale']);
    expect(human.exitCode).toBe(3);
    expect(human.stdout).toContain('[SHOW USER]');

    const job = await cli(['jobs', 'submit', 'embed', '--params', '{"stale":true}', '--follow']);
    expect(job.exitCode).toBe(3);
    expect(provider.embedCalls()).toBe(before);

    const stats = await cli(['stats']);
    expect(stats.stdout).toMatch(/Embedded:\s+0\b/);
  }, 300_000);

  test('a per-run preapproval authorizes the backfill; an ordinary write embeds as configured', async () => {
    expect((await cli(['config', 'set', 'consent.preapprove.paid.max_usd_per_run', '0.5'])).exitCode).toBe(0);
    const before = provider.embedCalls();
    const run = await cli(['embed', '--stale']);
    expect(run.exitCode, run.stderr).toBe(0);
    expect(run.stderr).toContain('preapproval');
    expect(provider.embedCalls()).toBeGreaterThan(before);

    // Write-path embedding of new content under a configured key is the configured feature, not a gated action:
    // an ordinary write never asks for consent.
    const write = Bun.spawnSync(['bun', '--no-env-file', 'run', join(REPO, 'src', 'cli.ts'), 'put', 'notes/gate-write-path'], {
      cwd: home, env: journeyEnv(home, env),
      stdin: Buffer.from('---\ntitle: Gate write path\n---\n\nA fresh page written after the backfill.\n'),
    });
    expect(write.exitCode, write.stderr.toString()).toBe(0);
    expect(write.stdout.toString() + write.stderr.toString()).not.toContain('confirmation_required');
  }, 300_000);
});

// ── 3. repair-failed brains are never opened ───────────────────────────────

/** Every file under the data dir, hashed (pg_control and postmaster.pid included: the gate allows zero writes). */
function manifest(dir: string, rel = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(join(dir, rel))) {
    const r = rel ? `${rel}/${name}` : name;
    const full = join(dir, r);
    if (statSync(full).isDirectory()) Object.assign(out, manifest(dir, r));
    else out[r] = `${statSync(full).size}:${createHash('sha256').update(readFileSync(full)).digest('hex')}`;
  }
  return out;
}

/** Overwrite the tuple area of every pg_class page in the user database: the catalog no longer opens and WAL repair cannot fix it. */
function corruptCatalog(dataDir: string): void {
  for (const db of readdirSync(join(dataDir, 'base'))) {
    if (db === '1') continue;
    const file = join(dataDir, 'base', db, '1259');
    if (!existsSync(file)) continue;
    const bytes = readFileSync(file);
    for (let i = 0; i < bytes.length; i += 8192) bytes.fill(0xff, i + 24, i + 600);
    writeFileSync(file, bytes);
  }
}

describe('a brain whose automatic repair failed is not opened or written', () => {
  let home = '';
  const cli = (args: string[]) => gb(home, args, { timeoutMs: 180_000 });
  const dataDir = () => join(home, '.gbrain', 'brain.pglite');
  const marker = () => `${dataDir()}.repair-failed.json`;

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'gbrain-gate-repair-'));
    expect((await cli(['init', '--pglite', '--no-embedding', '--json'])).exitCode).toBe(0);
    expect((await cli(['import', writeNotes(home), '--no-embed'])).exitCode).toBe(0);
    corruptCatalog(dataDir());
  }, 300_000);

  afterAll(() => { rmSync(home, { recursive: true, force: true }); });

  test('the failed automatic repair leaves a marker; every later command exits 3 with the consented repair and writes nothing', async () => {
    const first = await cli(['list', '--json']);
    expect(first.exitCode, first.stderr).toBe(3);
    expect(existsSync(marker())).toBe(true);
    const firstPayload = oneDocument(first, 'first refusal');
    expect(firstPayload).toMatchObject({ code: 'confirmation_required', effects: ['destructive'] });

    const before = manifest(dataDir());
    for (const args of [['stats'], ['doctor', '--json'], ['list'], ['search', 'heron'], ['doctor', '--only', 'brain_score', '--json'], ['status', '--json']]) {
      const r = await cli(args);
      expect(r.exitCode, `gbrain ${args.join(' ')}: ${r.stderr.slice(-500)}`).toBe(3);
      expect(r.stdout + r.stderr).toContain('Do not copy, rebuild, move or modify the brain.pglite files yourself');
    }
    const json = oneDocument(await cli(['stats', '--json']), 'stats --json refusal');
    expect(json).toMatchObject({ status: 'confirmation_required', code: 'confirmation_required', effects: ['destructive'], actor: 'agent' });
    expect(json.fix.next).toBe('ask_user');
    expect(json.fix.argv.slice(0, 4)).toEqual(['gbrain', 'pglite-repair', '--yes', '--expect']);
    expect(json.preview.argv).toEqual(['gbrain', 'pglite-repair', '--dry-run', '--json']);
    expect(json.user_message).toBeTruthy();

    // The repair lane still works and changes nothing on --dry-run; engine-free doctor checks run.
    const dry = await cli(['pglite-repair', '--dry-run', '--json']);
    expect(dry.exitCode).toBe(0);
    const diag = JSON.parse(dry.stdout);
    expect(diag.repair_failed).toBeTruthy();
    expect(diag.plan_hash).toBe(json.plan_hash);
    expect((await cli(['doctor', '--only', 'embedding_key_source', '--json'])).exitCode).toBe(0);

    expect(manifest(dataDir())).toEqual(before);
  }, 600_000);

  test('stdio serve completes the handshake in status-only mode naming the failed repair, without touching the data dir', async () => {
    const before = manifest(dataDir());
    const session = await mcp(home, []);
    try {
      expect((await session.client.listTools()).tools.map(t => t.name)).toEqual(['gbrain_status']);
      const status = body(await call(session, 'gbrain_status'));
      expect(status).toMatchObject({ status: 'unavailable', reason: 'repair_failed' });
      expect(status.fix.next).toBe('tell_user_to_run');
      expect(status.fix.why).toContain('Do not copy, rebuild, move or modify');
    } finally {
      await session.close();
    }
    expect(manifest(dataDir())).toEqual(before);
  }, 180_000);

  test('the consented repair clears the marker', async () => {
    const plan = JSON.parse((await cli(['pglite-repair', '--dry-run', '--json'])).stdout);
    const run = await cli(['pglite-repair', '--yes', '--expect', plan.plan_hash, '--json']);
    expect(run.exitCode, run.stderr).toBe(0);
    expect(existsSync(marker())).toBe(false);
  }, 180_000);
});

// ── 4. local transcripts reach a stdio agent ───────────────────────────────

describe('local transcripts are discoverable from stdio MCP', () => {
  let home = '';
  let session: McpSession | null = null;
  const cli = (args: string[]) => gb(home, args, { timeoutMs: 180_000 });

  beforeAll(async () => {
    home = mkdtempSync(join(tmpdir(), 'gbrain-gate-transcripts-'));
    expect((await cli(['init', '--pglite', '--no-embedding', '--json'])).exitCode).toBe(0);
    expect((await cli(['import', writeNotes(home), '--no-embed'])).exitCode).toBe(0);
    mkdirSync(join(home, 'transcripts'));
    writeFileSync(join(home, 'transcripts', '2026-10-01-session.txt'), 'User: I promise to finish the ledger cutover by Friday.\n');
    expect((await cli(['config', 'set', 'dream.synthesize.session_corpus_dir', join(home, 'transcripts')])).exitCode).toBe(0);
  }, 300_000);

  afterAll(async () => {
    await session?.close();
    rmSync(home, { recursive: true, force: true });
  });

  test('an activity-shaped search names the transcripts and the CLI read; the CLI reads them through the live serve', async () => {
    session = await mcp(home, []);
    const tools = (await session.client.listTools()).tools.map(t => t.name);
    expect(tools).not.toContain('get_recent_transcripts');

    const found = await call(session, 'search', { query: 'what did I promise in my coding sessions this week' });
    const blocks = noticeBlocks(found).filter(b => b.startsWith('[gbrain notice local_transcripts '));
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toContain('1 recent session transcript file(s)');
    expect(blocks[0]).toContain('gbrain transcripts recent --json');
    expect(blocks[0]).toContain('Never answer "no transcripts"');

    // A plain non-empty listing carries no transcript pointer.
    const listed = await call(session, 'list_pages', {});
    expect(noticeBlocks(listed).some(b => b.startsWith('[gbrain notice local_transcripts '))).toBe(false);

    const capabilities = await session.client.readResource({ uri: 'gbrain://capabilities' });
    const caps = JSON.parse((capabilities.contents[0] as { text: string }).text);
    const entry = (caps.readiness as Array<Record<string, any>>).find(e => e.capability === 'local_transcripts');
    expect(entry).toMatchObject({ state: 'ok', reason: 'transcripts_cli_only' });

    const read = await cli(['transcripts', 'recent', '--json']);
    expect(read.exitCode, read.stderr).toBe(0);
    expect(JSON.parse(read.stdout)[0].summary).toContain('ledger cutover');
  }, 240_000);
});
