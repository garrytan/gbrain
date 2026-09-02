/**
 * harness.ts — `gbrain bootstrap harness` (#4043): default brain wiring for
 * agent-framework-driven coding (a downstream framework spawning Claude Code
 * `claude -p` / codex exec / opencode run on a box that already hosts a brain
 * + a running `gbrain serve --http`).
 *
 * What it wires, per harness:
 * - Claude Code: user-scope HTTP MCP registration (`claude mcp add --scope
 *   user -t http … -H "Authorization: Bearer …"`), `mcp__<name>` into
 *   user-scope permissions.allow (headless pre-approval), and the lifecycle
 *   hooks (user scope by default, or per --project dir) — NO agent.json
 *   required anywhere.
 * - Codex: one managed `[mcp_servers.<name>]` TOML block with the inline
 *   bearer token (codex-toml.ts — `codex mcp add` cannot express it).
 * - opencode: one managed `mcp.<name>` remote entry with the inline bearer
 *   header in the user-global JSONC config (opencode-json.ts —
 *   framework-spawned opencode inherits no shell env, so the `{env:…}`
 *   interpolation the connect lane uses would resolve empty here).
 *
 * Contracts folded from the CEO review + outside voice (letters reference the
 * plan file):
 * - [C7] Mint-first rotation: mint → wire → smoke → only then revoke the
 *   PREVIOUS receipt's token BY ID. A wiring failure leaves the old token
 *   fully working; revoke-by-name never happens.
 * - [F1] Write-ahead receipt: harness.json persists at mint time with every
 *   planned target `pending`, flipping per-target as wiring lands — a crash
 *   at any step leaves a receipt --remove can consume.
 * - [C8] Ownership: an existing registration pointing at a DIFFERENT url is
 *   another brain's wiring — refuse without --force; --remove verifies url
 *   match before removing and skips (with a note) otherwise.
 * - [C6] User-scope and --project hook wiring are mutually exclusive; the
 *   writers additionally refuse same-file different-marker double-wiring.
 * - [C5] Session-transcript capture is its own consent item; --no-capture
 *   wires the context events only (SessionStart/UserPromptSubmit/PreCompact).
 * - [F3] Non-loopback --url is refused unless --token supplies the remote
 *   credential (remote brains are `gbrain connect`'s charter).
 * - [F7] Version-skew honesty: a serve older than the CLI verifies scoped
 *   tokens through pre-scopes code (full access) until restarted — say so.
 * - [C9] --remove is engine-free-first: host removals always run; the token
 *   revoke defers with a typed message under a live PGLite serve.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { VERSION } from '../../version.ts';
import { loadConfig, loadConfigFileOnly, toEngineConfig, type GBrainConfig } from '../config.ts';
import { resolveWritebackConfigFromFile } from '../facts/writeback-config.ts';
import {
  AMBIENT_WRITEBACK_BLOCK_BEGIN,
  ambientBlockPresent,
  installAmbientWritebackBlockAt,
  probeAmbientBlock,
  renderAmbientInstructionBlock,
  stripAmbientWritebackBlockAt,
} from './instructions-block.ts';
import { createEngine } from '../engine-factory.ts';
import { probeBrainIdentity, type ConnectProbeResult } from '../connect-probe.ts';
import {
  buildClaudeMcpAddArgv,
  isLoopbackHostname,
  isValidName,
  normalizeMcpUrl,
  redactToken,
  validateToken,
} from '../mcp-registration.ts';
import { mintLegacyToken, revokeLegacyTokenById, type MintedLegacyToken } from '../token-mint.ts';
import { generateToken } from '../utils.ts';
import { sqlQueryForEngine } from '../sql-query.ts';
import { BootstrapError, acquireBootstrapLock } from './lock.ts';
import { probeLivePgliteHolder } from './uninstall.ts';
import type { ExecRunner } from './repo.ts';
import {
  deleteHarnessReceipt,
  guardHarnessReceiptOverwrite,
  harnessReceiptPath,
  readHarnessReceiptState,
  writeHarnessReceipt,
  type HarnessReceipt,
  type HarnessTarget,
} from './format.ts';
import { atomicWriteTextFile } from './atomic-write.ts';
import { removeCodexHooks, writeCodexHooks } from './codex-hooks.ts';
import {
  removeCodexHttpServerBlock,
  writeCodexHttpServerBlock,
} from './codex-toml.ts';
import {
  addPermissionsAllowEntry,
  claudeSettingsPath,
  committedHookEvents,
  removeClaudeHooksAt,
  removePermissionsAllowEntry,
  writeClaudeHooksAt,
  type ClaudeHookEnv,
} from './hooks.ts';
import {
  CLAUDE_HOOK_EVENTS,
  CODEX_TOML_BLOCK_BEGIN,
  CODEX_TOML_BLOCK_END,
  GBRAIN_HARNESS_MARKER_VALUE,
  claudeUserMemoryPath,
  claudeUserSettingsPath,
  codexAgentsOverridePath,
  codexConfigPath,
  codexGlobalAgentsPath,
  mcpPermissionEntry,
  opencodeConfigDir,
  opencodeGlobalConfigPath,
  type ClaudeHookEvent,
  claudeConfigDir,
} from './host-specs.ts';
import {
  opencodeEntryKind,
  parseOpencodeConfig,
  parseOpencodeEntryBearer,
  reconcileOpencodeSiblingGlobal,
  removeOpencodeMcpEntry,
  writeOpencodeMcpEntry,
} from './opencode-json.ts';
import { isServeOlderThanScopes, probeServeHealth } from './serve-health.ts';

// Peeled façade seam (cathedral-6): the serve probe + scopes version floor
// moved to serve-health.ts; re-exported so this module's public surface — and
// every import site — is unchanged.
export {
  SCOPES_MIN_SERVE_VERSION,
  isServeOlderThanScopes,
  probeServeHealth,
  type ServeHealth,
} from './serve-health.ts';

// ── Flags ───────────────────────────────────────────────────────────────────

export type HarnessSelector = 'claude-code' | 'codex' | 'opencode' | 'all';

export interface HarnessFlags {
  harness: HarnessSelector;
  url?: string;
  port?: number;
  source?: string;
  tokenName: string;
  token?: string;
  name: string;
  projects: string[];
  noHooks: boolean;
  noCapture: boolean;
  force: boolean;
  remove: boolean;
  status: boolean;
  yes: boolean;
  json: boolean;
  gbrainBin?: string;
  error?: string;
}

/** Pure flag parser (unit-tested). `--local` is a documented no-op alias. */
export function parseHarnessArgs(rest: string[]): HarnessFlags {
  const out: HarnessFlags = {
    harness: 'all',
    tokenName: 'bootstrap-harness',
    name: 'gbrain',
    projects: [],
    noHooks: false,
    noCapture: false,
    force: false,
    remove: false,
    status: false,
    yes: false,
    json: false,
  };
  // [X14] Fail closed: an unattended setup command must never resolve a
  // malformed invocation by silent precedence. Missing values error.
  const value = (flag: string): string | undefined => {
    const i = rest.indexOf(flag);
    if (i < 0) return undefined;
    const v = rest[i + 1];
    if (v === undefined || v.startsWith('--')) {
      out.error = out.error ?? `${flag} requires a value`;
      return undefined;
    }
    return v;
  };
  const h = value('--harness');
  if (h !== undefined) {
    if (h !== 'claude-code' && h !== 'codex' && h !== 'opencode' && h !== 'all') {
      out.error = `unknown --harness '${h}' — pass claude-code, codex, opencode, or all`;
      return out;
    }
    out.harness = h;
  }
  const url = value('--url');
  if (url !== undefined) out.url = url;
  const port = value('--port');
  if (port !== undefined) {
    const n = Number(port);
    if (!Number.isInteger(n) || n <= 0 || n > 65535) {
      out.error = `invalid --port '${port}'`;
      return out;
    }
    out.port = n;
  }
  const source = value('--source');
  if (source !== undefined) out.source = source;
  out.tokenName = value('--token-name') ?? out.tokenName;
  const token = value('--token');
  if (token !== undefined) out.token = token;
  const name = value('--name');
  if (name !== undefined) {
    if (!isValidName(name)) {
      out.error = `invalid --name '${name}' (lowercase identifier)`;
      return out;
    }
    out.name = name;
  }
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] !== '--project') continue;
    // [X14] A --project with a missing or flag-like value must fail loudly —
    // silently dropping it would widen hook wiring to USER scope.
    if (rest[i + 1] === undefined || rest[i + 1].startsWith('--')) {
      out.error = out.error ?? 'the project flag requires a directory value';
      return out;
    }
    out.projects.push(resolve(rest[i + 1]));
  }
  out.noHooks = rest.includes('--no-hooks');
  out.noCapture = rest.includes('--no-capture');
  out.force = rest.includes('--force');
  out.remove = rest.includes('--remove');
  out.status = rest.includes('--status');
  out.yes = rest.includes('--yes');
  out.json = rest.includes('--json');
  const bin = value('--gbrain-bin');
  if (bin !== undefined) out.gbrainBin = bin;
  // [X14] Conflicting invocations error instead of resolving by precedence.
  if (out.url !== undefined && out.port !== undefined) {
    out.error = out.error ?? 'pass --url OR --port, not both (the url wins would be a silent guess)';
  }
  if (out.status && out.remove) {
    out.error = out.error ?? 'pass --status OR --remove, not both';
  }
  // --user-hooks and --local are accepted, documented no-ops (script clarity).
  // Unknown/typo'd flags never reach this parser through the CLI: cli.ts
  // validates argv against CLI_FLAG_REGISTRY pre-dispatch and rejects them
  // (verified live with a misspelled no-capture flag — it errors before
  // runHarness runs; do NOT spell the typo literally here, the registry
  // generator harvests bare flag tokens from comments and would make it
  // valid). This parser's [X14] errors are the second layer, for the known
  // flags' VALUE shapes.
  return out;
}

// ── Deps (injectable for the serial suite) ──────────────────────────────────

export interface HarnessDeps {
  runner: ExecRunner;
  gbrainHome: string;
  isTTY?: boolean;
  prompt?: (q: string) => Promise<string>;
  fetchFn?: typeof fetch;
  probeIdentity?: (url: string, token: string) => Promise<ConnectProbeResult>;
  /** Resolved user-scope settings path (tests point at a temp HOME). */
  userSettingsPath?: string;
  /** Resolved codex config path (tests point at a temp CODEX_HOME). */
  codexConfig?: string;
  /** Resolved opencode config path (tests point at a temp XDG_CONFIG_HOME). */
  opencodeConfig?: string;
  /** Resolved Claude user memory file (~/.claude/CLAUDE.md) — the
   * ambient-writeback block target. Defaults to the sibling of an injected
   * userSettingsPath so a sandboxed test can never touch the real file. */
  claudeMemoryPath?: string;
  /** Resolved codex user-global AGENTS.md (same sandboxing rule, keyed off
   * an injected codexConfig). */
  codexAgentsPath?: string;
  /** Resolved codex AGENTS.override.md — the [OV-A4] exclusivity probe. */
  codexAgentsOverride?: string;
  /** Engine-free file-plane config loader (ambient-writeback gate); tests
   * inject a fake. */
  loadFileConfig?: () => GBrainConfig | null;
  /** Engine-backed mint; tests inject a fake. */
  mint?: (opts: {
    name: string;
    scopes: string[];
    sourceGrant?: string[];
  }) => Promise<MintedLegacyToken>;
  revokeById?: (id: string) => Promise<boolean>;
  /** Live-PGLite-serve pre-probe for the revoke lane [C9]. */
  pgliteLiveServe?: () => boolean;
  detectClaude?: () => boolean;
  detectCodex?: () => boolean;
  detectOpencode?: () => boolean;
  gbrainBin?: string | null;
  log?: (line: string) => void;
  logError?: (line: string) => void;
}

