/**
 * Lane H3 (agent operator wave) journeys: safe recovery, approval binding and
 * interactivity, each through the real seam an agent or a human hits.
 *
 * Spec rows → where they are proven (existing unit owners in parentheses):
 *   - Cross-principal receipt recovery through real dispatch: a write that
 *     really committed (the journal row exists) but whose response failed
 *     carries its receipt over the production serve-http; the writing OAuth
 *     client's fix is `get_write_request`, which it follows to the committed
 *     receipt; another client's fix is the host inspection (actor host_admin),
 *     because the same read is not_found for it (unit:
 *     test/write-receipt-remediation.test.ts).
 *   - submit_job → status read: a job that was really queued before the call
 *     failed is recovered through the job list, never a resubmit, on the
 *     trusted local `gbrain call` dispatch and over HTTP. Fails without the
 *     src/core/agent-output.ts STATUS_READ row (the fix was `gbrain doctor`).
 *   - Approval binding: `gbrain reindex-frontmatter` (destructive, plan-bound)
 *     re-asks with `preview_changed` when an approved record changed and when
 *     a new record started matching, changes nothing, and runs once the
 *     current plan is approved (units: test/consent.test.ts verifyApproval,
 *     test/doctor-remediate-consent.test.ts stale hash).
 *   - isInteractive on a REAL gbrain CLI under a pseudo-terminal: a human with
 *     only CODEX_HOME set keeps the consent prompt; CLAUDECODE and CI force
 *     non-interactive with exactly one stderr line naming the cause and
 *     GBRAIN_INTERACTIVE=1 (units: test/interaction.test.ts,
 *     test/interaction-stdin.serial.test.ts drive interaction.ts directly).
 *
 * Serial: spawns the CLI (some under a PTY), runs an in-process serve-http.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { opError, type Operation, type OperationError } from '../src/core/ops/contract.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { renderCliError } from '../src/core/agent-output.ts';
import { keylessBrainEnv } from './helpers/provider-env.ts';
import { launchTty, ptySupported } from './helpers/tty-harness.ts';
import {
  callTool, clientCredentialsToken, envelopeOf, opNamed, ownerCookie, registerOAuthClient, startServeHttp, withOpHandler,
  type LiveServeHttp, type ToolResultWire,
} from './helpers/live-mcp-servers.ts';

const REPO = join(import.meta.dir, '..');
const CLI = join(REPO, 'src', 'cli.ts');
const MARKERS = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_SANDBOX', 'CODEX_CI', 'OPENCODE', 'OPENCODE_PID'];

// ── in-process brain + serve-http ───────────────────────────────────────────

let engine: PGLiteEngine;
let serve: LiveServeHttp;
let writer: { clientId: string; clientSecret: string; token: string };
let other: { clientId: string; clientSecret: string; token: string };
let home: string;
const savedHome = process.env.GBRAIN_HOME;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-h3-recovery-'));
  process.env.GBRAIN_HOME = join(home, 'server-home');
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  serve = await startServeHttp(engine);
  const cookie = await ownerCookie(serve);
  const mk = async () => {
    const c = await registerOAuthClient(serve, cookie, 'read write admin');
    return { ...c, token: await clientCredentialsToken(serve, c.clientId, c.clientSecret, 'read write admin') };
  };
  writer = await mk();
  other = await mk();
}, 120_000);

afterAll(async () => {
  await serve?.close();
  await engine?.disconnect();
  if (savedHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = savedHome;
  if (home) rmSync(home, { recursive: true, force: true });
});

describe('cross-principal receipt recovery through real dispatch', () => {
  test('the writer reads its receipt; another client is sent to the host, whose inspection it cannot do itself', async () => {
    const requestId = randomUUID();
    const original = opNamed('put_page').handler;
    /** The write commits, then the response is lost: the error carries the real receipt. */
    const commitThenLoseResponse = (principalId: string): Operation['handler'] => async (ctx, p) => {
      const result = await original(ctx, p) as { revision?: string };
      const e = opError('storage_error', 'The connection dropped after the write was accepted.', 'Inspect the receipt before resubmitting.');
      e.writeRequest = { request_id: requestId, state: 'committed', retry_after_ms: null, revision: result.revision } as OperationError['writeRequest'];
      e.receiptFields = { operation: 'put_page', source_id: 'default', slug: 'notes/h3-receipt', principal_kind: 'oauth_client', principal_id: principalId };
      throw e;
    };
    const args = { slug: 'notes/h3-receipt', content: '---\ntitle: Receipt\n---\nBody.\n', request_id: requestId };

    // The writing client: one block, a receipt read on its own channel, never a retry.
    const own = envelopeOf(await withOpHandler('put_page', commitThenLoseResponse(writer.clientId), () => callTool(serve.base, writer.token, 'put_page', args)));
    expect(own.write_request).toMatchObject({ request_id: requestId, state: 'committed' });
    expect(own.retryable).toBe(false);
    expect(own.fix).toMatchObject({ mcp: { tool: 'get_write_request', arguments: { request_id: requestId } }, actor: 'agent', next: 'run' });
    // Following the fix: the committed receipt, and the page is there.
    const receipt = await callTool(serve.base, writer.token, own.fix.mcp.tool, own.fix.mcp.arguments);
    expect(receipt.isError).toBeFalsy();
    expect(JSON.parse(receipt.content[0]!.text)).toMatchObject({ request_id: requestId, state: 'committed' });
    expect((await callTool(serve.base, writer.token, 'get_page', { slug: 'notes/h3-receipt' })).isError).toBeFalsy();

    // Another client handed the same receipt: host inspection, never this client's receipt read.
    const foreign = envelopeOf(await withOpHandler('put_page', async () => {
      const e = opError('storage_error', 'The connection dropped after the write was accepted.', 'Inspect the receipt before resubmitting.');
      e.writeRequest = { request_id: requestId, state: 'committed', retry_after_ms: null } as OperationError['writeRequest'];
      e.receiptFields = { operation: 'put_page', source_id: 'default', slug: 'notes/h3-receipt', principal_kind: 'oauth_client', principal_id: writer.clientId };
      throw e;
    }, () => callTool(serve.base, other.token, 'put_page', args)));
    expect(foreign.fix).toMatchObject({ argv: ['gbrain', 'sources', 'writer', 'status', 'default', '--probe', '--json'], actor: 'host_admin', next: 'tell_user_to_run' });
    expect(foreign.fix.mcp).toBeUndefined();
    expect(foreign.fix.user_message).toContain('brain host');
    // Why: the receipt read is principal-scoped, so it is not_found for this client.
    const denied = envelopeOf(await callTool(serve.base, other.token, 'get_write_request', { request_id: requestId }));
    expect(denied.code).toBe('not_found');

    // The trusted CLI owner of a local receipt reads it with `gbrain write-request -- <id>`.
    const local = opError('storage_error', 'The connection dropped after the write was accepted.', 'Inspect the receipt before resubmitting.');
    local.writeRequest = { request_id: requestId, state: 'queued', retry_after_ms: 1000 } as OperationError['writeRequest'];
    local.receiptFields = { operation: 'put_page', source_id: 'default', slug: 'notes/h3-receipt', principal_kind: 'local_cli', principal_id: 'local' };
    const cli = JSON.parse(renderCliError(local, { json: true, command: 'put', tty: false }).stdout!);
    expect(cli.fix.argv).toEqual(['gbrain', 'write-request', '--', requestId]);
  }, 120_000);
});

