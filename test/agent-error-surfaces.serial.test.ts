/**
 * Lane H3 (agent operator wave): the error normaliser's output SURVIVES every
 * surface. One instance of each family `toAgentError` handles must reach an
 * agent with the same frozen `error`, canonical `code` and `fix` over
 *   (1) MCP: a real `gbrain serve` stdio subprocess (SDK client) and the
 *       shared dispatch it runs, plus the production `serve --http` app over
 *       real HTTP;
 *   (2) CLI human output (stderr `Error [code]` / `Fix:` lines);
 *   (3) CLI `--json` (one envelope document on stdout);
 *   (4) the thin client: `callRemoteTool` parsing a real server response, the
 *       CLI renderer it hands the RemoteMcpError to, and a real thin-client
 *       `gbrain` subprocess against a real `gbrain serve --http` subprocess.
 * test/agent-error.test.ts pins the normaliser in isolation; this file pins
 * the surfaces.
 *
 * Family → trigger (REAL = a real invocation produces it; CONSTRUCTED = the
 * instance is built from production code and thrown by a swapped op handler
 * (`withOpHandler`) so dispatch, serialization and parsing stay real; the CLI
 * human/--json rows for CONSTRUCTED families drive `renderCliError`, the
 * renderer every CLI catch writes through, because no CLI command throws them
 * on a keyless brain):
 *   OperationError        REAL: get_page / `gbrain get` on a missing slug (every surface, both thin clients).
 *   StructuredAgentError  REAL on CLI (`gbrain code-def`, nested legacy shape + v1 siblings); CONSTRUCTED on MCP.
 *   GBrainError           REAL on CLI (`gbrain mounts add … --engine sqlite`); CONSTRUCTED on MCP.
 *   PhaseError (legacy {class,code,message} object) CONSTRUCTED: only cycle phase containment builds it.
 *   AIConfigError / CredentialError (class-local `.fix`) CONSTRUCTED: keyless brains never reach a provider.
 *   RemoteMcpError        REAL: thin-client CLI against a closed port; CONSTRUCTED when relayed by a server op.
 *   GBRAIN_DB_ACCESS      REAL on CLI (GBRAIN_DATABASE_URL at a closed port); CONSTRUCTED (ECONNREFUSED) on MCP.
 *   withRelationGuard     REAL: get_job_stats after dropping minion_jobs (CLI `gbrain call`, stdio, serve-http).
 *   F0 refresh refusal    REAL on CLI (`gbrain sources refresh` → refresh_no_upstream); CONSTRUCTED (catalogueError) on MCP.
 *   no_pricing            CONSTRUCTED from a real BudgetTracker.reserve (user cap × unpriced model).
 *   SourceTargetError     REAL on CLI (`gbrain import` with GBRAIN_SOURCE naming no source / a malformed id); CONSTRUCTED on MCP.
 *   unknown throw         CONSTRUCTED: a plain Error → internal_error; HTTP redacts its path/PID/key name.
 *
 * Product bugs this file found (each fixed in the owning module; the rows
 * below fail without the fix):
 *   - `gbrain call` printed every OperationError through the frozen write-
 *     receipt writer (`{error, code, message, suggestion}`), so op failures lost
 *     `fix`, `docs_cmd`, `class` and `contract_version` (src/commands/call.ts).
 *   - `gbrain sources refresh --json` refusals carried no v1 sibling keys
 *     (`error`, `docs_cmd`, `contract_version`, …) (src/commands/sources-refresh.ts).
 *   - `--brain <unknown>` refused with no suggestion and no fix
 *     (src/core/persistence/local-client.ts).
 *   - SourceTargetError (unknown/archived/malformed --source or GBRAIN_SOURCE)
 *     had no normaliser row, so it rendered as `internal_error` ("Server-side
 *     failure … not a caller mistake"); it is now unknown_source /
 *     invalid_source with a `gbrain sources list --json` fix (src/core/agent-output.ts).
 *
 * H3 row map (docs/designs/AGENT_OPERATOR_WAVE.md, Lane H, H3):
 *   normaliser families × MCP / CLI human / CLI --json / thin client → this file
 *     (normaliser in isolation: test/agent-error.test.ts);
 *   frozen old thin client × real new-server responses, one error block on
 *     every server path → test/mcp-error-single-block.test.ts
 *     (goldens: test/thin-client-contract-skew.test.ts);
 *   injection rows, HTTP view, notice dedupe over HTTP →
 *     test/agent-injection-http-view.serial.test.ts;
 *   isInteractive on a real PTY, cross-principal receipt + submit_job
 *     recovery, approval binding → test/agent-recovery-consent-journeys.serial.test.ts.
 *
 * Serial: spawns the CLI, a stdio serve and an HTTP serve, binds ports and
 * sets GBRAIN_HOME for the in-process servers.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { renderCliError } from '../src/core/agent-output.ts';
import { opError, type Operation } from '../src/core/ops/contract.ts';
import { errorFor } from '../src/core/errors.ts';
import { GBrainError } from '../src/core/types.ts';
import { AIConfigError } from '../src/core/ai/errors.ts';
import { CredentialError } from '../src/core/creds/errors.ts';
import { BudgetTracker } from '../src/core/budget/budget-tracker.ts';
import { catalogueError } from '../src/core/error-catalogue.ts';
import { SourceTargetError } from '../src/core/source-resolver.ts';
import { callRemoteTool, RemoteMcpError } from '../src/core/mcp-client.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import { keylessBrainEnv } from './helpers/provider-env.ts';
import {
  callTool, envelopeOf, legacyToken, ownerCookie, registerOAuthClient, startServeHttp, thinClientConfig, withOpHandler,
  type LiveServeHttp, type ToolResultWire,
} from './helpers/live-mcp-servers.ts';

const REPO = join(import.meta.dir, '..');
const CLI = join(REPO, 'src', 'cli.ts');
const MISSING = 'notes/missing-example';

// ── subprocess plumbing ─────────────────────────────────────────────────────

interface Run { exitCode: number; stdout: string; stderr: string; json: any }

function childEnv(home: string, extra: Record<string, string | undefined> = {}): Record<string, string> {
  return keylessBrainEnv(process.env, home, {
    DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_REMOTE_CLIENT_SECRET: undefined, GBRAIN_SOURCE: undefined,
    GBRAIN_NON_INTERACTIVE: '1', GBRAIN_SKIP_STARTUP_HOOKS: '1', GBRAIN_NO_BANNER: '1', NO_COLOR: '1', ...extra,
  });
}

async function gbrain(home: string, args: string[], extra: Record<string, string | undefined> = {}, timeoutMs = 90_000): Promise<Run> {
  const proc = Bun.spawn([process.execPath, '--no-env-file', CLI, ...args], {
    cwd: home, env: childEnv(home, extra), stdin: Bun.file('/dev/null'), stdout: 'pipe', stderr: 'pipe',
  });
  const killer = setTimeout(() => { try { proc.kill('SIGKILL'); } catch { /* gone */ } }, timeoutMs);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    let json: any = null;
    try { json = JSON.parse(stdout); } catch { /* human output */ }
    return { exitCode, stdout, stderr, json };
  } finally {
    clearTimeout(killer);
  }
}

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      s.close(() => resolve(typeof a === 'object' && a ? a.port : 0));
    });
  });
}

