#!/usr/bin/env bun

import { installSigchldHandler } from './core/zombie-reap.ts';
installSigchldHandler();

import { readFileSync } from 'fs';
import { loadConfig, loadConfigWithEngine, toEngineConfig, isThinClient } from './core/config.ts';
import type { GBrainConfig } from './core/config.ts';
import type { AIGatewayConfig } from './core/ai/types.ts';
import type { BrainEngine } from './core/engine.ts';
import { operations, OperationError } from './core/operations.ts';
import type { Operation, OperationContext } from './core/operations.ts';
import { serializeMarkdown } from './core/markdown.ts';
import { parseGlobalFlags, setCliOptions, getCliOptions } from './core/cli-options.ts';
import type { CliOptions } from './core/cli-options.ts';
import { callRemoteTool, RemoteMcpError, unpackToolResult } from './core/mcp-client.ts';
import { maybePromptForUpgrade } from './core/thin-client-upgrade-prompt.ts';
import { VERSION } from './version.ts';

// Build CLI name -> operation lookup
const cliOps = new Map<string, Operation>();
for (const op of operations) {
  const name = op.cliHints?.name;
  if (name && !op.cliHints?.hidden) {
    cliOps.set(name, op);
  }
}

// CLI-only commands that bypass the operation layer
const CLI_ONLY = new Set(['init', 'upgrade', 'post-upgrade', 'check-update', 'integrations', 'publish', 'check-backlinks', 'lint', 'report', 'import', 'export', 'files', 'embed', 'serve', 'call', 'config', 'doctor', 'migrate', 'eval', 'sync', 'extract', 'features', 'autopilot', 'graph-query', 'jobs', 'agent', 'apply-migrations', 'skillpack-check', 'skillpack', 'resolvers', 'integrity', 'repair-jsonb', 'orphans', 'sources', 'mounts', 'dream', 'check-resolvable', 'routing-eval', 'skillify', 'smoke-test', 'providers', 'storage', 'repos', 'code-def', 'code-refs', 'reindex-code', 'reindex-frontmatter', 'code-callers', 'code-callees', 'frontmatter', 'auth', 'friction', 'claw-test', 'book-mirror', 'takes', 'think', 'salience', 'anomalies', 'transcripts', 'models', 'remote', 'recall', 'forget']);
// CLI-only commands whose handlers print their own --help text. These are
// excluded from the generic short-circuit so detailed per-command and
// per-subcommand usage stays reachable.
const CLI_ONLY_SELF_HELP = new Set([
  'upgrade', 'post-upgrade', 'check-update',
  'embed', 'config',
  'skillpack', 'skillpack-check',
  'integrations', 'friction',
  'frontmatter', 'check-resolvable',
  'models',
]);

