/**
 * Agent operator wave H4: upgrade fixtures (docs/designs/AGENT_OPERATOR_WAVE.md,
 * Lane H). What a v0.60.37.0 install already had keeps working after the
 * upgrade, with the outputs, authorization and recovery it relied on:
 *
 * (1) existing scripts: every `--json` document an old script parsed still
 *     parses with every key path, exit code and `error` value it had
 *     (frozen capture: test/fixtures/agent-contract/v0.60.37-json-documents.json),
 *     except the documented renumbers; legacy advice keys stay put.
 * (2) scheduled jobs: cron/autopilot invocations, non-TTY, keep running; the
 *     only flip is the one the behavior table lists (`doctor --remediate`).
 * (3) harness configs: a pre-surface Claude Code registration, a Codex
 *     config.toml registration and a bare-`gbrain` registration answer
 *     initialize + tools/list + recall, and `doctor --only harness_wiring`
 *     reports each (the bare one with the rewire fix).
 * (4) an old thin client (the frozen v0.60.37 parser in
 *     test/fixtures/agent-contract/frozen-thin-client-v0.60.37.ts, over the
 *     same SDK transport it used) against a real new `serve --http`.
 * (5) queued jobs from before the upgrade carry no submit-time authorization
 *     and run under the configured budget (spec A4).
 *
 * Spec row → test (existing coverage this file does not duplicate):
 *   legacy `error` values and v1 fields on the goldens, both skew directions → test/thin-client-contract-skew.test.ts
 *   exit-3 enumeration and the published exit table                          → test/exit-codes.test.ts
 *   budget stop 3 → 11 (`embed --stale`, `dream --drain`)                    → test/embed.serial.test.ts, test/embed-exit-code-3037.serial.test.ts,
 *                                                                              test/dream-drain-failure-summary.serial.test.ts
 *   consent table: every gated command non-TTY exits 3 and mutates nothing   → test/consent-table.serial.test.ts (C9)
 *   absolute `serve --surface verbs` Claude registration smoke, live owner   → test/doctor-harness-smoke.serial.test.ts
 *   #5157 pre-cutover jobs (no submission authority) need review first       → test/minions-legacy-journey.test.ts,
 *                                                                              test/e2e/minions-legacy-journey-postgres.test.ts
 *   Postgres parity of the H1 journey                                        → test/e2e/agent-journey-postgres.test.ts
 *   (1) real CLI documents, renumbered exits, legacy keys                    → this file, "(1)"
 *   (2) cron/autopilot non-TTY                                               → this file, "(2)"
 *   (3) pre-surface, Codex and bare-binary registrations                     → this file, "(3)"
 *   (4) frozen old client against a live new serve --http                    → this file, "(4)"
 *   (5) pre-upgrade queued paid job under the configured cap                 → this file, "(5)"
 *
 * Keyless PGLite in hermetic HOME = GBRAIN_HOME; real subprocess CLI
 * (`bun --no-env-file src/cli.ts`), real MCP sessions, hard timeouts.
 * Row (5) points the embedding provider at a local stub (no network, no key).
 *
 * Serial: subprocess CLIs and servers over temp PGLite brains.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { makeDoctorHome, runGbrain, type DoctorHome, type GbrainRun } from './helpers/doctor-json-golden.ts';
import { PROVIDER_ENV_KEYS } from './helpers/provider-env.ts';
import { oldReadError, oldUnpack } from './fixtures/agent-contract/frozen-thin-client-v0.60.37.ts';
import { extractToolErrorDetail } from '../src/core/mcp-client.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { MinionQueue } from '../src/core/minions/queue.ts';

const REPO = join(import.meta.dir, '..');
const CLI = join(REPO, 'src', 'cli.ts');
const MARKER = 'zelkova-upgrade-fixture';
const FROZEN = JSON.parse(readFileSync(join(import.meta.dir, 'fixtures', 'agent-contract', 'v0.60.37-json-documents.json'), 'utf8')) as {
  commands: Record<string, { exit: number; keys?: string[]; error?: string; json?: false }>;
};

const homes: DoctorHome[] = [];
afterAll(() => { for (const h of homes) h.cleanup(); });

/** A hermetic home with a keyless PGLite brain and three imported notes (the frozen capture's fixture). */
async function upgradedBrain(prefix: string, initArgs: string[] = ['init', '--pglite', '--no-embedding'], env: Record<string, string | undefined> = {}): Promise<DoctorHome> {
  const h = makeDoctorHome(prefix);
  homes.push(h);
  rmSync(h.skillsDir, { recursive: true, force: true });
  const init = await run(h, initArgs, env);
  expect(init.exitCode, init.stderr).toBe(0);
  const notes = join(h.home, 'notes');
  mkdirSync(notes, { recursive: true });
  for (const n of ['alpha', 'beta', 'gamma']) {
    writeFileSync(join(notes, `${n}.md`), `---\ntitle: ${n} note\n---\n\n# ${n} note\n\nThe ${MARKER} ${n} fact lives here.\n`);
  }
  const imported = await run(h, ['import', notes, '--no-embed'], env);
  expect(imported.exitCode, imported.stderr).toBe(0);
  return h;
}

