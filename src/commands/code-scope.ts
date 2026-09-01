/**
 * Shared `--source` / `--all-sources` resolution for the four code-* CLI
 * commands (code-def, code-refs, code-callers, code-callees).
 *
 * Extracted from code-callers.ts / code-callees.ts, which carried identical
 * copies of this block. code-def and code-refs were brain-wide and had no copy
 * at all; giving all four one resolver is what keeps them from drifting again.
 *
 * Exits the process with code 2 on a usage-level failure (ambiguous source, bad
 * pin), matching the pre-extraction behavior of both callers.
 */

import type { BrainEngine } from '../core/engine.ts';
import { errorFor } from '../core/errors.ts';
import { resolveScopedSourceOrThrow, SourceResolutionError } from '../core/sources-ops.ts';
import { formatSoleNonDefaultNudge, isResolverUserError } from '../core/source-resolver.ts';
import { codeChunksExist } from '../core/code-graph-readiness.ts';

// A bad/invalid `.gbrain-source` pin or GBRAIN_SOURCE value surfaces from
// `resolveSourceWithTier`'s `assertSourceExists` as a resolver user error;
// the shared `isResolverUserError` (source-resolver.ts, next to the messages
// it matches) turns it into the exit-2 `invalid_source_pin` envelope below
// instead of an uncaught stack.

/**
 * Flags that consume the NEXT argv entry as their value. A positional scan that
 * ignores them treats the value as the symbol: `code-def --source srcb sym`
 * looked up the symbol "srcb". Pre-existing for --lang/--limit; adding --source
 * to code-def/code-refs multiplied the ways to hit it.
 */
const VALUE_FLAGS = new Set(['--source', '--limit', '--lang']);

/** Positional args, skipping both value-taking flags and their values.
 * The inline `name=value` flag spelling is one token starting with a double
 * dash, so the generic branch skips it without consuming a following token. */
export function positionalArgs(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      if (VALUE_FLAGS.has(a)) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

/**
 * Value-flag reader shared by the four code-* commands: accepts BOTH the
 * two-token `name value` and the inline `name=value` flag spellings. The
 * per-command exact-token copies silently ignored the inline spelling of
 * the source flag, answering from the wrong scope for a user who explicitly
 * named a source (review fix on the #4749 adoption).
 * NOTE: no double-dash flag literals in this comment — the flag-registry
 * generator harvests them from every scanned module (see source-resolver.ts).
 */
export function parseFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i >= 0 && i + 1 < args.length) return args[i + 1];
  const inline = args.find((a) => a.startsWith(`${name}=`));
  return inline ? inline.slice(name.length + 1) : undefined;
}

/**
 * Source-scope SQL predicate shared by the code-def / code-refs lookups (and
 * code-def's filtered-types probe): appends the source id to `params` and
 * returns the `AND p.source_id = $N` fragment, or '' when spanning every
 * source. Numbered off `params.length` so it composes with any number of
 * optional predicates before it (a fixed `$2` broke the moment --lang joined).
 */
export function pushSourcePredicate(
  params: unknown[],
  opts: { sourceId?: string; allSources?: boolean },
): string {
  if (opts.allSources || !opts.sourceId) return '';
  params.push(opts.sourceId);
  return `AND p.source_id = $${params.length}`;
}

export interface CodeScope {
  allSources: boolean;
  sourceId?: string;
  /** `'all'` when spanning sources, `'single'` when one source was resolved. */
  scope: 'all' | 'single';
  /** null when spanning sources — the value the JSON envelope reports. */
  envelopeSourceId: string | null;
}

/**
 * Resolve the source scope for a code-* CLI invocation.
 *
 * When neither `--source` nor `--all-sources` is set, routes through the full
 * source-resolution chain (`.gbrain-source` pin, env, local_path,
 * brain_default, sole_non_default); only a no-signal multi-source brain still
 * errors as `multiple_sources_ambiguous`.
 */
