/**
 * `harness_wiring` (agent-first operator wave G5 step 2 / Lane E): is an agent
 * harness wired to this brain, and does the registration actually answer?
 *
 * Engine-free and read-only. The full doctor run only READS the registration
 * (Claude Code `~/.claude.json`, Codex `config.toml`, opencode `opencode.json`)
 * and reports it; `gbrain doctor --only harness_wiring` adds the smoke test:
 * a live `gbrain serve` holding this brain's lock → pass (`wired_running`);
 * otherwise spawn the registered argv (15 s bound) and run initialize +
 * tools/list + `recall {query:"gbrain install check", limit:1}` (an empty
 * result passes). A `gbrain_status` reply (status-only serve) is reported with
 * its reason and fix. A live status-only `serve --http` (its marker under
 * GBRAIN_HOME, answering `/health` 503 as that instance within 500 ms) is
 * reported first as `serve_status_only` (transport http) with the status
 * reason's fix. Doctor seeds nothing; the only file it removes is a status
 * marker whose process is gone.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { gbrainPath, loadConfig } from '../../../core/config.ts';
import { peekLock } from '../../../core/pglite-lock.ts';
import { harnessWiringEntry, httpStatusServerEntry, type ReadinessHarness } from '../../../core/readiness.ts';
import { verifiedStatusMarkers } from '../../../core/serve-http-status-marker.ts';
import { agentProcessMarker } from '../../../core/interaction.ts';
import { resolveGbrainBin } from '../../../core/gbrain-bin.ts';
import { enabledPluginLanes } from '../../../core/bootstrap/plugin-lanes.ts';
import { claudeConfigDir } from '../../../core/bootstrap/host-specs.ts';
import type { Action } from '../../../core/agent-output.ts';
import type { Check } from '../../doctor.ts';
import { checkError, doctorVerify, infoCheck } from '../check-fix.ts';
import type { DoctorContext, DoctorEntry } from '../context.ts';

export const HARNESS_SMOKE_TIMEOUT_MS = 15_000;
const NAME = 'harness_wiring';
const SMOKE_QUERY = 'gbrain install check';
const STATUS_TOOL = 'gbrain_status';
const RECALL_TOOL = 'recall';

export interface HarnessRegistration {
  harness: ReadinessHarness;
  /** Where it was read from (config file path). */
  source: string;
  kind: 'stdio' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

const HARNESS_LABEL: Record<ReadinessHarness, string> = { 'claude-code': 'Claude Code', codex: 'Codex', opencode: 'opencode' };

function home(): string { return process.env.HOME || homedir(); }

