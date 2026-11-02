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
 * reason's fix. On a brain with no PGLite lock to consult (Postgres,
 * `database_url`, a `remote_mcp` thin client) an HTTP registration is probed
 * with a credential-free GET of its `/health` (`?deep=1` locally, shallow for
 * a thin client, 3 s, redirects not followed): a gbrain `status: ok` answer is
 * `wired_running` with `mcp_access: 'unverified'` (a listener is proven, the
 * registration's credentials and tool access are not); a refused loopback
 * `http:` port is `http_serve_missing` with the `serve --http` fix; every other
 * outcome is `http_serve_unreachable` / `http_serve_unhealthy` with no fix.
 * Registered URLs are printed without userinfo, query or fragment (#6453).
 * Doctor seeds nothing; the only file it removes is a status marker whose
 * process is gone.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { gbrainPath, loadConfig } from '../../../core/config.ts';
import { peekLock } from '../../../core/pglite-lock.ts';
import { harnessWiringEntry, httpStatusServerEntry, type ReadinessHarness } from '../../../core/readiness.ts';
import { verifiedStatusMarkers } from '../../../core/serve-http-status-marker.ts';
import { agentProcessMarker } from '../../../core/interaction.ts';
import { resolveGbrainBin } from '../../../core/gbrain-bin.ts';
import { enabledPluginLanes } from '../../../core/bootstrap/plugin-lanes.ts';
import { claudeConfigDir, opencodeProjectConfigPath } from '../../../core/bootstrap/host-specs.ts';
import { readReceipt } from '../../../core/bootstrap/format.ts';
import { resolveGbrainHome } from '../../../core/gbrain-home.ts';
import type { Action } from '../../../core/agent-output.ts';
import type { Check } from '../../doctor.ts';
import { checkError, doctorVerify, infoCheck } from '../check-fix.ts';
import type { DoctorContext, DoctorEntry } from '../context.ts';
import { VERSION } from '../../../version.ts';
import { TURN_HOOK_NATIVE_INSPECT, inspectTurnHook, turnHookFix, type TurnHookState } from '../../../core/setup/turn-hook-check.ts';
import { brainFirstTarget, inspectBrainFirst, isBrainFirstHarness, readBrainFirstLedger, renderBrainFirstBlock, type BrainFirstAccess } from '../../../core/setup/brain-first.ts';

export const HARNESS_SMOKE_TIMEOUT_MS = 15_000;
export const HARNESS_HTTP_PROBE_TIMEOUT_MS = 3_000;
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

/** #7422: the install receipt `gbrain bootstrap` keeps (its workspace and the registrations it made), or null. */
function bootstrapReceipt(): ReturnType<typeof readReceipt> {
  try { return readReceipt(resolveGbrainHome()); } catch { return null; }
}

function claudeRegistration(name: string): HarnessRegistration | null {
  const path = join(home(), '.claude.json');
  const cfg = readJson(path) as { mcpServers?: Record<string, unknown>; projects?: Record<string, { mcpServers?: Record<string, unknown> }> } | null;
  const ws = bootstrapReceipt()?.workspace_dir;
  const projectPath = ws ? join(ws, '.mcp.json') : null;
  const project = projectPath ? readJson(projectPath) as { mcpServers?: Record<string, unknown> } | null : null;
  const candidates: Array<[string, unknown]> = [[path, cfg?.mcpServers?.[name]], ...Object.values(cfg?.projects ?? {}).map((p): [string, unknown] => [path, p?.mcpServers?.[name]])];
  if (projectPath) candidates.push([projectPath, project?.mcpServers?.[name]]);
  const [source, entry] = (candidates.find(([, c]) => c && typeof c === 'object') ?? []) as [string?, Record<string, unknown>?];
  if (!source || !entry) return null;
  if (typeof entry.url === 'string') return { harness: 'claude-code', source, kind: 'http', url: entry.url };
  if (typeof entry.command !== 'string') return null;
  return { harness: 'claude-code', source, kind: 'stdio', command: entry.command, args: strings(entry.args) ?? [], env: stringRecord(entry.env) };
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

const codexConfigPath = () => join(process.env.CODEX_HOME || join(home(), '.codex'), 'config.toml');
const opencodeConfigPath = () => join(process.env.XDG_CONFIG_HOME || join(home(), '.config'), 'opencode', 'opencode.json');

function codexRegistration(name: string): HarnessRegistration | null {
  const path = codexConfigPath();
  if (!existsSync(path)) return null;
  try { return parseCodexRegistration(readFileSync(path, 'utf8'), name, path); } catch { return null; }
}

function opencodeRegistration(name: string): HarnessRegistration | null {
  const path = opencodeConfigPath();
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

interface RecordedRegistration { harness: ReadinessHarness; scope: string; config: string }

/**
 * #7422: MCP registrations `gbrain bootstrap` recorded for these harnesses
 * whose config file this process cannot read (a service running under
 * another HOME, a permission): unverified here, not missing. A readable
 * config without the registration is not listed (it was removed).
 */
function recordedUnreadableRegistrations(harnesses: readonly ReadinessHarness[]): RecordedRegistration[] {
  const receipt = bootstrapReceipt();
  if (!receipt) return [];
  const configFor = (harness: ReadinessHarness, scope: string): string => harness === 'claude-code'
    ? (scope === 'project' ? join(receipt.workspace_dir, '.mcp.json') : join(home(), '.claude.json'))
    : harness === 'codex' ? codexConfigPath() : scope === 'project' ? opencodeProjectConfigPath(receipt.workspace_dir) : opencodeConfigPath();
  const readable = (path: string) => { try { readFileSync(path); return true; } catch { return false; } };
  return receipt.registrations
    .filter((r) => harnesses.includes(r.host) && (r.detail?.split('+') ?? []).includes('mcp'))
    .map((r) => ({ harness: r.host, scope: r.scope, config: configFor(r.host, r.scope) }))
    .filter((r) => !readable(r.config));
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

type BrainLockView =
  | { kind: 'pglite'; lock: ReturnType<typeof peekLock> }
  | { kind: 'none'; remote: boolean };

/** The PGLite lock when this brain has one to consult; otherwise which kind of lock-less brain this is. */
function brainLock(): BrainLockView {
  try {
    const cfg = loadConfig();
    if (!cfg) return { kind: 'none', remote: false };
    if (cfg.remote_mcp) return { kind: 'none', remote: true };
    if (cfg.engine !== 'pglite' || cfg.database_url) return { kind: 'none', remote: false };
    return { kind: 'pglite', lock: peekLock(cfg.database_path ?? gbrainPath('brain.pglite')) };
  } catch {
    return { kind: 'none', remote: false };
  }
}

/** A registered URL as doctor prints it: origin and path only, never userinfo, query or fragment. */
export function redactRegistrationUrl(url: string | undefined): string {
  if (!url) return '<no url>';
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return '<unparseable url>';
  }
}

function describeRegistration(r: HarnessRegistration): string {
  return r.kind === 'http' ? `${HARNESS_LABEL[r.harness]} → ${redactRegistrationUrl(r.url)}` : `${HARNESS_LABEL[r.harness]} → ${[r.command, ...(r.args ?? [])].join(' ')}`;
}

function rewireFix(r: HarnessRegistration): Action | undefined {
  const bin = resolveGbrainBin();
  return harnessWiringEntry({ transport: 'cli', harnesses: [r.harness], lockOwner: null, gbrainBin: bin }).fix;
}

interface SmokeOutcome { ok: boolean; reason: string; message: string; fix?: Action; details?: Record<string, unknown> }

const serveHttpFix = (): Action => ({ argv: ['gbrain', 'serve', '--http'], consent: [], actor: 'user', requires_exclusive: true, verify: doctorVerify(NAME),
  why: 'The registration points at the shared HTTP server; it must be running (a long-lived process, so the user or a service manager starts it).',
  user_message: 'gbrain\'s shared memory server is not running. Please start `gbrain serve --http` (or its service) so your agent sessions can reach memory.' });

function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h);
}

function connectionRefused(e: unknown): boolean {
  const codes = [(e as { code?: unknown })?.code, (e as { cause?: { code?: unknown } })?.cause?.code];
  return codes.some((c) => c === 'ECONNREFUSED' || c === 'ConnectionRefused');
}

/**
 * GET the registration's `/health` without any credential from the
 * registration (userinfo, query and `headers` are dropped; the probe URL is
 * built from scheme, host and path only). `/health` proves a listener, not
 * that the registration's token or tool access works, so a healthy answer is
 * reported `mcp_access: 'unverified'`. Never throws; never echoes the URL.
 */
export async function probeHttpRegistration(r: HarnessRegistration, opts: { remote: boolean; timeoutMs?: number }): Promise<SmokeOutcome> {
  const timeoutMs = opts.timeoutMs ?? HARNESS_HTTP_PROBE_TIMEOUT_MS;
  const unreachable = (error: string, extra: Record<string, unknown> = {}): SmokeOutcome => ({
    ok: false, reason: 'http_serve_unreachable', details: { probe: 'health', error, ...extra },
    message: `the registered endpoint did not answer (${error}); MCP access unverified. Doctor cannot tell whether that server should be started here, so check the registration and the server it points at.`,
  });
  let probe: URL;
  try {
    probe = new URL(r.url ?? '');
    probe.username = '';
    probe.password = '';
    probe.hash = '';
    probe.search = opts.remote ? '' : '?deep=1';
    probe.pathname = `${probe.pathname.replace(/\/mcp\/?$/, '').replace(/\/$/, '')}/health`;
  } catch {
    return unreachable('invalid_url');
  }
  const remoteDetail = opts.remote ? { remote: true } : {};
  let res: Response;
  try {
    res = await fetch(probe, { method: 'GET', headers: { accept: 'application/json' }, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
  } catch (e: unknown) {
    if (connectionRefused(e)) {
      if (probe.protocol === 'http:' && isLoopbackHost(probe.hostname)) {
        return { ok: false, reason: 'http_serve_missing', fix: serveHttpFix(), details: { probe: 'health', error: 'connection_refused', ...remoteDetail },
          message: 'is registered, but nothing answers on that local port, so new sessions get no memory tools.' };
      }
      return unreachable('connection_refused', remoteDetail);
    }
    const name = e instanceof Error ? e.name : 'error';
    return unreachable(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : (name === 'TypeError' ? 'connect_failed' : name), remoteDetail);
  }
  const unhealthy = (why: string, extra: Record<string, unknown> = {}): SmokeOutcome => ({
    ok: false, reason: 'http_serve_unhealthy', details: { probe: 'health', http_status: res.status, ...remoteDetail, ...extra },
    message: `the registered endpoint answered, but not as a healthy gbrain server (${why}); MCP access unverified. Doctor does not start a second server on a port something already answers on.`,
  });
  if (res.status >= 300 && res.status < 400) return unhealthy(`HTTP ${res.status} redirect; doctor does not follow redirects`);
  type HealthBody = { status?: unknown; version?: unknown; error_description?: unknown };
  let body: HealthBody | null = null;
  try { body = await res.json() as HealthBody | null; } catch { body = null; }
  if (res.status !== 200 || !body || typeof body !== 'object') {
    const why = body && typeof body.error_description === 'string' ? `HTTP ${res.status}: ${body.error_description.slice(0, 200)}` : `HTTP ${res.status}${body ? '' : ', not a JSON health document'}`;
    return unhealthy(why);
  }
  if (body.status !== 'ok') return unhealthy('a JSON answer without status: ok');
  const version = typeof body.version === 'string' ? body.version : undefined;
  const details: Record<string, unknown> = { probe: 'health', mcp_access: 'unverified', ...remoteDetail, ...(version ? { version } : {}), ...(version && version !== VERSION ? { version_mismatch: true } : {}) };
  return { ok: true, reason: 'wired_running', details,
    message: `endpoint reachable (${probe.pathname}${version ? `, gbrain ${version}` : ''}); MCP access unverified: the health route proves a listener, not that this registration's credentials reach memory tools.` };
}

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
  const view = brainLock();
  if (r.kind === 'http' && view.kind === 'none') {
    const outcome = await probeHttpRegistration(r, { remote: view.remote });
    if (outcome.ok) return { name: NAME, status: 'ok', message: `${describeRegistration(r)}: ${outcome.message}`, details: { ...details, reason: outcome.reason, ...outcome.details } };
    return { name: NAME, status: 'warn', message: `${describeRegistration(r)} ${outcome.message}`, details: { ...details, reason: outcome.reason, ...outcome.details },
      ...(outcome.fix ? { fix: outcome.fix } : { fix_unavailable_reason: 'no_safe_automatic_fix' as const }) };
  }
  const lock = view.kind === 'pglite' ? view.lock : null;
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
      details: { ...details, reason: 'http_serve_missing' }, fix: serveHttpFix() };
  }
  const outcome = await smokeStdioRegistration(r);
  if (outcome.ok) return { name: NAME, status: 'ok', message: `${describeRegistration(r)}: ${outcome.message}`, details: { ...details, reason: 'wired_running', smoke: outcome.reason } };
  const fix = outcome.fix ?? rewireFix(r);
  return { name: NAME, status: 'warn', message: `${describeRegistration(r)}: ${outcome.message}`, details: { ...details, reason: outcome.reason },
    ...(fix ? { fix } : { fix_unavailable_reason: 'no_safe_automatic_fix' as const }) };
}

export interface InstructionBlockView {
  harness: string;
  path: string;
  state: 'current' | 'stale' | 'missing' | 'damaged' | 'opted_out';
  /** Where the record came from: the brain-first ledger, or the harness's default file for a registration with no record. */
  from: 'ledger' | 'default_path';
  /** The access the recorded block names, so the repair rewrites that block and not a default one. */
  access?: BrainFirstAccess;
}

/**
 * The brain-first instruction block for every surface gbrain wrote or was
 * told to skip (the ledger), plus each registered or plugin-served harness
 * with no record, checked at that harness's default instruction file. Read-only.
 */
export function instructionBlockViews(regs: HarnessRegistration[], plugins = enabledPluginLanes('gbrain')): InstructionBlockView[] {
  const state = (s: ReturnType<typeof inspectBrainFirst>['state']): InstructionBlockView['state'] =>
    s === 'current' ? 'current' : s === 'stale' ? 'stale' : s === 'damaged' ? 'damaged' : 'missing';
  const views: InstructionBlockView[] = readBrainFirstLedger().map((e) => {
    // Codex reads one global file: once a non-empty AGENTS.override.md appears, a block in AGENTS.md is no longer loaded.
    const live = e.harness === 'codex' ? brainFirstTarget('codex') : undefined;
    const path = live && !('error' in live) && dirname(live.path) === dirname(e.path) ? live.path : e.path;
    return e.status === 'declined'
      ? { harness: e.harness, path, state: 'opted_out', from: 'ledger' }
      : { harness: e.harness, path, state: state(inspectBrainFirst(path, renderBrainFirstBlock(e.harness, e.access)).state), from: 'ledger', access: e.access };
  });
  for (const harness of [...regs, ...plugins].map((r) => r.harness)) {
    if (views.some((v) => v.harness === harness) || !isBrainFirstHarness(harness)) continue;
    const target = brainFirstTarget(harness);
    if ('error' in target) continue;
    views.push({ harness, path: target.path, state: state(inspectBrainFirst(target.path).state), from: 'default_path' });
  }
  return views;
}

const INSTRUCTION_PROBLEM: Record<'stale' | 'missing' | 'damaged', string> = {
  stale: 'is out of date', missing: 'is missing', damaged: 'has damaged markers',
};

/**
 * Fold the brain-first block into the wiring verdict: without it agents rarely
 * reach for the brain at all, so a missing, stale or damaged block turns an
 * `ok` wiring into a warn whose fix rewrites only the block. An opt-out is
 * reported, never warned on. No views: the check is returned unchanged.
 */
export function withInstructionBlocks(check: Check, views: InstructionBlockView[]): Check {
  if (views.length === 0) return check;
  const details = { ...(check.details ?? {}), instructions: views };
  const bad = views.filter((v): v is InstructionBlockView & { state: 'stale' | 'missing' | 'damaged' } => v.state === 'stale' || v.state === 'missing' || v.state === 'damaged');
  if (bad.length === 0) {
    const current = views.filter((v) => v.state === 'current').map((v) => v.harness);
    const optedOut = views.filter((v) => v.state === 'opted_out').map((v) => v.harness);
    const note = [current.length ? `brain-first instructions current for ${current.join(', ')}` : '', optedOut.length ? `opted out for ${optedOut.join(', ')}` : ''].filter(Boolean).join('; ');
    return { ...check, message: `${check.message} ${note.charAt(0).toUpperCase()}${note.slice(1)}.`, details };
  }
  const first = bad[0]!;
  const problems = bad.map((v) => `the ${v.harness} block in ${v.path} ${INSTRUCTION_PROBLEM[v.state]}`).join('; ');
  const message = `${check.message} Brain-first instructions: ${problems}, so sessions are not told to check gbrain first.`;
  if (check.status !== 'ok') return { ...check, message, details };
  const fix: Action = first.state === 'damaged'
    ? { consent: [], actor: 'user', requires_exclusive: false, verify: doctorVerify(NAME),
      why: `The brain-first markers in ${first.path} were hand-edited; gbrain will not guess which lines are its own.`,
      user_message: `The gbrain instruction block in ${first.path} has damaged markers. Please delete the block (both marker lines included), then I'll write a fresh one.` }
    : repairArgv(first);
  return { name: NAME, status: 'warn', message, details, fix };
}

/** The setup command that rewrites exactly this block: same file, same connection name and surface. A project file needs its own directory, so the user runs it there. */
function repairArgv(v: InstructionBlockView): Action {
  const access = v.access;
  const argv = ['gbrain', 'setup', v.harness, '--instructions-only',
    ...(access?.kind === 'mcp' && access.server !== 'gbrain' ? ['--name', access.server] : []),
    ...(access?.kind === 'mcp' && access.surface ? ['--surface', access.surface] : []),
    ...(v.harness === 'openclaw' ? ['--workspace', dirname(v.path)] : []),
    ...(v.harness === 'claude-code' && basename(v.path) === 'CLAUDE.local.md' ? ['--scope', 'project'] : [])];
  const why = `Writes or upgrades only the marked brain-first block in ${v.path}; text outside the markers is left as it is. \`--no-instructions\` opts out instead.`;
  const project = v.harness === 'cursor' || basename(v.path) === 'CLAUDE.local.md';
  if (project) {
    const dir = v.harness === 'cursor' ? dirname(dirname(dirname(v.path))) : dirname(v.path);
    return { consent: [], actor: 'user', requires_exclusive: false, verify: doctorVerify(NAME), why,
      user_message: `The gbrain instruction block in ${v.path} needs a refresh. From ${dir}, run: ${argv.join(' ')}` };
  }
  return { argv, consent: ['persistent_install'], actor: 'agent', requires_exclusive: false, verify: doctorVerify(NAME), why };
}

/**
 * post-upgrade: one line per wired harness (registration, plugin or ledger)
 * whose brain-first block is missing or out of date, with the setup command
 * that writes only that block. Read-only; an opt-out prints nothing.
 */
export function instructionBlockUpgradeHints(): string[] {
  return instructionBlockViews(readHarnessRegistrations()).filter((v): v is InstructionBlockView & { state: 'missing' | 'stale' } => v.state === 'missing' || v.state === 'stale').map((v) => {
    const fix = repairArgv(v);
    return fix.argv ? `Brain-first instructions: the ${v.harness} block in ${v.path} ${INSTRUCTION_PROBLEM[v.state]}. Run \`${fix.argv.join(' ')}\` to write only that block (\`--no-instructions\` opts out).` : fix.user_message!;
  });
}

/**
 * The per-turn hook beside every accepted brain-first block on a harness that
 * has one (Claude Code, Codex, OpenClaw, Hermes). Files only: doctor never runs
 * the hook; the fix names the harness's own inspect command.
 */
export function turnHookViews(views: InstructionBlockView[]): TurnHookState[] {
  return views.filter((v) => (v.state === 'current' || v.state === 'stale') && TURN_HOOK_NATIVE_INSPECT[v.harness])
    .map((v) => inspectTurnHook(v.harness, basename(v.path) === 'CLAUDE.local.md' ? { projectDir: dirname(v.path) } : {}));
}

/** An untrusted per-turn hook, or one missing beside a recorded block, turns an ok wiring into a warn (code turn_hook_not_loaded) whose fix re-runs the install that writes it. */
export function withTurnHooks(check: Check, views: InstructionBlockView[], hooks: TurnHookState[]): Check {
  if (hooks.length === 0) return check;
  const details = { ...(check.details ?? {}), turn_hooks: hooks };
  // Missing beside a block gbrain recorded writing (the ledger) is a failed install; beside an unrecorded default-path block it is only reported.
  const bad = hooks.find((h) => h.state === 'untrusted' || (h.state === 'missing' && views.some((v) => v.harness === h.harness && v.from === 'ledger')));
  if (!bad) return { ...check, details };
  const message = `${check.message} Per-turn hook: ${bad.detail}, so the brain-first rule does not reach each turn (check: ${bad.native_inspect}).`;
  if (check.status !== 'ok') return { ...check, message, details };
  const view = views.find((v) => v.harness === bad.harness);
  const rerun = view ? repairArgv(view).argv : undefined;
  const fix: Action = rerun ? turnHookFix(bad.harness, rerun)
    : { consent: [], actor: 'user', requires_exclusive: false, verify: doctorVerify(NAME), why: turnHookFix(bad.harness, []).why,
      user_message: `The gbrain per-turn hook for ${bad.harness} is not active: ${bad.detail}. From that project directory, run: gbrain setup ${bad.harness} --instructions-only` };
  return { name: NAME, status: 'warn', message, details: { ...details, code: 'turn_hook_not_loaded', turn_hook_reason: bad.state }, fix };
}

/** Registration read (full run) or registration read + smoke (`--only harness_wiring`), plus the brain-first block and its per-turn hook. */
export async function harnessWiringCheck(opts: { smoke: boolean }): Promise<Check> {
  const regs = readHarnessRegistrations();
  const views = instructionBlockViews(regs);
  return withSurfaceNote(withTurnHooks(withInstructionBlocks(await registrationCheck(opts, regs), views), views, turnHookViews(views)), regs);
}

/**
 * Information only: a stdio registration pinned to `--surface full` keeps
 * working and is never rewritten; new installs register starter (the smaller
 * daily-driver tool list). Status and fix are unchanged.
 */
export function withSurfaceNote(check: Check, regs: HarnessRegistration[]): Check {
  const full = regs.filter((r) => r.kind === 'stdio' && !r.env?.GBRAIN_SURFACE && r.args?.[r.args.indexOf('--surface') + 1] === 'full' && r.args.includes('--surface'));
  if (full.length === 0) return check;
  return { ...check, details: { ...(check.details ?? {}), surface_note: `${full.map((r) => HARNESS_LABEL[r.harness]).join(', ')} registered with --surface full, which stays supported. New installs register starter listing the memory verbs (request_tools reaches the rest).` } };
}

async function registrationCheck(opts: { smoke: boolean }, regs: HarnessRegistration[]): Promise<Check> {
  // A shared HTTP server that answers in status-only mode outranks every registration verdict.
  const statusServer = (await verifiedStatusMarkers())[0];
  if (statusServer) {
    const entry = httpStatusServerEntry(statusServer);
    return { name: NAME, status: 'warn', message: entry.why, ...(entry.fix ? { fix: entry.fix } : { fix_unavailable_reason: 'no_safe_automatic_fix' as const }),
      details: { reason: entry.reason, transport: 'http', port: statusServer.port, pid: statusServer.pid, status_reason: statusServer.reason } };
  }
  if (regs.length === 0) {
    const detected = detectedHarnesses();
    const plugins = enabledPluginLanes('gbrain').filter((lane) => detected.includes(lane.harness));
    const recorded = recordedUnreadableRegistrations(detected.filter((h) => !plugins.some((lane) => lane.harness === h)));
    const harnesses = detected.filter((h) => !plugins.some((lane) => lane.harness === h) && !recorded.some((r) => r.harness === h));
    if (detected.length > 0 && harnesses.length === 0 && recorded.length > 0) {
      return infoCheck(NAME, `${recorded.map((r) => `${HARNESS_LABEL[r.harness]}: \`gbrain bootstrap\` recorded a gbrain MCP registration (${r.scope} scope)`).join('; ')}, `
        + `but this process cannot read its config, so doctor did not verify it here. Verify it with \`gbrain doctor --only harness_wiring\` run as the user who runs the agent app.`,
        'unknown', undefined, { reason: 'registration_recorded', harnesses: recorded.map((r) => r.harness), registrations: recorded });
    }
    if (detected.length > 0 && harnesses.length === 0) {
      return { name: NAME, status: 'ok',
        message: `${plugins.map((p) => `${HARNESS_LABEL[p.harness]} gets gbrain from the enabled '${p.plugin}' plugin`).join('; ')}. Enabled is a config signal: doctor does not smoke-test plugin lanes, so verify by starting a new session in that app and checking that gbrain's tools (recall, remember) are listed.`,
        details: { reason: 'plugin_lane_enabled', plugins: plugins.map((p) => p.plugin), harnesses: plugins.map((p) => p.harness),
          verify: 'start a new session in the harness and list its tools; gbrain\'s recall and remember should appear' } };
    }
    const view = brainLock();
    const lock = view.kind === 'pglite' ? view.lock : null;
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