function resolveDeps(deps: HarnessDeps): Required<Omit<HarnessDeps, 'gbrainBin'>> & { gbrainBin: string | null } {
  return {
    runner: deps.runner,
    gbrainHome: deps.gbrainHome,
    isTTY: deps.isTTY ?? process.stdout.isTTY === true,
    prompt: deps.prompt ?? (async () => 'n'),
    fetchFn: deps.fetchFn ?? fetch,
    probeIdentity: deps.probeIdentity ?? ((url, token) => probeBrainIdentity(url, token)),
    userSettingsPath: deps.userSettingsPath ?? claudeUserSettingsPath(),
    codexConfig: deps.codexConfig ?? codexConfigPath(),
    opencodeConfig: deps.opencodeConfig ?? opencodeGlobalConfigPath(),
    // Instruction-file targets derive from an INJECTED settings/config path's
    // directory when one is given: in production the derivation equals the
    // host-specs defaults (CLAUDE.md and AGENTS.md live beside settings.json
    // and config.toml), and in tests it keeps every write inside the temp
    // sandbox even when the test predates these fields.
    claudeMemoryPath:
      deps.claudeMemoryPath ??
      (deps.userSettingsPath ? join(dirname(deps.userSettingsPath), 'CLAUDE.md') : claudeUserMemoryPath()),
    codexAgentsPath:
      deps.codexAgentsPath ??
      (deps.codexConfig ? join(dirname(deps.codexConfig), 'AGENTS.md') : codexGlobalAgentsPath()),
    codexAgentsOverride:
      deps.codexAgentsOverride ??
      (deps.codexConfig ? join(dirname(deps.codexConfig), 'AGENTS.override.md') : codexAgentsOverridePath()),
    loadFileConfig: deps.loadFileConfig ?? loadConfigFileOnly,
    mint: deps.mint ?? defaultMint,
    revokeById: deps.revokeById ?? defaultRevokeById,
    pgliteLiveServe: deps.pgliteLiveServe ?? defaultPgliteLiveServe,
    // #4325: config-dir fallback mirrors detectCodex/detectOpencode below —
    // CI runners and alias-only shells don't expose a `claude` binary on the
    // probing process's PATH even when Claude Code is configured.
    detectClaude:
      deps.detectClaude ??
      (() => whichSafe('claude') !== null || existsSync(claudeConfigDir())),
    detectCodex:
      deps.detectCodex ??
      (() => whichSafe('codex') !== null || existsSync(deps.codexConfig ?? codexConfigPath())),
    detectOpencode:
      deps.detectOpencode ??
      (() => whichSafe('opencode') !== null || existsSync(opencodeConfigDir())),
    gbrainBin: deps.gbrainBin !== undefined ? deps.gbrainBin : null,
    log: deps.log ?? ((l) => console.log(l)),
    logError: deps.logError ?? ((l) => console.error(l)),
  };
}

function whichSafe(bin: string): string | null {
  try {
    // #4325: pass PATH explicitly — Bun.which's default lookup snapshots the
    // process-start PATH and ignores runtime process.env.PATH mutations, so
    // env-remapped test lanes (withEnv) could never sandbox detection.
    return process.env.PATH ? Bun.which(bin, { PATH: process.env.PATH }) : Bun.which(bin);
  } catch {
    return null;
  }
}

/** Optional overrides for the three harness-detection probes.
 *
 * Production leaves every field unset, so `resolveDeps` keeps its `Bun.which`
 * defaults. E2E tests MUST pin them: `Bun.which` resolves against the live
 * PATH and reads the real password-database HOME, so it ignores a test's
 * remapped HOME/PATH entirely. Without a pin, an otherwise hermetic test
 * silently asserts something different depending on which agent CLIs the host
 * happens to have installed — `claude` is on a developer laptop's PATH but
 * absent from a GitHub runner, so the claude lane never ran in CI, no
 * `claude mcp add` was exec'd, and no user-scope settings file was written.
 */
export interface HarnessDetectOverrides {
  claude?: () => boolean;
  codex?: () => boolean;
  opencode?: () => boolean;
}

/** Narrow the overrides to the HarnessDeps keys, omitting absent probes so
 * resolveDeps' production defaults stay in charge of anything not pinned. */
export function harnessDetectDeps(o?: HarnessDetectOverrides): Partial<HarnessDeps> {
  return {
    ...(o?.claude ? { detectClaude: o.claude } : {}),
    ...(o?.codex ? { detectCodex: o.codex } : {}),
    ...(o?.opencode ? { detectOpencode: o.opencode } : {}),
  };
}

/** Production mint: open the configured engine just long enough to insert. */
async function defaultMint(opts: { name: string; scopes: string[]; sourceGrant?: string[] }): Promise<MintedLegacyToken> {
  const cfg = loadConfig();
  if (!cfg) {
    throw new Error('no brain configured — run `gbrain init` first (the harness wires an EXISTING brain).');
  }
  const engineConfig = toEngineConfig(cfg);
  const engine = await createEngine(engineConfig);
  await engine.connect(engineConfig);
  try {
    let sourceGrant = opts.sourceGrant;
    if (!sourceGrant) {
      // [C2] Mirror the stdio lane's federation: no explicit --source →
      // reads span the federated=true sources, write floor 'default'.
      try {
        const { localFederatedSourceIds } = await import('../source-resolver.ts');
        sourceGrant = await localFederatedSourceIds(engine, 'default', 'seed_default');
      } catch {
        sourceGrant = undefined; // historical default floor
      }
    }
    return await mintLegacyToken(engine, {
      name: opts.name,
      takesHolders: ['world'],
      scopes: opts.scopes,
      ...(sourceGrant && sourceGrant.length > 0 ? { sourceGrant } : {}),
    });
  } finally {
    await engine.disconnect();
  }
}

async function defaultRevokeById(id: string): Promise<boolean> {
  const cfg = loadConfig();
  if (!cfg) throw new Error('no brain configured');
  const engineConfig = toEngineConfig(cfg);
  const engine = await createEngine(engineConfig);
  await engine.connect(engineConfig);
  try {
    return await revokeLegacyTokenById(sqlQueryForEngine(engine), id);
  } finally {
    await engine.disconnect();
  }
}

/** A live PGLite serve holds the single-writer lock — engine opens will fail. */
function defaultPgliteLiveServe(): boolean {
  const cfg = loadConfig();
  if (!cfg?.database_path) return false;
  return probeLivePgliteHolder(cfg.database_path) !== null;
}

// ── Consent copy [C5 / #4029 register] ──────────────────────────────────────

export function buildConsentBlock(p: {
  tokenName: string;
  tokenSupplied: boolean;
  scopes: string[];
  url: string;
  wireClaude: boolean;
  wireCodex: boolean;
  wireOpencode: boolean;
  hooks: boolean;
  capture: boolean;
  hookScope: string;
  name: string;
  userSettingsPath: string;
  codexConfig: string;
  opencodeConfig: string;
  /** Instruction files receiving the ambient-writeback managed block (only
   * when memory.auto_writeback is enabled) — consent names every file the
   * apply will write [X7 parity]. */
  instructionsPaths?: string[];
}): string {
  const lines: string[] = [
    'gbrain bootstrap harness — wire framework-spawned coding sessions to this brain',
    '',
    'Will do, on this machine:',
  ];
  let n = 1;
  lines.push(
    p.tokenSupplied
      ? `  ${n++}. Use the supplied bearer token — written ONLY into the host registrations below ` +
          `(gbrain keeps no copy) and NOT revoked by the remove flow (it is not ours to revoke).`
      : `  ${n++}. Mint bearer token '${p.tokenName}' (scopes: ${p.scopes.join('+')}; sees takes marked 'world'; ` +
          `reads span this brain's federated sources). Any prior harness token is revoked ` +
          `only after the new one is wired and verified.`,
  );
  if (p.wireClaude) {
    lines.push(
      `  ${n++}. Claude Code (user scope): register MCP server '${p.name}' -> ${p.url}, and ` +
        `pre-approve its tools for headless runs (permissions.allow entry 'mcp__${p.name}' in ${p.userSettingsPath}).`,
    );
    if (p.hooks) {
      lines.push(
        `  ${n++}. Wire the five lifecycle hooks (SessionStart/UserPromptSubmit/Stop/SessionEnd/PreCompact) in ${p.hookScope}.`,
      );
      lines.push(
        p.capture
          ? `  ${n++}. Session-transcript capture: every Claude Code session's transcript on this machine is ` +
              `secret-scanned and captured into the brain's corpus (Stop/SessionEnd hooks). Opt out of just ` +
              `this with the no-capture flag.`
          : `  ${n++}. Session-transcript capture: OFF (no-capture) — context injection only.`,
      );
    }
  }
  if (p.wireCodex) {
    lines.push(
      `  ${n++}. Codex (user-global): write [mcp_servers.${p.name}] with the bearer token INLINE into ` +
        `${p.codexConfig} (0600) — framework-spawned codex inherits no shell env, so an env-var token would not reach it.`,
    );
  }
  if (p.wireOpencode) {
    lines.push(
      `  ${n++}. opencode (user-global): write the mcp.${p.name} remote entry with the bearer token INLINE into ` +
        `${p.opencodeConfig} (0600) — framework-spawned opencode inherits no shell env, so the {env:…} ` +
        `interpolation would resolve empty.`,
    );
  }
  if (p.instructionsPaths && p.instructionsPaths.length > 0) {
    lines.push(
      `  ${n++}. Ambient memory writeback is ENABLED (memory.auto_writeback): install the managed ` +
        `instruction block (marker-delimited, credential-free) into ${p.instructionsPaths.join(' and ')} ` +
        `so every session saves durable user facts to this brain.`,
    );
  }
  // [X7] The reach statement matches what is ACTUALLY being wired — it must
  // never claim a host or a hook lane this invocation does not touch. Joined
  // list, not a ternary tree: a fourth harness must be a compile-time nudge
  // here, not a silent mislabel.
  const hostNames = [
    ...(p.wireClaude ? ['Claude Code'] : []),
    ...(p.wireCodex ? ['Codex'] : []),
    ...(p.wireOpencode ? ['opencode'] : []),
  ];
  const hosts = `EVERY ${hostNames.join(' and ')} session`;
  const hookLine = !p.wireClaude || !p.hooks
    ? 'No hooks are wired by this invocation.'
    : p.capture
      ? 'Hooks run in every Claude Code session (context injection + transcript capture); auto-commit/push lanes stay inert outside gbrain agent workspaces.'
      : 'Hooks run in every Claude Code session (context injection only — capture is OFF); auto-commit/push lanes stay inert outside gbrain agent workspaces.';
  const offRamps = [
    'GBRAIN_HOOKS=0 (runtime)',
    '`gbrain bootstrap harness --remove`',
    '`gbrain auth revoke --id <id>` (see auth list)',
    ...(p.wireClaude ? [`\`claude mcp remove ${p.name} --scope user\``] : []),
    ...(p.wireCodex ? ['edit the codex config'] : []),
    ...(p.wireOpencode ? ['edit the opencode config'] : []),
  ];
  lines.push(
    '',
    `Reach, plainly: ${hosts} on this machine — any repo, any`,
    'framework-spawned agent — can read AND write this brain through these tools.',
    hookLine,
    `Off-ramps: ${offRamps.join(', ')}.`,
  );
  return lines.join('\n');
}

// ── Apply ───────────────────────────────────────────────────────────────────

interface ClaudeMcpGetInfo {
  found: boolean;
  url?: string;
}

/** Parse `claude mcp get <name>` output for the registered URL (redact-safe). */
export function parseClaudeMcpGetUrl(out: string): ClaudeMcpGetInfo {
  const m = out.match(/^\s*URL:\s*(\S+)\s*$/m);
  if (!m) return { found: /Scope:|Type:/.test(out) };
  return { found: true, url: m[1] };
}

/**
 * [X3] Unwire prior-receipt targets that the new plan does not re-plan.
 * Matching is by (host, kind, path/name identity); unmatched targets are
 * removed from the hosts now. A cleanup failure re-appends the target to the
 * NEW receipt as failed so --remove (or a re-run) retries it.
 */