async function main() {
  // Parse global flags (--quiet / --progress-json / --progress-interval)
  // BEFORE command dispatch, so `gbrain --progress-json doctor` works.
  // The stripped argv is what the command sees.
  const rawArgs = process.argv.slice(2);
  const { cliOpts, rest: args } = parseGlobalFlags(rawArgs);
  setCliOptions(cliOpts);

  let command = args[0];

  if (!command || command === '--help' || command === '-h') {
    printHelp();
    return;
  }

  if (command === '--version' || command === 'version') {
    console.log(`gbrain ${VERSION}`);
    return;
  }

  if (command === '--tools-json') {
    const { printToolsJson } = await import('./commands/tools-json.ts');
    printToolsJson();
    return;
  }

  const subArgs = args.slice(1);

  // DX alias: `ask` is a natural-language alias for `query`
  if (command === 'ask') {
    command = 'query';
  }

  // Per-command --help
  if (hasHelpFlag(subArgs)) {
    const op = cliOps.get(command);
    if (op) {
      printOpHelp(op);
      return;
    }
    if (CLI_ONLY.has(command) && !CLI_ONLY_SELF_HELP.has(command)) {
      printCliOnlyHelp(command);
      return;
    }
  }

  // CLI-only commands
  if (CLI_ONLY.has(command)) {
    await handleCliOnly(command, subArgs);
    return;
  }

  // Shared operations
  const op = cliOps.get(command);
  if (!op) {
    console.error(`Unknown command: ${command}`);
    console.error('Run gbrain --help for available commands.');
    process.exit(1);
  }

  // v0.31.1 (Issue #734, CDX-1): parse CLI args BEFORE engine connect so
  // the routing seam below can decide local-vs-remote without paying a
  // PGLite migration replay on thin-client installs. The arg parser, image
  // transform, and required-param check are all engine-free; refactoring
  // them out of the engine try/catch is safe and unlocks routing.
  const params = parseOpArgs(op, subArgs);

  // v0.27.1 (`gbrain query --image <path>`): swap the `image` param from
  // a filesystem path into base64 bytes + mime. The op accepts base64; the
  // CLI accepts a path. Helper is exported so tests can exercise the
  // transform without spawning a subprocess.
  if (op.name === 'query' && typeof params.image === 'string' && params.image.length > 0) {
    try {
      const { path, base64, mime } = resolveQueryImage(
        params.image as string,
        (params.image_mime as string) || undefined,
      );
      params.image = base64;
      params.image_mime = mime;
      void path;
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  }

  // Validate required params before calling handler. v0.27.1: the
  // `query` op's positional `query` is required only when --image is
  // NOT supplied. The runtime altRequired check below overrides the
  // generic required-flag check for that op.
  const queryHasAlt = op.name === 'query' && typeof params.image === 'string' && params.image.length > 0;
  for (const [key, def] of Object.entries(op.params)) {
    if (def.required && params[key] === undefined) {
      if (queryHasAlt && key === 'query') continue;
      const cliName = op.cliHints?.name || op.name;
      const positional = op.cliHints?.positional || [];
      const usage = positional.map(p => `<${p}>`).join(' ');
      console.error(`Usage: gbrain ${cliName} ${usage}`);
      process.exit(1);
    }
  }

  // v0.31.1 (Issue #734, CDX-1 routing seam): on thin-client installs,
  // route every non-localOnly op through callRemoteTool instead of opening
  // the empty local PGLite. localOnly ops can't run on a thin client at all
  // (no local engine, server intentionally hides them) — refuse with hint.
  // Fix for the silent-empty-results bug class that motivated this whole release.
  const cfgPre = loadConfig();
  if (isThinClient(cfgPre)) {
    if (op.localOnly) {
      refuseThinClient(command, cfgPre!.remote_mcp!.mcp_url);
    }
    await runThinClientRouted(op, params, cfgPre!, cliOpts);
    return;
  }

  // Local engine path (unchanged behavior for local installs).
  const engine = await connectEngine();
  try {
    const ctx = await makeContext(engine, params);
    const rawResult = await op.handler(ctx, params);
    // ENG-2 (renderer parity by data shape): JSON-round-trip the local-engine
    // path's return value so renderers see the same shape they'd see on the
    // routed path. Date → ISO string; bigint → string (postgres.js shape);
    // Buffer → object. Microsecond-cost; eliminates a whole drift bug class.
    const result = JSON.parse(JSON.stringify(rawResult));
    const output = formatResult(op.name, result);
    if (output) process.stdout.write(output);
  } catch (e: unknown) {
    if (e instanceof OperationError) {
      console.error(`Error [${e.code}]: ${e.message}`);
      if (e.suggestion) console.error(`  Fix: ${e.suggestion}`);
      process.exit(1);
    }
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  } finally {
    await engine.disconnect();
  }
}

function hasHelpFlag(args: string[]): boolean {
  return args.includes('--help') || args.includes('-h');
}

function printCliOnlyHelp(command: string) {
  console.log(`Usage: gbrain ${command}`);
  console.log('');
  console.log(`gbrain ${command} - run gbrain --help for the full command list.`);
}

/**
 * v0.31.1 (Issue #734, CDX-1): route a shared op through the remote MCP
 * server instead of running it locally. Called from main() when
 * `isThinClient(cfg) && !op.localOnly`.
 *
 * Timeout policy (ENG-4): user override via --timeout=Ns wins; otherwise
 * 180s for `think` (LLM calls), 30s for everything else.
 *
 * Error policy (CDX-4): callRemoteTool's hardening pass guarantees every
 * thrown value reaches us as a RemoteMcpError. The switch below is
 * exhaustively typed (TS `never` check); adding a new reason variant fails
 * compilation until this dispatcher knows what to render.
 *
 * Renderer policy: the MCP tool result is unpacked via unpackToolResult
 * (which JSON.parses the text content) and handed to the SAME formatResult
 * the local-engine path uses. Renderer parity is enforced by data shape,
 * not by per-command audit.
 */
async function runThinClientRouted(
  op: Operation,
  params: Record<string, unknown>,
  cfg: GBrainConfig,
  cliOpts: CliOptions,
): Promise<void> {
  // ENG-4: per-op timeout default; user override wins.
  const defaultTimeoutMs = op.name === 'think' ? 180_000 : 30_000;
  const timeoutMs = cliOpts.timeoutMs ?? defaultTimeoutMs;

  // SIGINT support: aborts in-flight HTTP cleanly (exit 130 is the standard
  // SIGINT exit code; our error switch maps `network/aborted` to that).
  const sigintController = new AbortController();
  const onSigint = () => {
    sigintController.abort(new Error('SIGINT'));
  };
  process.on('SIGINT', onSigint);

  // v0.31.1 (Issue #734, cherry-pick B): print identity banner to stderr
  // BEFORE the routed call. Banner failure suppresses the banner only —
  // never the underlying command. Suppression honors --quiet, non-TTY,
  // and GBRAIN_NO_BANNER=1.
  await printIdentityBannerBestEffort(cfg, cliOpts, sigintController.signal);

  try {
    const raw = await callRemoteTool(cfg, op.name, params, {
      timeoutMs,
      signal: sigintController.signal,
    });
    const result = unpackToolResult(raw);
    const output = formatResult(op.name, result);
    if (output) process.stdout.write(output);
  } catch (e: unknown) {
    if (e instanceof RemoteMcpError) {
      const url = cfg.remote_mcp!.mcp_url;
      switch (e.reason) {
        case 'config':
          console.error(e.message);
          break;
        case 'discovery':
          console.error(`OAuth discovery failed at ${cfg.remote_mcp!.issuer_url}.`);
          console.error('Run `gbrain remote doctor` for details.');
          break;
        case 'auth':
          console.error('OAuth auth failed.');
          console.error('On the host, re-register your client:');
          console.error('  gbrain auth register-client <name> --grant-types client_credentials --scopes read,write,admin');
          break;
        case 'auth_after_refresh':
          console.error('OAuth auth failed after token refresh. Credentials may have been revoked.');
          console.error('Run `gbrain remote doctor` to confirm.');
          break;
        case 'network':
          if (e.detail?.kind === 'timeout') {
            const hint = cliOpts.timeoutMs ? '' : ` (default ${defaultTimeoutMs}ms; pass --timeout=Ns to override)`;
            console.error(`Request to ${url} timed out${hint}.`);
          } else if (e.detail?.kind === 'aborted') {
            console.error('Request aborted.');
            process.off('SIGINT', onSigint);
            process.exit(130);
          } else {
            console.error(`Cannot reach ${url}. Run \`gbrain remote doctor\` for details.`);
          }
          break;
        case 'tool_error':
          if (e.detail?.code === 'missing_scope') {
            console.error('Missing OAuth scope on this client.');
            console.error('On the host, re-register the client with broader scopes:');
            console.error('  gbrain auth register-client <name> --grant-types client_credentials --scopes read,write,admin');
          } else {
            console.error(e.message);
            console.error('Run `gbrain remote doctor` if this persists.');
          }
          break;
        case 'parse':
          console.error('Server response was malformed. Run `gbrain remote doctor`.');
          break;
        default: {
          // Exhaustive switch sentinel (TS `never` — fails to build if a
          // new RemoteMcpErrorReason variant is added without a case).
          const _exhaustive: never = e.reason;
          void _exhaustive;
          console.error(`Unhandled remote error: ${e.message}`);
        }
      }
      process.off('SIGINT', onSigint);
      process.exit(1);
    }
    // Defense in depth: callRemoteTool's contract is that everything is
    // RemoteMcpError. If a plain Error escapes, render it generically and
    // exit 1 — but this should never happen post-CDX-4.
    console.error(e instanceof Error ? e.message : String(e));
    process.off('SIGINT', onSigint);
    process.exit(1);
  } finally {
    process.off('SIGINT', onSigint);
  }
}

// ============================================================================
// v0.31.1 (Issue #734, cherry-pick B): thin-client identity banner.
//
// Prints "[thin-client → <host> · brain: 102k pages, 265k chunks · vX.Y.Z]"
// to stderr before each routed command, so users (and agents) know they're
// talking to a real remote brain — not the empty local PGLite that motivated
// this whole release.
//
// Cache: 60s TTL, in-memory Map keyed by mcp_url. Cross-process file cache
// is deferred (marginal benefit; one mint per CLI process is fine).
// Suppression: --quiet, non-TTY, GBRAIN_NO_BANNER=1.
// Failure mode: any error in fetching identity → suppress banner; underlying
// command runs normally. Banner is observability, not load-bearing.
// ============================================================================

export interface BrainIdentity {
  version: string;
  engine: 'postgres' | 'pglite';
  page_count: number;
  chunk_count: number;
  last_sync_iso: string | null;
}

interface CachedIdentity {
  identity: BrainIdentity;
  cached_at_ms: number;
}

const IDENTITY_TTL_MS = 60_000;
const identityCache = new Map<string, CachedIdentity>();

/** Test-only escape hatch — clears the in-memory cache between test runs. */
export function _clearIdentityCacheForTest(): void {
  identityCache.clear();
}

export function bannerSuppressed(cliOpts: CliOptions): boolean {
  if (cliOpts.quiet) return true;
  if (process.env.GBRAIN_NO_BANNER === '1') return true;
  // Non-TTY default is suppressed (clean pipes); explicit env-flag overrides.
  if (!process.stderr.isTTY && process.env.GBRAIN_BANNER !== '1') return true;
  return false;
}

function formatPageCount(n: number): string {
  if (n >= 1000) {
    const k = (n / 1000).toFixed(n >= 100_000 ? 0 : 1);
    return `${k}k`;
  }
  return String(n);
}

function formatBanner(mcpUrl: string, id: BrainIdentity): string {
  const host = mcpUrl.replace(/^https?:\/\//, '').split('/')[0];
  const counts = `brain: ${formatPageCount(id.page_count)} pages, ${formatPageCount(id.chunk_count)} chunks`;
  return `[thin-client → ${host} · ${counts} · v${id.version}]`;
}

async function fetchIdentity(
  cfg: GBrainConfig,
  signal: AbortSignal,
): Promise<BrainIdentity> {
  // 2s timeout for the banner fetch — must not delay the underlying command.
  const raw = await callRemoteTool(cfg, 'get_brain_identity', {}, {
    timeoutMs: 2000,
    signal,
  });
  const id = unpackToolResult<BrainIdentity>(raw);
  return id;
}

async function printIdentityBannerBestEffort(
  cfg: GBrainConfig,
  cliOpts: CliOptions,
  signal: AbortSignal,
): Promise<void> {
  if (bannerSuppressed(cliOpts)) return;
  const mcpUrl = cfg.remote_mcp?.mcp_url;
  if (!mcpUrl) return;

  // Cache lookup keyed by mcp_url so switching hosts via `gbrain init`
  // invalidates cleanly even within a long-lived process.
  const cached = identityCache.get(mcpUrl);
  if (cached && Date.now() - cached.cached_at_ms < IDENTITY_TTL_MS) {
    process.stderr.write(formatBanner(mcpUrl, cached.identity) + '\n');
    // v0.31.11: detect remote-version drift, prompt user to upgrade.
    // bannerIsSuppressed=false here — the early return above guaranteed it.
    await maybePromptForUpgrade(cfg, cached.identity, cliOpts, false);
    return;
  }

  // Cache miss — fetch. Failure is non-fatal: banner is observability,
  // never load-bearing for the underlying command.
  try {
    const id = await fetchIdentity(cfg, signal);
    identityCache.set(mcpUrl, { identity: id, cached_at_ms: Date.now() });
    process.stderr.write(formatBanner(mcpUrl, id) + '\n');
    // v0.31.11: detect remote-version drift, prompt user to upgrade.
    await maybePromptForUpgrade(cfg, id, cliOpts, false);
  } catch {
    // Swallow. Banner suppressed; main command continues. The CDX-4
    // hardened callRemoteTool will surface the same error class on the
    // actual command call if the host is genuinely unreachable.
  }
}

/**
 * v0.27.1: shared transform for `gbrain query --image <path>` (and any future
 * CLI surface that takes an image path). Reads the file, base64-encodes,
 * derives MIME from the extension, enforces the 20MB cap. Exported so tests
 * can verify the transform without spawning a subprocess.
 *
 * Throws Error on any failure (file missing, oversized, etc.). Caller is
 * responsible for routing to process.exit(1) with a user-facing message.
 */
export function resolveQueryImage(
  imagePath: string,
  explicitMime?: string,
): { path: string; base64: string; mime: string } {
  const bytes = readFileSync(imagePath);
  if (bytes.length > 20 * 1024 * 1024) {
    throw new Error(`Error: image too large (${bytes.length} bytes, max 20MB).`);
  }
  const base64 = bytes.toString('base64');
  let mime = explicitMime;
  if (!mime) {
    const lower = imagePath.toLowerCase();
    const mimeFromExt: Record<string, string> = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.heic': 'image/heic', '.heif': 'image/heif',
      '.avif': 'image/avif',
    };
    const ext = Object.keys(mimeFromExt).find(e => lower.endsWith(e));
    mime = ext ? mimeFromExt[ext] : 'image/jpeg';
  }
  return { path: imagePath, base64, mime };
}

function parseOpArgs(op: Operation, args: string[]): Record<string, unknown> {
  const params: Record<string, unknown> = {};
  const positional = op.cliHints?.positional || [];
  let posIdx = 0;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2).replace(/-/g, '_');
      const paramDef = op.params[key];
      if (paramDef?.type === 'boolean') {
        params[key] = true;
      } else if (i + 1 < args.length) {
        params[key] = args[++i];
        if (paramDef?.type === 'number') params[key] = Number(params[key]);
      }
    } else if (posIdx < positional.length) {
      const key = positional[posIdx++];
      const paramDef = op.params[key];
      params[key] = paramDef?.type === 'number' ? Number(arg) : arg;
    }
  }

  // Read stdin for content params
  if (op.cliHints?.stdin && !params[op.cliHints.stdin] && !process.stdin.isTTY) {
    const stdinContent = readFileSync('/dev/stdin', 'utf-8');
    const MAX_STDIN = 5_000_000; // 5MB
    if (Buffer.byteLength(stdinContent, 'utf-8') > MAX_STDIN) {
      console.error(`Error: stdin content exceeds ${MAX_STDIN} bytes. Split into smaller inputs.`);
      process.exit(1);
    }
    params[op.cliHints.stdin] = stdinContent;
  }

  return params;
}