async function stdioSession<T>(home: string, fn: (client: Client) => Promise<T>): Promise<T> {
  const transport = new StdioClientTransport({ command: process.execPath, args: ['--no-env-file', CLI, 'serve'], env: childEnv(home), cwd: home, stderr: 'pipe' });
  const client = new Client({ name: 'h3-stdio', version: '1' }, { capabilities: {} });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => {});
  }
}

const stdioCall = async (client: Client, name: string, args: Record<string, unknown>) =>
  await client.callTool({ name, arguments: args }, undefined, { timeout: 60_000 }) as unknown as ToolResultWire;

// ── shared state ────────────────────────────────────────────────────────────

let homeA: string;     // on-disk keyless brain driven by subprocesses
let homeB: string;     // GBRAIN_HOME for the in-process servers
let engineB: PGLiteEngine;
let serve: LiveServeHttp;
let adminToken: string;
let oauth: { clientId: string; clientSecret: string };
const savedHome = process.env.GBRAIN_HOME;

beforeAll(async () => {
  homeA = mkdtempSync(join(tmpdir(), 'gbrain-h3-surfaces-a-'));
  homeB = mkdtempSync(join(tmpdir(), 'gbrain-h3-surfaces-b-'));
  process.env.GBRAIN_HOME = homeB;
  const init = await gbrain(homeA, ['init', '--pglite', '--no-embedding', '--json']);
  if (init.exitCode !== 0) throw new Error(`init failed: ${init.stdout}\n${init.stderr}`);
  engineB = new PGLiteEngine();
  await engineB.connect({});
  await engineB.initSchema();
  serve = await startServeHttp(engineB);
  adminToken = await legacyToken(engineB, ['read', 'write', 'admin']);
  oauth = await registerOAuthClient(serve, await ownerCookie(serve), 'read write admin');
}, 180_000);