async function cleanupStalePriorTargets(
  prior: HarnessReceipt,
  receipt: HarnessReceipt,
  d: ReturnType<typeof resolveDeps>,
  save: () => void,
): Promise<void> {
  const planned = receipt.targets;
  const matches = (pt: HarnessTarget): boolean =>
    planned.some((nt) => {
      if (nt.host !== pt.host || nt.kind !== pt.kind) return false;
      if (pt.kind === 'hooks') return nt.path === pt.path && nt.marker === pt.marker;
      if (pt.kind === 'permission') return nt.path === pt.path && nt.entry === pt.entry;
      if (pt.kind === 'instructions') return nt.path === pt.path;
      return (nt.name ?? 'gbrain') === (pt.name ?? 'gbrain');
    });
  for (const pt of prior.targets) {
    if (matches(pt)) continue;
    try {
      if (pt.kind === 'instructions') {
        // Ambient-writeback block no longer planned (host dropped or
        // writeback turned off) — strip it. Same [X11] nested-lock
        // discipline as the codex branch below (the caller holds the
        // claude/config dir lock).
        if (pt.path && existsSync(pt.path)) {
          const blockDir = dirname(pt.path);
          const heldDir = resolve(dirname(d.userSettingsPath));
          const lk = resolve(blockDir) === heldDir ? null : await acquireBootstrapLock(blockDir);
          let r: { removed: boolean };
          try {
            r = stripAmbientWritebackBlockAt(pt.path);
          } finally {
            lk?.release();
          }
          if (r.removed) d.log(`stale ambient-writeback block removed from ${pt.path} (no longer planned).`);
        }
      } else if (pt.host === 'claude-code' && pt.kind === 'hooks') {
        const r = removeClaudeHooksAt(pt.path ?? d.userSettingsPath, pt.marker ?? GBRAIN_HARNESS_MARKER_VALUE);
        if (r.notes.some((n) => n.startsWith('WARNING'))) throw new Error(r.notes.join('; '));
        if (r.removed > 0) d.log(`stale harness hooks unwired from ${r.settingsPath} (no longer planned).`);
      } else if (pt.host === 'claude-code' && pt.kind === 'permission') {
        if (pt.mechanism === 'pre-existing') continue; // never ours to remove [X8]
        const r = removePermissionsAllowEntry(pt.path!, pt.entry!);
        if (r.notes.some((n) => n.startsWith('WARNING'))) throw new Error(r.notes.join('; '));
        if ((r.removed ?? 0) > 0) d.log(`stale permissions.allow entry '${pt.entry}' removed (no longer planned).`);
      } else if (pt.host === 'claude-code' && pt.kind === 'mcp') {
        const get = await d.runner(['claude', 'mcp', 'get', pt.name ?? 'gbrain']);
        const info = parseClaudeMcpGetUrl(`${get.stdout}\n${get.stderr}`);
        if (get.code === 0 && info.found && info.url === prior.url) {
          const rm = await d.runner(['claude', 'mcp', 'remove', pt.name ?? 'gbrain', '--scope', pt.scope]);
          if (rm.code !== 0 && !/not found|No MCP server/i.test(rm.stdout + rm.stderr)) {
            // A failed remove must NOT be forgotten as success — re-append so
            // --remove / the next converge retries it (ship-review P2).
            throw new Error(rm.stderr.trim() || `claude mcp remove exited ${rm.code}`);
          }
          d.log(`stale MCP registration '${pt.name}' removed (no longer planned).`);
        } else if (get.code === 0 && info.found && !info.url) {
          // Refuse-rather-than-guess: an unparseable URL means we cannot prove
          // ownership — never remove a registration we can't verify is ours.
          d.log(
            `stale MCP registration '${pt.name}' left in place — could not verify its URL against the receipt; ` +
              `remove it manually if it is this brain's: claude mcp remove ${pt.name ?? 'gbrain'} --scope ${pt.scope}`,
          );
        }
      } else if (pt.host === 'codex' && pt.kind === 'mcp') {
        // [X11] The caller holds only the claude config-dir lock; the codex
        // config is a DIFFERENT shared file, and its read-modify-write must
        // serialize on ITS directory's bootstrap lock too — a concurrent
        // codex-dir-locked writer interleaving here would have one rename
        // discard the other. Ordering matches apply/remove (claude/config
        // dir first, then codex dir), so no lock-order inversion; the lock
        // is non-reentrant, so the same-dir case skips the nested acquire.
        const codexPath = pt.path ?? d.codexConfig;
        const codexDir = dirname(codexPath);
        mkdirSync(codexDir, { recursive: true });
        const heldDir = resolve(dirname(d.userSettingsPath));
        const lk = resolve(codexDir) === heldDir ? null : await acquireBootstrapLock(codexDir);
        let r: ReturnType<typeof removeCodexHttpServerBlock>;
        try {
          r = removeCodexHttpServerBlock(codexPath, pt.name ?? 'gbrain');
        } finally {
          lk?.release();
        }
        if (r.removed) d.log(`stale codex managed block removed from ${codexPath} (no longer planned).`);
      } else if (pt.host === 'opencode' && pt.kind === 'mcp') {
        // Fingerprint-keyed against the PRIOR receipt's url — a foreign or
        // rotated-away entry refuses inside the module (never guess). Same
        // [X11] nested-lock discipline as the codex branch above (claude/
        // config dir held by the caller, then the opencode dir here).
        const ocPath = pt.path ?? d.opencodeConfig;
        const ocDir = dirname(ocPath);
        mkdirSync(ocDir, { recursive: true });
        const heldDir = resolve(dirname(d.userSettingsPath));
        const lk = resolve(ocDir) === heldDir ? null : await acquireBootstrapLock(ocDir);
        let r: ReturnType<typeof removeOpencodeMcpEntry>;
        try {
          r = removeOpencodeMcpEntry(ocPath, pt.name ?? 'gbrain', { url: prior.url });
        } finally {
          lk?.release();
        }
        if (r.removed) d.log(`stale opencode entry removed from ${ocPath} (no longer planned).`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      receipt.targets.push({ ...pt, state: 'failed', error: `stale-cleanup: ${msg}` });
      save();
      d.logError(`could not unwire stale ${pt.host}/${pt.kind}: ${msg} (kept on the receipt for retry).`);
    }
  }
}

export async function applyHarness(flags: HarnessFlags, rawDeps: HarnessDeps): Promise<number> {
  const d = resolveDeps(rawDeps);
  // stdout-for-data discipline: under --json, stdout carries ONLY the final
  // JSON document; every prose/progress line flows to stderr (matching the
  // statusHarness --json contract, so machine callers never scrape).
  const emitJson = d.log;
  if (flags.json) (d as { log: (line: string) => void }).log = d.logError;

  // 1. Validate inputs + detect harnesses.
  for (const dir of flags.projects) {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      d.logError(`--project directory does not exist: ${dir}`);
      return 2;
    }
  }
  if (flags.token !== undefined) {
    const v = validateToken(flags.token);
    if (!v.ok) {
      d.logError(`--token: ${v.error}`);
      return 2;
    }
  }
  // [X1] Detection heuristics gate only the `all` DEFAULT. An explicit
  // `--harness codex` FORCES wiring: the TOML writer needs no codex CLI and
  // creates the config 0600 — that no-CLI box (embedded/ACP codex) is the
  // exact use case #4043 filed. Claude Code stays CLI-gated even when
  // explicit (we exec `claude mcp add`; it owns ~/.claude.json).
  const wireClaude = (flags.harness === 'all' || flags.harness === 'claude-code') && d.detectClaude();
  const wireCodex = flags.harness === 'codex' || (flags.harness === 'all' && d.detectCodex());
  // opencode mirrors codex: an explicit --harness opencode FORCES wiring (the
  // JSONC writer needs no opencode CLI and creates the config file itself).
  const wireOpencode = flags.harness === 'opencode' || (flags.harness === 'all' && d.detectOpencode());
  if (flags.harness === 'claude-code' && !wireClaude) {
    d.logError('claude CLI not found on PATH — the user-scope MCP registration needs it (it owns ~/.claude.json).');
    return 2;
  }
  if (!wireClaude && !wireCodex && !wireOpencode) {
    d.logError(
      'no harness detected on this box (claude CLI not on PATH; no codex install; no opencode install) — ' +
        'pass --harness claude-code|codex|opencode explicitly if detection is wrong.',
    );
    return 2;
  }

  // 2. Serve health + loopback guard [F3].
  const norm = normalizeMcpUrl(flags.url ?? `http://127.0.0.1:${flags.port ?? 3131}/mcp`);
  if (!norm.ok) {
    d.logError(norm.error);
    return 2;
  }
  const url = norm.url;
  if (norm.warning) d.logError(norm.warning); // [X13] never discard the http-bearer warning
  const hostname = new URL(url).hostname;
  if (flags.url !== undefined && !isLoopbackHostname(hostname) && flags.token === undefined) {
    d.logError(
      `--url points at a non-loopback host (${hostname}) but the token would be minted in the LOCAL brain — ` +
        'those are different databases. For a remote brain use `gbrain connect --install`; ' +
        'to use harness mode as a pure registrar for a LAN serve, pass --token <bearer> from that brain.',
    );
    return 2;
  }
  // [X13] Registrar mode: a non-loopback --url + --token registers a REMOTE
  // serve, but hooks always talk to the LOCAL brain (gbrain bin + local
  // config) — wiring them here would split-brain the box. MCP only.
  const registrarMode = flags.url !== undefined && !isLoopbackHostname(hostname);
  if (registrarMode && !flags.noHooks && wireClaude) {
    d.log(
      'registrar mode (non-loopback url): hooks are NOT wired — they would talk to the LOCAL brain, ' +
        'not the registered remote serve. MCP registration only.',
    );
  }
  const health = await probeServeHealth(url, d.fetchFn);
  if (!health.ok) {
    d.logError(
      `no healthy gbrain serve at ${url} (${health.detail ?? 'unreachable'}) — ` +
        'start `gbrain serve --http` on this box first (or pass --url/--port).',
    );
    return 1;
  }

  // 2b. Ambient-writeback gate (WP3): resolved from the FILE plane only —
  // this lane is engine-free by design (the DB plane stays authoritative for
  // extraction; doctor's drift check catches plane divergence). Default OFF.
  // REGISTRAR MODE never installs instruction blocks (adversarial review,
  // this wave): the local file mirror speaks for the LOCAL brain, but the
  // block would order agents to save into the REMOTE brain — whose operator
  // may never have opted in. That brain's own serve advertises the ambient
  // section over MCP `instructions` when ITS config enables it.
  const wb = resolveWritebackConfigFromFile(d.loadFileConfig());
  const wbInstall = wb.enabled && !registrarMode;
  if (wb.enabled && registrarMode) {
    d.log(
      'registrar mode: ambient-writeback instruction blocks are NOT installed for a remote brain — ' +
        'its own MCP instructions carry the contract when the remote operator enables memory.auto_writeback.',
    );
  }
  const ambientBody =
    !wbInstall
      ? null
      : renderAmbientInstructionBlock({
          mode: wb.mode as 'salient' | 'all',
          transientTtl: wb.transient_ttl,
          visibility: wb.visibility_posture,
          serveUrl: url,
        });
  const instructionsPaths = wbInstall
    ? [...(wireClaude ? [d.claudeMemoryPath] : []), ...(wireCodex ? [d.codexAgentsPath] : [])]
    : [];

  // 3. Consent (connect --install shape; never the interview/A8 ledger).
  const wireHooks = wireClaude && !flags.noHooks && !registrarMode;
  const hookScope = flags.projects.length > 0 ? `${flags.projects.length} project dir(s)` : 'user scope';
  const consent = buildConsentBlock({
    tokenName: flags.tokenName,
    tokenSupplied: flags.token !== undefined,
    scopes: ['read', 'write'],
    url,
    wireClaude,
    wireCodex,
    wireOpencode,
    hooks: wireHooks,
    capture: !flags.noCapture,
    hookScope,
    name: flags.name,
    userSettingsPath: d.userSettingsPath,
    codexConfig: d.codexConfig,
    opencodeConfig: d.opencodeConfig,
    ...(instructionsPaths.length > 0 ? { instructionsPaths } : {}),
  });
  d.log(consent);
  if (!flags.yes) {
    if (!d.isTTY) {
      d.logError('\nnon-interactive shell: pass --yes to confirm the wiring above.');
      return 2;
    }
    const answer = (await d.prompt('\nProceed? (y/N) ')).trim().toLowerCase();
    if (answer !== 'y' && answer !== 'yes') {
      d.log('aborted — nothing written.');
      return 1;
    }
  }

  // Prior receipt: carries the previous minted token for post-wire rotation
  // [C7], and the prior hook-scope for the user-XOR-project exclusivity check
  // [C6].
  const priorState = readHarnessReceiptState(d.gbrainHome);
  const prior = priorState.state === 'ok' ? priorState.receipt : null;
  if (prior) {
    const priorProjectHooks = prior.targets.some(
      (t) => t.kind === 'hooks' && t.scope !== 'user' && t.state !== 'failed',
    );
    const priorUserHooks = prior.targets.some(
      (t) => t.kind === 'hooks' && t.scope === 'user' && t.state !== 'failed',
    );
    if (flags.projects.length > 0 && priorUserHooks) {
      d.logError(
        'this box already carries USER-scope harness hooks; --project would double-fire every event ' +
          '(Claude Code merges the scopes). Run `gbrain bootstrap harness --remove` first, then re-apply with --project.',
      );
      return 2;
    }
    if (flags.projects.length === 0 && !flags.noHooks && priorProjectHooks) {
      d.logError(
        'this box already carries PROJECT-scope harness hooks; user-scope wiring would double-fire every event. ' +
          'Run `gbrain bootstrap harness --remove` first, or re-apply with the same --project list.',
      );
      return 2;
    }
  }
  // Cross-HOME exclusivity (the receipt check above only sees THIS home's
  // install): when wiring --project, another install's USER-scope harness
  // hooks would double-fire in that project — the user settings file is
  // knowable, so scan it. (The reverse — user-scope wiring vs some other
  // home's --project dirs — is not enumerable; the receipt check plus the
  // same-file writer refusal are the guards there.)
  if (flags.projects.length > 0 && !flags.noHooks && existsSync(d.userSettingsPath)) {
    try {
      const raw = readFileSync(d.userSettingsPath, 'utf8');
      if (raw.includes(`"${GBRAIN_HARNESS_MARKER_VALUE}"`)) {
        d.logError(
          `user-scope harness hooks already exist in ${d.userSettingsPath} (possibly from another GBRAIN_HOME's ` +
            'install); --project wiring would double-fire every event. Remove that install first ' +
            '(`gbrain bootstrap harness --remove` under its home).',
        );
        return 2;
      }
    } catch {
      /* unreadable → the writers' own fail-closed paths handle it */
    }
  }

  // 4. Plan targets + WRITE-AHEAD receipt [F1/X6] — BEFORE the mint, so a
  // crash (or a newer-format receipt refusal) can never leave a live token
  // no receipt records.
  const guard = guardHarnessReceiptOverwrite(d.gbrainHome);
  if (guard.brokenBackupPath) {
    d.logError(`WARNING: the harness receipt was unreadable; backed it up to ${guard.brokenBackupPath}.`);
  }
  const targets: HarnessTarget[] = [];
  if (wireClaude) {
    targets.push({ host: 'claude-code', kind: 'mcp', state: 'pending', scope: 'user', name: flags.name, mechanism: 'claude-cli' });
    targets.push({
      host: 'claude-code',
      kind: 'permission',
      state: 'pending',
      scope: 'user',
      path: d.userSettingsPath,
      entry: mcpPermissionEntry(flags.name),
    });
    if (wireHooks) {
      if (flags.projects.length > 0) {
        for (const dir of flags.projects) {
          targets.push({
            host: 'claude-code',
            kind: 'hooks',
            state: 'pending',
            scope: dir,
            path: claudeSettingsPath(dir),
            marker: GBRAIN_HARNESS_MARKER_VALUE,
          });
        }
      } else {
        targets.push({
          host: 'claude-code',
          kind: 'hooks',
          state: 'pending',
          scope: 'user',
          path: d.userSettingsPath,
          marker: GBRAIN_HARNESS_MARKER_VALUE,
        });
      }
    }
    if (wbInstall) {
      targets.push({
        host: 'claude-code',
        kind: 'instructions',
        state: 'pending',
        scope: 'user',
        path: d.claudeMemoryPath,
        mechanism: 'managed-block',
      });
    }
  }
  if (wireCodex) {
    targets.push({
      host: 'codex',
      kind: 'mcp',
      state: 'pending',
      scope: 'user',
      path: d.codexConfig,
      name: flags.name,
      mechanism: 'toml-block',
    });
    if (wbInstall) {
      targets.push({
        host: 'codex',
        kind: 'instructions',
        state: 'pending',
        scope: 'user',
        path: d.codexAgentsPath,
        mechanism: 'managed-block',
      });
    }
  }
  if (wireOpencode) {
    targets.push({
      host: 'opencode',
      kind: 'mcp',
      state: 'pending',
      scope: 'user',
      path: d.opencodeConfig,
      name: flags.name,
      mechanism: 'jsonc-entry',
    });
  }
  // [X4] EVERY unrevoked prior minted id is carried — on the --token lane
  // too. A failed rotation must never forget the token before last.
  const carriedPreviousIds = [
    ...(prior?.token.previous_ids ?? []),
    ...(prior?.token.minted && prior.token.id ? [prior.token.id] : []),
  ];
  const receipt: HarnessReceipt = {
    harness_receipt_version: 1,
    created_at: new Date().toISOString(),
    created_by: `gbrain@${VERSION}`,
    url,
    ...(health.engine ? { engine: health.engine } : {}),
    ...(health.version ? { serve_version: health.version } : {}),
    source_id: flags.source ?? 'default',
    token: {
      name: flags.tokenName,
      minted: flags.token === undefined,
      ...(carriedPreviousIds.length > 0 ? { previous_ids: carriedPreviousIds } : {}),
    },
    targets,
  };
  writeHarnessReceipt(d.gbrainHome, receipt);
  const save = () => writeHarnessReceipt(d.gbrainHome, receipt);

  // ([X3] convergence cleanup of dropped prior targets is DEFERRED to after
  // the smoke passes — see step 9. Unwiring the old working state before the
  // mint even succeeds would leave the box disconnected when a PGLite lock or
  // mint failure aborts the run: mint-first applies to removals too.)

  // 5. Token — mint-first [C7]; the receipt already exists [X6].
  let token: string;
  if (flags.token !== undefined) {
    token = flags.token;
  } else {
    let minted: MintedLegacyToken;
    try {
      minted = await d.mint({
        name: flags.tokenName,
        scopes: ['read', 'write'],
        // [X2] --source is the write floor — a scalar grant, the stdio
        // env-tier mirror. Without it the default mint federates.
        ...(flags.source ? { sourceGrant: [flags.source] } : {}),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/already open through `gbrain serve`|LiveServeLockError/i.test(msg) || d.pgliteLiveServe()) {
        throw new BootstrapError(
          'LIVE_SERVE',
          'a live `gbrain serve` holds this PGLite brain, so the harness cannot mint a token — either ' +
            'pre-mint one while the serve is stopped (`gbrain auth create bootstrap-harness --scopes read,write`) ' +
            'and re-run with --token <value>, or stop the serve, re-run this command, and restart it. ' +
            '(Postgres brains mint fine while the serve runs.)',
        );
      }
      throw e;
    }
    token = minted.token;
    receipt.token.id = minted.id;
    receipt.token.name = minted.name;
    save();
  }

  const confirm = (t: HarnessTarget) => {
    t.state = 'confirmed';
    save();
  };
  const failTarget = (t: HarnessTarget, err: string) => {
    t.state = 'failed';
    t.error = err;
    save();
    d.logError(`FAILED (${t.host}/${t.kind}${t.scope !== 'user' ? ` ${t.scope}` : ''}): ${err}`);
  };

  // 6. Claude Code wiring — under a config-dir lock [X11]: serializes gbrain
  // writers (even with different GBRAIN_HOMEs) against the same user-scope
  // files. The race with Claude Code ITSELF is irreducible by any lock we
  // hold; the docs say so.
  const hookEvents: ClaudeHookEvent[] = flags.noCapture
    ? ([...CLAUDE_HOOK_EVENTS].filter((e) => e !== 'Stop' && e !== 'SessionEnd') as ClaudeHookEvent[])
    : [...CLAUDE_HOOK_EVENTS];
  // [X5] Captured for rollback: the previous working claude registration and
  // the codex .bak from THIS run — a failed apply restores a working state
  // (the old token is still valid; mint-first means nothing was revoked yet).
  let oldClaudeReg: { url: string; token: string } | null = null;
  let claudeReplaced = false;
  let codexRollback: { path: string; backupPath: string | null; replacedPrior: boolean } | null = null;
  let opencodeRollback: {
    path: string;
    backupPath: string | null;
    replacedPrior: boolean;
    /** Exact text this run's writer landed — the rollback compares the LIVE
     * file against it before restoring (the lock is released before the
     * smoke, so a newer registration may have landed since). */
    writtenText: string;
  } | null = null;
  let cfgLock: Awaited<ReturnType<typeof acquireBootstrapLock>> | null = null;
  if (wireClaude) {
    const cfgDir = dirname(d.userSettingsPath);
    mkdirSync(cfgDir, { recursive: true }); // the lock needs the dir; writers mkdir later anyway
    cfgLock = await acquireBootstrapLock(cfgDir);
  }
  try {
  for (const t of targets) {
    if (t.host !== 'claude-code') continue;
    try {
      if (t.kind === 'mcp') {
        // [C8] Ownership: an existing registration at a DIFFERENT url is
        // another brain's wiring.
        const get = await d.runner(['claude', 'mcp', 'get', flags.name]);
        if (get.code === 0) {
          const out = `${get.stdout}\n${get.stderr}`;
          const info = parseClaudeMcpGetUrl(out);
          if (info.found && info.url && info.url !== url && !flags.force) {
            failTarget(
              t,
              `an existing '${flags.name}' registration points at ${info.url}, not ${url} — ` +
                'another brain owns it; pass --force to replace, or --name <other>.',
            );
            continue;
          }
          if (info.found) {
            const oldBearer = parseClaudeMcpGetBearer(out);
            // A rollback with a garbage bearer would silently BREAK the
            // registration it exists to preserve — if the CLI ever redacts
            // header values ('***', '<redacted>'), treat the old bearer as
            // unrecoverable and take the honest-degrade branch instead.
            if (info.url && oldBearer && validateToken(oldBearer).ok && !/^[*<]/.test(oldBearer)) {
              oldClaudeReg = { url: info.url, token: oldBearer };
            }
            await d.runner(['claude', 'mcp', 'remove', flags.name, '--scope', 'user']);
            claudeReplaced = true;
          }
        }
        const add = await d.runner([
          'claude',
          ...buildClaudeMcpAddArgv({ name: flags.name, url, headerToken: token, scope: 'user' }),
        ]);
        if (add.code !== 0) {
          failTarget(t, redactToken(add.stderr.trim() || `exit ${add.code}`, token));
          // [X5] The old registration was already removed — restore it so
          // existing clients stay connected (its token is still valid).
          if (oldClaudeReg) {
            const restore = await d.runner([
              'claude',
              ...buildClaudeMcpAddArgv({ name: flags.name, url: oldClaudeReg.url, headerToken: oldClaudeReg.token, scope: 'user' }),
            ]);
            d.log(
              restore.code === 0
                ? 'previous MCP registration restored — existing clients stay connected.'
                : 'could not restore the previous MCP registration — re-run to converge.',
            );
          }
          continue;
        }
        confirm(t);
        d.log(`MCP registered with Claude Code (user scope) -> ${url}`);
      } else if (t.kind === 'permission') {
        // The pre-approval string only makes sense for OUR registration —
        // when the mcp target failed (ownership refusal, add failure), wiring
        // `mcp__<name>` would pre-approve whatever server owns that name,
        // possibly another brain's (red-team CRITICAL).
        const mcpTarget = targets.find((x) => x.host === 'claude-code' && x.kind === 'mcp');
        if (mcpTarget && mcpTarget.state !== 'confirmed') {
          failTarget(t, 'skipped: the MCP registration itself did not land — pre-approving the name would bless a foreign server');
          continue;
        }
        const r = addPermissionsAllowEntry(t.path!, t.entry!);
        for (const note of r.notes) d.logError(note);
        if (r.added === false) {
          // [X8] Already allowed before us — record it as pre-existing so
          // removal never deletes what we didn't add.
          t.mechanism = 'pre-existing';
          confirm(t);
          d.log(`headless pre-approval: '${t.entry}' was already allowed (pre-existing — remove will leave it).`);
        } else {
          confirm(t);
          d.log(`headless pre-approval: '${t.entry}' in permissions.allow (${t.path})`);
        }
      } else if (t.kind === 'instructions') {
        // Under the cfgLock already held for this loop — CLAUDE.md lives in
        // the same config dir the lock serializes. The null-guard replaces a
        // pair of `!` assertions whose invariant (targets planned ⟺ body
        // rendered) lived 350 lines away: if a future edit decouples them,
        // this fails the TARGET, not the whole install loop.
        if (!t.path || ambientBody === null) {
          failTarget(t, 'internal: instructions target planned without a rendered block body');
          continue;
        }
        // Same precedent as the permission pre-approval above: the block
        // orders agents to save through THIS host's gbrain registration —
        // if that registration didn't land (foreign-url refusal, write
        // failure), installing the block would direct ambient saves at
        // whatever server already owns the name, a consent the operator
        // never gave (codex re-review, this wave).
        const hostMcp = targets.find((x) => x.host === t.host && x.kind === 'mcp');
        if (hostMcp && hostMcp.state !== 'confirmed') {
          failTarget(t, `skipped: the ${t.host} MCP registration itself did not land — an instruction block without it would direct saves at a foreign server`);
          continue;
        }
        installAmbientWritebackBlockAt(t.path, ambientBody);
        confirm(t);
        d.log(`ambient-writeback instruction block installed in ${t.path} (mode: ${wb.mode}).`);
      } else {
        const settingsPath = t.scope === 'user' ? d.userSettingsPath : t.path!;
        const env: ClaudeHookEnv = {
          GBRAIN_SOURCE: flags.source ?? 'default',
          GBRAIN_HOOK_LANE: 'harness',
        };
        const bin = flags.gbrainBin ?? d.gbrainBin;
        if (!bin) {
          failTarget(t, 'cannot resolve an absolute gbrain binary path — pass --gbrain-bin <abs path>');
          continue;
        }
        const r = writeClaudeHooksAt(settingsPath, {
          gbrainBin: bin,
          env,
          events: hookEvents,
          marker: GBRAIN_HARNESS_MARKER_VALUE,
          backupStrategy: 'timestamped',
          refuseOnForeignGbrainMarker: true,
          ...(t.scope === 'user'
            ? { freshMode: 0o600 }
            : // [D12] a --project dir whose COMMITTED settings carry workspace
              // events must not get inert harness duplicates for them (the
              // runtime lane guard would make those entries yield forever).
              { carriedEvents: committedHookEvents(dirname(dirname(t.path!))) }),
        });
        for (const note of r.notes) d.logError(note);
        confirm(t);
        d.log(
          `hooks wired (${r.installed.length} event(s)${flags.noCapture ? ', capture off' : ''}) in ${r.settingsPath}`,
        );
      }
    } catch (e) {
      failTarget(t, e instanceof Error ? e.message : String(e));
    }
  }
  } finally {
    cfgLock?.release();
  }

  // 7. Codex wiring — the managed TOML block is the single write mechanism.
  // Same [X11] discipline as the claude lane: config.toml is user-global, so
  // gbrain writers with different GBRAIN_HOMEs serialize on ITS directory.
  for (const t of targets) {
    if (t.host !== 'codex') continue;
    if (t.kind === 'instructions') {
      try {
        // [OV-A4] Exclusivity pre-check: when AGENTS.override.md exists,
        // codex loads IT and IGNORES AGENTS.md — a block written there is a
        // dead integration and must never be reported as installed.
        if (existsSync(d.codexAgentsOverride)) {
          failTarget(
            t,
            `codex ignores ${t.path} while ${d.codexAgentsOverride} exists (AGENTS.override.md loads ` +
              `exclusively, per developers.openai.com/codex/guides/agents-md) — fold the ambient-writeback ` +
              `block into that file yourself, or remove it and re-run \`gbrain bootstrap harness\`.`,
          );
        } else if (!t.path || ambientBody === null) {
          // Same decoupling guard as the claude lane: fail the TARGET.
          failTarget(t, 'internal: instructions target planned without a rendered block body');
        } else if ((() => {
          // Same registration guard as the claude lane (codex re-review):
          // the codex MCP target is applied EARLIER in this loop (planned
          // first), so its state is final here — a foreign-toml refusal or
          // failed write must not leave a block directing ambient saves at
          // a server this run never registered.
          const codexMcp = targets.find((x) => x.host === 'codex' && x.kind === 'mcp');
          return codexMcp !== undefined && codexMcp.state !== 'confirmed';
        })()) {
          failTarget(t, 'skipped: the codex MCP registration itself did not land — an instruction block without it would direct saves at a foreign server');
        } else {
          // Same [X11] lock discipline as the managed TOML block: AGENTS.md
          // is a user-global shared file.
          const agentsDir = dirname(t.path);
          mkdirSync(agentsDir, { recursive: true });
          const agentsLock = await acquireBootstrapLock(agentsDir);
          try {
            installAmbientWritebackBlockAt(t.path, ambientBody);
          } finally {
            agentsLock.release();
          }
          confirm(t);
          d.log(`ambient-writeback instruction block installed in ${t.path} (mode: ${wb.mode}).`);
        }
      } catch (e) {
        failTarget(t, e instanceof Error ? e.message : String(e));
      }
      continue;
    }
    try {
      // Plugin-lane collision WARN (not a refusal — the harness lane serves
      // framework-spawned sessions over HTTP and may legitimately coexist
      // with the plugin's stdio serve): two servers named `<name>` in
      // different layers means duplicate tool registration, and which wins
      // is host-defined.
      const pluginOwner = codexPluginProvidesName(t.path!, flags.name);
      if (pluginOwner) {
        d.logError(
          `WARNING: the '${pluginOwner}' codex plugin also provides an MCP server named '${flags.name}' — ` +
            'after this wire, two servers with the same name exist in different layers (plugin + managed block); ' +
            'duplicate tool registration behavior is host-defined. Keep one: `codex plugin remove gbrain`, ' +
            'or re-run with `--remove` to drop the managed block.',
        );
      }
      const codexDir = dirname(t.path!);
      mkdirSync(codexDir, { recursive: true });
      const codexLock = await acquireBootstrapLock(codexDir);
      let r: ReturnType<typeof writeCodexHttpServerBlock>;
      try {
        r = writeCodexHttpServerBlock(t.path!, { name: flags.name, url, bearerToken: token });
      } finally {
        codexLock.release();
      }
      for (const note of r.notes) d.logError(note);
      codexRollback = { path: t.path!, backupPath: r.backupPath, replacedPrior: r.replacedPrior };
      confirm(t);
      d.log(
        `Codex wired: [mcp_servers.${flags.name}] with inline bearer token in ${t.path} (0600). ` +
          'Per-turn context on codex is MCP tools + the pull protocol. ' +
          '[X9] If codex cannot see the server, some builds gate HTTP MCP behind ' +
          'experimental_use_rmcp_client = true in the same config — add it above the managed block.',
      );
      // Codex SessionEnd capture (v1: session-end only): user-global
      // hooks.json + its config.toml trust entry via the ONE writer
      // (codex-hooks.ts) — idempotent, so a workspace-lane bootstrap and this
      // harness lane converge on the same entry. No GBRAIN_SOURCE in the
      // command (machine-global file; session-end resolves from the payload).
      if (!flags.noHooks) {
        const hooksBin = flags.gbrainBin ?? d.gbrainBin;
        if (!hooksBin) {
          d.logError('codex hooks skipped: cannot resolve an absolute gbrain binary path — pass --gbrain-bin <abs path>.');
        } else {
          // Paths derive from THIS TARGET's config.toml (CODEX_HOME-resolved
          // upstream, test-injectable) — never the ambient global default.
          const hr = writeCodexHooks({ gbrainBin: hooksBin, configPath: t.path!, hooksPath: join(dirname(t.path!), 'hooks.json') });
          if (hr.ok) d.log(`Codex SessionEnd hook wired: ${hr.hooksPath} + trust entry in ${hr.configPath}.`);
          else for (const note of hr.notes) d.logError(note);
        }
      }
    } catch (e) {
      failTarget(t, e instanceof Error ? e.message : String(e));
    }
  }

  // 7b. opencode wiring — the managed JSONC entry is the single write
  // mechanism (opencode-json.ts; fingerprint-owned, comment-preserving).
  // Same [X11] lock discipline; same forced-wire posture as codex.
  for (const t of targets) {
    if (t.host !== 'opencode') continue;
    try {
      const ocDir = dirname(t.path!);
      mkdirSync(ocDir, { recursive: true });
      const ocLock = await acquireBootstrapLock(ocDir);
      let r: ReturnType<typeof writeOpencodeMcpEntry>;
      try {
        // Ownership [C8]: an entry at OUR new url (idempotent re-run) or at
        // the PRIOR receipt's url (rotation across a port change) is ours;
        // anything else under the name refuses inside the writer. The prior
        // url is offered as the expectation only when the current one does
        // not classify the entry as ours.
        let expectUrl = url;
        if (prior && prior.url !== url && existsSync(t.path!)) {
          try {
            const parsedExisting = parseOpencodeConfig(readFileSync(t.path!, 'utf8'), t.path!);
            if (
              opencodeEntryKind(parsedExisting, flags.name, { url }) === 'foreign' &&
              opencodeEntryKind(parsedExisting, flags.name, { url: prior.url }) === 'ours-same-source'
            ) {
              expectUrl = prior.url;
            }
          } catch {
            /* the writer's own read path raises the real error below */
          }
        }
        // Two-filename merge blind spot: opencode merges BOTH user-global
        // filenames, so a same-name gbrain entry in the SIBLING file would
        // survive this write as a shadow registration. Reconcile under the
        // same config-dir lock (ours → removed with a note; foreign →
        // refuse loudly naming both files).
        const sib = reconcileOpencodeSiblingGlobal(t.path!, flags.name, { url: expectUrl });
        for (const note of sib.notes) d.log(note);
        r = writeOpencodeMcpEntry(
          t.path!,
          { kind: 'remote', name: flags.name, url, tokenMode: 'inline', bearerToken: token },
          { expect: { url: expectUrl }, allowReplaceOtherSource: true },
        );
      } finally {
        ocLock.release();
      }
      for (const note of r.notes) d.logError(note);
      opencodeRollback = { path: t.path!, backupPath: r.backupPath, replacedPrior: r.replacedPrior, writtenText: r.writtenText };
      confirm(t);
      d.log(
        `opencode wired: mcp.${flags.name} remote entry with inline bearer header in ${t.path} (0600). ` +
          'opencode ships a plugin/event system, but gbrain does not wire it yet — per-turn context on ' +
          'opencode is MCP tools + the pull protocol (AGENTS.md loads natively). Restart opencode: it ' +
          'reads config at session start.',
      );
    } catch (e) {
      // Redaction parity with the claude lane: the writer's refusal messages
      // can embed a paste-by-hand snippet, and the receipt + stderr must
      // never carry the live bearer under any error shape.
      failTarget(t, redactToken(e instanceof Error ? e.message : String(e), token));
    }
  }

  // 8. Smoke [C3-enriched message; X10 verbs-surface honesty]. An
  // unknown-tool tool_error means initialize + auth ALREADY succeeded — a
  // serve running a narrowed --surface (e.g. verbs) is verified, not broken.
  //
  // CANARY first (ship-review P0, three reviewers convergent): the smoke
  // sends the real bearer to whatever answers on the port, and an impostor
  // squatting 127.0.0.1 could accept it, fake an identity, and trigger
  // previous-token revocation. A real gbrain serve validates bearers against
  // the brain DB, so it MUST reject a random same-format token with an auth
  // failure — an impostor cannot tell the canary from the real token (same
  // format, both unknown to it), so it either rejects both (smoke fails,
  // nothing revoked, rollback fires) or accepts the canary and is caught
  // here. Either way the fresh mint is revoked below, never left live.
  const canary = await d.probeIdentity(url, generateToken('gbrain_'));
  let smoke: ConnectProbeResult;
  if (canary.ok || canary.reason === 'tool_error') {
    smoke = {
      ok: false,
      reason: 'auth',
      message:
        'the endpoint accepted an INVALID credential — whatever answers on this port is not a gbrain serve ' +
        'backed by this brain (loopback impostor guard). Wiring rolled back; nothing revoked.',
    };
  } else {
    smoke = await d.probeIdentity(url, token);
  }
  const smokeOk = smoke.ok || (!smoke.ok && smoke.reason === 'tool_error');
  if (smoke.ok) {
    d.log(`smoke test: ${smoke.identity}`);
  } else if (smoke.reason === 'tool_error') {
    d.log(
      'smoke test: token authenticated (initialize + tool dispatch reached); get_brain_identity ' +
        'unavailable — the serve likely runs a narrowed --surface (e.g. verbs). Counted as verified.',
    );
  } else {
    d.logError(
      redactToken(
        `smoke test FAILED (${smoke.reason}): ${smoke.message}` +
          (smoke.reason === 'auth' && flags.token === undefined
            ? ' — a fresh-minted token failing auth against a live loopback serve means the serve is NOT ' +
              'backed by this brain; check the serve process’s GBRAIN_HOME / DATABASE_URL.'
            : ''),
        token,
      ),
    );
    // [X5] Roll the host registrations back to the last working state — the
    // old token is still valid (mint-first), so old clients keep working for
    // real, not rhetorically.
    if (codexRollback) {
      try {
        const rbLock = await acquireBootstrapLock(dirname(codexRollback.path)); // [X11] parity
        try {
          if (codexRollback.backupPath && existsSync(codexRollback.backupPath)) {
            // Atomic restore: a crash mid-copy must never leave a torn config
            // (the backup carries the previous bearer — 0600 stays forced).
            atomicWriteTextFile(codexRollback.path, readFileSync(codexRollback.backupPath, 'utf8'), { forceMode: 0o600 });
          } else if (!codexRollback.replacedPrior) {
            removeCodexHttpServerBlock(codexRollback.path, flags.name);
          }
        } finally {
          rbLock.release();
        }
        const ct = targets.find((t) => t.host === 'codex' && t.kind === 'mcp');
        if (ct) failTarget(ct, 'rolled back to the previous codex config after the failed smoke');
      } catch (e) {
        d.logError(`codex rollback failed: ${e instanceof Error ? e.message : String(e)} — re-run to converge.`);
      }
    }
    if (opencodeRollback) {
      try {
        let failNote = 'rolled back to the previous opencode config after the failed smoke';
        const rbLock = await acquireBootstrapLock(dirname(opencodeRollback.path)); // [X11] parity
        try {
          // Restore-guard: the config-dir lock was released before the smoke,
          // so a NEWER registration (another run's) may have replaced ours —
          // restoring this run's snapshot over it would clobber that newer
          // wiring. Only restore when the live file still carries the EXACT
          // text this run wrote; either way the fresh mint is revoked below.
          const current = existsSync(opencodeRollback.path)
            ? readFileSync(opencodeRollback.path, 'utf8')
            : '';
          if (current !== opencodeRollback.writtenText) {
            failNote =
              'smoke failed; opencode rollback SKIPPED — the config changed after this run wrote it ' +
              '(a newer registration exists); this run\'s fresh mint is still revoked';
            d.log(failNote + '.');
          } else if (opencodeRollback.backupPath && existsSync(opencodeRollback.backupPath)) {
            // Atomic restore (codex-lane parity): never a torn config mid-crash.
            atomicWriteTextFile(opencodeRollback.path, readFileSync(opencodeRollback.backupPath, 'utf8'), { forceMode: 0o600 });
            // Consumed — the unique backup carries the previous bearer and
            // has no consumer once restored.
            try { rmSync(opencodeRollback.backupPath, { force: true }); } catch { /* best-effort */ }
          } else if (!opencodeRollback.replacedPrior) {
            removeOpencodeMcpEntry(opencodeRollback.path, flags.name, { url });
          }
        } finally {
          rbLock.release();
        }
        const ot = targets.find((t) => t.host === 'opencode' && t.kind === 'mcp');
        if (ot) failTarget(ot, failNote);
      } catch (e) {
        d.logError(`opencode rollback failed: ${e instanceof Error ? e.message : String(e)} — re-run to converge.`);
      }
    }
    const mt = targets.find((t) => t.host === 'claude-code' && t.kind === 'mcp');
    if (claudeReplaced && oldClaudeReg) {
      await d.runner(['claude', 'mcp', 'remove', flags.name, '--scope', 'user']);
      const restore = await d.runner([
        'claude',
        ...buildClaudeMcpAddArgv({ name: flags.name, url: oldClaudeReg.url, headerToken: oldClaudeReg.token, scope: 'user' }),
      ]);
      if (mt) failTarget(mt, 'rolled back to the previous registration after the failed smoke');
      d.log(
        restore.code === 0
          ? 'previous Claude Code registration restored — existing clients stay connected.'
          : 'could not restore the previous Claude Code registration — re-run to converge.',
      );
    } else if (mt?.state === 'confirmed' && !claudeReplaced) {
      // Fresh add (nothing existed before this run): roll back to the pre-run
      // state so a failed smoke never leaves a green-looking registration
      // wired to an unverified token — mirrors the codex fresh-add branch.
      await d.runner(['claude', 'mcp', 'remove', flags.name, '--scope', 'user']);
      failTarget(mt, 'fresh registration removed after the failed smoke');
    } else if (mt?.state === 'confirmed' && claudeReplaced) {
      // Replaced a prior registration whose bearer we could not recover — the
      // old state is unrestorable, so keep the new wiring but record the
      // failed smoke honestly instead of leaving the target green.
      failTarget(
        mt,
        'smoke failed and the previous registration could not be recovered — the new registration is left in place; re-run to converge',
      );
    }
    // A freshly-added pre-approval must not outlive its rolled-back
    // registration (red-team CRITICAL): remove the entry we added this run.
    // Pre-existing entries [X8] are never touched.
    const pt = targets.find((t) => t.host === 'claude-code' && t.kind === 'permission');
    if (pt?.state === 'confirmed' && pt.mechanism !== 'pre-existing') {
      try {
        removePermissionsAllowEntry(pt.path!, pt.entry!);
        failTarget(pt, 'pre-approval removed after the failed smoke (its registration was rolled back)');
      } catch (e) {
        d.logError(`could not remove the pre-approval after rollback: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    // Ambient instruction blocks installed THIS run must not outlive their
    // rolled-back registrations either (codex re-review): a confirmed block
    // would keep ordering every new session to save through an endpoint that
    // failed verification — or through a foreign registration a forced
    // replacement just restored. Strip removes only OUR marker block; the
    // file itself always stays.
    for (const it of targets) {
      if (it.kind !== 'instructions' || it.state !== 'confirmed' || !it.path) continue;
      try {
        stripAmbientWritebackBlockAt(it.path);
        failTarget(it, 'instruction block removed after the failed smoke (its registration was rolled back)');
      } catch (e) {
        d.logError(`could not remove the ambient-writeback block from ${it.path} after the failed smoke: ${e instanceof Error ? e.message : String(e)}`);
        failTarget(it, 'smoke failed and the instruction block could not be removed — run `gbrain bootstrap harness --remove` to converge');
      }
    }
    // The fresh mint was sent to an endpoint that failed verification — a
    // possible impostor now holds a live credential. Retire it immediately
    // (we minted it, so the engine is reachable); the receipt keeps the id,
    // and a later revoke of an already-revoked id is a no-op.
    if (flags.token === undefined && receipt.token.id) {
      try {
        await d.revokeById(receipt.token.id);
        d.log(`fresh-minted token revoked (id ${receipt.token.id}) — nothing live leaked to the unverified endpoint.`);
      } catch (e) {
        d.logError(
          `could not revoke the fresh-minted token (${e instanceof Error ? e.message : String(e)}) — ` +
            `revoke it manually: gbrain auth revoke with the id flag (${receipt.token.id}).`,
        );
      }
    }
  }

  // The unique opencode backup carries the PREVIOUS bearer; once the new
  // wiring is verified it has no consumer — unlink it so re-runs never
  // accumulate token-bearing snapshots (failed runs consume it via the
  // restore above; skipped restores leave it 0600 for manual recovery).
  if (smokeOk && opencodeRollback?.backupPath) {
    try {
      rmSync(opencodeRollback.backupPath, { force: true });
    } catch {
      /* best-effort — it is 0600 either way */
    }
  }

  // 9. [X3] Convergence cleanup — AFTER the smoke, so prior working wiring is
  // never unwired on a run that failed to establish its replacement. Cleanup
  // failures append as failed targets (blocking the rotation gate below) so
  // --remove or a re-run retries them. Runs under the config-dir lock: it
  // mutates the same user-scope files the apply loop serializes on [X11].
  if (prior && smokeOk) {
    const cfgDir = dirname(d.userSettingsPath);
    mkdirSync(cfgDir, { recursive: true });
    const cleanupLock = await acquireBootstrapLock(cfgDir);
    try {
      await cleanupStalePriorTargets(prior, receipt, d, save);
    } finally {
      cleanupLock.release();
    }
  }

  // 9b. Converge-on-off [OV-A2/OV2-2]: writeback disabled means a
  // previously-installed ambient block is a stale contract — strip it from
  // the receipt-recorded paths AND the candidate paths (an out-of-band or
  // crashed-receipt install still converges). The FILE always stays in
  // place, even when left empty of our content. Removing a stale
  // instruction block never disconnects anything, so this is not gated on
  // the smoke (unlike step 9's wiring cleanup).
  if (!wb.enabled) {
    const candidatePaths = new Set<string>([d.claudeMemoryPath, d.codexAgentsPath]);
    for (const pt of prior?.targets ?? []) {
      if (pt.kind === 'instructions' && pt.path) candidatePaths.add(pt.path);
    }
    for (const path of candidatePaths) {
      try {
        if (!existsSync(path) || !ambientBlockPresent(readFileSync(path, 'utf8'))) continue;
        const blockDir = dirname(path);
        const blockLock = await acquireBootstrapLock(blockDir);
        let r: { removed: boolean };
        try {
          r = stripAmbientWritebackBlockAt(path);
        } finally {
          blockLock.release();
        }
        if (r.removed) {
          d.log(`ambient-writeback instruction block removed from ${path} (memory.auto_writeback is off — converged).`);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        d.logError(
          `could not remove the ambient-writeback block from ${path}: ${msg}`,
        );
        // Track the orphan (adversarial review, this wave): a damaged block
        // that failed to strip would otherwise vanish from the rewritten
        // receipt while STILL instructing every new session — record a
        // failed `instructions` target so --status shows it, --remove and
        // the next converge retry it, and doctor's off-branch probe warns.
        receipt.targets.push({
          host: path === d.codexAgentsPath ? 'codex' : 'claude-code',
          kind: 'instructions',
          state: 'failed',
          scope: 'user',
          path,
          mechanism: 'managed-block',
          error: `converge-off: ${msg}`,
        });
        save();
      }
    }
    // WP8 audience gate (engine-free lane, so the DECLARED file-plane
    // audience is the signal — `config set brain.audience` dual-writes it):
    // a shared-declared brain never gets the enable nudge; undeclared reads
    // as the single-operator harness default (the consent ask itself only
    // ever fires on engine-classified personal brains).
    const declaredAudience = (d.loadFileConfig()?.brain?.audience ?? '').trim().toLowerCase();
    if (declaredAudience !== 'shared') {
      d.log('ambient writeback off — enable with `gbrain config set memory.auto_writeback salient` and re-run.');
    }
  }

  // 10. Rotation completion [C7/X4]: only after all targets confirmed + the
  // token verified. EVERY carried prior id is revoked; failures stay on the
  // receipt for the next converge.
  const allConfirmed = targets.every((t) => t.state === 'confirmed');
  if (allConfirmed && smokeOk && receipt.token.previous_ids?.length) {
    const remaining: string[] = [];
    for (const id of receipt.token.previous_ids) {
      try {
        const revoked = await d.revokeById(id);
        d.log(revoked ? `previous harness token revoked (id ${id}).` : `previous harness token was already revoked (id ${id}).`);
      } catch (e) {
        remaining.push(id);
        d.logError(
          `could not revoke a previous harness token (${e instanceof Error ? e.message : String(e)}) — ` +
            `revoke it manually: gbrain auth revoke with the id flag (${id}); kept on the receipt.`,
        );
      }
    }
    if (remaining.length > 0) receipt.token.previous_ids = remaining;
    else delete receipt.token.previous_ids;
    save();
  } else if (receipt.token.previous_ids?.length) {
    d.logError(
      `${receipt.token.previous_ids.length} previous harness token(s) NOT revoked (wiring incomplete or smoke failed) — ` +
        'old clients keep working; re-run `gbrain bootstrap harness` to converge.',
    );
  }

  // 11. Degradation + skew honesty.
  if (health.engine === 'postgres') {
    d.log(
      '\nNote: this brain runs on Postgres — per-turn hook injection needs a running `gbrain serve` for this ' +
        'brain (hooks heartbeat no_pglite_path/no_serve until one is up; the engine-uniform IPC listener keys its ' +
        'socket off the connection URL under ~/.gbrain/run). MCP tools are the active seam: sessions ' +
        'search/read/write the brain on demand; the pre-wired hooks light up whenever a serve runs.',
    );
  }
  if (health.version && flags.token === undefined && isServeOlderThanScopes(health.version)) {
    d.log(
      `\nNote: serve v${health.version} predates token scoping — this token verifies as FULL-ACCESS until you ` +
        'restart `gbrain serve` on this binary version.',
    );
  }

  if (flags.json) {
    emitJson(
      JSON.stringify(
        {
          schema_version: 1,
          url,
          engine: health.engine ?? null,
          serve_version: health.version ?? null,
          token_name: receipt.token.name,
          token_redacted: true,
          targets: receipt.targets,
          degraded_per_turn: health.engine === 'postgres',
          smoke_ok: smokeOk,
          receipt_path: harnessReceiptPath(d.gbrainHome),
        },
        null,
        2,
      ),
    );
  }
  return allConfirmed && smokeOk ? 0 : 1;
}

// ── Remove [C9/F2/C8] ───────────────────────────────────────────────────────

export async function removeHarness(flags: HarnessFlags, rawDeps: HarnessDeps): Promise<number> {
  const d = resolveDeps(rawDeps);
  const state = readHarnessReceiptState(d.gbrainHome);
  if (state.state === 'absent') {
    d.log('nothing harness-installed on this machine (no harness receipt).');
    return 0;
  }
  if (state.state === 'newer') {
    d.logError('the harness receipt was written by a newer gbrain — upgrade gbrain before removing.');
    return 1;
  }
  if (state.state === 'invalid') {
    d.logError(
      `the harness receipt at ${harnessReceiptPath(d.gbrainHome)} is unreadable — fix or delete it, then ` +
        'remove any stragglers by hand (claude mcp remove / the codex config block / hook entries).',
    );
    return 1;
  }
  const receipt = state.receipt;
  const save = () => writeHarnessReceipt(d.gbrainHome, receipt);
  let anyFailed = false;

  // Phase 1 — host removals (engine-free). Under the SAME config-dir lock the
  // apply loop takes [X11]: a remove racing an apply from another GBRAIN_HOME
  // must not lose the apply's just-written entry via read-modify-write
  // interleave. (Lock order everywhere is config-dir → codex-dir.)
  const rmCfgDir = dirname(d.userSettingsPath);
  mkdirSync(rmCfgDir, { recursive: true });
  const rmCfgLock = await acquireBootstrapLock(rmCfgDir);
  const remaining: HarnessTarget[] = [];
  try {
  for (const t of receipt.targets) {
    try {
      if (t.kind === 'instructions') {
        // Ambient-writeback managed block: strip it wherever the receipt
        // recorded it (any host). Damaged markers throw → the target stays
        // failed on the receipt for a hand-fix + retry.
        if (!t.path || !existsSync(t.path)) {
          d.log(`no ambient-writeback block file at ${t.path ?? '(no path recorded)'} — counted as removed.`);
        } else {
          const blockDir = dirname(t.path);
          const blockLock = resolve(blockDir) === resolve(rmCfgDir) ? null : await acquireBootstrapLock(blockDir);
          let r: { removed: boolean };
          try {
            r = stripAmbientWritebackBlockAt(t.path);
          } finally {
            blockLock?.release();
          }
          d.log(
            r.removed
              ? `ambient-writeback instruction block removed from ${t.path}.`
              : `no ambient-writeback block in ${t.path} — counted as removed.`,
          );
        }
      } else if (t.host === 'claude-code' && t.kind === 'mcp') {
        // [C8] Only remove what points at OUR url.
        const get = await d.runner(['claude', 'mcp', 'get', t.name ?? 'gbrain']);
        if (get.code !== 0 || !parseClaudeMcpGetUrl(`${get.stdout}\n${get.stderr}`).found) {
          d.log(`MCP '${t.name}' already gone — counted as removed.`); // [F2]
          continue;
        }
        const info = parseClaudeMcpGetUrl(`${get.stdout}\n${get.stderr}`);
        if (info.url && info.url !== receipt.url) {
          d.log(
            `MCP '${t.name}' now points at ${info.url} (not ours) — owned by another install; skipping, ` +
              'cleared from the receipt.',
          );
          continue;
        }
        if (!info.url) {
          // Refuse-rather-than-guess [C8]: no URL parsed means ownership is
          // unprovable (a claude CLI output-format change would otherwise turn
          // every remove into deleting other brains' registrations).
          d.log(
            `MCP '${t.name}' exists but its URL could not be verified against the receipt — left in place; ` +
              `remove it manually if it is this brain's: claude mcp remove ${t.name ?? 'gbrain'} --scope ${t.scope}`,
          );
          continue;
        }
        const rm = await d.runner(['claude', 'mcp', 'remove', t.name ?? 'gbrain', '--scope', t.scope]);
        if (rm.code !== 0 && !/not found|No MCP server/i.test(rm.stdout + rm.stderr)) {
          throw new Error(rm.stderr.trim() || `exit ${rm.code}`);
        }
        d.log(`MCP '${t.name}' removed from Claude Code (${t.scope} scope).`);
      } else if (t.host === 'claude-code' && t.kind === 'permission') {
        if (t.mechanism === 'pre-existing') {
          // [X8] The entry was allowed before us — never delete what we
          // didn't add. Left in place, cleared from the receipt.
          d.log(`permissions.allow entry '${t.entry}' predates the harness install — left in place.`);
          continue;
        }
        const r = removePermissionsAllowEntry(t.path!, t.entry!);
        if (r.notes.some((n) => n.startsWith('WARNING'))) throw new Error(r.notes.join('; '));
        d.log(
          r.removed && r.removed > 0
            ? `permissions.allow entry '${t.entry}' removed.`
            : `permissions.allow entry '${t.entry}' already gone — counted as removed.`,
        );
      } else if (t.host === 'claude-code' && t.kind === 'hooks') {
        const settingsPath = t.scope === 'user' ? (t.path ?? d.userSettingsPath) : t.path!;
        const r = removeClaudeHooksAt(settingsPath, t.marker ?? GBRAIN_HARNESS_MARKER_VALUE);
        if (r.notes.some((n) => n.startsWith('WARNING'))) throw new Error(r.notes.join('; '));
        d.log(
          r.removed > 0
            ? `${r.removed} harness hook entr${r.removed === 1 ? 'y' : 'ies'} removed from ${settingsPath}.`
            : `no harness hook entries in ${settingsPath} — counted as removed.`,
        );
      } else if (t.host === 'codex') {
        const codexPath = t.path ?? d.codexConfig;
        const codexDir = dirname(codexPath);
        mkdirSync(codexDir, { recursive: true });
        // [X11] parity — but the phase-1 config-dir lock may already cover
        // this dir (same-parent layouts): the lock is non-reentrant.
        const codexLock = resolve(codexDir) === resolve(rmCfgDir) ? null : await acquireBootstrapLock(codexDir);
        let r: ReturnType<typeof removeCodexHttpServerBlock>;
        try {
          r = removeCodexHttpServerBlock(codexPath, t.name ?? 'gbrain');
        } finally {
          codexLock?.release();
        }
        d.log(
          r.removed
            ? `Codex managed block removed from ${codexPath}.`
            : `no managed block in ${codexPath} — counted as removed.`,
        );
        const hr = removeCodexHooks({ configPath: codexPath, hooksPath: join(dirname(codexPath), 'hooks.json') });
        if (hr.removed) d.log(`Codex SessionEnd hook + trust entry removed (${hr.hooksPath}).`);
        for (const note of hr.notes) d.logError(note);
      } else if (t.host === 'opencode') {
        const ocPath = t.path ?? d.opencodeConfig;
        // [C8] Ownership before removal: an entry now at a DIFFERENT url is
        // another install's — skip with a note, cleared from the receipt
        // (mirror of the claude not-ours branch; the module's foreign check
        // would THROW, which reads as a failure rather than a skip).
        let kind: ReturnType<typeof opencodeEntryKind> = 'absent';
        if (existsSync(ocPath)) {
          try {
            kind = opencodeEntryKind(
              parseOpencodeConfig(readFileSync(ocPath, 'utf8'), ocPath),
              t.name ?? 'gbrain',
              { url: receipt.url },
            );
          } catch (e) {
            throw new Error(`opencode config unreadable: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        if (kind === 'absent') {
          d.log(`opencode entry '${t.name}' already gone — counted as removed.`); // [F2]
        } else if (kind !== 'ours-same-source') {
          d.log(
            `opencode entry '${t.name}' does not match this receipt's url (${receipt.url}) — owned by another ` +
              'install; skipping, cleared from the receipt.',
          );
        } else {
          const ocDir = dirname(ocPath);
          mkdirSync(ocDir, { recursive: true });
          const ocLock = resolve(ocDir) === resolve(rmCfgDir) ? null : await acquireBootstrapLock(ocDir);
          let r: ReturnType<typeof removeOpencodeMcpEntry>;
          try {
            r = removeOpencodeMcpEntry(ocPath, t.name ?? 'gbrain', { url: receipt.url });
          } finally {
            ocLock?.release();
          }
          d.log(
            r.removed
              ? `opencode managed entry removed from ${ocPath}.`
              : `no managed entry in ${ocPath} — counted as removed.`,
          );
        }
      }
    } catch (e) {
      anyFailed = true;
      t.state = 'failed';
      t.error = e instanceof Error ? e.message : String(e);
      remaining.push(t);
      d.logError(`could not remove ${t.host}/${t.kind}: ${t.error}`);
    }
  }
  } finally {
    rmCfgLock.release();
  }
  receipt.targets = remaining;
  save();

  // Phase 2 — revoke EVERY minted id we own [C7/X4]: the current token (when
  // minted) plus any carried previous_ids from unconverged rotations.
  // Deferred under a live PGLite serve [C9].
  const idsToRevoke = [
    ...(receipt.token.minted && receipt.token.id ? [receipt.token.id] : []),
    ...(receipt.token.previous_ids ?? []),
  ];
  let tokenDone = idsToRevoke.length === 0;
  if (!tokenDone) {
    if (d.pgliteLiveServe()) {
      d.logError(
        'a live `gbrain serve` holds this PGLite brain — token(s) NOT revoked. Host wiring is removed; ' +
          `stop the serve and re-run \`gbrain bootstrap harness --remove\`, or run ` +
          `\`gbrain auth revoke\` with the id flag per id (${idsToRevoke.join(', ')}).`,
      );
    } else {
      const unrevoked: string[] = [];
      for (const id of idsToRevoke) {
        try {
          await d.revokeById(id);
          d.log(`harness token revoked (id ${id}).`);
        } catch (e) {
          unrevoked.push(id);
          d.logError(
            `token revoke failed (${e instanceof Error ? e.message : String(e)}) — ` +
              `run \`gbrain auth revoke\` with the id flag (${id}) manually.`,
          );
        }
      }
      if (unrevoked.length === 0) {
        tokenDone = true;
      } else {
        const stillCurrent = receipt.token.id !== undefined && unrevoked.includes(receipt.token.id);
        receipt.token.previous_ids = unrevoked.filter((id) => id !== receipt.token.id);
        if (receipt.token.previous_ids.length === 0) delete receipt.token.previous_ids;
        if (!stillCurrent) delete receipt.token.id;
      }
    }
  }
  if (!receipt.token.minted && (receipt.token.previous_ids?.length ?? 0) === 0) {
    d.log('current token was supplied via --token — not revoked (not ours to revoke).');
  }

  if (remaining.length === 0 && tokenDone) {
    deleteHarnessReceipt(d.gbrainHome);
    d.log('harness wiring fully removed; receipt consumed.');
    return 0;
  }
  save();
  d.logError('some removals are pending — the receipt keeps exactly the unfinished parts (re-run to retry).');
  return 1;
}

// ── Status (read-only; no lockstep with apply — probes the live truth) ─────

/** Parse the bearer token back out of `claude mcp get` output (live-verified
 * shape: `Authorization: Bearer <tok>` under a Headers: section). NEVER echo
 * the raw output anywhere — redactToken everything user-visible. */
export function parseClaudeMcpGetBearer(out: string): string | null {
  const m = out.match(/Authorization:\s*Bearer\s+(\S+)/);
  return m ? m[1] : null;
}

/** Parse the bearer token out of OUR managed codex block. When
 * `expectedUrl` is given, the block's `url` must match it ([C8] parity with
 * the claude-lane recovery): a hand-edited block pointing at another brain's
 * serve carries a credential that must never be transmitted to receipt.url.
 * Reads the current `http_headers = { Authorization = "Bearer <t>" }` shape
 * (#4574 — codex-cli >=0.149 rejects inline `bearer_token`), with a legacy
 * `bearer_token = "<t>"` fallback so machines wired by older gbrain still
 * have their token recovered for status/rotation. */
export function parseCodexBlockBearer(configText: string, expectedUrl?: string): string | null {
  const norm = configText.replace(/\r\n/g, '\n');
  // The shared writer constants — inline copies here would silently stop
  // matching if host-specs.ts ever rewords the markers.
  const begin = norm.indexOf(CODEX_TOML_BLOCK_BEGIN);
  const end = norm.indexOf(CODEX_TOML_BLOCK_END);
  if (begin < 0 || end < 0 || end < begin) return null;
  const block = norm.slice(begin, end);
  if (expectedUrl !== undefined) {
    const u = block.match(/^url\s*=\s*"((?:[^"\\]|\\.)*)"\s*$/m);
    if (!u || u[1].replace(/\\(.)/g, '$1') !== expectedUrl) return null;
  }
  const h = block.match(/^http_headers\s*=\s*\{\s*Authorization\s*=\s*"((?:[^"\\]|\\.)*)"\s*\}\s*$/m);
  if (h) {
    const value = h[1].replace(/\\(.)/g, '$1');
    // A non-Bearer Authorization header is a hand-edit — not ours to recover.
    return value.startsWith('Bearer ') ? value.slice('Bearer '.length) : null;
  }
  const m = block.match(/^bearer_token\s*=\s*"((?:[^"\\]|\\.)*)"\s*$/m);
  if (!m) return null;
  return m[1].replace(/\\(.)/g, '$1');
}