async function makeContext(engine: BrainEngine, params: Record<string, unknown>): Promise<OperationContext> {
  // v0.31.8 (D11): resolve sourceId via the canonical 6-tier chain. Honors
  // --source / GBRAIN_SOURCE / .gbrain-source / path-match / brain default /
  // 'default'. Wrapped in try/catch so a doctor / single-source brain that
  // never set up sources still returns 'default' silently.
  let sourceId: string | undefined;
  try {
    const { resolveSourceId } = await import('./core/source-resolver.ts');
    // params.source is set when a CLI flag was parsed for the op (rare; most
    // CLI ops don't take --source). Falls through to env/dotfile/path-match.
    const explicit = (params.source as string | undefined) ?? null;
    sourceId = await resolveSourceId(engine, explicit);
  } catch {
    // Source resolution failed (e.g. sources table doesn't exist on a fresh
    // pre-init brain). Leave sourceId unset; engine read methods fall through
    // to the cross-source view (D16 back-compat path).
    sourceId = undefined;
  }
  return {
    engine,
    config: loadConfig() || { engine: 'postgres' },
    logger: { info: console.log, warn: console.warn, error: console.error },
    dryRun: (params.dry_run as boolean) || false,
    // Local CLI invocation — the user owns the machine; do not apply remote-caller
    // confinement (e.g., cwd-locked file_upload).
    remote: false,
    cliOpts: getCliOptions(),
    ...(sourceId ? { sourceId } : {}),
  };
}