describe('submit_job recovers through the job list, never a resubmit', () => {
  const jobCount = async (name: string) =>
    Number((await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM minion_jobs WHERE name = $1', [name]))[0]?.n ?? 0);

  test('trusted local dispatch (`gbrain call`): the job was queued, the fix lists it', async () => {
    const original = opNamed('submit_job').handler;
    const r = await withOpHandler('submit_job', async (ctx, p) => {
      await original(ctx, p);
      throw new Error('stdout closed after the job was queued');
    }, () => dispatchToolCall(engine, 'submit_job', { name: 'lint' }, { remote: false, sourceId: 'default' })) as ToolResultWire;
    const env = envelopeOf(r);
    expect(await jobCount('lint')).toBe(1);
    expect(env).toMatchObject({ code: 'internal_error', retryable: false });
    expect(env.suggestion).toContain('inspect state before resubmitting');
    expect(env.fix).toMatchObject({ argv: ['gbrain', 'jobs', 'list', '--json', '--brain', 'host'], next: 'run' });
    // Following it: the queued job is visible, so nothing is resubmitted.
    const listed = await dispatchToolCall(engine, 'list_jobs', {}, { remote: false, sourceId: 'default' }) as ToolResultWire;
    expect(JSON.parse(listed.content[0]!.text).map((j: { name: string }) => j.name)).toContain('lint');
  }, 60_000);

  test('over HTTP the list_jobs tool is the fix for an admin client', async () => {
    const r = await withOpHandler('submit_job', async ctx => {
      const { MinionQueue } = await import('../src/core/minions/queue.ts');
      await new MinionQueue(ctx.engine).add('embed', {}, {}, { allowProtectedSubmit: true });
      throw new Error('connection reset after enqueue');
    }, () => callTool(serve.base, writer.token, 'submit_job', { name: 'embed' }));
    const env = envelopeOf(r);
    expect(env.fix).toMatchObject({ mcp: { tool: 'list_jobs', arguments: {} }, actor: 'agent', next: 'run' });
    const listed = await callTool(serve.base, writer.token, env.fix.mcp.tool, env.fix.mcp.arguments);
    expect(JSON.parse(listed.content[0]!.text).map((j: { name: string }) => j.name)).toContain('embed');
  }, 60_000);
});

// ── real CLI on an on-disk brain: interactivity and approval binding ────────

let brain: string;

function cliEnv(extra: Record<string, string | undefined> = {}): Record<string, string> {
  const env = keylessBrainEnv(process.env, brain, {
    DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_SOURCE: undefined, GBRAIN_SKIP_STARTUP_HOOKS: '1', NO_COLOR: '1',
    GBRAIN_INTERACTIVE: undefined, GBRAIN_NON_INTERACTIVE: undefined, CI: undefined, CODEX_HOME: undefined,
    ...Object.fromEntries(MARKERS.map(k => [k, undefined])),
  });
  for (const [k, v] of Object.entries(extra)) if (v === undefined) delete env[k]; else env[k] = v;
  return env;
}

async function gbrain(args: string[], extra: Record<string, string | undefined> = {}) {
  const proc = Bun.spawn([process.execPath, '--no-env-file', CLI, ...args], {
    cwd: brain, env: cliEnv({ GBRAIN_NON_INTERACTIVE: '1', ...extra }), stdin: Bun.file('/dev/null'), stdout: 'pipe', stderr: 'pipe',
  });
  const killer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* gone */ } }, 120_000);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    let json: any = null;
    try { json = JSON.parse(stdout); } catch { /* human */ }
    return { exitCode, stdout, stderr, json };
  } finally {
    clearTimeout(killer);
  }
}