function readJson(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null;
  try {
    const text = readFileSync(path, 'utf8').replace(/^\s*\/\/.*$/gm, '');
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function strings(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : undefined;
}

function stringRecord(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) if (typeof val === 'string') out[k] = val;
  return out;
}

function claudeRegistration(name: string): HarnessRegistration | null {
  const path = join(home(), '.claude.json');
  const cfg = readJson(path) as { mcpServers?: Record<string, unknown>; projects?: Record<string, { mcpServers?: Record<string, unknown> }> } | null;
  if (!cfg) return null;
  const candidates = [cfg.mcpServers?.[name], ...Object.values(cfg.projects ?? {}).map((p) => p?.mcpServers?.[name])];
  const entry = candidates.find((c) => c && typeof c === 'object') as Record<string, unknown> | undefined;
  if (!entry) return null;
  if (typeof entry.url === 'string') return { harness: 'claude-code', source: path, kind: 'http', url: entry.url };
  if (typeof entry.command !== 'string') return null;
  return { harness: 'claude-code', source: path, kind: 'stdio', command: entry.command, args: strings(entry.args) ?? [], env: stringRecord(entry.env) };
}

/** `[mcp_servers.<name>]` from Codex's config.toml: the `command`/`args`/`url`/`env` keys only. */
export function parseCodexRegistration(text: string, name: string, source: string): HarnessRegistration | null {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const headers = new Set([`[mcp_servers.${name}]`, `[mcp_servers."${name}"]`]);
  const start = lines.findIndex((l) => headers.has(l.trim()));
  if (start < 0) return null;
  const body: string[] = [];
  for (let i = start + 1; i < lines.length && !lines[i].trim().startsWith('['); i++) body.push(lines[i].trim());
  const value = (key: string): string | undefined => {
    const line = body.find((l) => l.startsWith(key) && l.slice(key.length).trimStart().startsWith('='));
    return line?.slice(line.indexOf('=') + 1).trim();
  };
  const parse = (raw: string | undefined): unknown => {
    if (raw === undefined) return undefined;
    try { return JSON.parse(raw.replace(/^'(.*)'$/, '"$1"')); } catch { return undefined; }
  };
  const url = parse(value('url'));
  if (typeof url === 'string') return { harness: 'codex', source, kind: 'http', url };
  const command = parse(value('command'));
  if (typeof command !== 'string') return null;
  const envLine = value('env');
  const env = envLine ? stringRecord(parse(envLine.replace(/(\w+)\s*=/g, '"$1":').replace(/^\{/, '{'))) : undefined;
  return { harness: 'codex', source, kind: 'stdio', command, args: strings(parse(value('args'))) ?? [], env };
}

function codexRegistration(name: string): HarnessRegistration | null {
  const path = join(process.env.CODEX_HOME || join(home(), '.codex'), 'config.toml');
  if (!existsSync(path)) return null;
  try { return parseCodexRegistration(readFileSync(path, 'utf8'), name, path); } catch { return null; }
}

function opencodeRegistration(name: string): HarnessRegistration | null {
  const path = join(process.env.XDG_CONFIG_HOME || join(home(), '.config'), 'opencode', 'opencode.json');
  const cfg = readJson(path) as { mcp?: Record<string, Record<string, unknown>> } | null;
  const entry = cfg?.mcp?.[name];
  if (!entry) return null;
  if (typeof entry.url === 'string') return { harness: 'opencode', source: path, kind: 'http', url: entry.url };
  const argv = strings(entry.command);
  if (!argv?.length) return null;
  return { harness: 'opencode', source: path, kind: 'stdio', command: argv[0], args: argv.slice(1), env: stringRecord(entry.environment) };
}

/** Every gbrain MCP registration this machine's harness configs carry. */
export function readHarnessRegistrations(name = 'gbrain'): HarnessRegistration[] {
  return [claudeRegistration(name), codexRegistration(name), opencodeRegistration(name)].filter((r): r is HarnessRegistration => r !== null);
}

/** Harnesses installed on this machine: the active agent marker, else their config files. */
function detectedHarnesses(): ReadinessHarness[] {
  const marker = agentProcessMarker();
  if (marker) {
    if (marker.startsWith('CLAUDE')) return ['claude-code'];
    if (marker.startsWith('CODEX')) return ['codex'];
    return ['opencode'];
  }
  const out: ReadinessHarness[] = [];
  if (existsSync(join(home(), '.claude.json')) || existsSync(join(home(), '.claude')) || existsSync(claudeConfigDir())) out.push('claude-code');
  if (existsSync(process.env.CODEX_HOME || join(home(), '.codex'))) out.push('codex');
  if (existsSync(join(process.env.XDG_CONFIG_HOME || join(home(), '.config'), 'opencode'))) out.push('opencode');
  return out;
}

function brainLock(): ReturnType<typeof peekLock> | null {
  try {
    const cfg = loadConfig();
    if (!cfg || cfg.engine !== 'pglite' || cfg.database_url || cfg.remote_mcp) return null;
    return peekLock(cfg.database_path ?? gbrainPath('brain.pglite'));
  } catch {
    return null;
  }
}

function describeRegistration(r: HarnessRegistration): string {
  return r.kind === 'http' ? `${HARNESS_LABEL[r.harness]} → ${r.url}` : `${HARNESS_LABEL[r.harness]} → ${[r.command, ...(r.args ?? [])].join(' ')}`;
}

function rewireFix(r: HarnessRegistration): Action | undefined {
  const bin = resolveGbrainBin();
  return harnessWiringEntry({ transport: 'cli', harnesses: [r.harness], lockOwner: null, gbrainBin: bin }).fix;
}

interface SmokeOutcome { ok: boolean; reason: string; message: string; fix?: Action }

/** Spawn the registered stdio argv and run initialize + tools/list + recall. Never throws. */
export async function smokeStdioRegistration(r: HarnessRegistration, timeoutMs = HARNESS_SMOKE_TIMEOUT_MS): Promise<SmokeOutcome> {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (typeof v === 'string') env[k] = v;
  Object.assign(env, r.env ?? {});
  const transport = new StdioClientTransport({ command: r.command!, args: r.args ?? [], env, stderr: 'pipe' });
  const client = new Client({ name: 'gbrain-doctor-harness-smoke', version: '1' }, { capabilities: {} });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<SmokeOutcome>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, reason: 'smoke_timeout', message: `The registered server did not answer within ${timeoutMs / 1000}s.` }), timeoutMs);
  });
  const run = (async (): Promise<SmokeOutcome> => {
    await client.connect(transport);
    const tools = (await client.listTools()).tools.map((t) => t.name);
    if (tools.includes(STATUS_TOOL) && !tools.includes(RECALL_TOOL)) {
      const res = await client.callTool({ name: STATUS_TOOL, arguments: {} });
      const text = (res.content as Array<{ type: string; text?: string }>)?.[0]?.text ?? '';
      let status: { reason?: string; why?: string; fix?: Action } = {};
      try { status = JSON.parse(text); } catch { /* prose status */ }
      return { ok: false, reason: status.reason ?? 'status_only', message: `The server started in status-only mode: ${status.why ?? text}`, ...(status.fix ? { fix: status.fix } : {}) };
    }
    if (!tools.includes(RECALL_TOOL)) return { ok: false, reason: 'recall_missing', message: `The server answered but does not list recall (tools: ${tools.slice(0, 8).join(', ')}).` };
    const res = await client.callTool({ name: RECALL_TOOL, arguments: { query: SMOKE_QUERY, limit: 1 } });
    if (res.isError) {
      const text = (res.content as Array<{ type: string; text?: string }>)?.[0]?.text ?? '';
      return { ok: false, reason: 'recall_failed', message: `recall returned an error: ${text.slice(0, 300)}` };
    }
    return { ok: true, reason: 'smoke_passed', message: `initialize, tools/list (${tools.length} tools) and recall answered.` };
  })().catch((e: unknown): SmokeOutcome => ({
    ok: false, reason: 'spawn_failed', message: `The registered server did not complete the MCP handshake: ${e instanceof Error ? e.message : String(e)}`,
  }));
  try {
    return await Promise.race([run, timeout]);
  } finally {
    clearTimeout(timer);
    await client.close().catch(() => {});
    await transport.close().catch(() => {});
  }
}

