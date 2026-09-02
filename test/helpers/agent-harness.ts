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

/**
 * Door-family binary resolver factory (the rule-of-three extraction, fired by
 * the 4th door agent — opencode). One shape for every agent:
 *   $<envVar> (FAIL-CLOSED validation when set) > Bun.which > landing spots
 *   (+ optional nvm/PATH sweeps) > null.
 * Fail-closed on a set-but-invalid override on purpose (the grok lesson):
 * silently falling through to `which` could bind a colliding same-name
 * binary DESPITE the operator's explicit pin.
 */
export function makeBinaryResolver(spec: {
  envVar?: string;
  binName: string;
  candidates: (home: string) => string[];
  nvmSweep?: boolean;
  pathSweep?: boolean;
}): () => string | null {
  return () => {
    if (spec.envVar) {
      const fromEnv = process.env[spec.envVar]?.trim();
      if (fromEnv) {
        if (!fromEnv.startsWith('/') || fromEnv.split('/').includes('..')) return null;
        return firstExecutable([fromEnv]);
      }
    }
    const which = whichBin(spec.binName);
    if (which) return which;
    const home = process.env.HOME ?? os.homedir();
    const candidates = [...spec.candidates(home)];
    if (spec.nvmSweep) {
      try {
        const nvmBase = path.join(home, '.nvm', 'versions', 'node');
        for (const v of fs.readdirSync(nvmBase)) {
          candidates.push(path.join(nvmBase, v, 'bin', spec.binName));
        }
      } catch {
        /* no nvm */
      }
    }
    if (spec.pathSweep) {
      for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
        if (dir) candidates.push(path.join(dir, spec.binName));
      }
    }
    return firstExecutable(candidates);
  };
}

/** Locate the real `claude` binary. Bun.which first, then known install dirs. */
export const resolveClaudeBinary = makeBinaryResolver({
  binName: 'claude',
  candidates: (home) => [
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    `${home}/.local/bin/claude`,
    `${home}/.bun/bin/claude`,
    `${home}/.npm-global/bin/claude`,
  ],
});

/** Locate the real `hermes` binary (NousResearch hermes-agent). Bun.which
 *  first, then the installer's known landing spots. */
export const resolveHermesBinary = makeBinaryResolver({
  binName: 'hermes',
  candidates: (home) => [
    '/opt/homebrew/bin/hermes',
    '/usr/local/bin/hermes',
    `${home}/.local/bin/hermes`, // where the official installer symlinks (observed v0.20.0)
    `${home}/.hermes/bin/hermes`,
  ],
  pathSweep: true,
});

/** Locate the real `codex` binary. Bun.which first, then known install dirs
 *  (adds ~/.nvm + common node bin dirs where the npm global lands). */
export const resolveCodexBinary = makeBinaryResolver({
  binName: 'codex',
  candidates: (home) => [
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
    `${home}/.local/bin/codex`,
    `${home}/.bun/bin/codex`,
    `${home}/.npm-global/bin/codex`,
    `${home}/.cargo/bin/codex`,
  ],
  nvmSweep: true,
  pathSweep: true,
});

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
    // Either auth shape works for a spawned `codex exec`: the operator's
    // auth.json (copied into the hermetic CODEX_HOME) or an ambient
    // CODEX_API_KEY (hermeticChildEnv's extraAllow passes CODEX_* through).
    return fs.existsSync(path.join(os.homedir(), '.codex', 'auth.json'))
      || !!process.env.CODEX_API_KEY;
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
  /**
   * MCP tool invocations, in order (EV12: previously discarded, forcing
   * e2e assertions onto raw-line regexes). `server` is the MCP server name
   * (e.g. 'gbrain'), `tool` the invoked tool. Fields are best-effort across
   * codex versions (`tool` falls back to `name`/`invocation.tool`).
   */
  mcpToolCalls: Array<{ server: string; tool: string }>;
}

/**
 * Parse `codex exec --json` JSONL. Extracts agent_message → finalText,
 * command_execution → toolCalls, reasoning → reasoning, mcp_tool_call →
 * mcpToolCalls. Skips malformed lines.
 */
export function parseCodexJsonl(lines: string[]): ParsedCodexJsonl {
  const outputParts: string[] = [];
  const toolCalls: string[] = [];
  const reasoning: string[] = [];
  const mcpToolCalls: Array<{ server: string; tool: string }> = [];

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
      else if (item.type === 'mcp_tool_call') {
        mcpToolCalls.push({
          server: item.server ?? item.invocation?.server ?? '',
          tool: item.tool ?? item.name ?? item.invocation?.tool ?? '',
        });
      }
    }
  }

  return { finalText: outputParts.join('\n'), toolCalls, reasoning, mcpToolCalls };
}