afterAll(async () => {
  await serve?.close();
  await engineB?.disconnect();
  if (savedHome === undefined) delete process.env.GBRAIN_HOME;
  else process.env.GBRAIN_HOME = savedHome;
  for (const h of [homeA, homeB]) if (h) rmSync(h, { recursive: true, force: true });
});

// ── assertions ──────────────────────────────────────────────────────────────

interface Expect { error: string; code: string; fixArgv: string[] | null }

/**
 * error, code and fix.argv as the expectation says (fix absent when fixArgv is null). `pin` is the A1
 * routing the surface renders into the argv (`--brain`/`--source` on the CLI and stdio; only a
 * thin-client-sendable `--source` over HTTP; nothing where no routing is known).
 */
function expectSurvives(env: Record<string, any>, want: Expect, where: string, pin: string[] = []): void {
  expect({ where, error: env.error, code: env.code, fixArgv: env.fix?.argv ?? null })
    .toEqual({ where, error: want.error, code: want.code, fixArgv: want.fixArgv ? [...want.fixArgv, ...pin] : null });
  expect(env.contract_version).toBe(1);
}

/**
 * CLI human: the `Error [code]` line plus the fix's shell command (the
 * GBRAIN_DB_ACCESS seam keeps its golden-pinned `… Run: gbrain db-repair`
 * line), or a `Fix:` line carrying the suggestion when there is no fix.
 */
function expectHuman(stderr: string, env: Record<string, any>, want: Expect): void {
  expect(stderr).toContain(`Error [${want.code}]: `);
  if (want.fixArgv) expect(stderr).toContain(env.fix.command);
  else expect(stderr).toMatch(/^Fix: \S/m);
}

// ── constructed families ────────────────────────────────────────────────────

const unpriced = (): unknown => {
  try {
    new BudgetTracker({ label: 'h3', maxCostUsd: 0.6, capSource: 'user' })
      .reserve({ modelId: 'example:unpriced-model-x', estimatedInputTokens: 1000, maxOutputTokens: 100, kind: 'chat' });
  } catch (e) { return e; }
  throw new Error('BudgetTracker did not refuse an unpriced model under a user cap');
};

const DOCTOR = ['gbrain', 'doctor', '--json'];
const BRAIN_PIN = ['--brain', 'host'];

/** `localPin`: what a routed local render (stdio dispatch here) appends to the fix argv. */
interface Family { name: string; make(): unknown; want: Expect; localPin?: string[] }