/** The hermetic CLI env of test/helpers/doctor-json-golden.ts (no network preload when `net` is set). */
function childEnv(h: DoctorHome, extra: Record<string, string | undefined> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  for (const k of PROVIDER_ENV_KEYS) delete env[k];
  for (const k of ['DATABASE_URL', 'GBRAIN_DATABASE_URL', 'GBRAIN_REMOTE_CLIENT_SECRET', 'GBRAIN_PGLITE_SNAPSHOT', 'GBRAIN_SKILLS_DIR', 'GBRAIN_SOURCE',
    'GBRAIN_SERVE_FAIL_FAST', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_SANDBOX', 'CODEX_CI', 'CODEX_HOME', 'OPENCODE', 'OPENCODE_PID', 'XDG_CONFIG_HOME']) delete env[k];
  Object.assign(env, {
    HOME: h.home, GBRAIN_HOME: h.home, GBRAIN_AUDIT_DIR: join(h.home, 'audit'), GBRAIN_SKIP_STARTUP_HOOKS: '1', NO_COLOR: '1',
    PATH: [join(h.home, 'bin'), '/usr/bin', '/bin'].join(delimiter),
  });
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

function run(h: DoctorHome, args: string[], env: Record<string, string | undefined> = {}, timeoutMs = 120_000): Promise<GbrainRun> {
  return runGbrain(h, args, env, timeoutMs);
}

/** A CLI run with network allowed (row 5 talks to the local provider stub). */
async function runNet(h: DoctorHome, args: string[], env: Record<string, string | undefined>, timeoutMs = 120_000) {
  const proc = Bun.spawn([process.execPath, '--no-env-file', CLI, ...args], { cwd: h.work, env: childEnv(h, env), stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const killer = setTimeout(() => proc.kill(9), timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    return { stdout, stderr, exitCode };
  } finally {
    clearTimeout(killer);
  }
}

function keyPaths(v: unknown, prefix: string, out: Set<string>): Set<string> {
  if (Array.isArray(v)) { for (const el of v) keyPaths(el, `${prefix}[]`, out); return out; }
  if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { out.add(`${prefix}.${k}`); keyPaths(x, `${prefix}.${k}`, out); }
  return out;
}

function splitArgs(command: string): string[] {
  const i = command.indexOf(' {');
  return i < 0 ? command.split(' ') : [...command.slice(0, i).split(' '), command.slice(i + 1)];
}

/** Rows of docs/guides/exit-codes.md "Changed in this release" this file proves on the real CLI. */
const RENUMBERED: Record<string, { now: number; docRow: string }> = {
  'sources remove default --json': { now: 2, docRow: '`gbrain sources remove default` / `gbrain sources archive default`' },
};

describe('(1) existing scripts after the upgrade', () => {
  let h: DoctorHome;
  beforeAll(async () => { h = await upgradedBrain('upgrade-scripts'); }, 180_000);

  test('every --json document a v0.60.37 script parsed: same exit, same error value, every key path still there', async () => {
    const problems: string[] = [];
    for (const [command, old] of Object.entries(FROZEN.commands)) {
      const r = await run(h, splitArgs(command), { GBRAIN_NON_INTERACTIVE: '1' });
      const expectedExit = RENUMBERED[command]?.now ?? old.exit;
      if (r.exitCode !== expectedExit) problems.push(`${command}: exit ${r.exitCode}, a v0.60.37 script expects ${expectedExit}`);
      if (r.json === null) { problems.push(`${command}: stdout is no longer one JSON document: ${r.stdout.slice(0, 200)}`); continue; }
      const now = keyPaths(r.json, '$', new Set());
      const missing = (old.keys ?? []).filter(k => !now.has(k));
      if (missing.length) problems.push(`${command}: lost key paths ${missing.join(', ')}`);
      if (old.error !== undefined && (r.json as { error?: unknown }).error !== old.error) {
        problems.push(`${command}: error ${(r.json as { error?: unknown }).error} (was ${old.error})`);
      }
    }
    expect(problems).toEqual([]);
  }, 300_000);

  test('the renumbered exits are the documented ones, on every lane that reaches them', async () => {
    const changed = readFileSync(join(REPO, 'docs', 'guides', 'exit-codes.md'), 'utf8').split('## Changed in this release')[1] ?? '';
    for (const { now, docRow } of Object.values(RENUMBERED)) expect(changed).toContain(`| ${docRow} | 3 | ${now} |`);
    expect(changed).toContain('| `gbrain call` invalid parameters | 1 | 2 |');

    // Managed sources run through the persistence lane; its caller mistakes exit 2 like every other CLI lane.
    for (const args of [['sources', 'remove', 'default'], ['sources', 'archive', 'default'], ['sources', 'remove', 'default', '--json']]) {
      const r = await run(h, args, { GBRAIN_NON_INTERACTIVE: '1' });
      expect(r.exitCode, `${args.join(' ')}: ${r.stderr}`).toBe(2);
      expect(r.stderr).toContain('Error [invalid_params]');
    }
    const call = await run(h, ['call', 'get_page', '{}'], { GBRAIN_NON_INTERACTIVE: '1' });
    expect(call.exitCode).toBe(2);
    expect(call.json).toMatchObject({ error: 'invalid_params', code: 'invalid_params', contract_version: 1 });
    const notFound = await run(h, ['call', 'get_page', JSON.stringify({ slug: 'no-such-page' })], { GBRAIN_NON_INTERACTIVE: '1' });
    expect(notFound.exitCode).toBe(1);
  }, 180_000);

  test('legacy advice keys stay where old scripts read them, next to the v1 fields', async () => {
    const backup = await run(h, ['backup', 'status', '--json']);
    const assets = (backup.json as { assets: Array<Record<string, unknown>> }).assets;
    expect(assets.length).toBeGreaterThan(0);
    for (const asset of assets) expect('fix_argv' in asset).toBe(true);
    const err = (await run(h, ['call', 'get_page', JSON.stringify({ slug: 'no-such-page' })])).json as Record<string, any>;
    expect(err).toMatchObject({ error: 'page_not_found', code: 'page_not_found' });
    expect(typeof err.suggestion).toBe('string');
    expect(err.fix?.argv).toEqual(['gbrain', 'get', 'no-such-page', '--include-deleted', '--brain', 'host', '--source', 'default']);
  }, 120_000);
});

describe('(2) scheduled jobs: cron and autopilot invocations, non-TTY', () => {
  let h: DoctorHome;
  beforeAll(async () => { h = await upgradedBrain('upgrade-cron'); }, 180_000);

  test('the one listed flip: doctor --remediate with runnable work now stops for consent (exit 3, nothing submitted)', async () => {
    const table = readFileSync(join(REPO, 'docs', 'protocol', 'AGENT_OPERATOR_v1.md'), 'utf8').split('## Behavior changes for scripts and agents')[1] ?? '';
    expect(table).toContain('| `gbrain doctor --remediate` without a terminal | ran paid and mutating work');
    const r = await run(h, ['doctor', '--remediate', '--target-score', '30', '--json']);
    expect(r.exitCode, r.stdout + r.stderr).toBe(3);
    expect(r.json).toMatchObject({ code: 'confirmation_required', fix: { next: 'ask_user' } });
    const stats = (await run(h, ['jobs', 'stats', '--json'])).json as { by_status: Record<string, number> };
    expect(stats.by_status.waiting ?? 0).toBe(0);
  }, 180_000);

  const CRON: Array<{ args: string[]; json?: true }> = [
    { args: ['dream', '--json'], json: true },
    { args: ['jobs', 'submit', 'autopilot-cycle', '--follow'] },
    { args: ['extract', 'all'] },
    { args: ['embed', '--stale', '--json'], json: true },
    { args: ['jobs', 'work'] },
    { args: ['doctor', '--json'], json: true },
  ];
  for (const row of CRON) {
    test(`gbrain ${row.args.join(' ')} still runs unattended (exit 0, no consent stop)`, async () => {
      const r = await run(h, row.args, {}, 180_000);
      expect(r.exitCode, `${r.stdout.slice(-1500)}\n${r.stderr.slice(-1500)}`).toBe(0);
      expect(r.stdout).not.toContain('confirmation_required');
      expect(r.stderr).not.toContain('[SHOW USER]');
      if (row.json) expect(r.json).not.toBeNull();
    }, 200_000);
  }

  test('dream --json is still the CycleReport a cron log parses', async () => {
    const report = (await run(h, ['dream', '--json'], {}, 180_000)).json as Record<string, unknown>;
    expect(report).toMatchObject({ schema_version: '1' });
    expect(Array.isArray(report.phases)).toBe(true);
    expect(typeof report.status).toBe('string');
  }, 200_000);

});

interface McpSession { client: Client; close: () => Promise<void> }

async function stdioSession(command: string, args: string[], env: Record<string, string>, cwd: string): Promise<McpSession> {
  const transport = new StdioClientTransport({ command, args, env, cwd, stderr: 'pipe' });
  const client = new Client({ name: 'registered-harness', version: '1.0.0' }, { capabilities: {} });
  await client.connect(transport, { timeout: 60_000 });
  return { client, close: () => client.close() };
}

function body(res: unknown): unknown {
  return JSON.parse((res as { content: Array<{ text: string }> }).content[0].text);
}

describe('(3) harness configs registered before the upgrade', () => {
  let h: DoctorHome;
  beforeAll(async () => {
    h = await upgradedBrain('upgrade-harness');
    writeFileSync(join(h.home, 'bin', 'gbrain'), `#!/bin/sh\nexec "${process.execPath}" --no-env-file "${CLI}" "$@"\n`);
    chmodSync(join(h.home, 'bin', 'gbrain'), 0o755);
  }, 180_000);

  const clear = () => {
    rmSync(join(h.home, '.claude.json'), { force: true });
    rmSync(join(h.home, '.codex'), { recursive: true, force: true });
  };

  async function registeredRecall(command: string, args: string[], regEnv: Record<string, string>) {
    const s = await stdioSession(command, args, { ...childEnv(h), ...regEnv }, h.work);
    try {
      const tools = (await s.client.listTools()).tools.map(t => t.name);
      expect(tools).toContain('recall');
      expect(tools).not.toContain('gbrain_status');
      const res = await s.client.callTool({ name: 'recall', arguments: { query: MARKER } }) as { isError?: boolean };
      expect(res.isError).toBeFalsy();
      expect(JSON.stringify(body(res))).toContain(MARKER);
      return tools;
    } finally {
      await s.close();
    }
  }

  function harnessCheck(r: GbrainRun): Record<string, any> {
    const check = (r.json as { checks?: Array<Record<string, any>> } | null)?.checks?.find(c => c.name === 'harness_wiring');
    if (!check) throw new Error(`no harness_wiring check: ${r.stdout.slice(0, 500)} ${r.stderr.slice(0, 500)}`);
    return check;
  }

  test('a pre-surface Claude Code registration (`serve`, no --surface) keeps the full catalog and recalls', async () => {
    clear();
    const regEnv = { GBRAIN_HOME: h.home, GBRAIN_SKIP_STARTUP_HOOKS: '1' };
    writeFileSync(join(h.home, '.claude.json'), JSON.stringify({ mcpServers: { gbrain: { type: 'stdio', command: process.execPath, args: ['--no-env-file', CLI, 'serve'], env: regEnv } } }));
    const tools = await registeredRecall(process.execPath, ['--no-env-file', CLI, 'serve'], regEnv);
    expect(tools).toContain('search');
    const check = harnessCheck(await run(h, ['doctor', '--only', 'harness_wiring', '--json']));
    expect(check).toMatchObject({ status: 'ok', details: { harness: 'claude-code', reason: 'wired_running', smoke: 'smoke_passed' } });
  }, 120_000);

  test('a Codex config.toml registration keeps working and doctor reports it', async () => {
    clear();
    mkdirSync(join(h.home, '.codex'), { recursive: true });
    writeFileSync(join(h.home, '.codex', 'config.toml'), [
      'model = "gpt-example"', '', '[mcp_servers.gbrain]', `command = ${JSON.stringify(process.execPath)}`,
      `args = ${JSON.stringify(['--no-env-file', CLI, 'serve', '--surface', 'verbs'])}`,
      `env = { GBRAIN_HOME = ${JSON.stringify(h.home)}, GBRAIN_SKIP_STARTUP_HOOKS = "1" }`, '',
    ].join('\n'));
    await registeredRecall(process.execPath, ['--no-env-file', CLI, 'serve', '--surface', 'verbs'], { GBRAIN_HOME: h.home, GBRAIN_SKIP_STARTUP_HOOKS: '1' });
    const check = harnessCheck(await run(h, ['doctor', '--only', 'harness_wiring', '--json']));
    expect(check, JSON.stringify(check)).toMatchObject({ status: 'ok', details: { harness: 'codex', reason: 'wired_running', smoke: 'smoke_passed' } });
  }, 120_000);

  test('a bare `gbrain serve` registration still answers on a PATH that has gbrain; doctor flags it with the rewire fix', async () => {
    clear();
    writeFileSync(join(h.home, '.claude.json'), JSON.stringify({ mcpServers: { gbrain: { command: 'gbrain', args: ['serve'] } } }));
    await registeredRecall('gbrain', ['serve'], {});
    const check = harnessCheck(await run(h, ['doctor', '--only', 'harness_wiring', '--json']));
    expect(check).toMatchObject({ status: 'warn', details: { harness: 'claude-code', reason: 'bare_binary' } });
    expect(check.fix?.argv?.[0] ?? check.fix_unavailable_reason, JSON.stringify(check)).toBeTruthy();
  }, 120_000);
});

describe('(4) an old thin client against a real new serve --http', () => {
  let h: DoctorHome;
  let server: ChildProcess | null = null;
  let rw = '';
  let ro = '';
  const PORT = 44000 + Math.floor(Math.random() * 2000);
  const URL_ = `http://127.0.0.1:${PORT}/mcp`;

  beforeAll(async () => {
    h = await upgradedBrain('upgrade-thin-client');
    const token = async (name: string, scopes: string) => {
      const r = await run(h, ['auth', 'create', name, '--scopes', scopes]);
      expect(r.exitCode, r.stderr).toBe(0);
      return (r.stdout.match(/gbrain_[a-f0-9]{64}/) ?? [''])[0];
    };
    rw = await token('old-thin-client', 'read,write');
    ro = await token('old-thin-reader', 'read');
    expect(rw && ro).toBeTruthy();
    server = spawn(process.execPath, ['--no-env-file', CLI, 'serve', '--http', '--bind', '127.0.0.1', '--port', String(PORT)],
      { cwd: h.work, env: childEnv(h), stdio: ['ignore', 'ignore', 'ignore'] });
    const end = Date.now() + 60_000;
    while (Date.now() < end) {
      if ((await fetch(`http://127.0.0.1:${PORT}/health`).catch(() => null))?.ok) return;
      await Bun.sleep(500);
    }
    throw new Error('serve --http never became healthy');
  }, 180_000);

  afterAll(async () => {
    if (!server) return;
    server.kill('SIGTERM');
    await new Promise(r => server!.once('exit', r));
  });

  /** The old client's wire: SDK Client + StreamableHTTP with the bearer it minted. */
  async function oldClient(token: string): Promise<Client> {
    const client = new Client({ name: 'gbrain-thin-client', version: '0.60.37.0' }, { capabilities: {} });
    await client.connect(new StreamableHTTPClientTransport(new URL(URL_), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    return client;
  }

  test('success bodies: the old content[0]-only parse still gets the result, notice blocks or not', async () => {
    const c = await oldClient(rw);
    try {
      const res = await c.callTool({ name: 'search', arguments: { query: MARKER } }) as { content: Array<{ type: string; text: string }> };
      expect(res.content.length).toBeGreaterThan(1);
      const rows = oldUnpack(res) as Array<{ slug: string }>;
      expect(Array.isArray(rows)).toBe(true);
      expect(rows.map(r => r.slug).sort()).toEqual(['alpha', 'beta', 'gamma']);
    } finally {
      await c.close();
    }
  }, 60_000);

  test('error results: one block, and the old join-all parse reads the v0.60.37 error value and a suggestion', async () => {
    const c = await oldClient(rw);
    const reader = await oldClient(ro);
    try {
      const cases: Array<[Client, string, Record<string, unknown>, string]> = [
        [c, 'get_page', {}, 'invalid_params'],
        [c, 'get_page', { slug: 'no-such-page' }, 'page_not_found'],
        [c, 'no_such_tool', {}, 'unknown_operation'],
        [reader, 'put_page', { slug: 'notes/x', content: 'x' }, 'insufficient_scope'],
      ];
      for (const [client, name, args, oldCode] of cases) {
        const res = await client.callTool({ name, arguments: args }) as { isError?: boolean; content: Array<{ text: string }> };
        expect(res.isError, name).toBe(true);
        expect(res.content).toHaveLength(1);
        const old = oldReadError(res);
        expect(old.code, name).toBe(oldCode);
        expect(typeof old.suggestion, name).toBe('string');
      }
      const unknown = await c.callTool({ name: 'no_such_tool', arguments: {} }) as { content: Array<{ text: string }> };
      expect(extractToolErrorDetail(unknown.content[0].text)).toMatchObject({ code: 'unknown_operation', canonical_code: 'unknown_tool' });
      const denied = JSON.parse((await reader.callTool({ name: 'remember', arguments: { fact: 'x' } }) as { content: Array<{ text: string }> }).content[0].text);
      expect(denied).toMatchObject({ error: 'insufficient_scope', code: 'insufficient_scope', your_scopes: ['read'] });
      expect(denied.fix?.argv?.slice(0, 3)).toEqual(['gbrain', 'auth', 'rescope-token']);
    } finally {
      await c.close();
      await reader.close();
    }
  }, 60_000);
});

describe('(5) jobs queued before the upgrade run under the configured budget', () => {
  let h: DoctorHome;
  let provider: ReturnType<typeof Bun.serve>;
  let embeddingCalls = 0;
  let env: Record<string, string>;

  beforeAll(async () => {
    provider = Bun.serve({
      hostname: '127.0.0.1', port: 0, async fetch(request) {
        if (request.method === 'GET') return Response.json({ data: [{ id: 'text-embedding-3-small' }] });
        const payload = await request.json() as { input: string | string[] };
        const input = Array.isArray(payload.input) ? payload.input : [payload.input];
        embeddingCalls += 1;
        return Response.json({
          object: 'list', model: 'text-embedding-3-small',
          data: input.map((_, index) => ({ object: 'embedding', index, embedding: Array.from({ length: 1536 }, (_, i) => (i === index % 1536 ? 1 : 0)) })),
          usage: { prompt_tokens: 8 * input.length, total_tokens: 8 * input.length },
        });
      },
    });
    env = { OPENAI_API_KEY: 'synthetic-upgrade-fixture', OPENAI_BASE_URL: `http://127.0.0.1:${provider.port}/v1` };
    h = makeDoctorHome('upgrade-queued-jobs');
    homes.push(h);
    rmSync(h.skillsDir, { recursive: true, force: true });
    const init = await runNet(h, ['init', '--pglite', '--embedding-model', 'openai:text-embedding-3-small', '--embedding-dimensions', '1536', '--non-interactive'], env);
    expect(init.exitCode, init.stderr).toBe(0);
    const notes = join(h.home, 'notes');
    mkdirSync(notes, { recursive: true });
    for (const n of ['alpha', 'beta', 'gamma']) writeFileSync(join(notes, `${n}.md`), `---\ntitle: ${n} note\n---\n\n# ${n} note\n\nThe ${MARKER} ${n} fact lives here.\n`);
    const imported = await runNet(h, ['import', notes, '--no-embed'], env);
    expect(imported.exitCode, imported.stderr).toBe(0);
  }, 180_000);

  afterAll(() => { provider?.stop(true); });

  /**
   * The waiting row a v0.60.37 `gbrain jobs submit embed-backfill --follow` admitted on PGLite (its only queue
   * path there) and left behind when the process died before the inline claim: name and params only, no
   * submit-time authorization on it.
   */
  async function queuePreUpgradeRow(): Promise<number> {
    const engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite', database_path: join(h.home, '.gbrain', 'brain.pglite') });
    try {
      const job = await new MinionQueue(engine).add('embed-backfill', { sourceId: 'default' }, { queue: 'default' }, { allowPgliteInlineWorker: true });
      const [row] = await engine.executeRaw<{ data: Record<string, unknown> }>('SELECT data FROM minion_jobs WHERE id = $1', [job.id]);
      expect(row.data).toEqual({ sourceId: 'default' });
      return job.id;
    } finally {
      await engine.disconnect();
    }
  }

  async function jobRow(id: number): Promise<{ status: string; result: Record<string, any>; error_text: string | null }> {
    const engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite', database_path: join(h.home, '.gbrain', 'brain.pglite') });
    try {
      const [row] = await engine.executeRaw<{ status: string; result: Record<string, any>; error_text: string | null }>('SELECT status, result, error_text FROM minion_jobs WHERE id = $1', [id]);
      return row;
    } finally {
      await engine.disconnect();
    }
  }

  test('a configured cap below the work stops every provider call at the cap; the job is not refused for consent', async () => {
    expect((await runNet(h, ['config', 'set', 'embed.backfill_max_usd', '0.00000001'], env)).exitCode).toBe(0);
    const id = await queuePreUpgradeRow();
    const before = embeddingCalls;
    const worker = await runNet(h, ['jobs', 'work'], env, 180_000);
    expect(worker.exitCode, worker.stderr.slice(-2000)).toBe(0);
    expect(worker.stdout + worker.stderr).not.toContain('confirmation_required');
    expect(worker.stderr).toContain('embed-backfill:default: projected cost');
    expect(embeddingCalls).toBe(before);
    const row = await jobRow(id);
    expect(row.status, `${row.error_text}\n${worker.stderr.slice(-2000)}`).not.toBe('completed');
    expect(row.error_text).toContain('embed-backfill: incomplete');
    const cancelled = await runNet(h, ['jobs', 'cancel', String(id)], env);
    expect(cancelled.exitCode, cancelled.stderr).toBe(0);
  }, 240_000);

  test('a configured cap that covers the work runs it to completion', async () => {
    expect((await runNet(h, ['config', 'set', 'embed.backfill_max_usd', '1'], env)).exitCode).toBe(0);
    const id = await queuePreUpgradeRow();
    const worker = await runNet(h, ['jobs', 'work'], env, 180_000);
    expect(worker.exitCode, worker.stderr.slice(-2000)).toBe(0);
    const row = await jobRow(id);
    expect(row.status).toBe('completed');
    expect(row.result.status).toBe('success');
    expect(row.result.embedded).toBeGreaterThan(0);
    expect(row.result.spentUsd).toBeLessThanOrEqual(1);
    expect(embeddingCalls).toBeGreaterThan(0);
  }, 240_000);
});
