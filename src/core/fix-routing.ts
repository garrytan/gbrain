/**
 * A1 explicit routing for every CLI fix (docs/designs/AGENT_OPERATOR_WAVE.md,
 * DX-7): a rendered `fix.argv` names the brain and source the failing call
 * acted on, so the agent can run it later from another directory or under a
 * different GBRAIN_BRAIN_ID / GBRAIN_SOURCE / .gbrain-mount / .gbrain-source
 * and still act on the intended brain.
 *
 * The pin is applied once, at render time (`renderAction`), to every gbrain
 * argv in the action (`argv`, `preview_argv`, `verify.argv`, `then`):
 *
 * - `--brain <id>` for commands that route through the brain axis: every
 *   shared op, and CLI-only commands that open their engine through the
 *   connect terminator or read the global brain option.
 * - `--source <id>` for commands whose target source resolves through the
 *   ambient chain: every shared op (makeContext's resolver; ops that own a
 *   `source` param are excluded) and CLI-only commands whose command-table
 *   record declares `routes_source`.
 *
 * The CLI-only half is generated from the command table and each command's
 * code (CLI_ROUTING_FLAGS, `bun run build:flag-registry`), so this module never
 * imports the table (its lazy loaders would pull every command into any bundle
 * that renders a fix); the op half is registered by src/core/operations.ts.
 *
 * Flags already present are kept as written; the pin goes before a bare `--`
 * so it can never land in the positional lane. Over HTTP only the source id is
 * pinned (a mount id is host topology; a thin client refuses `--brain`).
 */
import { CLI_FLAG_REGISTRY, CLI_ROUTING_FLAGS } from './cli-flag-registry.generated.ts';
import { ALL_SOURCES, SOURCE_ID_RE } from './source-id.ts';

export interface FixRouting { brain?: string; source?: string }

const BRAIN_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const pinnableSource = (s: string) => SOURCE_ID_RE.test(s) || s === ALL_SOURCES;
const SOURCE_SELECTORS = ['--source', '--source-id', '--all-sources', '--sources'];

const opCommands = new Map<string, { ownsSource: boolean; scopesSourceId: boolean }>();

/**
 * Shared-op CLI names (primary + aliases, hidden excluded): every op routes the brain, and `--source`
 * unless the op owns a `source` param (provenance, not the target source). Called by src/core/operations.ts.
 */
export function registerOpRoutes(ops: Iterable<{ params: Record<string, unknown>; cliHints?: { name?: string; aliases?: readonly string[]; hidden?: boolean } }>): void {
  for (const op of ops) {
    if (!op.cliHints?.name || op.cliHints.hidden) continue;
    for (const name of [op.cliHints.name, ...(op.cliHints.aliases ?? [])]) {
      opCommands.set(name, { ownsSource: 'source' in op.params, scopesSourceId: 'source_id' in op.params });
    }
  }
}

/**
 * The routing flags a command accepts AND routes through (see the module comment).
 * `remote` (an HTTP render): a mount id is host topology, so `--brain` is never
 * pinned there, and `--source` only where a thin client can send it (an op with a
 * `source_id` scope, or a CLI command the brain host's operator runs).
 */
export function routingFlagsFor(command: string, opts: { remote?: boolean } = {}): { brain: boolean; source: boolean } {
  const accepted = CLI_FLAG_REGISTRY[command];
  if (accepted) {
    const routed = CLI_ROUTING_FLAGS[command] ?? [];
    return { brain: !opts.remote && accepted.includes('--brain') && routed.includes('--brain'), source: accepted.includes('--source') && routed.includes('--source') };
  }
  const op = opCommands.get(command);
  if (!op) return { brain: false, source: false };
  return { brain: !opts.remote, source: !op.ownsSource && (!opts.remote || op.scopesSourceId) };
}

const hasFlag = (head: readonly string[], flag: string) => head.some(a => a === flag || a.startsWith(`${flag}=`));

/** Append the missing routing flags to one gbrain argv (before a bare `--`). Non-gbrain argv pass through. */
export function pinRouting(argv: readonly string[], routing: FixRouting | undefined, opts: { remote?: boolean } = {}): string[] {
  if (!routing || argv[0] !== 'gbrain' || argv.length < 2) return [...argv];
  const flags = routingFlagsFor(argv[1]!, opts);
  const end = argv.indexOf('--');
  const head = end === -1 ? argv : argv.slice(0, end);
  const add: string[] = [];
  if (flags.brain && routing.brain && BRAIN_ID_RE.test(routing.brain) && !hasFlag(head, '--brain')) add.push('--brain', routing.brain);
  if (flags.source && routing.source && pinnableSource(routing.source) && !SOURCE_SELECTORS.some(f => hasFlag(head, f))) {
    add.push('--source', routing.source);
  }
  if (add.length === 0) return [...argv];
  return end === -1 ? [...argv, ...add] : [...argv.slice(0, end), ...add, ...argv.slice(end)];
}

// ── the CLI process's resolved routing ─────────────────────────────────────

let cliProvider: (() => FixRouting | undefined) | null = null;
let resolvedSource: string | undefined;
let recording = false;

/**
 * Installed by src/cli.ts once global flags are parsed: the default routing
 * for every CLI-surface render in this process (cliRenderContext). Also turns
 * on source recording, so the first source this invocation resolves through
 * the ambient chain becomes the pinned source.
 */
export function installCliRouting(provider: () => FixRouting | undefined): void {
  cliProvider = provider;
  recording = true;
}

/** Called by the source resolver: the first source an invocation resolves is the one its fixes pin. */
export function noteResolvedSource(sourceId: string): void {
  if (recording && resolvedSource === undefined && pinnableSource(sourceId)) resolvedSource = sourceId;
}

export function recordedSource(): string | undefined {
  return resolvedSource;
}

export function cliRouting(): FixRouting | undefined {
  try { return cliProvider?.(); } catch { return undefined; }
}

/** Test seam: drop the provider and the recorded source (registered command tables stay). */
export function __resetCliRoutingForTests(): void {
  cliProvider = null;
  resolvedSource = undefined;
  recording = false;
}
