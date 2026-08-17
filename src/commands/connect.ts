/**
 * `gbrain connect` — one-command coding-agent onboarding from a bearer token
 * (or OAuth 2.1 client credentials).
 *
 * Turns an MCP URL + credential into a paste-ready block (or wires it up
 * directly with --install) that connects a coding agent straight to a remote
 * `gbrain serve --http` and teaches it to self-orient via `get_brain_identity`
 * + `list_skills`. Direct HTTP MCP — no local install or thin-client config
 * needed for the connection.
 *
 *   gbrain connect <mcp-url> [--token <bearer>] [--name gbrain]
 *                  [--agent claude-code|codex|opencode|perplexity|generic]
 *                  [--oauth [--register | --client-id ID --client-secret SECRET] [--scopes "read write"]]
 *                  [--install] [--yes] [--json] [--show-token] [--force]
 *                  [--timeout-ms N]
 *
 * Auth:
 *   - Bearer (default): a `gbrain auth create` token. Simple; long-lived +
 *     full-access. Best for local/personal use.
 *   - OAuth 2.1 client credentials (`--oauth`, perplexity/generic only): the
 *     correct path for anything exposed to a third-party cloud — least-privilege
 *     scopes + short-lived rotating access tokens. The connector is given an
 *     issuer URL + client_id + client_secret; it mints its own tokens.
 *
 * Per-agent shape:
 *   - claude-code: `claude mcp add ... -H "Authorization: Bearer <tok>"` (bearer
 *     only; --install runs it).
 *   - codex: `codex mcp add <name> --url <url> --bearer-token-env-var
 *     GBRAIN_REMOTE_TOKEN` (bearer via env var; --install runs it).
 *   - opencode: `opencode mcp add <name> --url <url> --header
 *     "Authorization=Bearer {env:GBRAIN_REMOTE_TOKEN}"` (the interpolation is
 *     stored literally; --install writes the entry directly via
 *     opencode-json.ts — no binary needed).
 *   - perplexity: GUI connector (Settings → Connectors). Supports bearer or
 *     OAuth; no --install.
 *   - generic: prints the connector fields for any other MCP client.
 */

import { execFileSync } from 'child_process';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ConnectProbeResult } from '../core/connect-probe.ts';
import { probeBrainIdentity, DEFAULT_PROBE_TIMEOUT_MS } from '../core/connect-probe.ts';
import { opencodeGlobalConfigPath } from '../core/bootstrap/host-specs.ts';
import { acquireBootstrapLock } from '../core/bootstrap/lock.ts';
import {
  GBRAIN_REMOTE_TOKEN_ENV,
  reconcileOpencodeSiblingGlobal,
  writeOpencodeMcpEntry,
} from '../core/bootstrap/opencode-json.ts';
import { promptLine } from '../core/cli-util.ts';
import {
  NAME_RE,
  OAUTH_SECRET_NOTE,
  REDACTED,
  buildClaudeMcpAddArgv,
  buildCodexMcpAddArgv,
  buildOpencodeMcpAddArgv,
  cmdString,
  isValidName,
  issuerFromMcpUrl,
  normalizeMcpUrl,
  redactToken,
  shellQuote,
  validateToken,
} from '../core/mcp-registration.ts';

// The pure registration helpers moved to src/core/mcp-registration.ts for
// #4043 (the bootstrap harness lane consumes them; core must not import from
// commands). Re-exported so this module's public surface — and every test
// that imports from it — is unchanged.
export {
  OAUTH_SECRET_NOTE,
  REDACTED,
  buildClaudeMcpAddArgv,
  buildCodexMcpAddArgv,
  buildOpencodeMcpAddArgv,
  cmdString,
  isLinkLocalOrMetadata,
  issuerFromMcpUrl,
  isValidName,
  normalizeMcpUrl,
  redactToken,
  validateToken,
  type TokenValidation,
  type UrlResult,
} from '../core/mcp-registration.ts';

// Defined from the writer's exported constant so the printed interpolation and
// the ownership fingerprint literal ({env:GBRAIN_REMOTE_TOKEN}) cannot drift.
export const ENV_VAR = GBRAIN_REMOTE_TOKEN_ENV;
export const PLACEHOLDER_TOKEN = '<paste-your-token>';
export const PLACEHOLDER_SECRET = '<paste-your-client-secret>';
export const DEFAULT_NAME = 'gbrain';
export const DEFAULT_SCOPES = 'read write';
// Single source of truth shared with the probe (was a duplicated 15_000 literal).
const DEFAULT_TIMEOUT_MS = DEFAULT_PROBE_TIMEOUT_MS;