const FAMILIES: Family[] = [
  { name: 'StructuredAgentError', make: () => errorFor({ class: 'UsageError', code: 'code_def_requires_symbol', message: 'code-def requires a symbol name', hint: 'gbrain code-def <symbol>' }),
    want: { error: 'code_def_requires_symbol', code: 'code_def_requires_symbol', fixArgv: null } },
  { name: 'GBrainError', make: () => new GBrainError('Invalid engine: "sqlite"', 'Must be "postgres" or "pglite"', 'Pass --engine pglite or --engine postgres'),
    want: { error: 'config_error', code: 'config_error', fixArgv: null } },
  { name: 'PhaseError (legacy object)', make: () => ({ class: 'PhaseError', code: 'storage_error', message: 'disk full during extract' }),
    want: { error: 'storage_error', code: 'storage_error', fixArgv: DOCTOR }, localPin: BRAIN_PIN },
  { name: 'AIConfigError', make: () => new AIConfigError('No OpenAI key configured', 'export OPENAI_API_KEY=<key> in the brain host env'),
    want: { error: 'unavailable', code: 'unavailable', fixArgv: DOCTOR }, localPin: BRAIN_PIN },
  { name: 'CredentialError', make: () => new CredentialError('access_env_missing', ' (GOOGLE_TOKEN)'),
    want: { error: 'access_env_missing', code: 'access_env_missing', fixArgv: null } },
  { name: 'RemoteMcpError (relayed)', make: () => new RemoteMcpError('network', 'Request to http://127.0.0.1:1/mcp timed out', { kind: 'timeout' }),
    want: { error: 'timeout', code: 'timeout', fixArgv: ['gbrain', 'remote', 'doctor'] } },
  { name: 'GBRAIN_DB_ACCESS', make: () => Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' }),
    want: { error: 'database_error', code: 'database_error', fixArgv: ['gbrain', 'db-repair'] }, localPin: BRAIN_PIN },
  { name: 'F0 refresh refusal', make: () => catalogueError('refresh_dirty', 'The worktree has uncommitted changes.', 'gbrain sources refresh --source wiki --stash'),
    want: { error: 'refresh_dirty', code: 'refresh_dirty', fixArgv: ['gbrain', 'sources', 'refresh', '--source', 'wiki', '--stash'] }, localPin: BRAIN_PIN },
  { name: 'no_pricing', make: unpriced,
    want: { error: 'no_pricing', code: 'no_pricing', fixArgv: ['gbrain', 'pricing', 'set', 'example:unpriced-model-x', '--input', '<usd-per-1M-input-tokens>', '--output', '<usd-per-1M-output-tokens>', '--source', '<pricing-page-url>'] }, localPin: BRAIN_PIN },
  { name: 'SourceTargetError', make: () => new SourceTargetError('Source "h3-no-such-source" not found or is archived. Available active sources: run `gbrain sources list` to see registered sources, or create/restore "h3-no-such-source" before retrying.'),
    want: { error: 'unknown_source', code: 'unknown_source', fixArgv: ['gbrain', 'sources', 'list', '--json'] }, localPin: BRAIN_PIN },
  { name: 'unknown throw', make: () => new Error('boom opening /home/alice-example/.gbrain/brain.pglite (pid 4242) without OPENAI_API_KEY'),
    want: { error: 'internal_error', code: 'internal_error', fixArgv: DOCTOR }, localPin: BRAIN_PIN },
];

const OP = 'get_brain_identity';
const throwing = (f: Family): Operation['handler'] => async () => { throw f.make(); };

