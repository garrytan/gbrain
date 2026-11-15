/**
 * `gbrain serve` on a thin client: which argument lists start the stdio
 * bridge (bare, or with gbrain's own registration flags), and the refusal for
 * every other form. Engine-free and SDK-free, so the CLI routing step can load
 * it before deciding. A refused invocation's fix keeps its flags (an
 * allowlisted name, and its value only when it has a safe shape), so
 * `serve --http --port 3131` is never "fixed" into a bare `serve`, which on
 * a thin client is the bridge.
 */
import { OperationError, opError } from '../core/ops/contract.ts';
import { isMcpSurface, type McpSurface } from './surface.ts';

export type BridgeServeArgs =
  | { bridge: true; surface: McpSurface | null; advertise: McpSurface | null; sourceGuard: boolean }
  | { bridge: false; refused: string[] };

const SURFACE_ORDER: readonly McpSurface[] = ['verbs', 'starter', 'full'];
/** Serve flags that take a value, with the shape a value must have to be kept in a fix (null: never kept). */
const VALUE_FLAGS: Record<string, RegExp | null> = {
  '--surface': /^(verbs|starter|full)$/, '--advertise': /^(verbs|starter|full)$/, '--access': /^(full|read-only)$/,
  '--port': /^\d{1,5}$/, '--bind': /^[A-Za-z0-9.:[\]-]{1,64}$/, '--token-ttl': /^\d{1,9}$/, '--stdio-idle-timeout': /^\d{1,9}$/,
  '--stdio-member': /^[a-z0-9][a-z0-9-]{0,63}$/, '--public-url': /^https?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?\/?$/, '--takes-holders': null, '--scopes': null,
};
const BOOLEAN_FLAGS = new Set(['--http', '--source-guard', '--fail-fast', '--cli-socket', '--enable-dcr', '--enable-dcr-insecure', '--log-full-params', '--suppress-bootstrap-token', '--print-admin-token']);
const HTTP_FLAGS = new Set(['--http', '--port', '--bind', '--public-url', '--token-ttl', '--enable-dcr', '--enable-dcr-insecure', '--log-full-params', '--suppress-bootstrap-token', '--print-admin-token', '--scopes']);
const BRIDGE_NOTE = 'Bare `gbrain serve` on this thin client is the stdio bridge to that brain (it accepts --surface, --advertise and --source-guard).';

const flagName = (a: string): string => (a.startsWith('--') && a.includes('=') ? a.slice(0, a.indexOf('=')) : a);

function badValue(flag: string, raw: string | undefined): OperationError {
  const got = raw === undefined || raw.startsWith('--') ? 'no value' : `"${raw}"`;
  return opError('invalid_params', `gbrain serve ${flag} takes verbs, starter or full (got ${got}).`,
    `Edit the ${flag} value in this harness entry's args to verbs, starter or full, then start a new session.`, {
      fix: { argv: ['gbrain', 'serve', flag, 'starter'], consent: [], actor: 'user', requires_exclusive: false,
        why: `On a thin client ${flag} narrows the stdio bridge's tool list; its value is one of verbs, starter or full.` },
    });
}

/**
 * Read a thin-client serve argument list. Bare, or only `--surface <s>`,
 * `--advertise <s>` (space or `=` form) and `--source-guard`: the bridge.
 * Any other argument: refused, with the flags it named. A bad surface value
 * throws `invalid_params` (it is not a host-only form, so "run it on the
 * brain host" would mislead). A repeated flag takes the narrowest value, as
 * local serve does.
 */
