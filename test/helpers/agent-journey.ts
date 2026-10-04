/**
 * Shared harness for the Lane H agent journeys (docs/designs/AGENT_OPERATOR_WAVE.md
 * "Lane H"): the real CLI as a subprocess and real stdio MCP sessions against a
 * keyless PGLite brain in a hermetic HOME, the way an agent harness drives gbrain.
 *
 * - `gb()` runs `bun --no-env-file run src/cli.ts …` with stdin either closed
 *   (`</dev/null`) or an open pipe that never writes (a harness that forgot to
 *   close stdin), under a hard SIGKILL timeout, and times the run.
 * - `mcp()` opens a real `gbrain serve` over stdio with the MCP SDK client.
 * - `journeyGolden()` freezes a normalised wire value under
 *   test/fixtures/agent-contract/v1/journey/ (paths, pids, ids and times become
 *   placeholders; `next` is never stored, like the A0 goldens). The protocol
 *   page's journey transcripts are generated from these files
 *   (scripts/build-agent-protocol.ts). Regenerate: GBRAIN_TEST_UPDATE_GOLDENS=1.
 */
import { expect } from 'bun:test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { keylessBrainEnv } from './provider-env.ts';

export const REPO = join(import.meta.dir, '..', '..');
const CLI = join(REPO, 'src', 'cli.ts');
export const JOURNEY_GOLDENS = join(REPO, 'test', 'fixtures', 'agent-contract', 'v1', 'journey');

export type StdinMode = 'devnull' | 'silent';

/**
 * Process-scoped agent markers (src/core/interaction.ts) and harness config
 * homes: harness detection reads them, so a test runner inside an agent or
 * with a real harness config must not leak them into the journey.
 */
const AMBIENT_HARNESS = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CODEX_SANDBOX', 'CODEX_CI', 'OPENCODE', 'OPENCODE_PID',
  'CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME'];