/** `bootstrap harness --status [--json]` — one screen of live health. */
export async function statusHarness(flags: HarnessFlags, rawDeps: HarnessDeps): Promise<number> {
  const d = resolveDeps(rawDeps);
  const state = readHarnessReceiptState(d.gbrainHome);
  if (state.state === 'absent') {
    if (flags.json) {
      d.log(JSON.stringify({ schema_version: 1, installed: false }, null, 2));
      return 2; // cron contract: absence is distinguishable under --json
    }
    d.log('no harness install on this machine (no harness receipt).');
    return 0;
  }
  if (state.state !== 'ok') {
    d.logError(`harness receipt unreadable (${state.state}) — see ${harnessReceiptPath(d.gbrainHome)}`);
    return 1;
  }
  const receipt = state.receipt;

  const health = await probeServeHealth(receipt.url, d.fetchFn);
  const serveLine = health.ok
    ? `serve: OK at ${receipt.url} (engine ${health.engine ?? '?'}, v${health.version ?? '?'})`
    : `serve: UNREACHABLE at ${receipt.url} (${health.detail ?? 'no response'})`;

  // Token liveness — the receipt stores no plaintext by design [F1]; recover
  // from the host registration or degrade honestly.
  let token: string | null = null;
  let tokenSource = '';
  const claudeMcp = receipt.targets.find((t) => t.host === 'claude-code' && t.kind === 'mcp');
  if (claudeMcp) {
    try {
      const get = await d.runner(['claude', 'mcp', 'get', claudeMcp.name ?? 'gbrain']);
      if (get.code === 0) {
        const out = `${get.stdout}\n${get.stderr}`;
        // [C8] Ownership before recovery (red-team CRITICAL): if another
        // install has taken the name over, the parsed bearer is a FOREIGN
        // credential — recovering it here would transmit it to receipt.url,
        // a host it was never issued for. Only a URL match makes it ours.
        const info = parseClaudeMcpGetUrl(out);
        if (info.found && info.url === receipt.url) {
          token = parseClaudeMcpGetBearer(out);
          if (token) tokenSource = 'claude registration';
        }
      }
    } catch {
      /* degrade */
    }
  }
  if (!token) {
    const codexMcp = receipt.targets.find((t) => t.host === 'codex' && t.kind === 'mcp');
    if (codexMcp?.path && existsSync(codexMcp.path)) {
      try {
        token = parseCodexBlockBearer(readFileSync(codexMcp.path, 'utf8'), receipt.url);
        if (token) tokenSource = 'codex config block';
      } catch {
        /* degrade */
      }
    }
  }
  if (!token) {
    const ocMcp = receipt.targets.find((t) => t.host === 'opencode' && t.kind === 'mcp');
    if (ocMcp?.path) {
      // [C8] url-matched inside the helper: a foreign/rotated entry's bearer
      // is never recovered (it was not issued for receipt.url).
      token = parseOpencodeEntryBearer(ocMcp.path, ocMcp.name ?? 'gbrain', receipt.url);
      if (token) tokenSource = 'opencode config entry';
    }
  }

  let tokenLine: string;
  let tokenVerified: boolean | 'unavailable' = 'unavailable';
  if (!health.ok) {
    tokenLine = 'token: not verified (serve unreachable)';
  } else if (token) {
    const smoke = await d.probeIdentity(receipt.url, token);
    // [X10] An unknown-tool tool_error means auth + dispatch succeeded — a
    // narrowed --surface (e.g. verbs) is verified, not broken.
    tokenVerified = smoke.ok || smoke.reason === 'tool_error';
    tokenLine = smoke.ok
      ? `token: OK ('${receipt.token.name}' via ${tokenSource} — ${smoke.identity})`
      : smoke.reason === 'tool_error'
        ? `token: OK ('${receipt.token.name}' via ${tokenSource} — authenticated; get_brain_identity ` +
          'unavailable, the serve likely runs a narrowed --surface)'
        : `token: FAILED (${smoke.reason}) — ${redactToken(smoke.message, token)}. ` +
          'Someone may have revoked it; re-run `gbrain bootstrap harness` to rotate.';
  } else {
    tokenLine = `token: verify unavailable (no registration to recover the bearer from) — honest degrade, not a failure.`;
  }

  const skew =
    health.ok && health.version && isServeOlderThanScopes(health.version)
      ? `serve v${health.version} predates token scoping — the token verifies as FULL-ACCESS until the serve restarts on this version.`
      : null;

  const degraded = (health.engine ?? receipt.engine) === 'postgres';

  // Ambient-writeback block probes (kind === 'instructions'): live sentinel
  // presence, plus the [OV-A4] codex exclusivity file — an install shadowed
  // by AGENTS.override.md must never read as healthy.
  const instructionsProbes = receipt.targets
    .filter((t) => t.kind === 'instructions')
    .map((t) => {
      let probe: 'installed' | 'missing' | 'override-blocked' | 'unreadable' = 'missing';
      try {
        if (t.host === 'codex' && existsSync(d.codexAgentsOverride)) {
          probe = 'override-blocked';
        } else if (
          t.path &&
          existsSync(t.path) &&
          // The ONE probe vocabulary (instructions-block.ts) so status,
          // converge, and doctor classify a damaged-marker file identically.
          probeAmbientBlock(readFileSync(t.path, 'utf8')).state === 'present'
        ) {
          probe = 'installed';
        }
      } catch {
        probe = 'unreadable';
      }
      return { host: t.host, path: t.path ?? null, probe };
    });
  const instructionsOk = instructionsProbes.every((p) => p.probe === 'installed');

  if (flags.json) {
    d.log(
      JSON.stringify(
        {
          schema_version: 1,
          installed: true,
          url: receipt.url,
          serve_ok: health.ok,
          engine: health.engine ?? receipt.engine ?? null,
          serve_version: health.version ?? null,
          version_skew: skew !== null,
          token_name: receipt.token.name,
          token_verified: tokenVerified,
          degraded_per_turn: degraded,
          targets: receipt.targets,
          ...(instructionsProbes.length > 0 ? { instructions_blocks: instructionsProbes } : {}),
          pending_previous_tokens: receipt.token.previous_ids ?? [],
          receipt_path: harnessReceiptPath(d.gbrainHome),
        },
        null,
        2,
      ),
    );
  } else {
    d.log(serveLine);
    d.log(tokenLine);
    for (const t of receipt.targets) {
      d.log(`  ${t.host}/${t.kind} (${t.scope}): ${t.state}${t.error ? ` — ${t.error}` : ''}`);
    }
    for (const p of instructionsProbes) {
      d.log(
        `  ambient-writeback block (${p.host}): ${p.probe}${p.path ? ` — ${p.path}` : ''}` +
          (p.probe === 'override-blocked'
            ? ` (codex ignores AGENTS.md while ${d.codexAgentsOverride} exists — fold the block in there or remove the override and re-run)`
            : ''),
      );
    }
    if (receipt.token.previous_ids?.length) {
      d.log(`  pending: ${receipt.token.previous_ids.length} previous token(s) await revocation (re-run to converge): ${receipt.token.previous_ids.join(', ')}`);
    }
    if (degraded) {
      d.log('per-turn injection: needs a running gbrain serve on Postgres (MCP tools are the active seam).');
    }
    if (skew) d.log(`note: ${skew}`);
  }
  // Cron contract: 0 means ALL-VERIFIED (or honest degrades only) — a
  // crashed apply's pending/failed targets and an unconverged rotation are
  // NOT success just because /health answers (ship-review P2). The
  // token-unrecoverable honest degrade stays 0 per the documented contract.
  const allTargetsConfirmed = receipt.targets.every((t) => t.state === 'confirmed');
  const rotationConverged = (receipt.token.previous_ids?.length ?? 0) === 0;
  // Half-removed state (red-team CRITICAL): --remove under a live PGLite
  // serve strips every host target but defers the revoke, leaving a
  // zero-target receipt whose minted token is STILL ACTIVE. Vacuous
  // every() would read that as green forever.
  const removalPending = receipt.targets.length === 0 && receipt.token.minted && receipt.token.id !== undefined;
  if (removalPending) {
    d.logError(
      `removal pending: host wiring is gone but the minted token (id ${receipt.token.id}) is not yet revoked — ` +
        'stop the serve and re-run `gbrain bootstrap harness --remove`, or revoke it with `gbrain auth revoke` and the id flag.',
    );
  }
  return health.ok && tokenVerified !== false && allTargetsConfirmed && rotationConverged && !removalPending && instructionsOk
    ? 0
    : 1;
}