export type AgentId = 'claude-code' | 'codex' | 'opencode' | 'perplexity' | 'generic';

interface AgentSpec {
  id: AgentId;
  label: string;       // human label for messages
  binary?: string;     // CLI binary backing --install ('claude' | 'codex'; opencode installs via the direct JSONC writer)
  installable: boolean;
  supportsOAuth: boolean; // accepts OAuth client-credentials connector fields
}

export const AGENT_SPECS: Record<AgentId, AgentSpec> = {
  'claude-code': { id: 'claude-code', label: 'Claude Code', binary: 'claude', installable: true, supportsOAuth: false },
  codex: { id: 'codex', label: 'Codex', binary: 'codex', installable: true, supportsOAuth: false },
  // No `binary`: the opencode --install lane never execs a CLI (direct JSONC
  // write), and it branches before the exec lane's `spec.binary` read.
  opencode: { id: 'opencode', label: 'opencode', installable: true, supportsOAuth: false },
  perplexity: { id: 'perplexity', label: 'Perplexity Computer', installable: false, supportsOAuth: true },
  generic: { id: 'generic', label: 'your agent', installable: false, supportsOAuth: true },
};

export const AGENT_IDS: AgentId[] = ['claude-code', 'codex', 'opencode', 'perplexity', 'generic'];

// The named tools MUST be real MCP-exposed ops (verified by the round-trip
// E2E). `capture` earned its slot in the CLI→MCP gap-closure wave (D2A):
// it is a starter-surface op now — prefer it for quick notes (auto-slug +
// dedupe), `put_page` for full-control writes.
export const LEARN_INSTRUCTION =
  'Once connected, call the `get_brain_identity` tool (whose brain this is), then ' +
  '`list_skills` (everything it can do; if it errors, the host has not enabled skill ' +
  'publishing — these core tools still work: search, query, get_page, put_page, ' +
  'capture, think, find_experts). Then call `list_brain_skillpack`: if this brain ships ' +
  'a skillpack, ask the user whether to install it (gbrain skillpack scaffold <spec>). ' +
  'Prefer `capture` for quick notes (auto-slug + dedupe) and `put_page` for ' +
  'full-control writes. Always search the brain before answering or writing.';

const SECRET_NOTE =
  'Note: that bearer token is a long-lived, full-access secret — keep it private and ' +
  'prefer a scoped/short-lived token if your host supports one.';

// OAUTH_SECRET_NOTE moved to src/core/mcp-registration.ts (imported +
// re-exported above; text unchanged).

const PERPLEXITY_REMOTE_NOTE = [
  'Perplexity connects remotely, so the brain must be reachable over HTTPS. On the',
  'host run: gbrain serve --http --bind 0.0.0.0 --public-url <your-https-url> (the',
  'default 127.0.0.1 bind refuses tunneled connections). See docs/mcp/PERPLEXITY.md.',
].join('\n');

const HELP = `gbrain connect — wire a coding agent to a remote gbrain over MCP

Usage:
  gbrain connect <mcp-url> [--token <bearer>] [flags]

Prints a copy-paste setup block for your agent, or wires it up directly with
--install (claude-code, codex + opencode). The MCP URL is your remote
'gbrain serve --http' endpoint; a bare host is rejected — pass an explicit
https:// URL.

Auth:
  Bearer token (default)         simple, long-lived, full-access — best local/personal
  --oauth                        OAuth 2.1 client credentials (perplexity/generic):
                                 least-privilege scopes + short-lived tokens — best for
                                 anything exposed to a third-party cloud

Flags:
  --token <bearer>     Bearer token (else $${ENV_VAR}; from 'gbrain auth create')
  --name <id>          MCP server name in the agent (default: ${DEFAULT_NAME})
  --agent <kind>       claude-code (default) | codex | opencode | perplexity | generic
  --oauth              Use OAuth client credentials instead of a bearer token
  --register           With --oauth: mint a client on the host (gbrain auth register-client)
  --client-id <id>     With --oauth: use an existing OAuth client id
  --client-secret <s>  With --oauth: use an existing OAuth client secret
  --scopes "<s>"       With --oauth --register: client scopes (default: "${DEFAULT_SCOPES}")
  --install            Run the agent's MCP-add command, then smoke-test the token
                       (claude-code + codex + opencode; opencode installs via a direct
                       config write — no binary needed, token stays out of the file)
  --yes                Skip the install confirmation prompt
  --force              On --install, replace an existing server of the same name
  --json               Emit machine-readable JSON (secret redacted)
  --show-token         With --json, include the literal token/secret (avoid in logs)
  --timeout-ms <n>     Smoke-test timeout for --install (default: ${DEFAULT_TIMEOUT_MS})

Examples:
  gbrain connect https://brain.example.com/mcp --token gbrain_xxx
  gbrain connect https://brain.example.com:3131 --install --yes
  gbrain connect https://brain.example.com/mcp --token gbrain_xxx --agent codex
  gbrain connect https://brain.example.com/mcp --token gbrain_xxx --agent opencode --install
  gbrain connect https://brain.example.com/mcp --agent perplexity --oauth --register
  gbrain connect https://brain.example.com/mcp --agent perplexity --oauth \\
    --client-id gbrain_cl_xxx --client-secret gbrain_cs_xxx
`;

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in test/connect.test.ts; registration helpers
// live in src/core/mcp-registration.ts and are re-exported above)
// ---------------------------------------------------------------------------

