/**
 * Shared harness for the REAL-agent "door" E2E tests — the ones that drive the
 * ACTUAL `claude` and `codex` binaries against a live gbrain brain (over MCP
 * for Claude Code, over CLI for Codex). No PATH shims, no SDK: the door tests
 * spawn the operator's installed binaries and pay real API cost, so every entry
 * point here is written to fail-SKIP (never fail-HARD) on a machine that lacks
 * a binary or its auth.
 *
 * Adapted from gstack's test/helpers/{hermetic-env,session-runner,
 * codex-session-runner,claude-pty-runner}.ts. What changed for gbrain:
 *
 *   - Hermeticity is UNCONDITIONAL here (no EVALS_HERMETIC escape hatch). A
 *     door test must NEVER see the operator's real ~/.claude, ~/.gbrain, or
 *     ~/.codex. Every spawn gets a scrubbed env pointed at temp HOME /
 *     CLAUDE_CONFIG_DIR / CODEX_HOME / GBRAIN_HOME the test owns.
 *   - promotedEnv is inlined (no dependency on gstack's conductor-env-shim):
 *     GSTACK_ANTHROPIC_API_KEY is promoted to ANTHROPIC_API_KEY when the
 *     canonical key is unset, so a Conductor workspace (which only exports the
 *     GSTACK_ form) still authenticates the child.
 *   - The stream parsers (parseClaudeStream / parseCodexJsonl) are pure and
 *     exported so the companion unit test exercises extraction with ZERO real
 *     binaries.
 *   - seedBrainForAgent + writeGbrainMcpConfig wire a real keyless PGLite brain
 *     to a spawned `gbrain serve` so a Claude Code door test can assert recall.
 *
 * The drop-list is the security contract: CONDUCTOR_* / CLAUDE_* / GSTACK_* /
 * MCP_* / GBRAIN_* never reach a child except via the explicit overrides the
 * caller passes (which spread LAST and always win). HERMES_HOME is handled the
 * same way — not in any allowlist, so it only reaches a child via an explicit
 * override (the hermes door test always sets it to a temp home).
 */

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { operations, type OperationContext, type Operation } from '../../src/core/operations.ts';
import { saveConfig, gbrainPath, type GBrainConfig } from '../../src/core/config.ts';
import { addSource } from '../../src/core/sources-ops.ts';

// ────────────────────────────────────────────────────────────────────────────
// 1. Hermetic child environment
// ────────────────────────────────────────────────────────────────────────────

/** Exact env names a hermetic child keeps. Everything else (unless matched by
 *  a prefix rule or the caller's extraAllow) is dropped. */
const ALLOW_EXACT = new Set<string>([
  // Process basics
  'PATH', 'HOME', 'TMPDIR', 'TERM', 'COLORTERM', 'LANG', 'LC_ALL', 'SHELL',
  'USER', 'LOGNAME', 'TZ', 'NODE_ENV', 'CI',
  // Network reachability — proxied networks can't reach the Anthropic API
  // without these.
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'no_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
  // Auth — named, NOT the broad ANTHROPIC_* prefix (a prefix rule would smuggle
  // model/beta/debug knobs that change agent behavior).
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_AUTH_TOKEN',
]);

/** Prefix rules: eval-harness knobs + CI metadata. Deliberately NOT here:
 *  CONDUCTOR_* / CLAUDE_* / GSTACK_* / MCP_* / GBRAIN_* (session-context
 *  contamination) and operator credentials (GH_TOKEN, OPENAI_API_KEY, …). A
 *  provider runner re-admits its own auth via opts.extraAllow. */
const ALLOW_PREFIXES = ['EVALS_', 'GITHUB_'];

export interface HermeticEnvOpts {
  /** Additional allowed names (exact) or prefixes (entries ending in '*').
   *  Example: the codex runner passes ['OPENAI_API_KEY', 'CODEX_*']. */
  extraAllow?: string[];
}

/**
 * Pure form of the GSTACK_ → canonical promotion. Returns a copy of `base`
 * with ANTHROPIC_API_KEY / OPENAI_API_KEY filled from their GSTACK_-prefixed
 * form when the canonical is empty. Never mutates `base`.
 */
export function promotedEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...base };
  for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY'] as const) {
    if (!out[key] && out[`GSTACK_${key}`]) out[key] = out[`GSTACK_${key}`];
  }
  return out;
}

/**
 * Build a scrubbed child env: promote GSTACK_ keys, keep only the allowlisted
 * names (+ caller's extraAllow), then spread the caller's overrides LAST so a
 * per-test HOME / CLAUDE_CONFIG_DIR / CODEX_HOME / GBRAIN_HOME always wins.
 * Reads process.env at CALL time.
 */
export function hermeticChildEnv(
  overrides: Record<string, string | undefined> = {},
  opts?: HermeticEnvOpts,
): NodeJS.ProcessEnv {
  const promoted = promotedEnv(process.env);

  const extraExact = new Set<string>();
  const extraPrefixes: string[] = [];
  for (const entry of opts?.extraAllow ?? []) {
    if (entry.endsWith('*')) extraPrefixes.push(entry.slice(0, -1));
    else extraExact.add(entry);
  }

  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(promoted)) {
    if (v === undefined) continue;
    const allowed =
      ALLOW_EXACT.has(k) ||
      extraExact.has(k) ||
      ALLOW_PREFIXES.some((p) => k.startsWith(p)) ||
      extraPrefixes.some((p) => k.startsWith(p));
    if (allowed) out[k] = v;
  }
  if (!out.TERM) out.TERM = 'xterm-256color';
  for (const [k, v] of Object.entries(overrides)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

// ────────────────────────────────────────────────────────────────────────────
// 2. Binary resolution
// ────────────────────────────────────────────────────────────────────────────

function whichBin(name: string): string | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const found = (Bun as any).which?.(name);
    return found || null;
  } catch {
    return null;
  }
}

