/**
 * Child-process plumbing for engine graduation tests and measurements: the
 * real CLI (`bun src/cli.ts`) or another binary with an isolated
 * HOME/GBRAIN_HOME and no provider keys or ambient database URLs, optional
 * boundary hooks (test/helpers/graduation-hooks-preload.ts), MCP stdio and
 * HTTP clients, and the accessors that read the graduation JSON contract.
 * Shared by test/e2e/graduation-*.test.ts and graduation-ttv.ts.
 */
import { join, resolve } from 'node:path';

export const REPO = resolve(import.meta.dir, '..', '..');
export const CLI = join(REPO, 'src', 'cli.ts');
export const PRELOAD = join(REPO, 'test', 'helpers', 'graduation-hooks-preload.ts');

const PROVIDER_KEYS = /^(OPENAI|ANTHROPIC|VOYAGE|GEMINI|GOOGLE|TYPESAFE|JEV_TYPESAFE|OPENROUTER|GROQ|MISTRAL|COHERE|DEEPSEEK|XAI)_/;

export interface GbrainResult { code: number; signal: string | null; stdout: string; stderr: string; json: Record<string, any> | null; ms: number }
export interface GbrainOpts {
  home: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  /** Load the boundary-hook preload; `pause` names boundaries to stop at. */
  hooks?: { events: string; pause?: string[] };
  stdin?: string;
  /** Run another binary (an older release) instead of `bun src/cli.ts`. */
  binary?: string;
}

function childEnv(opts: GbrainOpts): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !PROVIDER_KEYS.test(k)) env[k] = v;
  delete env.DATABASE_URL; delete env.GBRAIN_DATABASE_URL; delete env.GBRAIN_DIRECT_DATABASE_URL; delete env.GBRAIN_REMOTE_CLIENT_SECRET;
  Object.assign(env, { HOME: opts.home, GBRAIN_HOME: opts.home, GBRAIN_SKIP_STARTUP_HOOKS: '1', NO_COLOR: '1' });
  if (opts.hooks) {
    env.GBRAIN_TEST_GRADUATION_EVENTS = opts.hooks.events;
    env.GBRAIN_TEST_GRADUATION_PAUSE = (opts.hooks.pause ?? []).join(',');
  }
  for (const [k, v] of Object.entries(opts.env ?? {})) { if (v === undefined) delete env[k]; else env[k] = v; }
  return env;
}

function command(argv: string[], opts: GbrainOpts): string[] {
  if (opts.binary) return [opts.binary, ...argv];
  return [process.execPath, '--no-env-file', ...(opts.hooks ? ['--preload', PRELOAD] : []), CLI, ...argv];
}

/** The last top-level JSON document on stdout (the `--json` contract prints exactly one). */
export function jsonDoc(stdout: string): Record<string, any> | null {
  const text = stdout.trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const start = text.lastIndexOf('\n{');
  try { return JSON.parse(start >= 0 ? text.slice(start + 1) : text); } catch { return null; }
}

export interface GbrainChild {
  pid: number;
  exited: Promise<GbrainResult>;
  kill(signal?: NodeJS.Signals): void;
}