function formatResult(opName: string, result: unknown): string {
  switch (opName) {
    case 'get_page': {
      const r = result as any;
      if (r.error === 'ambiguous_slug') {
        return `Ambiguous slug. Did you mean:\n${r.candidates.map((c: string) => `  ${c}`).join('\n')}\n`;
      }
      return serializeMarkdown(r.frontmatter || {}, r.compiled_truth || '', r.timeline || '', {
        type: r.type, title: r.title, tags: r.tags || [],
      });
    }
    case 'list_pages': {
      const pages = result as any[];
      if (pages.length === 0) return 'No pages found.\n';
      return pages.map(p =>
        `${p.slug}\t${p.type}\t${p.updated_at?.toString().slice(0, 10) || '?'}\t${p.title}`,
      ).join('\n') + '\n';
    }
    case 'search':
    case 'query': {
      const results = result as any[];
      if (results.length === 0) return 'No results.\n';
      return results.map(r =>
        `[${r.score?.toFixed(4) || '?'}] ${r.slug} -- ${r.chunk_text?.slice(0, 100) || ''}${r.stale ? ' (stale)' : ''}`,
      ).join('\n') + '\n';
    }
    case 'get_tags': {
      const tags = result as string[];
      return tags.length > 0 ? tags.join(', ') + '\n' : 'No tags.\n';
    }
    case 'get_stats': {
      const s = result as any;
      const lines = [
        `Pages:     ${s.page_count}`,
        `Chunks:    ${s.chunk_count}`,
        `Embedded:  ${s.embedded_count}`,
        `Links:     ${s.link_count}`,
        `Tags:      ${s.tag_count}`,
        `Timeline:  ${s.timeline_entry_count}`,
      ];
      if (s.pages_by_type) {
        lines.push('', 'By type:');
        for (const [k, v] of Object.entries(s.pages_by_type)) {
          lines.push(`  ${k}: ${v}`);
        }
      }
      return lines.join('\n') + '\n';
    }
    case 'get_health': {
      const h = result as any;
      // Health score weights: missing_embeddings is the heaviest (2 pts), other
      // graph quality issues are 1 pt each. link_coverage / timeline_coverage below
      // 50% on entity pages indicates the graph needs population.
      const score = Math.max(0, 10
        - (h.missing_embeddings > 0 ? 2 : 0)
        - (h.stale_pages > 0 ? 1 : 0)
        - (h.orphan_pages > 0 ? 1 : 0)
        - ((h.link_coverage ?? 1) < 0.5 ? 1 : 0)
        - ((h.timeline_coverage ?? 1) < 0.5 ? 1 : 0));
      const lines = [
        `Health score: ${score}/10`,
        `Embed coverage: ${(h.embed_coverage * 100).toFixed(1)}%`,
        `Missing embeddings: ${h.missing_embeddings}`,
        `Stale pages: ${h.stale_pages}`,
        `Orphan pages: ${h.orphan_pages}`,
      ];
      if (h.link_coverage !== undefined) {
        lines.push(`Link coverage (entities): ${(h.link_coverage * 100).toFixed(1)}%`);
      }
      if (h.timeline_coverage !== undefined) {
        lines.push(`Timeline coverage (entities): ${(h.timeline_coverage * 100).toFixed(1)}%`);
      }
      if (Array.isArray(h.most_connected) && h.most_connected.length > 0) {
        lines.push('Most connected entities:');
        for (const e of h.most_connected) {
          lines.push(`  ${e.slug}: ${e.link_count} links`);
        }
      }
      return lines.join('\n') + '\n';
    }
    case 'get_timeline': {
      const entries = result as any[];
      if (entries.length === 0) return 'No timeline entries.\n';
      return entries.map(e =>
        `${e.date}  ${e.summary}${e.source ? ` [${e.source}]` : ''}`,
      ).join('\n') + '\n';
    }
    case 'get_versions': {
      const versions = result as any[];
      if (versions.length === 0) return 'No versions.\n';
      return versions.map(v =>
        `#${v.id}  ${v.snapshot_at?.toString().slice(0, 19) || '?'}  ${v.compiled_truth?.slice(0, 60) || ''}...`,
      ).join('\n') + '\n';
    }
    default:
      return JSON.stringify(result, null, 2) + '\n';
  }
}

/**
 * Multi-topology v1: thin-client refusal set. These commands require a local
 * engine; if `~/.gbrain/config.json` has `remote_mcp` set, the dispatch guard
 * refuses them with a canonical error pointing at the remote host. The check
 * runs before per-command dispatch so the error message is consistent.
 *
 * `serve` is in this set because `gbrain serve` (stdio or http) requires a
 * local engine to expose. Thin clients don't have one to expose.
 *
 * `doctor` is intentionally NOT in this set — task 4 routes it to
 * `runRemoteDoctor` for thin-client installs.
 */
const THIN_CLIENT_REFUSED_COMMANDS = new Set([
  'sync', 'embed', 'extract', 'migrate', 'apply-migrations',
  'repair-jsonb', 'orphans', 'integrity', 'serve',
  // v0.31.1 (CDX-2 op coverage matrix): more local-only commands
  'dream', 'transcripts', 'storage',
  // v0.31.1 CDX-2 audit: takes/sources have multiple subcommands; some
  // (takes_list/takes_search, sources_list/sources_status) have MCP
  // equivalents and others are file-system bound (takes mutate commands
  // edit local .md files). v0.31.1 refuses both at the top level with a
  // hint pointing at the routable MCP tools; per-subcommand splits are
  // a v0.31.x follow-up TODO.
  'takes', 'sources',
]);

/**
 * v0.31.1 (Issue #734, CDX-5 + cherry-pick A): pinpoint refusal hints for
 * local-only commands when running on a thin-client install. Each hint names
 * the closest path (remote MCP call, host-side workflow) so users aren't
 * stuck guessing what to do next.
 *
 * Source-of-truth lives here so adding a new local-only command means
 * adding both the THIN_CLIENT_REFUSED_COMMANDS member AND the hint in one
 * place during code review.
 */
const THIN_CLIENT_REFUSE_HINTS: Record<string, string> = {
  sync: 'sync runs on the host. Trigger a remote cycle with `gbrain remote ping` (queues an autopilot-cycle job).',
  embed: 'embed runs on the host as part of the autopilot cycle. `gbrain remote ping` triggers a full cycle including embed.',
  extract: 'extract runs on the host. Use `gbrain remote ping` to trigger a cycle including extract.',
  migrate: "migrate runs on the host's local engine. Run on the host machine.",
  'apply-migrations': 'schema migrations run on the host. SSH and run there.',
  'repair-jsonb': 'repair-jsonb operates on the local DB only.',
  integrity: 'integrity scans local files. Run on the host machine.',
  serve: 'serve starts a server. Run on the host, not the thin client.',
  dream: 'dream runs the autopilot cycle on the host. `gbrain remote ping` queues one. (Native `gbrain dream` thin-client routing planned for v0.31.2.)',
  orphans: "orphans needs the host's brain. Run on the host or use the `find_orphans` MCP tool from your agent.",
  transcripts: 'transcripts is server-private (raw chat exports stay on the host). Read transcripts on the host machine.',
  storage: 'storage operates on the local repo on disk. Run on the host.',
  takes: 'takes mutate subcommands edit local .md files; routing the read subcommands lands in v0.31.x. For now: use `takes_list` and `takes_search` MCP tools from your agent, or run on the host.',
  sources: 'sources commands manage local DB + config rows. Per-subcommand thin-client routing lands in v0.31.x. For now: use `sources_list` / `sources_status` MCP tools, or run on the host.',
};

/**
 * v0.31.1: emit a pinpoint refusal hint for a thin-client-incompatible
 * command and exit 1. Falls back to the canonical generic message when no
 * specific hint is registered (defensive — every member of
 * THIN_CLIENT_REFUSED_COMMANDS should have a hint).
 */
function refuseThinClient(command: string, mcpUrl: string): never {
  const hint = THIN_CLIENT_REFUSE_HINTS[command];
  if (hint) {
    console.error(`\`gbrain ${command}\` is not routable. ${hint}`);
    console.error(`(thin-client of ${mcpUrl})`);
  } else {
    console.error(
      `\`gbrain ${command}\` requires a local engine. This install is a thin client of ${mcpUrl}.\n` +
      `Run \`${command}\` on the remote host, or use the corresponding MCP tool from your agent.`,
    );
  }
  process.exit(1);
}