export type TokenResolution =
  | { kind: 'literal'; token: string }
  | { kind: 'placeholder' }
  | { kind: 'error'; error: string };

export function resolveToken(opts: { tokenFlag?: string | null; env?: string | null; mode: 'print' | 'install' }): TokenResolution {
  const t = opts.tokenFlag ?? opts.env ?? null;
  if (t != null && t !== '') {
    const v = validateToken(t);
    if (!v.ok) return { kind: 'error', error: v.error };
    return { kind: 'literal', token: t };
  }
  if (opts.mode === 'print') return { kind: 'placeholder' };
  return {
    kind: 'error',
    error: `No token. Pass --token <bearer> or set ${ENV_VAR}. Create one on the host with: gbrain auth create "<name>"`,
  };
}

export interface OAuthCreds {
  issuer: string;
  clientId: string;
  clientSecret: string | null;
}

function claudeBlock(p: { name: string; url: string; token: string | null }): string {
  const headerToken = p.token ?? PLACEHOLDER_TOKEN;
  const cmd = cmdString('claude', buildClaudeMcpAddArgv({ name: p.name, url: p.url, headerToken }));
  const lines = ['# Paste into Claude Code:', '', 'Connect my knowledge brain, then learn what it can do:', '', `  ${cmd}`, ''];
  if (!p.token) lines.push(`Replace ${PLACEHOLDER_TOKEN} with a token from \`gbrain auth create "claude-code"\` on the host.`, '');
  lines.push(LEARN_INSTRUCTION, '', SECRET_NOTE);
  return lines.join('\n');
}

function codexBlock(p: { name: string; url: string; token: string | null }): string {
  const tokenValue = p.token ?? PLACEHOLDER_TOKEN;
  const cmd = cmdString('codex', buildCodexMcpAddArgv({ name: p.name, url: p.url, envVar: ENV_VAR }));
  const lines = [
    '# Paste into Codex:',
    '',
    'Connect my knowledge brain, then learn what it can do:',
    '',
    `  export ${ENV_VAR}=${shellQuote(tokenValue)}`,
    `  ${cmd}`,
    '',
  ];
  if (!p.token) lines.push(`Replace ${PLACEHOLDER_TOKEN} with a token from \`gbrain auth create "codex"\` on the host.`, '');
  lines.push(
    `Codex reads the token from $${ENV_VAR} at runtime — keep that variable set in your shell profile so new Codex sessions can reach the brain.`,
    '',
    LEARN_INSTRUCTION,
    '',
    SECRET_NOTE,
  );
  return lines.join('\n');
}

function opencodeBlock(p: { name: string; url: string; token: string | null }): string {
  const tokenValue = p.token ?? PLACEHOLDER_TOKEN;
  const cmd = cmdString('opencode', buildOpencodeMcpAddArgv({ name: p.name, url: p.url, envVar: ENV_VAR }));
  const lines = [
    '# Paste into opencode:',
    '',
    'Connect my knowledge brain, then learn what it can do:',
    '',
    `  export ${ENV_VAR}=${shellQuote(tokenValue)}`,
    `  ${cmd}`,
    '',
  ];
  if (!p.token) lines.push(`Replace ${PLACEHOLDER_TOKEN} with a token from \`gbrain auth create "opencode"\` on the host.`, '');
  lines.push(
    `The config stores the literal \`{env:${ENV_VAR}}\` interpolation — opencode resolves it at read time, ` +
      `so keep that variable exported in your shell profile; the token never lands in the config file. ` +
      `Restart opencode after registering (config is read at session start).`,
    '',
    LEARN_INSTRUCTION,
    '',
    SECRET_NOTE,
  );
  return lines.join('\n');
}