describe('every error family survives MCP, CLI human, CLI --json and the thin client', () => {
  for (const f of FAMILIES) {
    test(f.name, async () => {
      // (1a) shared dispatch on the stdio transport.
      const stdio = await withOpHandler(OP, throwing(f), () => dispatchToolCall(engineB, OP, {}, { remote: true, transport: 'stdio', sourceId: 'default' })) as ToolResultWire;
      expectSurvives(envelopeOf(stdio), f.want, 'mcp stdio dispatch', f.localPin);

      // (1b) production serve-http over real HTTP.
      const http = await withOpHandler(OP, throwing(f), () => callTool(serve.base, adminToken, OP));
      const httpEnv = envelopeOf(http);
      expectSurvives(httpEnv, f.want, 'mcp http');
      // A fix the agent can call as a tool runs; a CLI-only or host-side fix over HTTP is the host's to run.
      if (f.want.fixArgv) expect(httpEnv.fix.next).toBe(httpEnv.fix.actor === 'agent' && httpEnv.fix.mcp ? 'run' : 'tell_user_to_run');

      // (2)/(3) the CLI renderer every catch writes through.
      const json = renderCliError(f.make(), { json: true, command: 'h3', tty: false });
      const cliEnv = JSON.parse(json.stdout!);
      expectSurvives(cliEnv, f.want, 'cli --json');
      const human = renderCliError(f.make(), { json: false, command: 'h3', tty: false });
      expectHuman(human.stderr!, cliEnv, f.want);
      expect(human.exitCode).toBe(json.exitCode);

      // (4) thin client: callRemoteTool parses the live server's response, then the CLI renders it.
      const remote = await withOpHandler(OP, throwing(f), () => callRemoteTool(thinClientConfig(serve, oauth), OP, {}, { timeoutMs: 30_000 }).catch(e => e));
      expect(remote).toBeInstanceOf(RemoteMcpError);
      expect((remote as RemoteMcpError).reason).toBe('tool_error');
      expectSurvives((remote as RemoteMcpError).toJSON() as Record<string, any>, f.want, 'thin client RemoteMcpError');
      const thinCli = JSON.parse(renderCliError(remote, { json: true, command: 'h3', tty: false }).stdout!);
      expectSurvives(thinCli, f.want, 'thin client CLI --json');
      expectHuman(renderCliError(remote, { json: false, command: 'h3', tty: false }).stderr!, thinCli, f.want);
    }, 60_000);
  }

  test('unknown throw over HTTP: the redaction pass strips the local path, PID and key name on every remote surface', async () => {
    const f = FAMILIES.find(x => x.name === 'unknown throw')!;
    const http = envelopeOf(await withOpHandler(OP, throwing(f), () => callTool(serve.base, adminToken, OP)));
    const remote = await withOpHandler(OP, throwing(f), () => callRemoteTool(thinClientConfig(serve, oauth), OP, {}).catch(e => e)) as RemoteMcpError;
    for (const text of [JSON.stringify(http), JSON.stringify(remote.toJSON())]) {
      expect(text).not.toContain('/home/alice-example');
      expect(text).not.toContain('4242');
      expect(text).not.toContain('OPENAI_API_KEY');
    }
    expect(http.suggestion).toContain(`Server-side failure in ${OP}`);
    expect(http.fix).toMatchObject({ actor: 'host_admin', next: 'tell_user_to_run' });
  }, 60_000);
});