function firstExecutable(candidates: string[]): string | null {
  for (const c of candidates) {
    if (!c) continue;
    try {
      fs.accessSync(c, fs.constants.X_OK);
      return c;
    } catch {
      /* keep searching */
    }
  }
  return null;
}

/** Locate the real `claude` binary. Bun.which first, then known install dirs. */
export function resolveClaudeBinary(): string | null {
  const which = whichBin('claude');
  if (which) return which;
  const home = process.env.HOME ?? os.homedir();
  return firstExecutable([
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    `${home}/.local/bin/claude`,
    `${home}/.bun/bin/claude`,
    `${home}/.npm-global/bin/claude`,
  ]);
}

/** Locate the real `hermes` binary (NousResearch hermes-agent). Bun.which
 *  first, then the installer's known landing spots. */
export function resolveHermesBinary(): string | null {
  const which = whichBin('hermes');
  if (which) return which;
  const home = process.env.HOME ?? os.homedir();
  const candidates = [
    '/opt/homebrew/bin/hermes',
    '/usr/local/bin/hermes',
    `${home}/.local/bin/hermes`, // where the official installer symlinks (observed v0.20.0)
    `${home}/.hermes/bin/hermes`,
  ];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, 'hermes'));
  }
  return firstExecutable(candidates);
}

/** Locate the real `codex` binary. Bun.which first, then known install dirs
 *  (adds ~/.nvm + common node bin dirs where the npm global lands). */
export function resolveCodexBinary(): string | null {
  const which = whichBin('codex');
  if (which) return which;
  const home = process.env.HOME ?? os.homedir();
  const candidates = [
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
    `${home}/.local/bin/codex`,
    `${home}/.bun/bin/codex`,
    `${home}/.npm-global/bin/codex`,
    `${home}/.cargo/bin/codex`,
  ];
  // ~/.nvm/versions/node/*/bin/codex and any dir already on PATH.
  try {
    const nvmBase = path.join(home, '.nvm', 'versions', 'node');
    for (const v of fs.readdirSync(nvmBase)) {
      candidates.push(path.join(nvmBase, v, 'bin', 'codex'));
    }
  } catch {
    /* no nvm */
  }
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, 'codex'));
  }
  return firstExecutable(candidates);
}

// ────────────────────────────────────────────────────────────────────────────
// 3. Auth probes (drive skipIf in the door tests)
// ────────────────────────────────────────────────────────────────────────────

/** Claude Code is usable if an Anthropic key is exported (either form) OR the
 *  operator has a real ~/.claude.json (subscription auth). */
export function hasClaudeAuth(): boolean {
  if (process.env.ANTHROPIC_API_KEY || process.env.GSTACK_ANTHROPIC_API_KEY) return true;
  try {
    return fs.existsSync(path.join(os.homedir(), '.claude.json'));
  } catch {
    return false;
  }
}

/** Codex is usable if the operator has a real ~/.codex/auth.json. */
export function hasCodexAuth(): boolean {
  try {
    return fs.existsSync(path.join(os.homedir(), '.codex', 'auth.json'));
  } catch {
    return false;
  }
}

/** Every provider key hermes recognizes — scrubbed from child env so the
 *  seeded .env is the SINGLE auth source. Observed (v0.20.0): with model
 *  pinned to anthropic/* but MULTIPLE provider keys visible, hermes's
 *  provider-auto mis-routes the request and the turn returns
 *  "HTTP 401: Missing Authentication header" as final text (exit 0). */
const HERMES_ALL_PROVIDER_KEYS = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN',
  'OPENAI_API_KEY', 'OPENROUTER_API_KEY',
] as const;

/** Parse KEY=VALUE lines from a dotenv-style file. Ignores comments, blanks,
 *  and export prefixes; strips single/double quotes. Never throws. */
export function parseDotenvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    for (const rawLine of fs.readFileSync(file, 'utf-8').split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      out[m[1]] = v;
    }
  } catch {
    /* unreadable → empty */
  }
  return out;
}

/**
 * Hermes is usable BY THE DOOR SUITE if an ANTHROPIC key with a NON-EMPTY
 * value is available — either exported (GSTACK_ promotion applies) or present
 * in the operator's real ~/.hermes/.env.
 *
 * Anthropic-only on purpose: the door pins model.default to anthropic/*, and
 * seeding any second provider key makes hermes's provider-auto mis-route the
 * pinned model ("HTTP 401: Missing Authentication header", observed). Bare
 * file existence is deliberately NOT auth: a blank CI secret writes an empty
 * .env, and that must produce a SKIP, not a paid failing test.
 */
export function hasHermesAuth(): boolean {
  const env = promotedEnv(process.env);
  if (env.ANTHROPIC_API_KEY?.trim()) return true;
  const parsed = parseDotenvFile(path.join(os.homedir(), '.hermes', '.env'));
  return Boolean(parsed.ANTHROPIC_API_KEY?.trim());
}

// ────────────────────────────────────────────────────────────────────────────
// 4. Stream parsers (pure — exercised by the unit test with fixtures)
// ────────────────────────────────────────────────────────────────────────────

export interface ParsedClaudeStream {
  /** The final assistant/result text of the turn. */
  finalText: string;
  /** Names of every tool_use block the assistant emitted, in order. */
  toolCalls: string[];
}

/**
 * Parse `claude -p --output-format stream-json` NDJSON. Collects tool_use
 * names from assistant events and the final answer text. Prefers the terminal
 * `result` event's `result` field; falls back to the concatenation of the last
 * assistant message's text blocks. Skips malformed lines.
 */