export function startGbrain(argv: string[], opts: GbrainOpts): GbrainChild {
  const started = Date.now();
  const child = Bun.spawn(command(argv, opts), { cwd: REPO, env: childEnv(opts), stdin: opts.stdin === undefined ? 'ignore' : new TextEncoder().encode(opts.stdin),
    stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs ?? 600_000);
  const exited = (async () => {
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    await child.exited;
    clearTimeout(timer);
    return { code: child.exitCode ?? -1, signal: child.signalCode ?? null, stdout, stderr, json: jsonDoc(stdout), ms: Date.now() - started };
  })();
  return { pid: child.pid, exited, kill: (signal = 'SIGKILL') => { if (child.exitCode === null) child.kill(signal); } };
}

export async function gbrain(argv: string[], opts: GbrainOpts): Promise<GbrainResult> {
  return startGbrain(argv, opts).exited;
}

// ── Contract accessors (one place to fix if the CLI's JSON names move) ───────

export const planHashOf = (doc: Record<string, any> | null): string | undefined =>
  doc?.plan_hash ?? doc?.planHash ?? doc?.plan?.plan_hash ?? doc?.plan?.planHash ?? doc?.fix?.plan_hash ?? doc?.data?.plan_hash;
export const codeOf = (doc: Record<string, any> | null): string | undefined => doc?.code ?? doc?.error?.code ?? doc?.error;
export const fixOf = (doc: Record<string, any> | null): Record<string, any> | undefined => doc?.fix ?? doc?.error?.fix;
export const stateOf = (doc: Record<string, any> | null): string | undefined =>
  doc?.state ?? doc?.graduation?.state ?? doc?.manifest?.state ?? doc?.status?.state;

// ── MCP clients ───────────────────────────────────────────────────────────────

function parseRpc(text: string): Record<string, any> {
  const data = text.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).pop();
  return JSON.parse(data ?? text);
}

/** One stateless JSON-RPC tools/call against `foresights serve --http`. */
export async function mcpHttpCall(base: string, token: string, tool: string, args: Record<string, unknown> = {}): Promise<{ status: number; rpc: Record<string, any> | null }> {
  const res = await fetch(`${base}/mcp`, { method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: tool, arguments: args } }) });
  const text = await res.text();
  let rpc: Record<string, any> | null = null;
  try { rpc = parseRpc(text); } catch {}
  return { status: res.status, rpc };
}

export interface StdioSession {
  /** Resolves with the JSON-RPC response, or with null when serve exited first. */
  call(tool: string, args?: Record<string, unknown>): Promise<Record<string, any> | null>;
  close(): Promise<GbrainResult>;
  exited: Promise<GbrainResult>;
}

/** `foresights serve` over stdio, initialized, as an MCP host would launch it. */
export async function mcpStdioSession(opts: GbrainOpts & { argv?: string[] }): Promise<StdioSession> {
  const started = Date.now();
  const child = Bun.spawn(command(['serve', ...(opts.argv ?? [])], opts), { cwd: REPO, env: childEnv(opts), stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  const pending = new Map<number, (value: Record<string, any> | null) => void>();
  let stdout = '';
  let id = 0;
  const reading = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of child.stdout) {
      stdout += decoder.decode(chunk);
      let nl: number;
      while ((nl = stdout.indexOf('\n')) >= 0) {
        const line = stdout.slice(0, nl); stdout = stdout.slice(nl + 1);
        try { const msg = JSON.parse(line); pending.get(msg.id)?.(msg); pending.delete(msg.id); } catch {}
      }
    }
  })();
  const exited = (async () => {
    const stderr = await new Response(child.stderr).text();
    await child.exited; await reading;
    for (const resolve of pending.values()) resolve(null);
    return { code: child.exitCode ?? -1, signal: child.signalCode ?? null, stdout, stderr, json: jsonDoc(stdout), ms: Date.now() - started };
  })();
  const send = (method: string, params: Record<string, unknown>): Promise<Record<string, any> | null> => {
    const n = ++id;
    const reply = new Promise<Record<string, any> | null>(resolve => pending.set(n, resolve));
    try { child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method, params })}\n`); child.stdin.flush(); } catch { pending.get(n)?.(null); }
    return reply;
  };
  const init = await Promise.race([send('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'graduation-e2e', version: '1' } }), exited.then(() => null)]);
  if (init) { try { child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`); child.stdin.flush(); } catch {} }
  return {
    call: (tool, args = {}) => Promise.race([send('tools/call', { name: tool, arguments: args }), exited.then(() => null)]),
    async close() { try { child.stdin.end(); } catch {} const t = setTimeout(() => child.kill('SIGKILL'), 10_000); const r = await exited; clearTimeout(t); return r; },
    exited,
  };
}

/** A free TCP port on loopback. */
export function freePort(): number {
  const server = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const port = server.port;
  server.stop(true);
  return port;
}