describe('OperationError (REAL: a missing page) on every surface', () => {
  const want: Expect = { error: 'page_not_found', code: 'page_not_found', fixArgv: ['gbrain', 'get', MISSING, '--include-deleted'] };
  const localPin = ['--brain', 'host', '--source', 'default'];
  const httpPin = ['--source', 'default'];

  test('CLI human and --json', async () => {
    const json = await gbrain(homeA, ['get', MISSING, '--json']);
    expect(json.exitCode).toBe(1);
    expectSurvives(json.json, want, 'cli --json', localPin);
    const human = await gbrain(homeA, ['get', MISSING]);
    expect(human.exitCode).toBe(1);
    expectHuman(human.stderr, json.json, want);
  }, 120_000);

  test('real stdio serve (SDK client) and serve-http', async () => {
    const env = await stdioSession(homeA, async c => envelopeOf(await stdioCall(c, 'get_page', { slug: MISSING })));
    expectSurvives(env, want, 'stdio serve', localPin);
    expect(env.fix.mcp).toEqual({ tool: 'get_page', arguments: { slug: MISSING, include_deleted: true } });
    const http = envelopeOf(await callTool(serve.base, adminToken, 'get_page', { slug: MISSING }));
    expectSurvives(http, want, 'serve-http', httpPin);
  }, 120_000);

  test('real thin-client CLI against a real `gbrain serve --http` (human and --json)', async () => {
    const reg = await gbrain(homeA, ['auth', 'register-client', 'h3-thin-client', '--grant-types', 'client_credentials',
      '--scopes', 'read write admin', '--token-endpoint-auth-method', 'client_secret_post']);
    const clientId = /Client ID:\s+(\S+)/.exec(reg.stdout)?.[1];
    const clientSecret = /Client Secret:\s+(\S+)/.exec(reg.stdout)?.[1];
    if (!clientId || !clientSecret) throw new Error(`register-client yielded no credentials:\n${reg.stdout}\n${reg.stderr}`);
    const port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    const server: ChildProcess = spawn(process.execPath, ['--no-env-file', CLI, 'serve', '--http', '--bind', '127.0.0.1', '--port', String(port), '--public-url', base],
      { cwd: homeA, env: childEnv(homeA), stdio: ['ignore', 'pipe', 'pipe'] });
    let serr = '';
    server.stderr?.on('data', (d: Buffer) => { serr += d.toString(); });
    const homeC = mkdtempSync(join(tmpdir(), 'gbrain-h3-thin-'));
    try {
      let ready = false;
      for (let i = 0; i < 120 && !ready; i++) {
        try { ready = (await fetch(`${base}/health`)).ok; } catch { /* not up yet */ }
        if (!ready) await Bun.sleep(500);
      }
      if (!ready) throw new Error(`serve --http did not become ready:\n${serr}`);
      mkdirSync(join(homeC, '.gbrain'), { recursive: true });
      writeFileSync(join(homeC, '.gbrain', 'config.json'), JSON.stringify({
        engine: 'postgres', remote_mcp: { issuer_url: base, mcp_url: `${base}/mcp`, oauth_client_id: clientId, oauth_client_secret: clientSecret },
      }));
      const json = await gbrain(homeC, ['get', MISSING, '--json']);
      expect(json.exitCode).toBe(1);
      // The server's HTTP render pins the source; the thin client adds no routing of its own.
      expectSurvives(json.json, want, 'thin client CLI --json', httpPin);
      const human = await gbrain(homeC, ['get', MISSING]);
      expect(human.exitCode).toBe(1);
      expectHuman(human.stderr, json.json, want);
    } finally {
      server.kill('SIGTERM');
      await new Promise(resolve => { if (server.exitCode !== null) resolve(null); else server.once('exit', resolve); });
      rmSync(homeC, { recursive: true, force: true });
    }
  }, 180_000);
});