export function parseClaudeStream(lines: string[]): ParsedClaudeStream {
  const toolCalls: string[] = [];
  let resultText: string | null = null;
  let lastAssistantText = '';

  for (const line of lines) {
    if (!line.trim()) continue;
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === 'assistant') {
      const content = event.message?.content ?? [];
      const textParts: string[] = [];
      for (const item of content) {
        if (item?.type === 'tool_use') toolCalls.push(item.name || 'unknown');
        else if (item?.type === 'text' && typeof item.text === 'string') textParts.push(item.text);
      }
      if (textParts.length > 0) lastAssistantText = textParts.join('');
    } else if (event.type === 'result') {
      if (typeof event.result === 'string') resultText = event.result;
    }
  }

  return { finalText: (resultText ?? lastAssistantText) || '', toolCalls };
}

export interface ParsedCodexJsonl {
  /** Concatenated agent_message text. */
  finalText: string;
  /** command_execution commands, in order. */
  toolCalls: string[];
  /** reasoning item text blocks, in order. */
  reasoning: string[];
}

/**
 * Parse `codex exec --json` JSONL. Extracts agent_message → finalText,
 * command_execution → toolCalls, reasoning → reasoning. Skips malformed lines.
 */
export function parseCodexJsonl(lines: string[]): ParsedCodexJsonl {
  const outputParts: string[] = [];
  const toolCalls: string[] = [];
  const reasoning: string[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj.type === 'item.completed' && obj.item) {
      const item = obj.item;
      const text = item.text || '';
      if (item.type === 'reasoning' && text) reasoning.push(text);
      else if (item.type === 'agent_message' && text) outputParts.push(text);
      else if (item.type === 'command_execution' && item.command) toolCalls.push(item.command);
    }
  }

  return { finalText: outputParts.join('\n'), toolCalls, reasoning };
}

// ────────────────────────────────────────────────────────────────────────────
// 5. Real-binary turns
// ────────────────────────────────────────────────────────────────────────────

/** Read a piped stream to a string of NDJSON/JSONL lines, calling onLine for
 *  each complete line. Returns all collected lines. */
async function streamLines(
  stream: ReadableStream<Uint8Array>,
  collected: string[],
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split('\n');
      buf = parts.pop() || '';
      for (const line of parts) {
        if (line.trim()) collected.push(line);
      }
    }
  } catch {
    /* stream cancelled (timeout) or read error — fall through */
  }
  if (buf.trim()) collected.push(buf);
}

export interface ClaudeTurnOpts {
  prompt: string;
  cwd: string;
  home: string;
  claudeConfigDir: string;
  mcpConfigPath?: string;
  model?: string;
  timeoutMs?: number;
}

export interface ClaudeTurnResult {
  finalText: string;
  toolCalls: string[];
  rawLines: string[];
  exitCode: number | null;
  timedOut: boolean;
}

/**
 * Drive one headless `claude -p` turn against a hermetic HOME/config dir.
 * Optionally wires an MCP config (with --strict-mcp-config so ONLY that server
 * is loaded — no operator MCP contamination). Prompt is piped via stdin.
 */