/** Stored effective dates: what a refused or re-asked run must leave alone. */
async function dates(): Promise<string> {
  const e = new PGLiteEngine();
  await e.connect({ engine: 'pglite', database_path: join(brain, '.gbrain', 'brain.pglite') });
  try {
    return JSON.stringify(await e.executeRaw("SELECT slug, effective_date::text AS d, effective_date_source AS s FROM pages ORDER BY slug"));
  } finally {
    await e.disconnect();
  }
}

async function sql(statement: string): Promise<void> {
  const e = new PGLiteEngine();
  await e.connect({ engine: 'pglite', database_path: join(brain, '.gbrain', 'brain.pglite') });
  try { await e.executeRaw(statement); } finally { await e.disconnect(); }
}

describe('real CLI: interactivity and approval binding', () => {
  beforeAll(async () => {
    brain = mkdtempSync(join(tmpdir(), 'gbrain-h3-consent-'));
    const init = await gbrain(['init', '--pglite', '--no-embedding', '--json']);
    if (init.exitCode !== 0) throw new Error(`init failed:\n${init.stdout}\n${init.stderr}`);
    const notes = join(brain, 'notes');
    mkdirSync(join(notes, 'meetings'), { recursive: true });
    writeFileSync(join(notes, 'meetings', '2026-01-02-sync.md'), '---\ntitle: Sync\nevent_date: 2026-01-02\n---\n\nA meeting about the launch.\n');
    writeFileSync(join(notes, 'idea.md'), '---\ntitle: Idea\n---\n\nAn idea page.\n');
    const imported = await gbrain(['import', notes, '--no-embed']);
    if (imported.exitCode !== 0) throw new Error(`import failed:\n${imported.stdout}\n${imported.stderr}`);
  }, 180_000);

  afterAll(() => { if (brain) rmSync(brain, { recursive: true, force: true }); });

  const ptyTest = ptySupported() ? test : test.skip;
  if (process.env.CI) test('PTY support is mandatory on CI', () => expect(ptySupported()).toBe(true));

  async function underPty(extra: Record<string, string>, steps: (s: ReturnType<typeof launchTty>) => Promise<void>): Promise<{ out: string; exit: number | null }> {
    const env = cliEnv(extra);
    const s = launchTty([process.execPath, '--no-env-file', CLI, 'reindex-frontmatter', '--force'], {
      cwd: brain, env, dropEnv: ['CI', 'GBRAIN_INTERACTIVE', 'GBRAIN_NON_INTERACTIVE', 'CODEX_HOME', ...MARKERS].filter(k => !(k in extra)), timeoutMs: 90_000,
    });
    try {
      await steps(s);
      const exit = await s.waitForExit(30_000);
      return { out: s.visible(), exit };
    } finally {
      await s.close();
    }
  }

  ptyTest('a human with only CODEX_HOME on a real terminal is prompted; declining changes nothing', async () => {
    const before = await dates();
    const r = await underPty({ CODEX_HOME: join(brain, '.codex') }, async s => {
      await s.waitFor('[y/N]', { timeoutMs: 60_000 });
      s.send('n\r');
    });
    expect(r.out).toContain('Recompute the effective date');
    expect(r.out).not.toContain('prompts are off');
    expect(r.exit).toBe(3);
    expect(await dates()).toBe(before);
  }, 120_000);

  for (const cause of ['CLAUDECODE', 'CI']) {
    ptyTest(`${cause} on a real terminal: no prompt, exit 3, one stderr line naming it and the override`, async () => {
      const before = await dates();
      const r = await underPty({ [cause]: '1' }, async s => { await s.waitForExit(60_000); });
      expect(r.exit).toBe(3);
      expect(r.out).not.toContain('[y/N]');
      expect(r.out.match(new RegExp(`prompts are off: ${cause}`, 'g'))?.length).toBe(1);
      expect(r.out).toContain('GBRAIN_INTERACTIVE=1');
      expect(r.out).toContain('[AGENT]');
      expect(await dates()).toBe(before);
    }, 120_000);
  }

  test('approval binding: a changed record and a newly matching record both re-ask; the current plan runs', async () => {
    const ask = async () => {
      const r = await gbrain(['reindex-frontmatter', '--force', '--json']);
      expect(r.exitCode).toBe(3);
      expect(r.json).toMatchObject({ code: 'confirmation_required', effects: ['destructive'], fix: { next: 'ask_user' } });
      return r.json as { plan_hash: string; fix: { argv: string[] } };
    };
    const reask = async (approved: { plan_hash: string; fix: { argv: string[] } }) => {
      const before = await dates();
      const r = await gbrain(approved.fix.argv.slice(1));
      expect(r.exitCode).not.toBe(0);
      expect(r.json).toMatchObject({ code: 'preview_changed', fix: { argv: ['gbrain', 'reindex-frontmatter', '--force', '--dry-run', '--json', '--brain', 'host'], next: 'run' } });
      expect(r.json.message).toContain(approved.plan_hash);
      expect(await dates()).toBe(before);
      // The preview the fix names is read-only and shows the plan to ask about next.
      const preview = await gbrain(r.json.fix.argv.slice(1));
      expect(preview.json).toMatchObject({ status: 'dry_run' });
      expect(preview.json.plan_hash).not.toBe(approved.plan_hash);
      expect(await dates()).toBe(before);
    };

    const first = await ask();
    // The approved command binds the plan (`--yes --expect <hash>`) and, per A1, names the brain.
    expect(first.fix.argv.slice(-5)).toEqual(['--yes', '--expect', first.plan_hash, '--brain', 'host']);

    // A record the user approved changed (its stored date moved) → re-ask.
    await sql("UPDATE pages SET effective_date = '1999-01-01', effective_date_source = 'fallback' WHERE slug = 'idea'");
    await reask(first);

    // A record the user never saw now matches the selection → re-ask.
    const second = await ask();
    expect(second.plan_hash).not.toBe(first.plan_hash);
    const extra = join(brain, 'more');
    mkdirSync(extra, { recursive: true });
    writeFileSync(join(extra, 'later.md'), '---\ntitle: Later\nevent_date: 2026-03-04\n---\n\nA later page.\n');
    expect((await gbrain(['import', extra, '--no-embed'])).exitCode).toBe(0);
    await sql("UPDATE pages SET effective_date = '1999-01-01', effective_date_source = 'fallback' WHERE slug = 'later'");
    await reask(second);

    // The plan the user approves now is the one that runs.
    const current = await ask();
    const applied = await gbrain(current.fix.argv.slice(1));
    expect(applied.exitCode).toBe(0);
    expect(applied.json).toMatchObject({ status: 'ok' });
    expect(applied.json.updated).toBeGreaterThan(0);
    // The newly matching page got its frontmatter date back (a fallback-dated page keeps its stored date by design).
    expect(JSON.parse(await dates()).find((r: { slug: string }) => r.slug === 'later')).toMatchObject({ s: 'event_date' });
  }, 240_000);
});