/** Hermetic keyless env: no provider keys, no database URLs, no agent markers or harness config homes, no ambient GBRAIN_* routing (brain, source, surface…). */
export function journeyEnv(home: string, extra: Record<string, string | undefined> = {}): Record<string, string> {
  const env = keylessBrainEnv(process.env, home);
  for (const key of Object.keys(env)) {
    if (key.startsWith('GBRAIN_') || key === 'DATABASE_URL' || key === 'LLMS_REPO_BASE' || AMBIENT_HARNESS.includes(key)) delete env[key];
  }
  env.HOME = home;
  env.GBRAIN_HOME = home;
  env.GBRAIN_SKIP_STARTUP_HOOKS = '1';
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

export interface GbResult { exitCode: number; stdout: string; stderr: string; ms: number; killed: boolean }

/** One CLI invocation as a non-TTY agent shell runs it. Fails the test if the hard timeout had to kill it. */
export async function gb(home: string, args: string[], opts: { stdin?: StdinMode; cwd?: string; timeoutMs?: number; env?: Record<string, string | undefined> } = {}): Promise<GbResult> {
  const t0 = performance.now();
  const proc = Bun.spawn(['bun', '--no-env-file', 'run', CLI, ...args], {
    cwd: opts.cwd ?? home,
    env: journeyEnv(home, opts.env),
    stdin: opts.stdin === 'silent' ? 'pipe' : Bun.file('/dev/null'),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  let killed = false;
  const killer = setTimeout(() => { killed = true; try { proc.kill('SIGKILL'); } catch { /* gone */ } }, opts.timeoutMs ?? 90_000);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    const res = { exitCode, stdout, stderr, ms: Math.round(performance.now() - t0), killed };
    expect(killed, `gbrain ${args.join(' ')} hung (stdin ${opts.stdin ?? 'devnull'}) and was killed:\n${stderr.slice(-2000)}`).toBe(false);
    return res;
  } finally {
    clearTimeout(killer);
    if (opts.stdin === 'silent') try { (proc.stdin as { end?: () => void }).end?.(); } catch { /* closed */ }
  }
}

/** stdout of a `--json` invocation must be exactly one JSON document. */
export function oneDocument(r: GbResult, label: string): Record<string, any> {
  try {
    const doc = JSON.parse(r.stdout);
    expect(doc !== null && typeof doc === 'object', `${label}: --json stdout is not an object`).toBe(true);
    return doc;
  } catch (e) {
    throw new Error(`${label}: --json stdout is not one JSON document (exit ${r.exitCode}): ${String(e)}\nstdout: ${r.stdout.slice(0, 1500)}\nstderr: ${r.stderr.slice(-1500)}`);
  }
}

export interface McpSession {
  client: Client;
  pid: number;
  initMs: number;
  stderr: () => string;
  close: () => Promise<void>;
}

/** A real `gbrain serve` on stdio, initialised (handshake done) with the SDK client. */
export async function mcp(home: string, serveArgs: string[] = [], opts: { cwd?: string; env?: Record<string, string | undefined> } = {}): Promise<McpSession> {
  const transport = new StdioClientTransport({
    command: 'bun', args: ['--no-env-file', 'run', CLI, 'serve', ...serveArgs],
    cwd: opts.cwd ?? home, env: journeyEnv(home, opts.env), stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
  const client = new Client({ name: 'agent-journey', version: '1.0.0' }, { capabilities: {} });
  const t0 = performance.now();
  await client.connect(transport);
  const initMs = Math.round(performance.now() - t0);
  return {
    client, pid: transport.pid ?? -1, initMs, stderr: () => stderr,
    close: async () => { try { await client.close(); } catch { /* best-effort */ } },
  };
}

export interface ToolResult { content: Array<{ type: string; text: string }>; isError?: boolean; _meta?: Record<string, any> }

export async function call(s: McpSession, name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  return await s.client.callTool({ name, arguments: args }) as unknown as ToolResult;
}

/** content[0] parsed: the result body, or the error envelope of an isError result. */
export function body(r: ToolResult): any {
  return JSON.parse(r.content[0].text);
}

export const NOTICE_PREFIX = '[gbrain notice ';

/** The prefixed notice blocks after content[0]. */
export function noticeBlocks(r: ToolResult): string[] {
  return r.content.slice(1).map(c => c.text).filter(t => t.startsWith(NOTICE_PREFIX));
}

/** Error results are exactly one content block holding the v1 envelope (A6). */
export function expectOneBlockError(r: ToolResult, label: string): any {
  expect(r.isError, `${label}: isError`).toBe(true);
  expect(r.content.length, `${label}: an error result is one content block`).toBe(1);
  const env = body(r);
  expect(env.contract_version, `${label}: contract_version`).toBe(1);
  expect(typeof env.code, `${label}: code`).toBe('string');
  expect(typeof env.suggestion, `${label}: suggestion`).toBe('string');
  return env;
}

export async function waitFor(pred: () => Promise<boolean> | boolean, ms = 30_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await pred()) return true;
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

// ── journey goldens ────────────────────────────────────────────────────────

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const ISO = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}(?::?\d{2})?)?/g;
const DOCS = /https:\/\/github\.com\/garrytan\/gbrain\/blob\/[^/\s"]+/g;
const VOLATILE_KEYS = new Set(['duration_s', 'root_identity', 'plan_hash', 'doctor_run_id']);

export interface GoldenVars { home: string; pids?: number[] }

function normaliseString(s: string, v: GoldenVars): string {
  let out = s.split(v.home).join('{{HOME}}').replace(DOCS, '{{DOCS_BASE}}').replace(UUID, '{{UUID}}').replace(ISO, '{{TIME}}')
    .replace(/ph_[0-9a-f]{24}/g, '{{PLAN_HASH}}');
  for (const pid of v.pids ?? []) out = out.replace(new RegExp(`\\b${pid}\\b`, 'g'), '{{PID}}');
  return out.replace(/^next: [a-z_]+$/m, 'next: {{next}}');
}

/** Paths, pids, ids, times and plan hashes become placeholders; `next` is stripped (computed at render time). */
export function normaliseWire(value: unknown, v: GoldenVars): unknown {
  if (Array.isArray(value)) return value.map(x => normaliseWire(x, v));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(value as Record<string, unknown>)) {
      if (k === 'next') continue;
      if (VOLATILE_KEYS.has(k)) { out[k] = `{{${k.toUpperCase()}}}`; continue; }
      if ((k === 'pid' || k === 'lock_owner_pid') && typeof x === 'number' && (v.pids ?? []).includes(x)) { out[k] = '{{PID}}'; continue; }
      out[k] = normaliseWire(x, v);
    }
    return out;
  }
  if (typeof value === 'string') {
    const t = value.trimStart();
    if (t.startsWith('{') || t.startsWith('[')) {
      try { return JSON.stringify(normaliseWire(JSON.parse(value), v), null, 2); } catch { /* prose */ }
    }
    return normaliseString(value, v);
  }
  return value;
}

/** Compare (or, with GBRAIN_TEST_UPDATE_GOLDENS=1, rewrite) one journey golden. */
export function journeyGolden(name: string, actual: unknown, vars: GoldenVars): void {
  const path = join(JOURNEY_GOLDENS, name);
  const text = `${JSON.stringify(normaliseWire(actual, vars), null, 2)}\n`;
  if (process.env.GBRAIN_TEST_UPDATE_GOLDENS === '1') {
    mkdirSync(JOURNEY_GOLDENS, { recursive: true });
    writeFileSync(path, text);
  }
  expect(text, `journey golden ${name} drifted; if the change is intended, regenerate with GBRAIN_TEST_UPDATE_GOLDENS=1 and run bun run build:agent-protocol`).toBe(readFileSync(path, 'utf8'));
}