describe('REAL CLI triggers for the other families', () => {
  test('StructuredAgentError: code-def keeps its nested legacy error and gains code + fix', async () => {
    const r = await gbrain(homeA, ['code-def', '--json']);
    expect(r.exitCode).toBe(2);
    expect(r.json.error).toMatchObject({ class: 'UsageError', code: 'code_def_requires_symbol' });
    expect(r.json).toMatchObject({ code: 'code_def_requires_symbol', fix: { argv: ['gbrain', 'code-def', '--help', '--brain', 'host'], next: 'run' }, contract_version: 1 });
  }, 90_000);

  test('GBrainError: mounts add with an invalid engine → config_error (human and --json)', async () => {
    const want: Expect = { error: 'config_error', code: 'config_error', fixArgv: null };
    const args = ['mounts', 'add', 'h3-mount', '--path', join(homeA, 'mount'), '--engine', 'sqlite'];
    const json = await gbrain(homeA, [...args, '--json']);
    expectSurvives(json.json, want, 'cli --json');
    expect(json.json.suggestion).toContain('--engine pglite');
    expectHuman((await gbrain(homeA, args)).stderr, json.json, want);
  }, 90_000);

  test('GBRAIN_DB_ACCESS: a closed database port classifies with the db-repair fix (human and --json)', async () => {
    const want: Expect = { error: 'database_error', code: 'database_error', fixArgv: ['gbrain', 'db-repair'] };
    const env = { GBRAIN_DATABASE_URL: ['postgresql://h3', 'GSTACK_EXAMPLE_NONCE'].join(':') + '@127.0.0.1:1/h3' };
    const json = await gbrain(homeA, ['get', MISSING, '--json'], env);
    expectSurvives(json.json, want, 'cli --json', BRAIN_PIN);
    expect(json.json.suggestion).toContain('GBRAIN_DB_ACCESS');
    expect(json.stdout).not.toContain('GSTACK_EXAMPLE_NONCE');
    // Human output is the golden-pinned GBRAIN_DB_ACCESS seam (`… Run: gbrain db-repair`), not the rendered fix line.
    const humanErr = (await gbrain(homeA, ['get', MISSING], env)).stderr;
    expect(humanErr).toContain('Error [database_error]: ');
    expect(humanErr).toContain('Run: gbrain db-repair');
  }, 90_000);

  test('F0 refresh refusal: the legacy refusal keys stay and the v1 siblings ride beside them (human and --json)', async () => {
    const r = await gbrain(homeA, ['sources', 'refresh', 'default', '--json']);
    expect(r.exitCode).toBe(1);
    expect(r.json).toMatchObject({ status: 'refused', code: 'refresh_no_upstream', error: 'refresh_no_upstream', contract_version: 1,
      docs_cmd: ['gbrain', 'errors', 'refresh_no_upstream'], class: 'caller', retryable: false });
    expect(typeof r.json.fix).toBe('string'); // F0's stored refusal.fix string is frozen (alias table)
    expect(r.json.suggestion).toBe(r.json.fix);
    const human = await gbrain(homeA, ['sources', 'refresh', 'default']);
    expect(human.stdout).toContain('Refresh refused (refresh_no_upstream)');
    expect(human.stdout).toContain(`Fix: ${r.json.fix}`);
  }, 90_000);

  test('RemoteMcpError: a thin client whose host is down names the remote doctor (human and --json)', async () => {
    const homeC = mkdtempSync(join(tmpdir(), 'gbrain-h3-thin-down-'));
    try {
      mkdirSync(join(homeC, '.gbrain'), { recursive: true });
      writeFileSync(join(homeC, '.gbrain', 'config.json'), JSON.stringify({ engine: 'postgres',
        remote_mcp: { issuer_url: 'http://127.0.0.1:1', mcp_url: 'http://127.0.0.1:1/mcp', oauth_client_id: 'h3-cid', oauth_client_secret: 'h3-secret' } }));
      const json = await gbrain(homeC, ['get', MISSING, '--json']);
      expect(json.exitCode).toBe(1);
      expect(json.json).toMatchObject({ code: expect.any(String), fix: { argv: ['gbrain', 'remote', 'doctor'] }, contract_version: 1 });
      expect(typeof json.json.error).toBe('string');
      const human = await gbrain(homeC, ['get', MISSING]);
      expect(human.exitCode).toBe(1);
      expect(human.stderr).toContain('gbrain remote doctor');
    } finally {
      rmSync(homeC, { recursive: true, force: true });
    }
  }, 90_000);

  test('SourceTargetError: GBRAIN_SOURCE naming no source is a caller mistake with a sources-list fix, not internal_error', async () => {
    const want: Expect = { error: 'unknown_source', code: 'unknown_source', fixArgv: ['gbrain', 'sources', 'list', '--json'] };
    const dir = join(homeA, 'import-src');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'one.md'), '---\ntitle: One\n---\n\nOne page.\n');
    const env = { GBRAIN_SOURCE: 'h3-no-such-source' };
    const json = await gbrain(homeA, ['import', dir, '--no-embed', '--json'], env);
    expect(json.exitCode).not.toBe(0);
    expectSurvives(json.json, want, 'cli --json', BRAIN_PIN);
    expect(json.json.class).toBe('caller');
    expect(json.json.suggestion).not.toContain('Server-side failure');
    expectHuman((await gbrain(homeA, ['import', dir, '--no-embed'], env)).stderr, json.json, want);
    const malformed = await gbrain(homeA, ['import', dir, '--no-embed', '--json'], { GBRAIN_SOURCE: 'Not A Source' });
    expectSurvives(malformed.json, { ...want, error: 'invalid_source', code: 'invalid_source' }, 'cli --json (malformed id)', BRAIN_PIN);
  }, 120_000);

  test('--brain naming no mount: a suggestion and a mounts-list fix (human and --json)', async () => {
    const want: Expect = { error: 'invalid_params', code: 'invalid_params', fixArgv: ['gbrain', 'mounts', 'list', '--json'] };
    const json = await gbrain(homeA, ['--brain', 'h3-no-such-mount', 'get', MISSING, '--json']);
    expect(json.exitCode).not.toBe(0);
    expectSurvives(json.json, want, 'cli --json');
    expect(json.json.suggestion).toContain('gbrain mounts list');
    expectHuman((await gbrain(homeA, ['--brain', 'h3-no-such-mount', 'get', MISSING])).stderr, json.json, want);
  }, 90_000);
});