async function handleCliOnly(command: string, args: string[]) {
  // Thin-client guard: refuse DB-bound commands cleanly with a pinpoint
  // hint instead of letting them fail later inside connectEngine or
  // mid-handler. v0.31.1 routes through `refuseThinClient` so every
  // refusal carries an actionable next-step hint (CDX-5 cherry-pick A).
  if (THIN_CLIENT_REFUSED_COMMANDS.has(command)) {
    const cfg = loadConfig();
    if (isThinClient(cfg)) {
      refuseThinClient(command, cfg!.remote_mcp!.mcp_url);
    }
  }

  // Commands that don't need a database connection
  if (command === 'init') {
    const { runInit } = await import('./commands/init.ts');
    await runInit(args);
    return;
  }
  if (command === 'auth') {
    const { runAuth } = await import('./commands/auth.ts');
    await runAuth(args);
    return;
  }
  if (command === 'remote') {
    // Multi-topology v1 (Tier B): thin-client-only convenience commands.
    // `runRemote` self-checks for remote_mcp config and exits 1 if local-only.
    const { runRemote } = await import('./commands/remote.ts');
    await runRemote(args);
    return;
  }
  if (command === 'upgrade') {
    const { runUpgrade } = await import('./commands/upgrade.ts');
    await runUpgrade(args);
    return;
  }
  if (command === 'post-upgrade') {
    const { runPostUpgrade } = await import('./commands/upgrade.ts');
    await runPostUpgrade(args);
    return;
  }
  if (command === 'check-update') {
    const { runCheckUpdate } = await import('./commands/check-update.ts');
    await runCheckUpdate(args);
    return;
  }
  if (command === 'integrations') {
    const { runIntegrations } = await import('./commands/integrations.ts');
    await runIntegrations(args);
    return;
  }
  if (command === 'providers') {
    const { runProviders } = await import('./commands/providers.ts');
    const [sub, ...rest] = args;
    await runProviders(sub, rest);
    return;
  }
  if (command === 'auth') {
    const { runAuth } = await import('./commands/auth.ts');
    await runAuth(args);
    return;
  }
  if (command === 'resolvers') {
    const { runResolvers } = await import('./commands/resolvers.ts');
    await runResolvers(args);
    return;
  }
  if (command === 'integrity') {
    const { runIntegrity } = await import('./commands/integrity.ts');
    await runIntegrity(args);
    return;
  }
  if (command === 'publish') {
    const { runPublish } = await import('./commands/publish.ts');
    await runPublish(args);
    return;
  }
  if (command === 'check-backlinks') {
    const { runBacklinks } = await import('./commands/backlinks.ts');
    await runBacklinks(args);
    return;
  }
  if (command === 'frontmatter') {
    const { runFrontmatter } = await import('./commands/frontmatter.ts');
    await runFrontmatter(args);
    return;
  }
  if (command === 'lint') {
    const { runLint } = await import('./commands/lint.ts');
    await runLint(args);
    return;
  }
  if (command === 'check-resolvable') {
    const { runCheckResolvable } = await import('./commands/check-resolvable.ts');
    await runCheckResolvable(args);
    return;
  }
  if (command === 'mounts') {
    // No DB needed: mounts.json is a local config file. Registry will
    // connect mount engines lazily on first use by op dispatch.
    const { runMounts } = await import('./commands/mounts.ts');
    await runMounts(args);
    return;
  }
  if (command === 'routing-eval') {
    const { runRoutingEvalCli } = await import('./commands/routing-eval.ts');
    await runRoutingEvalCli(args);
    return;
  }
  if (command === 'skillify') {
    const { runSkillify } = await import('./commands/skillify.ts');
    // `args` here is subArgs (command already stripped by caller), so
    // args[0] is the subcommand (scaffold|check).
    await runSkillify(args);
    return;
  }
  if (command === 'skillpack') {
    const { runSkillpack } = await import('./commands/skillpack.ts');
    // subArgs already has `skillpack` stripped; args[0] is the subcommand.
    await runSkillpack(args);
    return;
  }
  if (command === 'friction') {
    const { runFriction } = await import('./commands/friction.ts');
    process.exit(runFriction(args));
  }
  if (command === 'claw-test') {
    const { runClawTest } = await import('./commands/claw-test.ts');
    process.exit(await runClawTest(args));
  }
  if (command === 'report') {
    const { runReport } = await import('./commands/report.ts');
    await runReport(args);
    return;
  }
  if (command === 'apply-migrations') {
    // Does not need connectEngine — each phase (schema, smoke, host-rewrite)
    // manages its own subprocess or file-layer access directly. Avoids
    // connecting a second time when the orchestrator shells out to
    // `gbrain init --migrate-only` and `gbrain jobs smoke`.
    const { runApplyMigrations } = await import('./commands/apply-migrations.ts');
    await runApplyMigrations(args);
    return;
  }
  if (command === 'repair-jsonb') {
    const { runRepairJsonbCli } = await import('./commands/repair-jsonb.ts');
    await runRepairJsonbCli(args);
    return;
  }
  if (command === 'skillpack-check') {
    // Agent-readable health report. Shells out to doctor + apply-migrations
    // internally; does not need its own DB connection.
    const { runSkillpackCheck } = await import('./commands/skillpack-check.ts');
    await runSkillpackCheck(args);
    return;
  }
  if (command === 'doctor') {
    // Multi-topology v1: thin-client doctor. When `~/.gbrain/config.json`
    // has remote_mcp set, every DB-bound check is irrelevant. Route to the
    // outbound-HTTP probe set in `src/core/doctor-remote.ts` and return
    // before any local-engine work.
    const cfgForDoctor = loadConfig();
    if (isThinClient(cfgForDoctor)) {
      const { runRemoteDoctor } = await import('./core/doctor-remote.ts');
      await runRemoteDoctor(cfgForDoctor!, args);
      return;
    }

    // Doctor runs filesystem checks first (no DB needed), then DB checks.
    // --fast skips DB checks entirely.
    const { runDoctor } = await import('./commands/doctor.ts');
    const { getDbUrlSource } = await import('./core/config.ts');
    if (args.includes('--fast')) {
      // Pass the DB URL source so doctor can tell "no config at all" from
      // "user chose --fast while config is present".
      await runDoctor(null, args, getDbUrlSource());
    } else {
      try {
        const eng = await connectEngine();
        await runDoctor(eng, args);
        await eng.disconnect();
      } catch {
        // DB unavailable — still run filesystem checks
        await runDoctor(null, args, getDbUrlSource());
      }
    }
    return;
  }

  if (command === 'smoke-test') {
    // Run smoke tests — no DB connection needed, the script handles its own checks
    const { execSync } = await import('child_process');
    const { resolve, dirname } = await import('path');
    const { fileURLToPath } = await import('url');
    const scriptDir = dirname(fileURLToPath(import.meta.url));
    const scriptPath = resolve(scriptDir, '..', 'scripts', 'smoke-test.sh');
    try {
      execSync(`bash "${scriptPath}"`, { stdio: 'inherit', env: { ...process.env } });
    } catch (e: any) {
      // Non-zero exit = some tests failed (exit code = failure count)
      process.exit(e.status ?? 1);
    }
    return;
  }

  if (command === 'dream') {
    // Dream mirrors doctor's pattern: filesystem phases run without a DB,
    // so an engine connection failure is non-fatal. runCycle honestly
    // reports DB phases as skipped when engine is null.
    const { runDream } = await import('./commands/dream.ts');
    let eng: BrainEngine | null = null;
    try {
      eng = await connectEngine();
    } catch {
      // DB unavailable — lint + backlinks still run against the brain dir.
    }
    try {
      await runDream(eng, args);
    } finally {
      if (eng) await eng.disconnect();
    }
    return;
  }

  // `eval cross-modal` is a pure API-call command — no DB, no brain. Bypass
  // connectEngine entirely so first-run users (no `gbrain init` yet) can
  // run the quality gate. Mirrors the dream/doctor no-DB pattern but
  // doesn't even attempt the connect (T3=A in plans/radiant-napping-lerdorf.md).
  // The handler self-configures the AI gateway from loadConfig() + process.env.
  if (command === 'eval' && args[0] === 'cross-modal') {
    const { runEvalCrossModal } = await import('./commands/eval-cross-modal.ts');
    process.exit(await runEvalCrossModal(args.slice(1)));
  }

  // v0.32 EXP-5 (codex review #10): `eval takes-quality replay <receipt>`
  // is the ONLY sub-subcommand that doesn't need a brain — it reads a
  // receipt JSON file from disk and re-renders it. Bypass connectEngine
  // here so users can replay a receipt on a machine without DATABASE_URL.
  // run/trend/regress need the brain and fall through to the regular
  // engine-required path below.
  if (command === 'eval' && args[0] === 'takes-quality' && args[1] === 'replay') {
    const { runReplayNoBrain } = await import('./commands/eval-takes-quality.ts');
    process.exit(await runReplayNoBrain(args.slice(2)));
  }

  // v0.28.8: longmemeval brings its own in-memory PGLite. Bypassing
  // connectEngine here keeps `gbrain eval longmemeval --help` and benchmark
  // runs working on machines that have no `~/.gbrain/config.json` configured.
  if (command === 'eval' && args[0] === 'longmemeval') {
    const { runEvalLongMemEval } = await import('./commands/eval-longmemeval.ts');
    await runEvalLongMemEval(args.slice(1));
    return;
  }

  // All remaining CLI-only commands need a DB connection
  const engine = await connectEngine();
  try {
    switch (command) {
      case 'import': {
        const { runImport } = await import('./commands/import.ts');
        await runImport(engine, args);
        break;
      }
      case 'export': {
        const { runExport } = await import('./commands/export.ts');
        await runExport(engine, args);
        break;
      }
      case 'files': {
        const { runFiles } = await import('./commands/files.ts');
        await runFiles(engine, args);
        break;
      }
      case 'embed': {
        const { runEmbed } = await import('./commands/embed.ts');
        await runEmbed(engine, args);
        break;
      }
      case 'serve': {
        const { runServe } = await import('./commands/serve.ts');
        await runServe(engine, args);
        return; // serve doesn't disconnect
      }
      case 'call': {
        const { runCall } = await import('./commands/call.ts');
        await runCall(engine, args);
        break;
      }
      case 'config': {
        const { runConfig } = await import('./commands/config.ts');
        await runConfig(engine, args);
        break;
      }
      // doctor is handled before connectEngine() above
      case 'migrate': {
        const { runMigrateEngine } = await import('./commands/migrate-engine.ts');
        await runMigrateEngine(engine, args);
        break;
      }
      case 'eval': {
        // v0.32 EXP-5: `eval takes-quality {run,trend,regress}` requires a
        // brain (samples takes from DB / reads runs table). `replay` was
        // already routed through the no-DB bypass above and never reaches
        // this case. Other `eval` subcommands (export/prune/replay-capture/
        // longmemeval/cross-modal) go to the generic dispatcher.
        if (args[0] === 'takes-quality') {
          const { runEvalTakesQuality } = await import('./commands/eval-takes-quality.ts');
          await runEvalTakesQuality(engine, args.slice(1));
          break;
        }
        const { runEvalCommand } = await import('./commands/eval.ts');
        await runEvalCommand(engine, args);
        break;
      }
      case 'jobs': {
        const { runJobs } = await import('./commands/jobs.ts');
        await runJobs(engine, args);
        break;
      }
      case 'agent': {
        const { runAgent } = await import('./commands/agent.ts');
        await runAgent(engine, args);
        break;
      }
      case 'book-mirror': {
        const { runBookMirrorCmd } = await import('./commands/book-mirror.ts');
        await runBookMirrorCmd(engine, args);
        break;
      }
      case 'sync': {
        const { runSync } = await import('./commands/sync.ts');
        await runSync(engine, args);
        break;
      }
      case 'extract': {
        const { runExtract } = await import('./commands/extract.ts');
        await runExtract(engine, args);
        break;
      }
      case 'features': {
        const { runFeatures } = await import('./commands/features.ts');
        await runFeatures(engine, args);
        break;
      }
      case 'autopilot': {
        const { runAutopilot } = await import('./commands/autopilot.ts');
        await runAutopilot(engine, args);
        return; // autopilot doesn't disconnect (long-running)
      }
      case 'graph-query': {
        const { runGraphQuery } = await import('./commands/graph-query.ts');
        await runGraphQuery(engine, args);
        break;
      }
      case 'reconcile-links': {
        // v0.20.0 Cathedral II Layer 8 D3: batch-recompute doc↔impl edges
        // for any markdown page that cites code files. Idempotent; safe to
        // re-run. Closes the v0.19.0 Layer 6 order-dependency bug where
        // guides imported before their code never got their edges written.
        const { runReconcileLinksCli } = await import('./commands/reconcile-links.ts');
        await runReconcileLinksCli(engine, args);
        break;
      }
      case 'orphans': {
        const { runOrphans } = await import('./commands/orphans.ts');
        await runOrphans(engine, args);
        break;
      }
      // v0.29 — Salience + Anomaly Detection
      case 'salience': {
        const { runSalience } = await import('./commands/salience.ts');
        await runSalience(engine, args);
        break;
      }
      case 'anomalies': {
        const { runAnomalies } = await import('./commands/anomalies.ts');
        await runAnomalies(engine, args);
        break;
      }
      case 'transcripts': {
        const { runTranscripts } = await import('./commands/transcripts.ts');
        await runTranscripts(engine, args);
        break;
      }
      case 'models': {
        const { runModels } = await import('./commands/models.ts');
        await runModels(engine, args);
        break;
      }
      case 'takes': {
        const { runTakes } = await import('./commands/takes.ts');
        await runTakes(engine, args);
        break;
      }
      case 'think': {
        const { runThinkCli } = await import('./commands/think.ts');
        await runThinkCli(engine, args);
        break;
      }
      case 'recall': {
        // v0.31: hot memory recall surface — `gbrain recall <entity>`,
        // `--since DUR`, `--session ID`, `--today`, `--grep TEXT`,
        // `--supersessions`, `--include-expired`, `--as-context`, `--json`.
        const { runRecall } = await import('./commands/recall.ts');
        await runRecall(engine, args);
        break;
      }
      case 'forget': {
        // v0.31: shorthand for expireFact. `gbrain forget <fact-id>`.
        const { runForget } = await import('./commands/recall.ts');
        await runForget(engine, args);
        break;
      }
      case 'notability-eval': {
        // v0.31.2: notability gate eval suite. Two subcommands:
        //   gbrain notability-eval mine    — sample paragraphs, write candidates
        //   gbrain notability-eval review  — TTY hand-confirm tiers
        const { runNotabilityEval } = await import('./commands/notability-eval.ts');
        const subcmd = args[0] || 'help';
        const flags: Record<string, string | boolean> = {};
        for (let i = 1; i < args.length; i++) {
          const a = args[i];
          if (a.startsWith('--')) {
            const key = a.slice(2);
            const next = args[i + 1];
            if (next && !next.startsWith('--')) {
              flags[key] = next;
              i++;
            } else {
              flags[key] = true;
            }
          }
        }
        // sync.repo_path resolution (matches dream phase pattern).
        let repoPath: string | undefined;
        try {
          repoPath = (flags.repo as string) || (await engine.getConfig('sync.repo_path')) || undefined;
        } catch { /* engine may not be connected for help */ }
        await runNotabilityEval({ cmd: subcmd, flags, engine, repoPath });
        break;
      }
      case 'sources': {
        const { runSources } = await import('./commands/sources.ts');
        await runSources(engine, args);
        break;
      }
      case 'pages': {
        // v0.26.5: page-level operator commands (purge-deleted escape hatch).
        const { runPages } = await import('./commands/pages.ts');
        await runPages(engine, args);
        break;
      }
      case 'storage': {
        const { runStorage } = await import('./commands/storage.ts');
        await runStorage(engine, args);
        break;
      }
      case 'code-def': {
        const { runCodeDef } = await import('./commands/code-def.ts');
        await runCodeDef(engine, args);
        break;
      }
      case 'code-refs': {
        const { runCodeRefs } = await import('./commands/code-refs.ts');
        await runCodeRefs(engine, args);
        break;
      }
      case 'reindex-code': {
        // v0.20.0 Cathedral II Layer 13 (E2): explicit code-page reindex
        // for users upgrading from v0.19.0. Cost-preview gated; TTY prompt
        // or ConfirmationRequired envelope for non-TTY/JSON callers.
        const { runReindexCodeCli } = await import('./commands/reindex-code.ts');
        await runReindexCodeCli(engine, args);
        break;
      }
      case 'reindex-frontmatter': {
        // v0.29.1: recovery / explicit-rebuild path for pages.effective_date.
        // Mirror of reindex-code shape. Wraps the shared library function in
        // src/core/backfill-effective-date.ts (same code path the v0.29.1
        // migration orchestrator uses). The orchestrator runs once on
        // upgrade; this command is for after-the-fact frontmatter edits.
        //
        // v0.30.1: still works; canonical entrypoint is now `gbrain backfill
        // effective_date`. This command stays as a thin alias for back-compat.
        const { reindexFrontmatterCli } = await import('./commands/reindex-frontmatter.ts');
        await reindexFrontmatterCli(args);
        return; // reindexFrontmatterCli handles its own engine lifecycle
      }
      case 'backfill': {
        // v0.30.1: first-class generic backfill command. Subcommand dispatch
        // is inside runBackfillCommand (kind | list | --help).
        const { runBackfillCommand } = await import('./commands/backfill.ts');
        await runBackfillCommand(args);
        return;
      }
      case 'code-callers': {
        // v0.20.0 Cathedral II Layer 10 (C4): "who calls <symbol>?"
        const { runCodeCallers } = await import('./commands/code-callers.ts');
        await runCodeCallers(engine, args);
        break;
      }
      case 'code-callees': {
        // v0.20.0 Cathedral II Layer 10 (C5): "what does <symbol> call?"
        const { runCodeCallees } = await import('./commands/code-callees.ts');
        await runCodeCallees(engine, args);
        break;
      }
      case 'repos': {
        // v0.19.0: `gbrain repos ...` is an alias into the v0.18.0 sources
        // subsystem. The repos abstraction (Garry's OpenClaw baseline) was
        // redundant with sources and carried per-user config state that
        // couldn't participate in federation / RLS / multi-tenancy. We
        // keep the alias so scripts like `gbrain repos add .` keep
        // working, with a nudge toward the canonical command.
        console.error('[gbrain] Note: "repos" is an alias for "sources" as of v0.19.0. Prefer `gbrain sources <subcommand>`.');
        const { runSources } = await import('./commands/sources.ts');
        await runSources(engine, args);
        break;
      }
    }
  } finally {
    if (command !== 'serve') await engine.disconnect();
  }
}