export function parseBridgeServeArgs(args: string[]): BridgeServeArgs {
  const narrowing: { '--surface': McpSurface | null; '--advertise': McpSurface | null } = { '--surface': null, '--advertise': null };
  let sourceGuard = false;
  const refused: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const flag = flagName(a);
    if (flag === '--surface' || flag === '--advertise') {
      const raw = a !== flag ? a.slice(flag.length + 1) : args[++i];
      if (raw === undefined || !isMcpSurface(raw)) throw badValue(flag, raw);
      const prev = narrowing[flag];
      narrowing[flag] = prev && SURFACE_ORDER.indexOf(prev) < SURFACE_ORDER.indexOf(raw) ? prev : raw;
      continue;
    }
    if (a === '--source-guard') { sourceGuard = true; continue; }
    refused.push(a);
    if (flag in VALUE_FLAGS && a === flag && args[i + 1] !== undefined && !args[i + 1].startsWith('--')) refused.push(args[++i]);
  }
  return refused.length ? { bridge: false, refused } : { bridge: true, surface: narrowing['--surface'], advertise: narrowing['--advertise'], sourceGuard };
}

/** The refused flags as fix argv: known names only, values only when their shape is safe. */
function keptFlags(refused: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < refused.length; i++) {
    const a = refused[i];
    const flag = flagName(a);
    if (BOOLEAN_FLAGS.has(flag)) { out.push(flag); continue; }
    if (!(flag in VALUE_FLAGS)) continue;
    const value = a !== flag ? a.slice(flag.length + 1) : refused[i + 1] !== undefined && !refused[i + 1].startsWith('--') ? refused[++i] : undefined;
    out.push(flag, value !== undefined && VALUE_FLAGS[flag]?.test(value) ? value : '<value>');
  }
  return out;
}

/** The refusal for a serve form a thin client cannot run: what it asked for decides the message and the fix. */
export function serveThinClientRefusal(refused: string[], mcpUrl: string): OperationError {
  const kept = keptFlags(refused);
  const names = new Set(kept.filter(a => a.startsWith('--')));
  const shown = ['gbrain', 'serve', ...kept].join(' ');
  if ([...names].some(n => HTTP_FLAGS.has(n))) {
    return opError('requires_local_engine', `\`${shown}\` is not routable (thin-client of ${mcpUrl}): it serves a brain over HTTP, so it runs on the brain host.`,
      `Run it on the brain host. ${BRIDGE_NOTE}`, {
        why: 'HTTP serving hosts the brain database, which lives on the brain host; a thin client has none to serve.',
        fix: { argv: ['gbrain', 'serve', ...kept], consent: [], actor: 'host_admin', requires_exclusive: false, why: 'HTTP serving runs where the brain database lives.' },
      });
  }
  if (names.has('--access')) {
    return opError('requires_local_engine', `\`${shown}\` is not routable (thin-client of ${mcpUrl}): it asks this bridge to enforce a restriction, and a thin client cannot enforce one locally.`,
      `Give this harness its own narrow client instead: on the brain host, register an OAuth client with only the scopes it needs (read, for a read-only harness), then run gbrain init --mcp-only with it under a separate GBRAIN_HOME and point the harness entry there (docs/guides/hosted-harness-access.md). ${BRIDGE_NOTE}`, {
        why: 'The brain host enforces what each client may do; a filter in this process would be advice, not a boundary.',
        fix: { argv: ['gbrain', 'auth', 'register-client', '<name>', '--grant-types', 'client_credentials', '--scopes', 'read'], consent: [], actor: 'host_admin', requires_exclusive: false,
          why: 'A read-only client row on the brain host is the restriction; this machine then uses it from its own GBRAIN_HOME.',
          inputs: [{ name: 'name', how: 'A name for the harness this client is for.' }] },
      });
  }
  return opError('requires_local_engine', `\`${shown}\` is not routable (thin-client of ${mcpUrl}); run it on the brain host.`,
    `Run it on the brain host. ${BRIDGE_NOTE}`, {
      why: 'These serve flags act on a local brain database, and a thin client has none.',
      fix: { argv: ['gbrain', 'serve', ...kept], consent: [], actor: 'host_admin', requires_exclusive: false, why: 'The brain database lives on the brain host; this machine only forwards MCP calls.' },
    });
}
