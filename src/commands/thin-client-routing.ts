/**
 * CLI→MCP gap-closure wave [OV6] — per-subcommand thin-client routing for the
 * commands whose reads/writes gained MCP ops: takes (list/search/scorecard/
 * calibration + the write verbs), search (modes/stats/tune, read-only forms),
 * jobs stats, cache stats, and quarantine list. The salience/anomalies/
 * graph-query precedent, engine-free: each routable subcommand maps onto its
 * op over callRemoteTool; everything else returns false so the caller falls
 * through to refuseThinClient's pinpoint hint.
 *
 * Config-MUTATING forms stay host-side by design: `search modes --reset` and
 * `search tune --apply` (CDX-21), plus `search modes --source <mode>` (the
 * reset dry-run — previews what a reset would change on the host), `cache
 * clear|prune`, `quarantine scan|clear`, `takes extract|revisit`.
 */

import type { GBrainConfig } from '../core/config.ts';
import { callRemoteTool, unpackToolResult } from '../core/mcp-client.ts';

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

function num(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : undefined;
}

async function call(cfg: GBrainConfig, tool: string, args: Record<string, unknown>): Promise<unknown> {
  return unpackToolResult(await callRemoteTool(cfg, tool, args));
}

function printJson(result: unknown): void {
  console.log(JSON.stringify(result, null, 2));
}

/**
 * Recognized-but-malformed routable subcommand: print the SAME usage string
 * the host CLI prints (copied verbatim from src/commands/takes.ts) and exit 1.
 * Returning false here instead would fall through to the host-bound refusal
 * hint, which misleads (the subcommand IS routable — the args are just wrong).
 */
function usageExit(...lines: string[]): never {
  for (const line of lines) console.error(line);
  process.exit(1);
}

/**
 * Route a thin-client invocation to its MCP op. Returns true when handled
 * (output printed); false ONLY when the subcommand is genuinely host-bound
 * and the caller should refuse with the hint. Routable subcommands with
 * invalid required args report a nonzero CLI verdict instead of returning
 * false. Take writes share the durable mutation parser, timeout and typed
 * receipt renderer; other remote op errors propagate to the dispatcher.
 */
export async function routeThinClientCommand(
  cfg: GBrainConfig,
  command: string,
  args: string[],
): Promise<boolean> {
  const sub = args[0];
  const rest = args.slice(1);

  if (command === 'takes') {
    switch (sub) {
      case 'list': {
        const slug = rest[0] && !rest[0].startsWith('-') ? rest[0] : undefined;
        printJson(await call(cfg, 'takes_list', {
          ...(slug ? { page_slug: slug } : {}),
          ...(flagValue(rest, '--who') ? { holder: flagValue(rest, '--who') } : {}),
          ...(flagValue(rest, '--kind') ? { kind: flagValue(rest, '--kind') } : {}),
        }));
        return true;
      }
      case 'search': {
        if (!rest[0]) {
          usageExit('Usage: gbrain takes search "<query>" [--who h] [--json]');
        }
        printJson(await call(cfg, 'takes_search', { query: rest[0], ...(num(flagValue(rest, '--limit')) !== undefined ? { limit: num(flagValue(rest, '--limit')) } : {}) }));
        return true;
      }
      case 'scorecard': {
        const holder = rest[0] && !rest[0].startsWith('--') ? rest[0] : flagValue(rest, '--holder');
        printJson(await call(cfg, 'takes_scorecard', { ...(holder ? { holder } : {}) }));
        return true;
      }
      case 'calibration': {
        printJson(await call(cfg, 'takes_calibration', { ...(flagValue(rest, '--holder') ? { holder: flagValue(rest, '--holder') } : {}) }));
        return true;
      }
      case 'add':
      case 'update':
      case 'resolve':
      case 'supersede': {
        const { runTakesMutation } = await import('./takes-mutation.ts');
        await runTakesMutation(async () => { throw new Error('Remote takes cannot open a local engine.'); }, args, cfg);
        return true;
      }
      default:
        return false; // extract / revisit / unknown — host-bound, refuse with hint
    }
  }

  if (command === 'search') {
    if (sub === 'modes' && !rest.includes('--reset') && !rest.includes('--source')) {
      printJson(await call(cfg, 'search_modes', {}));
      return true;
    }
    if (sub === 'stats') {
      printJson(await call(cfg, 'search_stats', { ...(num(flagValue(rest, '--days')) !== undefined ? { days: num(flagValue(rest, '--days')) } : {}) }));
      return true;
    }
    if (sub === 'tune' && !rest.includes('--apply')) {
      printJson(await call(cfg, 'search_tune', {}));
      return true;
    }
    return false; // modes --reset / modes --source (the reset dry-run) / tune --apply / diagnose — host-side config or live probe
  }

  if (command === 'jobs' && sub === 'stats') {
    printJson(await call(cfg, 'get_job_stats', { ...(flagValue(rest, '--queue') ? { queue: flagValue(rest, '--queue') } : {}) }));
    return true;
  }

  if (command === 'cache' && sub === 'stats') {
    printJson(await call(cfg, 'cache_stats', {}));
    return true;
  }

  if (command === 'quarantine' && sub === 'list') {
    printJson(await call(cfg, 'quarantine_list', { ...(rest.includes('--include-flagged') ? { include_flagged: true } : {}) }));
    return true;
  }

  return false;
}