// Build the AIGatewayConfig payload from a GBrainConfig. File-local; not
// exported. Both configureGateway sites in connectEngine() pass through this
// helper so adding a new field touches one place. Adding a field to one site
// but not the other previously required remembering to mirror the change;
// the helper makes that structural.
function buildGatewayConfig(c: GBrainConfig): AIGatewayConfig {
  return {
    embedding_model: c.embedding_model,
    embedding_dimensions: c.embedding_dimensions,
    embedding_multimodal_model: c.embedding_multimodal_model,
    expansion_model: c.expansion_model,
    chat_model: c.chat_model,
    chat_fallback_chain: c.chat_fallback_chain,
    base_urls: c.provider_base_urls,
    env: { ...process.env },
  };
}

async function connectEngine(opts?: { probeOnly?: boolean }): Promise<BrainEngine> {
  const config = loadConfig();
  if (!config) {
    console.error('No brain configured. Run: gbrain init');
    process.exit(1);
  }

  // Configure the AI gateway BEFORE engine connect — initSchema needs embedding dims.
  // Env is read once here; the gateway never reads process.env at call time (Codex C3).
  const { configureGateway } = await import('./core/ai/gateway.ts');
  configureGateway(buildGatewayConfig(config));

  const { createEngine } = await import('./core/engine-factory.ts');
  const engine = await createEngine(toEngineConfig(config));
  const noRetry = process.argv.includes('--no-retry-connect') ||
                  process.env.GBRAIN_NO_RETRY_CONNECT === '1';
  const { connectWithRetry } = await import('./core/db.ts');
  await connectWithRetry(engine, toEngineConfig(config), { noRetry });

  // v0.30.1 (Codex X1 / C2): probeOnly skips both hasPendingMigrations() probe
  // AND initSchema(). Used by `get_health` MCP op + `gbrain upgrade --status`
  // + doctor's migration_wedge check — these surfaces report wedge state and
  // must NEVER themselves start or block on migrations.
  if (opts?.probeOnly === true) {
    return engine;
  }

  // Auto-apply pending schema migrations on connect (#651). Cheap probe
  // first so already-migrated brains don't pay the bootstrap-probe +
  // SCHEMA_SQL replay + ledger-check cost on every short-lived CLI call.
  // This is the conditional version of #652 (oyi77's investigation):
  // same correctness, no perf regression on the hot path.
  try {
    const { hasPendingMigrations } = await import('./core/migrate.ts');
    if (await hasPendingMigrations(engine)) {
      await engine.initSchema();
    }
  } catch (err) {
    // Non-fatal: if probe or initSchema fails, surface a hint and continue
    // with the connected engine. Subsequent operations will surface the
    // real schema error in context.
    console.warn(`  Schema probe/migrate failed: ${(err as Error).message}`);
    console.warn('  Try: gbrain init --migrate-only');
  }

  // v0.27.1 (F3 fix): re-merge DB-plane config now that the engine is up.
  // Flags like `embedding_multimodal` are user-mutable via `gbrain config set`
  // (DB plane) and need to flow into the gateway after connect. Schema-sizing
  // fields (embedding_dimensions etc.) keep their pre-connect file/env values
  // — those drove initSchema and the merged config respects file/env first.
  try {
    const merged = await loadConfigWithEngine(engine, config);
    if (merged) {
      // Stash gate flags on process.env for downstream readers (import-file.ts
      // dispatches on GBRAIN_EMBEDDING_MULTIMODAL, OCR consumer reads
      // GBRAIN_EMBEDDING_IMAGE_OCR_*). The gateway itself doesn't read these
      // flags; this preserves the contract without changing the gateway shape.
      if (merged.embedding_multimodal !== undefined) {
        process.env.GBRAIN_EMBEDDING_MULTIMODAL = String(merged.embedding_multimodal);
      }
      if (merged.embedding_image_ocr !== undefined) {
        process.env.GBRAIN_EMBEDDING_IMAGE_OCR = String(merged.embedding_image_ocr);
      }
      if (merged.embedding_image_ocr_model !== undefined) {
        process.env.GBRAIN_EMBEDDING_IMAGE_OCR_MODEL = merged.embedding_image_ocr_model;
      }
      // Always re-configure with merged values when DB merge succeeded. The
      // trigger used to be field-name-gated (only when embedding_multimodal_model
      // was set); that coupled the gate to the field set and would silently
      // miss future DB-mutable gateway fields. One extra cache+shrinkState
      // clear per startup is microseconds, no hot path.
      configureGateway(buildGatewayConfig(merged));
    }
    // v0.31.12: re-resolve gateway defaults through resolveModel so
    // `models.tier.*` and `models.default` overrides apply to expansion +
    // chat. Per Codex F3 — configureGateway is sync; this is the async
    // re-stamp seam after engine.connect() makes config reads possible.
    const { reconfigureGatewayWithEngine } = await import('./core/ai/gateway.ts');
    await reconfigureGatewayWithEngine(engine);
  } catch {
    // Non-fatal. Pre-v39 brains may not have a usable config table yet.
  }

  return engine;
}