export async function claudeHeadlessTurn(opts: ClaudeTurnOpts): Promise<ClaudeTurnResult> {
  const model = opts.model ?? 'claude-sonnet-4-6';
  const timeoutMs = opts.timeoutMs ?? 180_000;

  const args = [
    '-p',
    '--model', model,
    '--output-format', 'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
    ...(opts.mcpConfigPath ? ['--mcp-config', opts.mcpConfigPath, '--strict-mcp-config'] : []),
  ];

  const proc = Bun.spawn(['claude', ...args], {
    cwd: opts.cwd,
    env: hermeticChildEnv({ HOME: opts.home, CLAUDE_CONFIG_DIR: opts.claudeConfigDir }),
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  // Write the prompt then close stdin.
  proc.stdin.write(opts.prompt);
  await proc.stdin.end();

  let timedOut = false;
  const rawLines: string[] = [];
  const stdoutDone = streamLines(proc.stdout, rawLines);
  const stderrDone = new Response(proc.stderr).text();

  const timer = setTimeout(() => {
    timedOut = true;
    try { proc.kill(); } catch { /* already dead */ }
  }, timeoutMs);

  await stdoutDone;
  await stderrDone.catch(() => '');
  const exitCode = await proc.exited;
  clearTimeout(timer);

  const parsed = parseClaudeStream(rawLines);
  return { finalText: parsed.finalText, toolCalls: parsed.toolCalls, rawLines, exitCode, timedOut };
}

export interface CodexTurnOpts {
  prompt: string;
  cwd: string;
  home: string;
  timeoutMs?: number;
  sandbox?: string;
}

export interface CodexTurnResult {
  finalText: string;
  toolCalls: string[];
  reasoning: string[];
  rawLines: string[];
  exitCode: number | null;
  timedOut: boolean;
}

/**
 * Drive one `codex exec` turn against a hermetic HOME. Copies the operator's
 * real ~/.codex/* (except skills/) into <home>/.codex so codex authenticates
 * without touching the real config dir. Parses JSONL output.
 */
export async function codexExecTurn(opts: CodexTurnOpts): Promise<CodexTurnResult> {
  const timeoutMs = opts.timeoutMs ?? 240_000;
  const sandbox = opts.sandbox ?? 'workspace-write';

  // Seed the temp HOME's .codex from the operator's real auth (read-only copy,
  // skipping skills/ so a downstream test can install its own).
  const realCodex = path.join(os.homedir(), '.codex');
  const tempCodex = path.join(opts.home, '.codex');
  fs.mkdirSync(tempCodex, { recursive: true });
  if (fs.existsSync(realCodex)) {
    for (const entry of fs.readdirSync(realCodex)) {
      if (entry === 'skills') continue;
      const src = path.join(realCodex, entry);
      const dst = path.join(tempCodex, entry);
      if (!fs.existsSync(dst)) {
        try { fs.cpSync(src, dst, { recursive: true }); } catch { /* best-effort */ }
      }
    }
  }

  const proc = Bun.spawn(['codex', 'exec', opts.prompt, '--json', '-s', sandbox], {
    cwd: opts.cwd,
    env: hermeticChildEnv({ HOME: opts.home }, { extraAllow: ['OPENAI_API_KEY', 'CODEX_*'] }),
    stdout: 'pipe',
    stderr: 'pipe',
  });

  let timedOut = false;
  const rawLines: string[] = [];
  const stdoutDone = streamLines(proc.stdout, rawLines);
  const stderrDone = new Response(proc.stderr).text();

  const timer = setTimeout(() => {
    timedOut = true;
    try { proc.kill(); } catch { /* already dead */ }
  }, timeoutMs);

  await stdoutDone;
  await stderrDone.catch(() => '');
  const exitCode = await proc.exited;
  clearTimeout(timer);

  const parsed = parseCodexJsonl(rawLines);
  return {
    finalText: parsed.finalText,
    toolCalls: parsed.toolCalls,
    reasoning: parsed.reasoning,
    rawLines,
    exitCode: timedOut ? 124 : exitCode,
    timedOut,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 5a-bis. Hermes home seeding + one-shot turn (mirror of the codex trio)
// ────────────────────────────────────────────────────────────────────────────

export interface SeedHermesHomeOpts {
  /** Test-only injection point: read provider keys from this dotenv file
   *  instead of the operator's real ~/.hermes/.env (lets the unit test assert
   *  the allowlist-only copy against a fixture without touching real homes). */
  sourceEnvPath?: string;
}

/**
 * Seed a hermetic <home>/.hermes for a spawned hermes. Copies EXACTLY ONE
 * key — a non-empty ANTHROPIC_API_KEY, from the operator's real ~/.hermes/.env
 * when present, falling back to the (promoted) process env. One key on
 * purpose: the door pins an anthropic/* model, and a second provider key
 * flips hermes's provider-auto into a mis-routed request (observed 401).
 * Never the whole .env file (other creds / endpoints / behavior knobs stay
 * behind), NEVER config.yaml (the operator's private MCP servers). The model
 * pin is a separate step (`pinHermesModel`) because hermes owns config.yaml's
 * schema — hand-writing it risks drift; `hermes config set` round-trips
 * safely.
 */
export function seedHermesHome(home: string, opts?: SeedHermesHomeOpts): string {
  const hermesHome = path.join(home, '.hermes');
  fs.mkdirSync(hermesHome, { recursive: true });

  const fromFile = parseDotenvFile(opts?.sourceEnvPath ?? path.join(os.homedir(), '.hermes', '.env'));
  const env = promotedEnv(process.env);
  const key = fromFile.ANTHROPIC_API_KEY?.trim() || env.ANTHROPIC_API_KEY?.trim();
  if (key) {
    fs.writeFileSync(path.join(hermesHome, '.env'), `ANTHROPIC_API_KEY=${key}\n`, { mode: 0o600 });
  }
  return hermesHome;
}

/**
 * Hermetic env for spawning hermes itself: standard scrub + HOME/HERMES_HOME
 * overrides, then ALL provider keys deleted so the seeded .env is the single
 * auth source (provider-auto determinism — see HERMES_ALL_PROVIDER_KEYS).
 */
export function hermesChildEnv(home: string): NodeJS.ProcessEnv {
  const env = hermeticChildEnv({ HOME: home, HERMES_HOME: path.join(home, '.hermes') });
  for (const k of HERMES_ALL_PROVIDER_KEYS) delete env[k];
  return env;
}

/**
 * Non-interactive model/provider pin for a hermetic hermes home. A virgin
 * install refuses `-z` with "No inference provider configured" (exit 1,
 * observed), and `hermes model` is interactive-only — `config set` is the
 * scriptable path (observed working against v0.20.0).
 */
export function pinHermesModel(hermesBin: string, home: string, model = 'anthropic/claude-haiku-4.5'): { code: number | null; stderr: string } {
  const res = spawnSync(hermesBin, ['config', 'set', 'model.default', model], {
    env: hermesChildEnv(home),
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { code: res.status, stderr: res.stderr ?? '' };
}

export interface HermesTurnOpts {
  prompt: string;
  cwd: string;
  home: string;
  timeoutMs?: number;
  /** When set, the turn passes hermes's usage-report flag targeting this path. */
  usageFile?: string;
}

export interface HermesTurnResult {
  /** hermes's one-shot mode prints ONLY the final response text on stdout. */
  finalText: string;
  exitCode: number | null;
  timedOut: boolean;
  stderrText: string;
  /** Parsed usage-report JSON when usageFile was requested and parseable. */
  usage?: unknown;
}

/**
 * Drive one `hermes -z` turn against a hermetic HOME + HERMES_HOME. The
 * RESOLVED binary path is used (never the bare literal), so resolution and
 * execution can't disagree. stdout is plain final text — NOT NDJSON; there is
 * no per-event tool-call stream to parse (door tests use a negative-control
 * prompt instead).
 */
export async function hermesOneShotTurn(opts: HermesTurnOpts): Promise<HermesTurnResult> {
  const bin = resolveHermesBinary();
  if (!bin) throw new Error('hermesOneShotTurn: hermes binary not found');
  const timeoutMs = opts.timeoutMs ?? 240_000;

  const argv = [bin, '-z', opts.prompt, ...(opts.usageFile ? ['--usage-file', opts.usageFile] : [])];
  const proc = Bun.spawn(argv, {
    cwd: opts.cwd,
    env: hermesChildEnv(opts.home),
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { proc.kill(); } catch { /* already dead */ }
  }, timeoutMs);

  const [stdout, stderrText] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text().catch(() => ''),
  ]);
  const exitCode = await proc.exited;
  clearTimeout(timer);

  let usage: unknown;
  if (opts.usageFile) {
    try { usage = JSON.parse(fs.readFileSync(opts.usageFile, 'utf-8')); } catch { /* best-effort */ }
  }

  return {
    finalText: stdout.trim(),
    exitCode: timedOut ? 124 : exitCode,
    timedOut,
    stderrText,
    usage,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 5a-grok. Grok Build (xAI) — all shapes observed against v1.0.4
//          (docs/mcp/GROK-CLI-PIN.md). grok ≠ groq ≠ ngrok.
// ────────────────────────────────────────────────────────────────────────────

/** Locate the real `grok` binary (xAI Grok Build). $GROK_BIN (absolute,
 *  executable — same override the claw-test runner honors) first, then
 *  Bun.which, then the npm-global and installer landing spots. Collision
 *  note: the community superagent-ai grok-cli ships a colliding `grok`
 *  binary — the door's version-shape pin (T1) is the discriminator. */
export function resolveGrokBinary(): string | null {
  // FAIL-CLOSED on a set-but-invalid GROK_BIN (matching the runner's
  // detectBinary posture): silently falling through to `which grok` could
  // bind the colliding community grok-cli binary DESPITE the operator's
  // explicit pin — the exact mis-bind the pin exists to prevent.
  const fromEnv = process.env.GROK_BIN?.trim();
  if (fromEnv) {
    if (!fromEnv.startsWith('/') || fromEnv.split('/').includes('..')) return null;
    return firstExecutable([fromEnv]);
  }
  const which = whichBin('grok');
  if (which) return which;
  const home = process.env.HOME ?? os.homedir();
  const candidates = [
    '/opt/homebrew/bin/grok',
    '/usr/local/bin/grok',
    `${home}/.local/bin/grok`,
    `${home}/.npm-global/bin/grok`,
    `${home}/.bun/bin/grok`,
  ];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, 'grok'));
  }
  return firstExecutable(candidates);
}

/**
 * Grok is usable BY THE PAID TIER if a NON-EMPTY XAI_API_KEY is exported.
 * Env-only on purpose: the keyless one-shot exits 1 with "Not signed in …
 * set the XAI_API_KEY environment variable" (observed v1.0.4), and no
 * credential file was observed keyless — if the authed observation finds one
 * under ~/.grok, add it here as a second probe (GROK-CLI-PIN.md marks that
 * item pending auth). Blank CI secret ⇒ skip, never a paid failing test.
 */
export function hasGrokAuth(): boolean {
  return Boolean(process.env.XAI_API_KEY?.trim());
}

/**
 * Hermetic env for spawning grok itself: standard scrub + HOME/GROK_HOME
 * overrides; XAI_API_KEY re-admitted EXPLICITLY (it is deliberately not in
 * ALLOW_EXACT — default-deny stays intact for every other child). Deletes:
 *  - other providers' keys (defensive; grok is single-provider, but scrubbing
 *    is free and keeps the door single-auth-source like the hermes lane), and
 *  - GITHUB_ENV/GITHUB_PATH/GITHUB_OUTPUT/GITHUB_STATE — the GITHUB_ prefix
 *    rule would forward these CI step-metadata files to an UNTRUSTED agent
 *    child, which could append to them and poison later workflow steps.
 */
export function grokChildEnv(home: string, opts?: { binDir?: string }): NodeJS.ProcessEnv {
  const env = hermeticChildEnv({
    HOME: home,
    GROK_HOME: path.join(home, '.grok'),
    XAI_API_KEY: process.env.XAI_API_KEY?.trim() || undefined,
  });
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY']) delete env[k];
  // Writable step-metadata files the GITHUB_ prefix rule would otherwise
  // forward: appending to any of them poisons later workflow steps (ENV/
  // PATH/OUTPUT/STATE) or the run summary UI (STEP_SUMMARY).
  for (const k of ['GITHUB_ENV', 'GITHUB_PATH', 'GITHUB_OUTPUT', 'GITHUB_STATE', 'GITHUB_STEP_SUMMARY', 'GITHUB_ACTION_PATH']) delete env[k];
  // PATH-prepend the staged gbrain bin dir when given — the MCP registration
  // uses the DOCUMENTED bare `gbrain` command, so EVERY grok spawn that may
  // start the server (doctor probes AND the paid turn) must resolve it.
  if (opts?.binDir) env.PATH = `${opts.binDir}:${env.PATH ?? ''}`;
  return env;
}

/**
 * Seed a hermetic <home>/.grok/config.toml BEFORE any grok spawn:
 *  - `[cli] auto_update = false` — auto-update is config-only and defaults ON
 *    (observed); without this seed a door run can self-update mid-suite and
 *    break the version pin.
 *  - `[models] default = <model>` when given — `grok mcp add` PRESERVES
 *    pre-existing sections (observed), so the seed survives registration.
 * No credentials are written: auth travels via XAI_API_KEY env only.
 */
export function seedGrokConfig(home: string, opts?: { defaultModel?: string }): string {
  const grokHome = path.join(home, '.grok');
  fs.mkdirSync(grokHome, { recursive: true });
  const model = opts?.defaultModel;
  const doc = `[cli]\nauto_update = false\n${model ? `\n[models]\ndefault = "${model}"\n` : ''}`;
  fs.writeFileSync(path.join(grokHome, 'config.toml'), doc, 'utf-8');
  return grokHome;
}

/**
 * Stage a `gbrain` binary into a fresh bin dir so the DOCUMENTED registration
 * shape (`grok mcp add gbrain -- gbrain serve --surface verbs`, bare command
 * resolved via PATH — observed working v1.0.4) is what the door exercises.
 * Compiled binary copy when available; otherwise an executable sh wrapper
 * exec'ing `bun run src/cli.ts` so the fallback lane survives staging.
 */
export function stageGbrainBinDir(repoRoot: string, dir: string): { kind: 'compiled' | 'bun-run' } {
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, 'gbrain');
  const { binPath } = ensureCompiledGbrain(repoRoot);
  if (binPath) {
    fs.copyFileSync(binPath, target);
    fs.chmodSync(target, 0o755);
    return { kind: 'compiled' };
  }
  const cli = path.join(repoRoot, 'src', 'cli.ts');
  // The path is interpolated single-quoted into an sh shim — reject the same
  // metachar set validateBinPathEnv guards, rather than trying to escape.
  if (/['"`$\\\n\r]/.test(cli)) {
    throw new Error(`stageGbrainBinDir: repo path contains shell-active characters unsafe for the shim: ${cli}`);
  }
  fs.writeFileSync(target, `#!/bin/sh\nexec bun run '${cli}' "$@"\n`, { mode: 0o755 });
  return { kind: 'bun-run' };
}

export interface GrokTurnOpts {
  prompt: string;
  cwd: string;
  home: string;
  timeoutMs?: number;
  /** Per-call model pin (authoritative — immune to config rewrites). */
  model?: string;
  /** Disable grok's built-in web search + fetch tools (observed flag). */
  disableWebSearch?: boolean;
  /** Staged gbrain bin dir — PATH-prepended so the bare-`gbrain` MCP
   *  registration resolves when grok spawns the server DURING the turn
   *  (without this the doctor preflight passes but the paid turn cannot
   *  start the server on a clean runner). */
  binDir?: string;
}

export interface GrokTurnResult {
  /** plain output format: stdout is the final response text. */
  finalText: string;
  exitCode: number | null;
  timedOut: boolean;
  stderrText: string;
}

/**
 * Drive one `grok -p` turn against a hermetic HOME + GROK_HOME. Plain output
 * format (final text on stdout — observed). The permission posture is
 * deliberately unset pending the authed observation (GROK-CLI-PIN.md); the
 * JSON event-stream shapes are also unobserved, so there is no parseGrokJson
 * yet — the door's tool-call assertion stays gated on that observation.
 */
export async function grokOneShotTurn(opts: GrokTurnOpts): Promise<GrokTurnResult> {
  const bin = resolveGrokBinary();
  if (!bin) throw new Error('grokOneShotTurn: grok binary not found');
  const timeoutMs = opts.timeoutMs ?? 240_000;

  const argv = [
    bin, '-p', opts.prompt, '--output-format', 'plain',
    ...(opts.model ? ['-m', opts.model] : []),
    ...(opts.disableWebSearch ? ['--disable-web-search'] : []),
  ];
  const proc = Bun.spawn(argv, {
    cwd: opts.cwd,
    env: grokChildEnv(opts.home, { binDir: opts.binDir }),
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { proc.kill(); } catch { /* already dead */ }
    // grok may leave its leader daemon / MCP server child holding the pipes
    // open past the parent's death — escalate so the stream drain below
    // cannot hang the retry loop indefinitely.
    setTimeout(() => { try { proc.kill(9); } catch { /* already dead */ } }, 5_000);
  }, timeoutMs);

  // Bounded drain: even a SIGKILLed parent can leave a grandchild holding
  // the pipe fds; cap the post-timeout wait instead of awaiting EOF forever.
  const drainCap = timeoutMs + 30_000;
  const bounded = <T>(p: Promise<T>, fallback: T): Promise<T> =>
    Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), drainCap))]);
  const [stdout, stderrText] = await Promise.all([
    bounded(new Response(proc.stdout).text(), ''),
    bounded(new Response(proc.stderr).text().catch(() => ''), ''),
  ]);
  const exitCode = await bounded(proc.exited, 124);
  clearTimeout(timer);

  return {
    finalText: stdout.trim(),
    exitCode: timedOut ? 124 : exitCode,
    timedOut,
    stderrText,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 5b. Fast gbrain MCP server command (compiled binary, cached; bun-run fallback)
// ────────────────────────────────────────────────────────────────────────────

/**
 * A resolved launch spec for the gbrain MCP stdio server. The door tests
 * register THIS as their MCP server so the child agent's first tool call finds
 * a server that is already up. A compiled binary starts fast; `bun run
 * src/cli.ts serve` cold-transpiles the whole CLI on every spawn and can miss
 * an agent's tool-call window (the source of the codex "the available gbrain
 * mcp calls were cancelled" flake). `kind` lets the caller widen the turn
 * timeout when we fell back to the slow path.
 */
export interface GbrainServerCommand {
  command: string;
  /** Full arg vector INCLUDING the `serve` subcommand + any extra flags. */
  args: string[];
  kind: 'compiled' | 'bun-run';
}

// Module-level cache: compile the binary at most once per test process.
let _compiledBin: string | null = null;
let _compileTried = false;
let _compileReason = '';
let _compileBuildDir: string | null = null;

/**
 * Verify a freshly-built `gbrain` binary can actually stand up a PGLite brain.
 * As of the embedded-assets fix (src/core/pglite-embedded-assets.ts), `bun
 * build --compile` binaries DO carry PGLite's WASM runtime + extension tarballs
 * (`pglite.wasm`, `initdb.wasm`, `pglite.data`, `vector.tar.gz`,
 * `pg_trgm.tar.gz`) — embedded via `with { type: 'file' }` and fed to PGLite
 * through PGliteOptions — so a compiled `gbrain init --pglite` now succeeds
 * where it used to ENOENT on those assets (Bun vfs #1340). This probe is the
 * runtime backstop: it confirms the embedding held for THIS binary before we
 * trust it as the door-test MCP server (the brain is keyless PGLite). If the
 * embedding ever regresses, the probe fails and we fall back to `bun run`.
 * `init` is the cheapest exercise of the WASM path that terminates on its own
 * (unlike `serve`, which either waits on stdin or bails early on a brain-less
 * home). scripts/check-pglite-embedded.sh guards the same property in CI.
 */
function probeCompiledPglite(binPath: string): { ok: boolean; reason: string } {
  const probeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-agent-probe-'));
  try {
    const res = spawnSync(binPath, ['init', '--pglite', '--no-embedding', '--non-interactive'], {
      env: { ...process.env, HOME: probeHome, GBRAIN_HOME: probeHome, GBRAIN_SKIP_STARTUP_HOOKS: '1' },
      encoding: 'utf8',
      timeout: 60_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stderr = `${res.stdout ?? ''}\n${res.stderr ?? ''}`;
    const wasmBroken = /PGLite failed to initialize|Extension bundle not found|\$bunfs|pglite\.data/.test(stderr);
    if (res.error) return { ok: false, reason: `compiled \`gbrain init --pglite\` probe error: ${res.error.message}` };
    if (wasmBroken || res.status !== 0) {
      const lines = stderr.split('\n').map((l) => l.trim()).filter(Boolean);
      const markerLine =
        lines.find((l) => /PGLite failed to initialize|Extension bundle not found|\$bunfs|pglite\.data/.test(l)) ??
        lines[0] ??
        `exit ${res.status}`;
      return {
        ok: false,
        reason:
          `compiled \`gbrain\` cannot open a PGLite brain — \`bun build --compile\` does not embed ` +
          `PGLite's WASM/extension payload (Bun vfs #1340): ${markerLine.slice(0, 160)}`,
      };
    }
    return { ok: true, reason: '' };
  } catch (e) {
    return { ok: false, reason: `compiled PGLite probe threw: ${(e as Error).message}` };
  } finally {
    try { fs.rmSync(probeHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

/**
 * Build a standalone `gbrain` binary once via `bun build --compile` into a
 * cached temp path AND verify it can serve a PGLite brain. Returns the path (or
 * null + a reason) — null covers both "compile unavailable in this sandbox" and
 * "compile succeeds but the binary can't open PGLite" (#1340). Mirrors
 * test/e2e/bootstrap-compiled-binary.serial.test.ts. Fail-soft: every error is
 * captured as a reason string, never thrown, so any failure degrades to the
 * bun-run fallback instead of hard-failing the door suite.
 */
export function ensureCompiledGbrain(repoRoot: string): { binPath: string | null; reason: string } {
  // CI short-circuit: a workflow can compile ONCE in a dedicated step and
  // export GBRAIN_COMPILED_BIN — the module-global cache below is per-process,
  // so two `bun test` invocations in one job would otherwise compile twice.
  const prebuilt = process.env.GBRAIN_COMPILED_BIN?.trim();
  if (prebuilt && prebuilt.startsWith('/')) {
    try {
      fs.accessSync(prebuilt, fs.constants.X_OK);
      return { binPath: prebuilt, reason: '' };
    } catch { /* fall through to the normal compile path */ }
  }
  if (_compileTried) return { binPath: _compiledBin, reason: _compileReason };
  _compileTried = true;
  try {
    const buildDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gb-agent-bin-'));
    _compileBuildDir = buildDir;
    const binPath = path.join(buildDir, 'gbrain');
    const res = spawnSync('bun', ['build', '--compile', '--outfile', binPath, 'src/cli.ts'], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 240_000,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (res.error) {
      _compileReason = `bun build --compile unavailable: ${res.error.message}`;
    } else if (res.status !== 0) {
      _compileReason = `bun build --compile exited ${res.status}: ${(res.stderr ?? '').slice(-1000)}`;
    } else if (!fs.existsSync(binPath)) {
      _compileReason = 'bun build --compile exited 0 but produced no binary';
    } else {
      const probe = probeCompiledPglite(binPath);
      if (probe.ok) _compiledBin = binPath;
      else _compileReason = probe.reason;
    }
  } catch (e) {
    _compileReason = `bun build --compile threw: ${(e as Error).message}`;
  }
  return { binPath: _compiledBin, reason: _compileReason };
}

// Best-effort cleanup of the compiled-binary temp dir at process exit.
process.on('exit', () => {
  if (_compileBuildDir) {
    try { fs.rmSync(_compileBuildDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

/**
 * Resolve the gbrain MCP server launch spec: a compiled binary
 * (`{command:<bin>, args:['serve', ...extra]}`) when `bun build --compile`
 * both succeeds AND can open a PGLite brain, else the `bun run src/cli.ts
 * serve` fallback. `extraArgs` are appended after `serve` (e.g.
 * `['--surface','full']` for the codex door). The env
 * (GBRAIN_HOME/GBRAIN_SOURCE) is layered on by the caller and stays identical
 * across both kinds.
 *
 * NOTE: the `bun build --compile` binary now embeds PGLite's WASM/extension
 * payload (src/core/pglite-embedded-assets.ts, Bun vfs #1340), so this resolves
 * to the fast `compiled` path in practice. The `bun-run` fallback stays wired
 * as a safety net for sandboxes where compile is unavailable or the probe fails
 * (its server is measured ready to answer `tools/list` in ~300ms, and the door
 * tests lean on the bounded SMOKE retry, not server speed, for robustness).
 */
export function resolveGbrainServerCommand(repoRoot: string, extraArgs: string[] = []): GbrainServerCommand {
  const { binPath, reason } = ensureCompiledGbrain(repoRoot);
  if (binPath) {
    return { command: binPath, args: ['serve', ...extraArgs], kind: 'compiled' };
  }
  console.error(
    `[agent-harness] compiled gbrain unavailable, falling back to \`bun run src/cli.ts\` ` +
      `(slower MCP startup, wider readiness window): ${reason}`,
  );
  return {
    command: 'bun',
    args: ['run', path.join(repoRoot, 'src', 'cli.ts'), 'serve', ...extraArgs],
    kind: 'bun-run',
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 6. MCP config for a Claude Code door test
// ────────────────────────────────────────────────────────────────────────────

export interface GbrainMcpConfigOpts {
  path: string;
  /** Resolved server launch spec (compiled bin or bun-run fallback). */
  server: { command: string; args: string[] };
  gbrainHome: string;
  sourceId: string;
}

/**
 * Write a Claude Code `--mcp-config` JSON that runs THIS repo's gbrain over
 * stdio, pinned to a hermetic GBRAIN_HOME + source. The server command comes
 * from `resolveGbrainServerCommand` (compiled binary preferred, `bun run
 * src/cli.ts serve` fallback) so startup is fast enough that the child agent's
 * first tool call doesn't get cancelled. Mirrors `claude mcp add gbrain --
 * gbrain serve` from docs/mcp/CLAUDE_CODE.md.
 */
export function writeGbrainMcpConfig(opts: GbrainMcpConfigOpts): void {
  const cfg = {
    mcpServers: {
      gbrain: {
        command: opts.server.command,
        args: opts.server.args,
        env: {
          GBRAIN_HOME: opts.gbrainHome,
          GBRAIN_SOURCE: opts.sourceId,
        },
      },
    },
  };
  fs.mkdirSync(path.dirname(opts.path), { recursive: true });
  fs.writeFileSync(opts.path, JSON.stringify(cfg, null, 2));
}

// ────────────────────────────────────────────────────────────────────────────
// 7. Seed a real keyless PGLite brain the spawned `gbrain serve` will read
// ────────────────────────────────────────────────────────────────────────────

const put_page = operations.find((o) => o.name === 'put_page') as Operation | undefined;

export interface SeededBrain {
  fact: string;
  entity: string;
  query: string;
}

/**
 * Initialize a keyless PGLite brain at GBRAIN_HOME=<home> and seed ONE page
 * with a distinctive, 100%-synthetic fact so a door test can assert the agent
 * recalls it over MCP. Persistent on disk (so the spawned `gbrain serve`
 * subprocess reads the same brain), keyless (embedding_disabled) so it runs
 * with no API key, skills published so the verbs surface is available.
 *
 * Temporarily pins process.env.GBRAIN_HOME while creating the brain, then
 * restores it — the door test sets GBRAIN_HOME on the spawned child via the
 * MCP config's env block, not on this process.
 */
export async function seedBrainForAgent(
  home: string,
  sourceId: string,
  opts?: { entity?: string; fact?: string; query?: string; slug?: string },
): Promise<SeededBrain> {
  if (!put_page) throw new Error('seedBrainForAgent: put_page op not registered');

  // Defaults are the committed synthetic fact (hermes/claude doors). Callers
  // whose agent has filesystem/shell tools in reach pass a PER-RUN nonce fact
  // instead — the committed string is greppable in the checkout, so recall of
  // it proves nothing against an agent that can read the repo (grok door).
  const entity = opts?.entity ?? 'Summit Robotics';
  const fact = opts?.fact ?? 'Summit Robotics runs the Rivermouth fulfillment center.';
  const query = opts?.query ?? 'Where does Summit Robotics run its fulfillment center?';

  const savedHome = process.env.GBRAIN_HOME;
  process.env.GBRAIN_HOME = home;
  try {
    const dbPath = gbrainPath('brain.pglite'); // <home>/.gbrain/brain.pglite

    const engine = new PGLiteEngine();
    await engine.connect({ database_path: dbPath, engine: 'pglite' });
    await engine.initSchema();
    try {
      // Register a non-default source so GBRAIN_SOURCE routing has a real row.
      if (sourceId !== 'default') {
        const srcDir = path.join(home, `source-${sourceId}`);
        fs.mkdirSync(srcDir, { recursive: true });
        try {
          await addSource(engine, { id: sourceId, localPath: srcDir, force: true });
        } catch {
          /* already registered — fine */
        }
      }

      const ctx: OperationContext = {
        engine,
        config: { engine: 'pglite' } as never,
        logger: { info: () => {}, warn: () => {}, error: () => {} },
        dryRun: false,
        remote: false,
        sourceId,
      };
      await put_page.handler(ctx, {
        slug: opts?.slug ?? 'companies/summit-robotics',
        content: `# ${entity}\n\n${fact}\n`,
      });
    } finally {
      // Release the PGLite lock so the spawned `gbrain serve` can open the
      // same data dir.
      try { await engine.disconnect(); } catch { /* best-effort */ }
    }

    // Persist a keyless config so the spawned `gbrain serve` reads the same
    // engine + path and doesn't try to reach an embedding provider.
    const config: GBrainConfig = {
      engine: 'pglite',
      database_path: dbPath,
      embedding_disabled: true,
      mcp: { publish_skills: true },
    } as unknown as GBrainConfig;
    saveConfig(config);
  } finally {
    if (savedHome === undefined) delete process.env.GBRAIN_HOME;
    else process.env.GBRAIN_HOME = savedHome;
  }

  return { fact, entity, query };
}