export interface ParsedOpencodeJsonl {
  /** Concatenated text-part content, in stream order. */
  finalText: string;
  /** Tool names from tool events, in order (MCP tools: `<server>_<tool>`,
   *  e.g. `gbrain_recall` — observed v1.18.18). */
  toolCalls: string[];
}

/**
 * Parse `opencode run --format json` NDJSON. Every event is
 * `{type, timestamp, sessionID, part}` (observed v1.18.18 —
 * OPENCODE-CLI-PIN.md §One-shot): `text` events carry `part.text`;
 * `tool_use` events carry `part.tool` + `part.state.{status,input,output}`.
 * Skips malformed lines and unknown event types.
 */
export function parseOpencodeJsonl(lines: string[]): ParsedOpencodeJsonl {
  const textParts: string[] = [];
  const toolCalls: string[] = [];
  for (const line of lines) {
    let evt: unknown;
    try {
      evt = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof evt !== 'object' || evt === null) continue;
    const e = evt as { type?: string; part?: { text?: unknown; tool?: unknown } };
    if (e.type === 'text' && typeof e.part?.text === 'string') {
      textParts.push(e.part.text);
    } else if (e.type === 'tool_use' && typeof e.part?.tool === 'string') {
      toolCalls.push(e.part.tool);
    }
  }
  return { finalText: textParts.join('\n').trim(), toolCalls };
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
  /** Extra env for the child (spread LAST — wins). See CodexTurnOpts.extraEnv. */
  extraEnv?: Record<string, string>;
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

  // EV12: spawn the RESOLVED binary — the hermetic child env strips PATH
  // customizations, so a bare 'claude' can resolve differently (or not at
  // all) inside the child than the resolver reported to the skip-gate.
  const claudeBin = resolveClaudeBinary() ?? 'claude';
  const proc = Bun.spawn([claudeBin, ...args], {
    cwd: opts.cwd,
    env: hermeticChildEnv({ HOME: opts.home, CLAUDE_CONFIG_DIR: opts.claudeConfigDir, ...opts.extraEnv }),
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
  /** Extra env for the child (spread LAST — wins). The plugin doors use this
   *  to thread GBRAIN_BIN/GBRAIN_HOME/GBRAIN_SOURCE through codex's env_vars
   *  passthrough into the plugin-launched MCP server. */
  extraEnv?: Record<string, string>;
}

export interface CodexTurnResult {
  finalText: string;
  toolCalls: string[];
  reasoning: string[];
  /** MCP tool invocations ({server, tool}) — see ParsedCodexJsonl.mcpToolCalls. */
  mcpToolCalls: Array<{ server: string; tool: string }>;
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

  // EV12: spawn the RESOLVED binary (see claudeHeadlessTurn).
  const codexBin = resolveCodexBinary() ?? 'codex';
  const proc = Bun.spawn([codexBin, 'exec', opts.prompt, '--json', '-s', sandbox], {
    cwd: opts.cwd,
    env: hermeticChildEnv({ HOME: opts.home, ...opts.extraEnv }, { extraAllow: ['OPENAI_API_KEY', 'CODEX_*'] }),
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
    mcpToolCalls: parsed.mcpToolCalls,
    rawLines,
    exitCode: timedOut ? 124 : exitCode,
    timedOut,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 5a-core. Door-family shared core (childEnv factory + one-shot spawn) —
//          the rule-of-three extraction, fired by the 4th door agent
//          (opencode). hermes/grok/opencode build on these; behavior for the
//          ported agents is pinned by their existing unit truth-tables.
// ────────────────────────────────────────────────────────────────────────────

/** Writable CI step-metadata files the GITHUB_ prefix rule would otherwise
 *  forward to an UNTRUSTED agent child: appending to any of them poisons
 *  later workflow steps (ENV/PATH/OUTPUT/STATE) or the run summary UI. */
const GITHUB_STEP_META_KEYS = [
  'GITHUB_ENV', 'GITHUB_PATH', 'GITHUB_OUTPUT', 'GITHUB_STATE',
  'GITHUB_STEP_SUMMARY', 'GITHUB_ACTION_PATH',
] as const;

/** CI credential material that must never reach an UNTRUSTED agent child:
 *  GITHUB_TOKEN rides the GITHUB_ prefix rule, and the ACTIONS_* runtime/OIDC
 *  tokens are scrubbed unconditionally as defense-in-depth (an exfiltrated
 *  workflow token is repo write access; the OIDC request token mints cloud
 *  credentials). */
const CI_CREDENTIAL_KEYS = [
  'GITHUB_TOKEN', 'ACTIONS_RUNTIME_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
] as const;

/**
 * Per-agent hermetic child-env factory: hermeticChildEnv + the agent's home
 * overrides, then key deletion (single-auth-source discipline), the
 * GITHUB_* step-metadata scrub, and an optional staged-bin-dir PATH prepend
 * (agents whose MCP registration uses the documented bare `gbrain` command
 * need every spawn that may start the server to resolve it).
 */
export function makeAgentChildEnv(spec: {
  overrides: (home: string) => Record<string, string | undefined>;
  deleteKeys?: readonly string[];
}): (home: string, opts?: { binDir?: string }) => NodeJS.ProcessEnv {
  return (home, opts) => {
    const env = hermeticChildEnv(spec.overrides(home));
    for (const k of spec.deleteKeys ?? []) delete env[k];
    for (const k of GITHUB_STEP_META_KEYS) delete env[k];
    for (const k of CI_CREDENTIAL_KEYS) delete env[k];
    if (opts?.binDir) env.PATH = `${opts.binDir}:${env.PATH ?? ''}`;
    return env;
  };
}

export interface OneShotSpawnResult {
  /** One-shot modes print the final response text alone on stdout. */
  finalText: string;
  exitCode: number | null;
  timedOut: boolean;
  stderrText: string;
}

/**
 * Shared one-shot spawn core: timeout → kill, kill(9) escalation after 5s
 * (agents may leave a daemon/MCP-server child holding the pipes open past
 * the parent's death), and a BOUNDED stream drain (timeout + 30s cap) so a
 * grandchild holding the pipe fds can never hang a retry loop. Exit 124 on
 * timeout.
 */
export async function runOneShotSpawn(opts: {
  argv: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}): Promise<OneShotSpawnResult> {
  const proc = Bun.spawn(opts.argv, {
    cwd: opts.cwd,
    env: opts.env,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  });

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { proc.kill(); } catch { /* already dead */ }
    setTimeout(() => { try { proc.kill(9); } catch { /* already dead */ } }, 5_000);
  }, opts.timeoutMs);

  const drainCap = opts.timeoutMs + 30_000;
  // The cap timer is CLEARED when the real promise wins — an uncancelled
  // drainCap timer (timeoutMs + 30s) would keep Bun's event loop alive for
  // minutes after every successful door run.
  const bounded = <T>(p: Promise<T>, fallback: T): Promise<T> => {
    let capTimer: ReturnType<typeof setTimeout> | undefined;
    const cap = new Promise<T>((r) => {
      capTimer = setTimeout(() => r(fallback), drainCap);
    });
    return Promise.race([p, cap]).finally(() => clearTimeout(capTimer)) as Promise<T>;
  };
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
 * Via the shared factory, hermes now ALSO gets the GITHUB_* step-metadata
 * scrub (the filed backport from grokChildEnv — the prefix rule forwarded
 * writable CI step files to an untrusted agent child).
 */
export const hermesChildEnv = makeAgentChildEnv({
  overrides: (home) => ({ HOME: home, HERMES_HOME: path.join(home, '.hermes') }),
  deleteKeys: HERMES_ALL_PROVIDER_KEYS,
});

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
  // Shared spawn core: hermes gains the kill(9) escalation + bounded drain
  // the grok lane proved out (strictly-safer; nothing pinned the old
  // unbounded drain).
  const r = await runOneShotSpawn({
    argv: [bin, '-z', opts.prompt, ...(opts.usageFile ? ['--usage-file', opts.usageFile] : [])],
    cwd: opts.cwd,
    env: hermesChildEnv(opts.home),
    timeoutMs: opts.timeoutMs ?? 240_000,
  });

  let usage: unknown;
  if (opts.usageFile) {
    try { usage = JSON.parse(fs.readFileSync(opts.usageFile, 'utf-8')); } catch { /* best-effort */ }
  }

  return { ...r, usage };
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
export const resolveGrokBinary = makeBinaryResolver({
  envVar: 'GROK_BIN', // fail-closed override — see makeBinaryResolver
  binName: 'grok',
  candidates: (home) => [
    '/opt/homebrew/bin/grok',
    '/usr/local/bin/grok',
    `${home}/.local/bin/grok`,
    `${home}/.npm-global/bin/grok`,
    `${home}/.bun/bin/grok`,
  ],
  pathSweep: true,
});

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
export const grokChildEnv = makeAgentChildEnv({
  overrides: (home) => ({
    HOME: home,
    GROK_HOME: path.join(home, '.grok'),
    XAI_API_KEY: process.env.XAI_API_KEY?.trim() || undefined,
  }),
  deleteKeys: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY'],
});

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
  return runOneShotSpawn({
    argv: [
      bin, '-p', opts.prompt, '--output-format', 'plain',
      ...(opts.model ? ['-m', opts.model] : []),
      ...(opts.disableWebSearch ? ['--disable-web-search'] : []),
    ],
    cwd: opts.cwd,
    env: grokChildEnv(opts.home, { binDir: opts.binDir }),
    timeoutMs: opts.timeoutMs ?? 240_000,
  });
}

// ────────────────────────────────────────────────────────────────────────────
// 5a-opencode. opencode (SST, opencode.ai) — all shapes observed against
//              v1.18.18 (docs/mcp/OPENCODE-CLI-PIN.md). First consumer of the
//              5a-core door-family factories. opencode ≠ OpenClaw ≠ the
//              renamed-to-Crush ancestor sharing the binary name.
// ────────────────────────────────────────────────────────────────────────────

/** Locate the real `opencode` binary. $OPENCODE_BIN (fail-closed) first —
 *  the binary name has colliding claimants, and the bare-semver `--version`
 *  shape (T1) is the runtime discriminator. */
export const resolveOpencodeBinary = makeBinaryResolver({
  envVar: 'OPENCODE_BIN',
  binName: 'opencode',
  candidates: (home) => [
    '/opt/homebrew/bin/opencode',
    '/usr/local/bin/opencode',
    `${home}/.local/bin/opencode`,
    `${home}/.npm-global/bin/opencode`,
    `${home}/.bun/bin/opencode`,
  ],
  nvmSweep: true,
  pathSweep: true,
});

/**
 * The opencode door's PAID leg gates on a NON-EMPTY ANTHROPIC key (GSTACK_
 * promotion applies). Deliberately NOT an "is opencode usable" probe — the
 * keyless anonymous free tier answers headless runs AND drives MCP tool
 * calls (observed; the door's core SMOKE rides it), so the paid leg is an
 * optional hardening tier, and a blank CI secret ⇒ skip, never a paid
 * failing test. auth.json probing is deliberately absent until its shape is
 * observed post-login (OPENCODE-CLI-PIN.md §Pending auth).
 */
export function hasOpencodeAuth(): boolean {
  return Boolean(promotedEnv(process.env).ANTHROPIC_API_KEY?.trim());
}

/**
 * Hermetic env for spawning opencode itself: HOME + BOTH XDG dirs redirected
 * (config/auth/data all move — verified on macOS; belt-and-suspenders), the
 * env half of the double autoupdate kill, ANTHROPIC_API_KEY re-admitted
 * explicitly for the paid leg (default-deny stays intact for every other
 * child). Deletes the OTHER providers' keys (single-auth-source discipline —
 * the paid leg pins an anthropic/* model) and the OPENCODE_CONFIG* trio
 * (observed inert in 1.18.18, but a future release activating them must not
 * let ambient values shadow the hermetic config). GITHUB_* step-metadata
 * scrub via the shared factory.
 */
export const opencodeChildEnv = makeAgentChildEnv({
  overrides: (home) => ({
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_DATA_HOME: path.join(home, '.local', 'share'),
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    ANTHROPIC_API_KEY: promotedEnv(process.env).ANTHROPIC_API_KEY?.trim() || undefined,
  }),
  deleteKeys: [
    'OPENAI_API_KEY', 'XAI_API_KEY', 'OPENROUTER_API_KEY',
    'GOOGLE_GENERATIVE_AI_API_KEY', 'GEMINI_API_KEY', 'ANTHROPIC_AUTH_TOKEN',
    'OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG_CONTENT',
  ],
});

/**
 * Seed a hermetic <XDG_CONFIG_HOME>/opencode/opencode.json BEFORE any
 * opencode spawn:
 *  - `"autoupdate": false` — the config half of the double kill (the env
 *    half rides opencodeChildEnv); a door run must never self-update
 *    mid-suite and break the version pin.
 *  - `"model": <model>` when given (provider/model form). Per-call `-m`
 *    stays authoritative; the seed covers spawns that take no flag.
 * Plain JSON (comments legal but not needed here); `opencode mcp add`
 * preserves pre-existing keys (observed), so the seed survives registration.
 * No credentials are written: paid auth travels via ANTHROPIC_API_KEY only.
 */
export function seedOpencodeConfig(home: string, opts?: { defaultModel?: string }): string {
  const cfgDir = path.join(home, '.config', 'opencode');
  fs.mkdirSync(cfgDir, { recursive: true });
  const doc: Record<string, unknown> = {
    $schema: 'https://opencode.ai/config.json',
    autoupdate: false,
    ...(opts?.defaultModel ? { model: opts.defaultModel } : {}),
  };
  const cfgPath = path.join(cfgDir, 'opencode.json');
  fs.writeFileSync(cfgPath, `${JSON.stringify(doc, null, 2)}\n`, 'utf-8');
  return cfgPath;
}

export interface OpencodeTurnOpts {
  prompt: string;
  cwd: string;
  home: string;
  timeoutMs?: number;
  /** Per-call model pin (provider/model — authoritative over the config seed). */
  model?: string;
  /** 'json' emits the NDJSON event stream parseOpencodeJsonl pins. */
  format?: 'default' | 'json';
  /** Staged gbrain bin dir — PATH-prepended so a PATH-resolved registration
   *  resolves when opencode spawns the server during the turn. */
  binDir?: string;
}

/**
 * Drive one `opencode run` turn against a hermetic HOME + XDG dirs. Default
 * format prints the final answer ALONE on stdout (banner/UI on stderr —
 * observed); no permission flag is needed for MCP tool calls (observed:
 * --auto not passed, deliberately). Shared spawn core: kill(9) escalation +
 * bounded drain.
 */
export async function opencodeOneShotTurn(opts: OpencodeTurnOpts): Promise<OneShotSpawnResult> {
  const bin = resolveOpencodeBinary();
  if (!bin) throw new Error('opencodeOneShotTurn: opencode binary not found');
  return runOneShotSpawn({
    argv: [
      bin, 'run', opts.prompt,
      '--format', opts.format ?? 'default',
      ...(opts.model ? ['-m', opts.model] : []),
    ],
    cwd: opts.cwd,
    env: opencodeChildEnv(opts.home, { binDir: opts.binDir }),
    timeoutMs: opts.timeoutMs ?? 240_000,
  });
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

// ────────────────────────────────────────────────────────────────────────────
// Plugin-lane probes (EV11/EV12)
// ────────────────────────────────────────────────────────────────────────────

/** True when the codex binary supports the plugin/marketplace subcommands. */
export function codexSupportsPlugins(bin: string): boolean {
  try {
    const r = spawnSync(bin, ['plugin', '--help'], { encoding: 'utf8', timeout: 15_000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

/** True when the claude binary supports the plugin subcommands. */
export function claudeSupportsPlugins(bin: string): boolean {
  try {
    const r = spawnSync(bin, ['plugin', '--help'], { encoding: 'utf8', timeout: 15_000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

/**
 * Deterministic MCP surface oracle (EV12): spawn an MCP stdio server command,
 * run the initialize handshake, and return the advertised tool names via a
 * real `tools/list` — never an LLM-output assertion. Used by the plugin e2e
 * to pin "the snapshot launcher serves exactly the starter surface".
 */
export async function mcpToolsListProbe(opts: {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
}): Promise<{ tools: string[]; stderr: string }> {
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const proc = Bun.spawn([opts.command, ...opts.args], {
    cwd: opts.cwd,
    env: opts.env as Record<string, string>,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const frames = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'gbrain-e2e-probe', version: '0' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  ];
  proc.stdin.write(frames.map((f) => JSON.stringify(f)).join('\n') + '\n');
  try { await proc.stdin.end(); } catch { /* already closed */ }

  const stderrDone = new Response(proc.stderr).text();
  const reader = proc.stdout.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let tools: string[] | null = null;
  const deadline = Date.now() + timeoutMs;
  // Race each read against the remaining deadline: a child that opens stdout
  // but never writes would otherwise block `reader.read()` forever, past the
  // deadline the while-condition can only check between reads.
  const readOrTimeout = () => Promise.race([
    reader.read(),
    new Promise<{ done: true; value: undefined }>((res) =>
      setTimeout(() => res({ done: true, value: undefined }), Math.max(0, deadline - Date.now())),
    ),
  ]);
  try {
    while (tools === null && Date.now() < deadline) {
      const { done, value } = await readOrTimeout();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split('\n');
      buf = parts.pop() || '';
      for (const line of parts) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.id === 2 && obj.result?.tools) {
            tools = obj.result.tools.map((t: { name: string }) => t.name);
          }
        } catch {
          /* non-JSON stderr leakage or partial frame — skip */
        }
      }
    }
  } finally {
    try { proc.kill(); } catch { /* already dead */ }
  }
  const stderr = await stderrDone.catch(() => '');
  if (tools === null) {
    throw new Error(`mcpToolsListProbe: no tools/list response within ${timeoutMs}ms — stderr:\n${stderr.slice(0, 2000)}`);
  }
  return { tools, stderr };
}