// ── Home preflight ──────────────────────────────────────────────────────────

/** Ensure the gbrain home exists before locking in it (the bootstrap lock's
 * missing-dir message says "workspace directory", which would mislead here). */
export function ensureHarnessHome(home: string): void {
  mkdirSync(join(home, 'bootstrap'), { recursive: true });
}

/** True when the codex config carries OUR managed block for `name` — the
 * stdio lane (runHooks) must not fight the harness lane for the same server
 * name (one owner per name; `codex mcp remove` drops comments). */
export function codexBlockOwnsName(configPath: string, name: string): boolean {
  if (!existsSync(configPath)) return false;
  try {
    const text = readFileSync(configPath, 'utf8').replace(/\r\n/g, '\n');
    const begin = text.indexOf(CODEX_TOML_BLOCK_BEGIN);
    const end = text.indexOf(CODEX_TOML_BLOCK_END);
    if (begin < 0 || end < 0 || end < begin) return false;
    // Ownership means the table header sits INSIDE our managed block — a
    // foreign `[mcp_servers.<name>]` elsewhere in the file must not make the
    // stdio lane defer to us.
    return text.slice(begin, end).includes(`[mcp_servers.${name}]`);
  } catch {
    return false;
  }
}

// ── Plugin-lane detection (codex/claude plugins provide an MCP server) ─────
//
// Plugin-provided MCP servers never appear in `codex mcp list` or in
// `[mcp_servers.*]` — the only cheap CONFIG signal is the plugin-enable
// entry in the harness's own config. Config is not health (an enabled
// plugin whose launcher can't find the gbrain binary still matches), so
// every consumer pairs the detection with an override path
// (`--mcp-even-if-plugin`) and copy that says "enabled, not necessarily
// healthy". All three detectors below share the read/normalize posture of
// codexBlockOwnsName: fail-open (null/false) on any read or parse error.