function perplexityBearerBlock(p: { url: string; token: string | null }): string {
  const tokenValue = p.token ?? PLACEHOLDER_TOKEN;
  return [
    '# In Perplexity (Pro): Settings → Connectors → add a remote MCP server:',
    `#   URL:    ${p.url}`,
    '#   Auth:   Bearer token (API key)',
    `#   Token:  ${tokenValue}`,
    '',
    PERPLEXITY_REMOTE_NOTE,
    '',
    LEARN_INSTRUCTION,
    '',
    SECRET_NOTE,
  ].join('\n');
}

function perplexityOAuthBlock(p: { oauth: OAuthCreds }): string {
  const secret = p.oauth.clientSecret ?? PLACEHOLDER_SECRET;
  return [
    '# In Perplexity (Pro): Settings → Connectors → add a remote MCP server:',
    `#   URL:           ${p.oauth.issuer}/mcp`,
    '#   Auth:          OAuth 2.1 (client credentials)',
    `#   Issuer URL:    ${p.oauth.issuer}`,
    `#   Client ID:     ${p.oauth.clientId}`,
    `#   Client Secret: ${secret}`,
    '',
    'OAuth is the recommended path for Perplexity (a cloud service): the connector',
    'mints short-lived, scoped access tokens instead of holding a long-lived secret.',
    '',
    PERPLEXITY_REMOTE_NOTE,
    '',
    LEARN_INSTRUCTION,
    '',
    OAUTH_SECRET_NOTE,
  ].join('\n');
}

function genericBearerBlock(p: { url: string; token: string | null }): string {
  const headerToken = p.token ?? PLACEHOLDER_TOKEN;
  return [
    '# Add an HTTP MCP server pointed at your gbrain:',
    `#   URL:    ${p.url}`,
    `#   Header: Authorization: Bearer ${headerToken}`,
    '',
    LEARN_INSTRUCTION,
  ].join('\n');
}

function genericOAuthBlock(p: { oauth: OAuthCreds }): string {
  const secret = p.oauth.clientSecret ?? PLACEHOLDER_SECRET;
  return [
    '# Add an OAuth 2.1 (client-credentials) MCP server pointed at your gbrain:',
    `#   URL:           ${p.oauth.issuer}/mcp`,
    `#   Issuer URL:    ${p.oauth.issuer}`,
    `#   Client ID:     ${p.oauth.clientId}`,
    `#   Client Secret: ${secret}`,
    '',
    LEARN_INSTRUCTION,
    '',
    OAUTH_SECRET_NOTE,
  ].join('\n');
}

export function buildConnectBlock(p: { agent: AgentId; name: string; url: string; token: string | null; oauth?: OAuthCreds }): string {
  if (p.oauth) {
    // OAuth is only emitted for connector-style agents (gated upstream).
    return p.agent === 'generic' ? genericOAuthBlock({ oauth: p.oauth }) : perplexityOAuthBlock({ oauth: p.oauth });
  }
  switch (p.agent) {
    case 'claude-code': return claudeBlock(p);
    case 'codex': return codexBlock(p);
    case 'opencode': return opencodeBlock(p);
    case 'perplexity': return perplexityBearerBlock(p);
    case 'generic': return genericBearerBlock(p);
  }
}

export function buildJson(p: { url: string; name: string; agent: AgentId; token: string | null; showToken: boolean; oauth?: OAuthCreds; scopes?: string }): Record<string, unknown> {
  if (p.oauth) {
    const secret = p.oauth.clientSecret;
    return {
      schema_version: 1,
      agent: p.agent,
      mcp_url: p.url,
      name: p.name,
      auth: 'oauth',
      issuer_url: p.oauth.issuer,
      client_id: p.oauth.clientId,
      client_secret: secret == null ? null : (p.showToken ? secret : REDACTED),
      secret_redacted: secret != null && !p.showToken,
      scopes: p.scopes ?? DEFAULT_SCOPES,
      command: null,
      command_argv: null,
      learn_instruction: LEARN_INSTRUCTION,
    };
  }
  const shownToken = p.token ? (p.showToken ? p.token : REDACTED) : PLACEHOLDER_TOKEN;
  let command_argv: string[] | null = null;
  let command: string | null = null;
  if (p.agent === 'claude-code') {
    command_argv = buildClaudeMcpAddArgv({ name: p.name, url: p.url, headerToken: shownToken });
    command = cmdString('claude', command_argv);
  } else if (p.agent === 'codex') {
    // Codex command carries no token (env-var name only), so it's safe verbatim.
    command_argv = buildCodexMcpAddArgv({ name: p.name, url: p.url, envVar: ENV_VAR });
    command = cmdString('codex', command_argv);
  } else if (p.agent === 'opencode') {
    // The literal {env:VAR} interpolation, not a token — safe verbatim.
    command_argv = buildOpencodeMcpAddArgv({ name: p.name, url: p.url, envVar: ENV_VAR });
    command = cmdString('opencode', command_argv);
  }
  return {
    schema_version: 1,
    agent: p.agent,
    mcp_url: p.url,
    name: p.name,
    auth: 'bearer',
    env_var: ENV_VAR,
    token_present: p.token != null,
    token_redacted: p.token != null && !p.showToken,
    header: `Authorization: Bearer ${shownToken}`,
    command, // runnable CLI command; null for perplexity/generic (UI/manual setup)
    command_argv,
    learn_instruction: LEARN_INSTRUCTION,
  };
}

