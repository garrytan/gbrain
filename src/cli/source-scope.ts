/**
 * #5827: CLI source-scope checks shared by the local and thin-client op
 * paths in src/cli.ts — the `--source` vs `--source-id`/`--all-sources`
 * conflict, the mixed-version check that fails when a brain host ignored a
 * scope param, and the ambient-narrowing hint for empty thin-client reads.
 */
import type { Operation } from '../core/operations.ts';
import { ignoredRemoteParams } from '../core/mcp-client.ts';

/** Where an ambient (not flag-supplied) thin-client source scope came from. */
export type AmbientSourceBinding = { sourceId: string; via: 'GBRAIN_SOURCE' | '.gbrain-source' };

/**
 * `--source` together with `--source-id` / `--all-sources` names two scopes;
 * refuse instead of letting one silently win (local and thin-client paths).
 * Ops that own a `source` param are exempt: their --source is not scope.
 */
export function assertSingleSourceScopeFlag(op: Operation, params: Record<string, unknown>): void {
  if ('source' in op.params) return;
  const explicit = typeof params.source === 'string' && params.source.length > 0;
  if (explicit && (params.source_id !== undefined || params.all_sources === true)) {
    throw new Error('Pass either --source or --source-id/--all-sources, not both.');
  }
}

/** Per-call scope params a thin client must never see silently dropped. */
const SCOPE_WIRE_PARAMS = ['source_id', 'all_sources'];

/**
 * #5827 mixed versions: an older brain host that does not declare a scope
 * param the client sent (from a flag, GBRAIN_SOURCE or .gbrain-source)
 * answers unscoped with an unknown-parameter warning; fail instead of
 * printing that result. Other ignored params this client's op declares are
 * surfaced on stderr (CLI-local keys such as `json` are not). Hosts that
 * predate unknown-parameter warnings cannot be detected here.
 */
export function checkHostHonoredParams(op: Operation, params: Record<string, unknown>, raw: unknown): void {
  const ignored = ignoredRemoteParams(raw);
  const scope = ignored.filter((name) => SCOPE_WIRE_PARAMS.includes(name) && params[name] !== undefined);
  if (scope.length > 0) {
    throw new Error(
      `the brain host does not support ${scope.join(', ')} on ${op.name}; upgrade the host (gbrain upgrade on the brain host)`,
    );
  }
  for (const name of ignored) {
    if (!(name in op.params)) continue;
    process.stderr.write(`[gbrain] warning: the brain host ignored parameter "${name}" on ${op.name}; upgrade the host to use it.\n`);
  }
}

/**
 * #5827: a thin-client read narrowed by an ambient binding that came back
 * empty says which binding scoped it and how to widen; it names only the
 * caller's own binding, never another source.
 */
export function hintAmbientNarrowing(op: Operation, params: Record<string, unknown>, result: unknown, ambient: AmbientSourceBinding | null): void {
  if (!ambient || params.json === true || !('all_sources' in op.params)) return;
  if (!Array.isArray(result) || result.length > 0) return;
  const cliName = op.cliHints?.name || op.name;
  const positional = (op.cliHints?.positional ?? []).map((key) => String(params[key] ?? `<${key}>`)).join(' ');
  process.stderr.write(
    `[gbrain] ${cliName}: no results within source ${ambient.sourceId} (set by ${ambient.via}). ` +
    `To read every source you can see: gbrain ${cliName}${positional ? ` ${positional}` : ''} --all-sources\n`,
  );
}