/**
 * Marketplace-qualified id (`<name>@<marketplace>`) when an ENABLED codex
 * plugin named `name` exists in the codex config, else null. Line-anchored
 * table-header scan — a commented-out lookalike or an inline mention never
 * matches — followed by `enabled = true` before the next table header.
 */
export function codexPluginProvidesName(configPath: string, name: string): string | null {
  if (!existsSync(configPath)) return null;
  try {
    const lines = readFileSync(configPath, 'utf8').replace(/\r\n/g, '\n').split('\n');
    const header = new RegExp(`^\\[plugins\\."${name}@([^"]+)"\\]\\s*$`);
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(header);
      if (!m) continue;
      for (let j = i + 1; j < lines.length; j++) {
        const line = lines[j].trim();
        if (line.startsWith('[')) break;
        if (/^enabled\s*=\s*true\b/.test(line)) return `${name}@${m[1]}`;
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Marketplace-qualified id when an ENABLED Claude Code plugin named `name`
 * exists in `~/.claude/settings.json` (`enabledPlugins`: `"<name>@<mkt>":
 * true` — the shape verified on a live install), else null. User-level file
 * only; project-scope enablement is out of best-effort scope.
 */
export function claudePluginProvidesName(settingsPath: string, name: string): string | null {
  if (!existsSync(settingsPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
      enabledPlugins?: Record<string, unknown>;
    };
    const enabled = parsed.enabledPlugins;
    if (!enabled || typeof enabled !== 'object') return null;
    const prefix = `${name}@`;
    for (const [key, value] of Object.entries(enabled)) {
      if (key.startsWith(prefix) && value === true) return key;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Doctor-side coexistence scan: does ANY registration for `name` exist in
 * the harness config, regardless of owner? Unlike codexBlockOwnsName this
 * deliberately counts foreign/manual entries — a hand-wired
 * `[mcp_servers.<name>]` next to an enabled plugin is exactly the
 * double-registration the doctor advisory reports. Claude side scans BOTH
 * the user config (`~/.claude.json` mcpServers) and, when a project dir is
 * given, the project-scope `.mcp.json`.
 */
export function codexAnyRegistrationExists(configPath: string, name: string): boolean {
  if (!existsSync(configPath)) return false;
  try {
    const lines = readFileSync(configPath, 'utf8').replace(/\r\n/g, '\n').split('\n');
    const header = new RegExp(`^\\[mcp_servers\\.(?:${name}|"${name}")\\]\\s*$`);
    return lines.some(l => header.test(l));
  } catch {
    return false;
  }
}

export function claudeAnyRegistrationExists(
  userConfigPath: string,
  name: string,
  projectDir?: string,
): boolean {
  const hasInMcpServers = (servers: unknown): boolean =>
    !!servers && typeof servers === 'object' && Object.prototype.hasOwnProperty.call(servers, name);
  const readJson = (path: string): Record<string, unknown> | null => {
    if (!existsSync(path)) return null;
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    } catch {
      return null;
    }
  };
  const userCfg = readJson(userConfigPath) as {
    mcpServers?: unknown;
    projects?: Record<string, { mcpServers?: unknown }>;
  } | null;
  if (userCfg) {
    // User scope: top-level mcpServers.
    if (hasInMcpServers(userCfg.mcpServers)) return true;
    // LOCAL scope: `claude mcp add` (README Option 1) defaults here —
    // projects.<cwd>.mcpServers in ~/.claude.json, keyed by the resolved
    // project path. Scan the projectDir entry (and, defensively, any entry —
    // a duplicate under ANY project path is still a real coexistence).
    const projects = userCfg.projects;
    if (projects && typeof projects === 'object') {
      if (projectDir && hasInMcpServers(projects[projectDir]?.mcpServers)) return true;
      for (const entry of Object.values(projects)) {
        if (hasInMcpServers(entry?.mcpServers)) return true;
      }
    }
  }
  // Project-committed .mcp.json.
  if (projectDir) {
    const projCfg = readJson(join(projectDir, '.mcp.json')) as { mcpServers?: unknown } | null;
    if (projCfg && hasInMcpServers(projCfg.mcpServers)) return true;
  }
  return false;
}