async function smoke(r: HarnessRegistration): Promise<Check> {
  const details = { harness: r.harness, registration: r.source, kind: r.kind };
  const lock = brainLock();
  if (lock?.held && lock.isServe) {
    const transport = lock.http ? 'serve --http' : 'stdio serve';
    if (r.kind === 'http' && !lock.http) {
      const fix = rewireFix(r);
      return { name: NAME, status: 'warn', message: `${describeRegistration(r)} is registered over HTTP, but the live server (PID ${lock.pid}) is a stdio serve, so the HTTP endpoint cannot answer.`,
        details: { ...details, reason: 'http_serve_missing' }, ...(fix ? { fix } : { fix_unavailable_reason: 'no_safe_automatic_fix' as const }) };
    }
    return { name: NAME, status: 'ok', message: `${describeRegistration(r)}: a live gbrain ${transport} (PID ${lock.pid}) holds this brain.`, details: { ...details, reason: 'wired_running' } };
  }
  if (r.kind === 'http') {
    return { name: NAME, status: 'warn', message: `${describeRegistration(r)} is registered, but no \`gbrain serve --http\` is running on this machine, so new sessions get no memory tools.`,
      details: { ...details, reason: 'http_serve_missing' },
      fix: { argv: ['gbrain', 'serve', '--http'], consent: [], actor: 'user', requires_exclusive: true, verify: doctorVerify(NAME),
        why: 'The registration points at the shared HTTP server; it must be running (a long-lived process, so the user or a service manager starts it).',
        user_message: 'gbrain\'s shared memory server is not running. Please start `gbrain serve --http` (or its service) so your agent sessions can reach memory.' } };
  }
  const outcome = await smokeStdioRegistration(r);
  if (outcome.ok) return { name: NAME, status: 'ok', message: `${describeRegistration(r)}: ${outcome.message}`, details: { ...details, reason: 'wired_running', smoke: outcome.reason } };
  const fix = outcome.fix ?? rewireFix(r);
  return { name: NAME, status: 'warn', message: `${describeRegistration(r)}: ${outcome.message}`, details: { ...details, reason: outcome.reason },
    ...(fix ? { fix } : { fix_unavailable_reason: 'no_safe_automatic_fix' as const }) };
}