// ---------------------------------------------------------------------------
// --install / --register dependencies (injectable for tests)
// ---------------------------------------------------------------------------

export type RegisterResult =
  | { ok: true; clientId: string; clientSecret: string }
  | { ok: false; message: string };

export interface ConnectDeps {
  isTTY(): boolean;
  promptYesNo(question: string): Promise<boolean>;
  hasBinary(binary: string): boolean;
  runBinary(binary: string, argv: string[]): { code: number; stdout: string; stderr: string };
  probe(url: string, token: string, timeoutMs: number): Promise<ConnectProbeResult>;
  env(name: string): string | undefined;
  registerOAuthClient(name: string, scopes: string): RegisterResult;
  /** opencode --install lane: direct JSONC write of a remote entry carrying
   * the literal `{env:GBRAIN_REMOTE_TOKEN}` interpolation (no binary execed,
   * no token on disk). Throws on a foreign same-name entry; an OURS entry at
   * a different url refuses unless `allowReplaceOtherSource` (connect maps
   * --force onto it). May be async: the default impl serializes on the
   * config-dir bootstrap lock (the writer contract); sync test fakes remain
   * assignable. */
  writeOpencodeRemoteEntry(
    name: string,
    url: string,
    opts?: { allowReplaceOtherSource?: boolean },
  ): { configPath: string; replacedPrior: boolean } | Promise<{ configPath: string; replacedPrior: boolean }>;
}

async function defaultPromptYesNo(question: string): Promise<boolean> {
  // Reuse the shared prompt helper so stdin pause/resume lifecycle matches the
  // rest of the interactive CLI flows (init, apply-migrations, ...).
  const answer = (await promptLine(`${question} (y/N): `)).toLowerCase();
  return answer === 'y' || answer === 'yes';
}

function defaultRunBinary(binary: string, argv: string[]): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(binary, argv, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, stdout: stdout ?? '', stderr: '' };
  } catch (e) {
    const err = e as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer; message?: string };
    return {
      code: typeof err.status === 'number' ? err.status : 1,
      stdout: err.stdout ? String(err.stdout) : '',
      stderr: err.stderr ? String(err.stderr) : (err.message ?? ''),
    };
  }
}

/** Mint an OAuth client by shelling to the host's `gbrain auth register-client`. */
function defaultRegisterOAuthClient(name: string, scopes: string): RegisterResult {
  const r = defaultRunBinary('gbrain', [
    'auth', 'register-client', name,
    '--grant-types', 'client_credentials',
    '--scopes', scopes,
    '--token-endpoint-auth-method', 'client_secret_post',
  ]);
  if (r.code !== 0) {
    return { ok: false, message: r.stderr || r.stdout || 'gbrain auth register-client failed' };
  }
  const clientId = r.stdout.match(/Client ID:\s+(\S+)/)?.[1];
  const clientSecret = r.stdout.match(/Client Secret:\s+(\S+)/)?.[1];
  if (!clientId || !clientSecret) {
    return { ok: false, message: 'could not parse client_id/client_secret from register-client output' };
  }
  return { ok: true, clientId, clientSecret };
}