export async function resolveCliCodeScope(
  engine: BrainEngine,
  opts: { sourceId?: string; allSources: boolean; jsonMode: boolean; command: string },
): Promise<CodeScope> {
  const { allSources, jsonMode, command } = opts;
  let sourceId = opts.sourceId;

  // Contradictory flags are a usage error, not a silent winner. Resolving them
  // by precedence hides a typo'd invocation behind plausible-looking output.
  if (allSources && sourceId) {
    exitUsage(jsonMode, errorFor({
      class: 'UsageError',
      code: 'conflicting_source_scope',
      message: `${command}: --source and --all-sources are mutually exclusive`,
      hint: 'pass --source <id> to scope to one source, or --all-sources to span every source',
    }).envelope, `${command}: --source and --all-sources are mutually exclusive`);
  }

  // An explicit --source skips the resolution chain, so it also skips that
  // chain's existence check. Unvalidated, a typo lands in the SQL predicate and
  // returns an empty result that reads as "no such symbol".
  if (sourceId) {
    if (sourceId.startsWith('--')) {
      exitUsage(jsonMode, errorFor({
        class: 'UsageError',
        code: 'missing_source_value',
        message: `${command}: --source expects a source id, got '${sourceId}'`,
        hint: 'pass --source <id>, or drop it to use the .gbrain-source pin',
      }).envelope, `${command}: --source expects a source id, got '${sourceId}'`);
    }
    if (!(await sourceExists(engine, sourceId))) {
      exitUsage(jsonMode, errorFor({
        class: 'UsageError',
        code: 'unknown_source',
        message: `Source "${sourceId}" not found or is archived.`,
        hint: 'run `gbrain sources list` to see registered sources',
      }).envelope, `Source "${sourceId}" not found or is archived.`);
    }
  }

  if (!allSources && !sourceId) {
    try {
      const resolved = await resolveScopedSourceOrThrow(engine);
      sourceId = resolved.source_id;
      // Nudge only when we auto-routed to the sole non-default source (the one
      // tier with no explicit user signal). Matches sync/import behavior.
      if (resolved.tier === 'sole_non_default') {
        const nudge = formatSoleNonDefaultNudge(resolved.source_id);
        if (nudge) console.error(nudge);
      }
    } catch (e: unknown) {
      if (e instanceof SourceResolutionError) {
        exitUsage(jsonMode, errorFor({
          class: 'UsageError',
          code: e.code,
          message: e.message,
          hint: 'pass --source <id> for one source, or --all-sources to search every source',
        }).envelope, e.message);
      }
      if (isResolverUserError(e)) {
        exitUsage(jsonMode, errorFor({
          class: 'UsageError',
          code: 'invalid_source_pin',
          message: (e as Error).message,
          hint: `fix the .gbrain-source pin / GBRAIN_SOURCE value, or pass --source <id> / --all-sources to ${command}`,
        }).envelope, (e as Error).message);
      }
      throw e;
    }
  }

  // #4747 / #3242 sibling: on a vault+code brain the resolution chain can land
  // on a source that holds no code at all (the scalar seed source, usually
  // 'default'). Scoping to it turns every lookup into a silent zero. The MCP
  // graph ops RE-ROUTE for this shape; def/refs are plain SQL, so they can just
  // widen. Only fires when the resolved source was implicit — an explicit
  // --source is the user's word and is never second-guessed.
  const widened = (!allSources && sourceId && !opts.sourceId)
    ? await shouldWidenForNoCode(engine, sourceId)
    : false;
  if (widened) {
    console.error(
      `[${command}] resolved source '${sourceId}' holds no code — widening to every source. ` +
      `Pass --source <id> to pin one, or --all-sources to make this explicit.`,
    );
  }

  const spanning = allSources || widened;
  return {
    allSources: spanning,
    sourceId: spanning ? undefined : (sourceId ?? undefined),
    scope: spanning ? 'all' : 'single',
    envelopeSourceId: spanning ? null : (sourceId ?? null),
  };
}

/**
 * True when an IMPLICITLY resolved source holds no code but the brain has code
 * elsewhere — the vault+code shape where scoping would answer every lookup with
 * a silent zero. Exported for tests; a probe failure returns false so the
 * resolved scope stands.
 */
export async function shouldWidenForNoCode(
  engine: BrainEngine,
  sourceId: string,
): Promise<boolean> {
  try {
    if (await codeChunksExist(engine, sourceId)) return false;
    return await codeChunksExist(engine, undefined);
  } catch {
    return false;
  }
}

/** Existence check for an explicit --source, mirroring the resolver's own gate. */
async function sourceExists(engine: BrainEngine, sourceId: string): Promise<boolean> {
  try {
    const rows = await engine.executeRaw<{ e: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM sources WHERE id = $1 AND NOT archived) AS e`,
      [sourceId],
    );
    return rows[0]?.e === true;
  } catch {
    // A probe failure must not block a lookup the user could otherwise run.
    return true;
  }
}

function exitUsage(jsonMode: boolean, envelope: unknown, message: string): never {
  if (jsonMode) {
    console.log(JSON.stringify({ error: envelope }));
  } else {
    console.error(message);
  }
  process.exit(2);
}