/** Registration read (full run) or registration read + smoke (`--only harness_wiring`). */
export async function harnessWiringCheck(opts: { smoke: boolean }): Promise<Check> {
  // A shared HTTP server that answers in status-only mode outranks every registration verdict.
  const statusServer = (await verifiedStatusMarkers())[0];
  if (statusServer) {
    const entry = httpStatusServerEntry(statusServer);
    return { name: NAME, status: 'warn', message: entry.why, ...(entry.fix ? { fix: entry.fix } : { fix_unavailable_reason: 'no_safe_automatic_fix' as const }),
      details: { reason: entry.reason, transport: 'http', port: statusServer.port, pid: statusServer.pid, status_reason: statusServer.reason } };
  }
  const regs = readHarnessRegistrations();
  if (regs.length === 0) {
    const detected = detectedHarnesses();
    const plugins = enabledPluginLanes('gbrain').filter((lane) => detected.includes(lane.harness));
    const harnesses = detected.filter((h) => !plugins.some((lane) => lane.harness === h));
    if (detected.length > 0 && harnesses.length === 0) {
      return { name: NAME, status: 'ok',
        message: `${plugins.map((p) => `${HARNESS_LABEL[p.harness]} gets gbrain from the enabled '${p.plugin}' plugin`).join('; ')}. Enabled is a config signal: doctor does not smoke-test plugin lanes, so verify by starting a new session in that app and checking that gbrain's tools (recall, remember) are listed.`,
        details: { reason: 'plugin_lane_enabled', plugins: plugins.map((p) => p.plugin), harnesses: plugins.map((p) => p.harness),
          verify: 'start a new session in the harness and list its tools; gbrain\'s recall and remember should appear' } };
    }
    const lock = brainLock();
    const lockOwner = lock?.held && lock.isServe && lock.pid !== undefined ? { pid: lock.pid, transport: lock.http ? 'http' as const : 'stdio' as const, is_self: false } : null;
    const entry = harnessWiringEntry({ transport: 'cli', harnesses, lockOwner, gbrainBin: resolveGbrainBin() });
    if (harnesses.length === 0) return infoCheck(NAME, `${entry.why} Wire one when the user picks an agent app.`, entry.state, entry.fix, { reason: entry.reason });
    return { name: NAME, status: 'warn', message: `${harnesses.map((h) => HARNESS_LABEL[h]).join(', ')} ${harnesses.length > 1 ? 'are' : 'is'} installed but ${harnesses.length > 1 ? 'have' : 'has'} no gbrain MCP registration, so its sessions get no memory tools. ${entry.why}`,
      details: { reason: entry.reason }, ...(entry.fix ? { fix: entry.fix } : { fix_unavailable_reason: 'no_safe_automatic_fix' as const }) };
  }
  const bare = regs.find((r) => r.kind === 'stdio' && r.command && !isAbsolute(r.command) && r.command !== 'bun' && r.command !== 'node');
  if (bare) {
    const fix = rewireFix(bare);
    return { name: NAME, status: 'warn', message: `${describeRegistration(bare)} registers a bare \`${bare.command}\`; GUI-launched harnesses inherit no PATH, so it may not start. Re-register with the absolute binary.`,
      details: { harness: bare.harness, registration: bare.source, reason: 'bare_binary' }, ...(fix ? { fix } : { fix_unavailable_reason: 'no_safe_automatic_fix' as const }) };
  }
  const active = detectedHarnesses()[0];
  const primary = regs.find((r) => r.harness === active) ?? regs[0];
  if (opts.smoke) return smoke(primary);
  return { name: NAME, status: 'ok', message: `Registered: ${regs.map(describeRegistration).join('; ')}. Smoke-test it with \`gbrain doctor --only harness_wiring\`.`,
    details: { reason: 'registration_unverified', harnesses: regs.map((r) => r.harness) } };
}

async function runHarnessWiring(ctx: DoctorContext): Promise<Check[]> {
  const checks: Check[] = [];
  try {
    checks.push(await harnessWiringCheck({ smoke: !!ctx.only?.has('harness_wiring') }));
  } catch (e) {
    checks.push(checkError('harness_wiring', 'read the harness registrations', e));
  }
  return checks;
}

export const harnessWiringDoctorEntry: DoctorEntry = {
  name: 'harness_wiring',
  emits: ['harness_wiring'],
  run: runHarnessWiring,
};