const defaultDeps: ConnectDeps = {
  isTTY: () => !!process.stdin.isTTY,
  promptYesNo: defaultPromptYesNo,
  hasBinary: (binary) => {
    try {
      execFileSync(binary, ['--version'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  },
  runBinary: defaultRunBinary,
  probe: (url, token, timeoutMs) => probeBrainIdentity(url, token, { timeoutMs }),
  env: (name) => process.env[name],
  registerOAuthClient: defaultRegisterOAuthClient,
  writeOpencodeRemoteEntry: async (name, url, opts) => {
    // The writer's contract: callers hold acquireBootstrapLock on the config
    // dir (harness.ts [X11] parity) — the user-global file is shared across
    // workspaces and homes, so concurrent gbrain writers serialize here.
    const configPath = opencodeGlobalConfigPath();
    const cfgDir = dirname(configPath);
    mkdirSync(cfgDir, { recursive: true }); // the lock needs the dir; the writer mkdirs later anyway
    const lock = await acquireBootstrapLock(cfgDir);
    try {
      // Two-filename merge blind spot: opencode merges BOTH user-global
      // filenames, so a same-name gbrain entry in the SIBLING file would
      // survive this write as a shadow registration (ours → removed with a
      // note; foreign → refuse loudly naming both files).
      const sib = reconcileOpencodeSiblingGlobal(configPath, name, { url });
      for (const note of sib.notes) console.error(note);
      const r = writeOpencodeMcpEntry(
        configPath,
        { kind: 'remote', name, url, tokenMode: 'env' },
        { expect: { url }, ...(opts?.allowReplaceOtherSource ? { allowReplaceOtherSource: true } : {}) },
      );
      return { configPath: r.configPath, replacedPrior: r.replacedPrior };
    } finally {
      lock.release();
    }
  },
};

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

interface ParsedFlags {
  url?: string;
  token?: string;
  name: string;
  agent: AgentId;
  oauth: boolean;
  register: boolean;
  clientId?: string;
  clientSecret?: string;
  scopes: string;
  install: boolean;
  yes: boolean;
  force: boolean;
  json: boolean;
  showToken: boolean;
  timeoutMs: number;
  help: boolean;
  agentError?: string;
  argError?: string;
}

function parseArgs(args: string[]): ParsedFlags {
  const out: ParsedFlags = {
    name: DEFAULT_NAME,
    agent: 'claude-code',
    oauth: false,
    register: false,
    scopes: DEFAULT_SCOPES,
    install: false,
    yes: false,
    force: false,
    json: false,
    showToken: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    help: false,
  };
  // Read the value for a value-taking flag, refusing a missing value or one
  // that is itself a flag (e.g. `--token --install` would otherwise silently
  // consume `--install` as the token and leave install off). Shares `i` with
  // the loop below, so it is declared in the function body, not the for-header.
  let i = 0;
  const takeValue = (flag: string): string | undefined => {
    const v = args[i + 1];
    if (v === undefined || v.startsWith('--')) {
      out.argError = `${flag} requires a value.`;
      return undefined;
    }
    i++;
    return v;
  };
  for (; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case '--help': case '-h': out.help = true; break;
      case '--install': out.install = true; break;
      case '--oauth': out.oauth = true; break;
      case '--register': out.register = true; break;
      case '--yes': case '-y': out.yes = true; break;
      case '--force': out.force = true; break;
      case '--json': out.json = true; break;
      case '--show-token': out.showToken = true; break;
      case '--token': { const v = takeValue('--token'); if (v !== undefined) out.token = v; break; }
      case '--client-id': { const v = takeValue('--client-id'); if (v !== undefined) out.clientId = v; break; }
      case '--client-secret': { const v = takeValue('--client-secret'); if (v !== undefined) out.clientSecret = v; break; }
      case '--scopes': { const v = takeValue('--scopes'); if (v !== undefined) out.scopes = v; break; }
      case '--name': { const v = takeValue('--name'); if (v !== undefined) out.name = v; break; }
      case '--agent': {
        const v = takeValue('--agent');
        if (v === undefined) break;
        if ((AGENT_IDS as string[]).includes(v)) out.agent = v as AgentId;
        else out.agentError = `Unknown --agent '${v}'. Use one of: ${AGENT_IDS.join(', ')}.`;
        break;
      }
      case '--timeout-ms': {
        const raw = takeValue('--timeout-ms');
        if (raw === undefined) break;
        const n = parseInt(raw, 10);
        if (Number.isFinite(n) && n > 0) out.timeoutMs = n;
        break;
      }
      default:
        if (!a.startsWith('-') && out.url === undefined) out.url = a;
        break;
    }
  }
  return out;
}

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

/** Resolve OAuth creds from explicit flags or by registering a client on the host. */
function resolveOAuthCreds(f: ParsedFlags, url: string, deps: ConnectDeps): OAuthCreds {
  const issuer = issuerFromMcpUrl(url);
  if (f.clientId && f.clientSecret) {
    return { issuer, clientId: f.clientId, clientSecret: f.clientSecret };
  }
  if (f.clientId || f.clientSecret) {
    fail('--oauth needs BOTH --client-id and --client-secret (or use --register to mint a client).');
  }
  if (f.register) {
    const r = deps.registerOAuthClient(f.name, f.scopes);
    if (!r.ok) {
      fail(`Could not register an OAuth client (run this on the brain host where the DB lives): ${r.message}\n` +
        `Or mint one manually: gbrain auth register-client ${f.name} --grant-types client_credentials --scopes "${f.scopes}"`);
    }
    return { issuer, clientId: r.clientId, clientSecret: r.clientSecret };
  }
  return fail(
    '--oauth needs an OAuth client. Either:\n' +
    `  • --register  (mint one on the host: gbrain auth register-client ${f.name} --grant-types client_credentials --scopes "${f.scopes}")\n` +
    '  • --client-id <id> --client-secret <secret>  (use an existing client)',
  );
}

export async function runConnect(args: string[], deps: ConnectDeps = defaultDeps): Promise<void> {
  const f = parseArgs(args);
  if (f.help) {
    console.log(HELP);
    return;
  }
  if (f.argError) fail(f.argError);
  if (f.agentError) fail(f.agentError);
  if (!isValidName(f.name)) {
    fail(`Invalid --name '${f.name}'. Use a lowercase identifier matching ${NAME_RE}.`);
  }

  const norm = normalizeMcpUrl(f.url ?? '');
  if (!norm.ok) fail(norm.error);
  if (norm.warning) console.error(norm.warning);
  const url = norm.url;
  const spec = AGENT_SPECS[f.agent];

  // ---- OAuth path (connector-style agents only; no --install) ----
  if (f.oauth) {
    if (!spec.supportsOAuth) {
      fail(`--oauth (client credentials) is for connector-style agents (${AGENT_IDS.filter((a) => AGENT_SPECS[a].supportsOAuth).join(', ')}). ${spec.label} uses the bearer path — drop --oauth.`);
    }
    if (f.install) {
      fail(`--install is not supported with --oauth. ${spec.label} is configured through its UI; this prints the OAuth connector fields to paste.`);
    }
    const oauth = resolveOAuthCreds(f, url, deps);
    if (f.json) {
      console.log(JSON.stringify(buildJson({ url, name: f.name, agent: f.agent, token: null, showToken: f.showToken, oauth, scopes: f.scopes }), null, 2));
    } else {
      console.log(buildConnectBlock({ agent: f.agent, name: f.name, url, token: null, oauth }));
    }
    return;
  }

  const mode = f.install ? 'install' : 'print';
  const tok = resolveToken({ tokenFlag: f.token ?? null, env: deps.env(ENV_VAR) ?? null, mode });
  if (tok.kind === 'error') fail(tok.error);
  const token: string | null = tok.kind === 'literal' ? tok.token : null;

  if (!f.install) {
    if (f.json) {
      console.log(JSON.stringify(buildJson({ url, name: f.name, agent: f.agent, token, showToken: f.showToken }), null, 2));
    } else {
      console.log(buildConnectBlock({ agent: f.agent, name: f.name, url, token }));
    }
    return;
  }

  // --install path. token is guaranteed literal here (install mode resolveToken).
  const realToken = token as string;
  if (!spec.installable) {
    fail(`--install supports claude-code, codex, and opencode. ${spec.label} is set up through its own UI — drop --install to print the setup steps.`);
  }

  if (f.agent === 'opencode') {
    // Direct-writer lane: no opencode binary required (the JSONC write IS the
    // registration), and the config carries only the {env:VAR} interpolation
    // — the writer's fingerprint handles idempotent re-runs and refuses a
    // foreign same-name entry (--force cannot override THAT; pick --name).
    // --force maps to the writer's allowReplaceOtherSource so an OURS entry
    // at an old url (a rotated serve) is replaceable, mirroring the exec
    // lanes' documented --force semantics.
    if (!f.yes) {
      if (!deps.isTTY()) {
        fail('--install in a non-interactive shell requires --yes (refusing to register a credential-bearing MCP server without confirmation).');
      }
      const ok = await deps.promptYesNo(`Add MCP entry '${f.name}' -> ${url} to the opencode user-global config?`);
      if (!ok) fail('Aborted.');
    }
    let w: { configPath: string; replacedPrior: boolean };
    try {
      w = await deps.writeOpencodeRemoteEntry(f.name, url, { allowReplaceOtherSource: f.force });
    } catch (e) {
      fail(redactToken((e as Error).message, realToken));
    }
    console.error(
      `Added MCP entry '${f.name}' -> ${url} in ${w.configPath}` +
        `${w.replacedPrior ? ' (replaced the prior gbrain entry)' : ''}. Restart opencode (config is read at session start).`,
    );
    if (deps.env(ENV_VAR) !== realToken) {
      console.error(`opencode resolves {env:${ENV_VAR}} at read time. Add this to your shell profile so sessions can reach the brain:`);
      console.error(`  export ${ENV_VAR}=<your-token>`);
    }
    const ocProbe = await deps.probe(url, realToken, f.timeoutMs);
    if (ocProbe.ok) {
      console.error(`Verified: ${ocProbe.identity || 'brain reachable'}`);
      console.error('');
      console.error(LEARN_INSTRUCTION);
      return;
    }
    console.error(
      `Warning: registered '${f.name}', but the smoke-test did not verify (${ocProbe.reason}): ${redactToken(ocProbe.message, realToken)}`,
    );
    console.error('The agent will likely hit 401/errors until the token or URL is fixed.');
    process.exit(1);
  }

  const binary = spec.binary as string; // 'claude' | 'codex'
  if (!deps.hasBinary(binary)) {
    fail(`${spec.label} CLI ('${binary}') not found on PATH. Install ${spec.label}, or drop --install to print the command to run manually.`);
  }

  const exists = deps.runBinary(binary, ['mcp', 'get', f.name]).code === 0;
  if (exists && !f.force) {
    fail(`An MCP server named '${f.name}' already exists in ${spec.label}. Run '${binary} mcp remove ${f.name}' first, pass --name <other>, or --force to replace it.`);
  }

  if (!f.yes) {
    if (!deps.isTTY()) {
      // Non-interactive --install registers a credential-bearing MCP server and
      // fires the token at a remote host — require an explicit --yes rather than
      // silently proceeding when there's no TTY to confirm at.
      fail('--install in a non-interactive shell requires --yes (refusing to register a credential-bearing MCP server without confirmation).');
    }
    const ok = await deps.promptYesNo(`Add MCP server '${f.name}' -> ${url} to ${spec.label}?`);
    if (!ok) fail('Aborted.');
  }

  let removedExisting = false;
  if (exists && f.force) {
    const rm = deps.runBinary(binary, ['mcp', 'remove', f.name]);
    if (rm.code !== 0) {
      fail(`Could not replace existing server '${f.name}': ${redactToken(rm.stderr || rm.stdout, realToken)}`);
    }
    removedExisting = true;
  }

  const addArgv = f.agent === 'codex'
    ? buildCodexMcpAddArgv({ name: f.name, url, envVar: ENV_VAR })
    : buildClaudeMcpAddArgv({ name: f.name, url, headerToken: realToken });
  const add = deps.runBinary(binary, addArgv);
  if (add.code !== 0) {
    const note = removedExisting ? ` (note: the previous '${f.name}' was already removed — re-run to restore it)` : '';
    fail(`'${binary} mcp add' failed${note}: ${redactToken(add.stderr || add.stdout, realToken)}`);
  }
  console.error(`Added MCP server '${f.name}' -> ${url}.`);

  // Codex reads the token from the env var at runtime, not from its config.
  // If the current env doesn't already carry it, the user must export it.
  if (f.agent === 'codex' && deps.env(ENV_VAR) !== realToken) {
    console.error(`Codex reads the token from $${ENV_VAR} at runtime. Add this to your shell profile so new sessions can reach the brain:`);
    console.error(`  export ${ENV_VAR}=<your-token>`);
  }

  // D4 smoke-test: prove the token actually authenticates a tool call now,
  // instead of failing silently on the agent's first request.
  const probe = await deps.probe(url, realToken, f.timeoutMs);
  if (probe.ok) {
    console.error(`Verified: ${probe.identity || 'brain reachable'}`);
    console.error('');
    console.error(LEARN_INSTRUCTION);
    return;
  }
  // Server is registered, but end-to-end auth did not verify. Exit non-zero so
  // scripts notice; the message never echoes the token.
  console.error(
    `Warning: registered '${f.name}', but the smoke-test did not verify (${probe.reason}): ${redactToken(probe.message, realToken)}`,
  );
  console.error('The agent will likely hit 401/errors until the token or URL is fixed.');
  process.exit(1);
}