describe('withRelationGuard (REAL: the job table is gone)', () => {
  const want: Expect = { error: 'unavailable', code: 'unavailable', fixArgv: DOCTOR };

  test('gbrain call, the stdio serve and serve-http all carry error, code and the diagnostic fix', async () => {
    const drop = async (engine: PGLiteEngine) => { await engine.executeRaw('DROP TABLE IF EXISTS minion_jobs CASCADE'); };
    const a = new PGLiteEngine();
    await a.connect({ engine: 'pglite', database_path: join(homeA, '.gbrain', 'brain.pglite') });
    try { await drop(a); } finally { await a.disconnect(); }

    const call = await gbrain(homeA, ['call', 'get_job_stats', '{}']);
    expect(call.exitCode).toBe(1);
    expectSurvives(call.json, want, 'gbrain call', BRAIN_PIN);
    expect(call.json.message).toContain('a required table is missing');
    // The suggestion is rendered from the fix: it quotes the fix command and names no other one.
    expect(call.json.suggestion).toContain(call.json.fix.command);
    expect(call.json.suggestion).not.toContain('apply-migrations');
    expect(call.json.docs_cmd).toEqual(['gbrain', 'errors', 'unavailable']);
    expect(call.stderr).toContain('Error [unavailable]');

    const stdio = await stdioSession(homeA, async c => envelopeOf(await stdioCall(c, 'get_job_stats', {})));
    expectSurvives(stdio, want, 'stdio serve', BRAIN_PIN);

    await drop(engineB);
    const http = envelopeOf(await callTool(serve.base, adminToken, 'get_job_stats', {}));
    expectSurvives(http, want, 'serve-http');
    expect(http.fix).toMatchObject({ mcp: { tool: 'run_doctor', arguments: {} }, actor: 'host_admin' });
  }, 180_000);
});

describe('a real OperationError built with opError round-trips the thin client unchanged', () => {
  test('frozen legacy pair over HTTP: error keeps the legacy value, code is canonical', async () => {
    const handler: Operation['handler'] = async () => { throw opError('not_found', 'Job 42 not found.', 'List jobs to find the id.', { legacy_error: 'invalid_params' }); };
    const remote = await withOpHandler(OP, handler, () => callRemoteTool(thinClientConfig(serve, oauth), OP, {}).catch(e => e)) as RemoteMcpError;
    expect(remote.toJSON()).toMatchObject({ error: 'invalid_params', code: 'not_found' });
    expect(JSON.parse(renderCliError(remote, { json: true, command: 'h3', tty: false }).stdout!)).toMatchObject({ error: 'invalid_params', code: 'not_found' });
  }, 60_000);
});