function printOpHelp(op: Operation) {
  const positional = (op.cliHints?.positional || []).map(p => `<${p}>`).join(' ');
  const name = op.cliHints?.name || op.name;
  console.log(`Usage: gbrain ${name} ${positional} [options]\n`);
  console.log(op.description + '\n');
  const entries = Object.entries(op.params);
  if (entries.length > 0) {
    console.log('Options:');
    for (const [key, def] of entries) {
      const isPos = op.cliHints?.positional?.includes(key);
      const req = def.required ? ' (required)' : '';
      const prefix = isPos ? `  <${key}>` : `  --${key.replace(/_/g, '-')}`;
      console.log(`${prefix.padEnd(28)} ${def.description || ''}${req}`);
    }
  }
}

function printHelp() {
  // Gather shared operations grouped by category
  const cliNames = Array.from(cliOps.entries())
    .map(([name, op]) => ({ name, desc: op.description }));

  console.log(`gbrain ${VERSION} -- personal knowledge brain

USAGE
  gbrain <command> [options]

SETUP
  init [--pglite|--supabase|--url]   Create brain (PGLite default, no server)
  migrate --to <supabase|pglite>     Transfer brain between engines
  upgrade                            Self-update
  check-update [--json]              Check for new versions
  doctor [--json] [--fast]            Health check (resolver, skills, pgvector, RLS, embeddings)
  integrations [subcommand]          Manage integration recipes (senses + reflexes)

PAGES
  get <slug>                         Read a page
  put <slug> [< file.md]             Write/update a page
  delete <slug>                      Delete a page
  list [--type T] [--tag T] [-n N]   List pages

SEARCH
  search <query>                     Keyword search (tsvector)
  query <question> [--no-expand]     Hybrid search (RRF + expansion)
  ask <question> [--no-expand]       Alias for query

IMPORT/EXPORT
  import <dir> [--no-embed]          Import markdown directory
  sync [--repo <path>] [flags]       Git-to-brain incremental sync
  sync --watch [--interval N]        Continuous sync (loops until stopped)
  sync --install-cron                Install persistent sync daemon
  export [--dir ./out/]              Export to markdown
  export --restore-only [--repo <p>] Restore missing supabase-only files
        [--type T] [--slug-prefix S] With optional filters

FILES
  files list [slug]                  List stored files
  files upload <file> --page <slug>  Upload file to storage
  files upload-raw <file> --page <s> Smart upload (size routing + .redirect.yaml)
  files signed-url <path>            Generate signed URL (1-hour)
  files sync <dir>                   Bulk upload directory
  files verify                       Verify all uploads

EMBEDDINGS
  embed [<slug>|--all|--stale]       Generate/refresh embeddings

LINKS
  link <from> <to> [--type T]        Create typed link
  unlink <from> <to>                 Remove link
  backlinks <slug>                   Incoming links
  graph <slug> [--depth N]           Traverse link graph (returns nodes)
  graph-query <slug> [--type T]      Edge-based traversal with type/direction filters
        [--depth N] [--direction in|out|both]

TAGS
  tags <slug>                        List tags
  tag <slug> <tag>                   Add tag
  untag <slug> <tag>                 Remove tag

TIMELINE
  timeline [<slug>]                  View timeline
  timeline-add <slug> <date> <text>  Add timeline entry

TOOLS
  extract <links|timeline|all>       Extract links/timeline (idempotent)
        [--source fs|db]             fs (default) walks .md files; db iterates engine pages
        [--dir <brain>]              brain dir for fs source
        [--type T] [--since DATE]    filters (db source)
        [--dry-run] [--json]
  publish <page.md> [--password]     Shareable HTML (strips private data, optional AES-256)
  check-backlinks <check|fix> [dir]  Find/fix missing back-links across brain
  lint <dir|file> [--fix]            Catch LLM artifacts, placeholder dates, bad frontmatter
  orphans [--json] [--count]         Find pages with no inbound wikilinks
  salience [--days N] [--kind P]     v0.29: pages ranked by emotional + activity salience
  anomalies [--since D] [--sigma N]  v0.29: cohort-based statistical anomalies (tag, type)
  transcripts recent [--days N]      v0.29: recent raw .txt transcripts (local-only)
  dream [--dry-run] [--json]         Run the overnight maintenance cycle once (cron-friendly).
                                     See also: autopilot --install (continuous daemon).
  check-resolvable [--json] [--fix]  Validate skill tree (reachability/MECE/DRY)
  report --type <name> --content ... Save timestamped report to brain/reports/

SOURCES (multi-repo / multi-brain)
  sources list                       Show registered sources
  sources add <id> --path <p>        Register a source (id = short name, e.g. 'wiki')
  sources remove <id>                Remove a source + its pages
  sync --all                         Sync all sources with a local_path
  sync --source <id>                 Sync one specific source
  repos ...                          DEPRECATED alias for 'sources' (v0.19.0)

CODE INDEXING (v0.19.0 / v0.20.0 Cathedral II)
  code-def <symbol> [--lang l]       Find the definition of a symbol across code pages
  code-refs <symbol> [--lang l]      Find all references to a symbol (JSON-first)
  code-callers <symbol>              Who calls this symbol? (v0.20.0 A1)
  code-callees <symbol>              What does this symbol call? (v0.20.0 A1)
  query <q> --lang <l>               Filter hybrid search to one language (v0.20.0)
  query <q> --symbol-kind <k>        Filter to symbol type (function|class|method|...) (v0.20.0)
  reconcile-links [--dry-run]        Batch-recompute doc↔impl edges (v0.20.0)
  reindex-code [--source id] [--yes] Explicit code-page reindex (v0.20.0)
  sync --strategy code               Sync code files into the brain

JOBS (Minions)
  jobs submit <name> [--params JSON]  Submit background job [--follow] [--dry-run]
  jobs list [--status S] [--limit N]  List jobs
  jobs get <id>                       Job details + history
  jobs cancel <id>                    Cancel job
  jobs retry <id>                     Re-queue failed/dead job
  jobs prune [--older-than 30d]       Clean old jobs
  jobs stats                          Job health dashboard
  jobs work [--queue Q]               Start worker daemon (Postgres only)

ADMIN
  stats                              Brain statistics
  health                             Brain health dashboard
  history <slug>                     Page version history
  revert <slug> <version-id>         Revert to version
  features [--json] [--auto-fix]     Scan usage + recommend unused features
  autopilot [--repo] [--interval N]  Self-maintaining brain daemon
  config [show|get|set] <key> [val]  Brain config
  storage status [--repo <path>]     Storage tier status and health
        [--json]                     (git-tracked vs supabase-only)
  serve                              MCP server (stdio)
  serve --http [--port N]            HTTP MCP server with OAuth 2.1
    --token-ttl N                    Access token TTL in seconds (default: 3600)
    --enable-dcr                     Enable Dynamic Client Registration
    --public-url URL                 Public issuer URL (required behind proxy/tunnel)
  call <tool> '<json>'               Raw tool invocation
  version                            Version info
  --tools-json                       Tool discovery (JSON)

Run gbrain <command> --help for command-specific help.
`);
}

main().catch(e => {
  console.error(e.message || e);
  process.exit(1);
});
