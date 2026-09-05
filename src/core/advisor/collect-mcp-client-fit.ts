/**
 * advisor/collect-mcp-client-fit.ts — E3: MCP surface right-sizing over
 * `mcp_request_log` (amendment 29 + D12).
 *
 * The read-only fit check rides the shared usage reader
 * (src/core/mcp-usage.ts — the same hygiene rules as the E4 CLI):
 *
 *  Per-client fit: a client resolving to the FULL surface whose observed
 *  successful HTTP calls in the trailing 30d window fit inside STARTER_OPS
 *  gets a read-only usage-review action. This is deliberately not a global
 *  STARTER_OPS curator: usage logging is incomplete and cannot establish
 *  set-level drift.
 *
 * Privacy (amendment 29): when the advisor runs REMOTE (ctx.remote), client
 * identifiers are REDACTED to aggregate counts ("2 clients fit the starter
 * surface — run gbrain advisor on the host for details"). Full per-client
 * detail is local-CLI-only. Op NAMES are not client identifiers and stay
 * visible only in the aggregate count on the remote surface.
 *
 * D12 exclusions: automation-shaped clients (>90% of calls are the
 * context_pack/delta boundary verbs — the hook-lane/turn-context signature;
 * there is no registered-name convention to key on, the hook lane is stdio
 * and never logs) are excluded from the fit check via
 * `ClientOpUsage.likely_automation`.
 *
 * Dismiss/snooze: the skillpack nag-state engine (escalate-then-suppress,
 * ceiling 3) with its OWN state file (`~/.gbrain/advisor-usage-nag-state.json`)
 * so declines never pollute the skillpack ledger. The nag "version" is a
 * fingerprint of the finding's inputs — a changed usage profile re-surfaces a
 * suppressed finding, an unchanged one goes quiet after the ceiling. Local
 * runs only: the remote advisor op is strictly read-only (no nag writes).
 *
 * Alert threshold (amendment 29): a client needs >= MIN_CALLS_FOR_FIT calls
 * in the window before a fit finding fires — one whoami probe is not a
 * workload.
 */

import { gbrainPath } from '../config.ts';
import { readClientOpUsage, type ClientOpUsage } from '../mcp-usage.ts';
import {
  STARTER_OPS,
  isMcpSurface,
  resolveDefaultClientSurface,
} from '../../mcp/surface.ts';
import {
  loadNagState,
  saveNagState,
  findNag,
  upsertNag,
  decideNagAction,
  recordNagDisplay,
  type NagState,
} from '../skillpack/nag-state.ts';
import type { AdvisorCollector, AdvisorContext, AdvisorFinding } from './types.ts';

/** Minimum 30d call volume before a per-client fit finding fires. */
export const MIN_CALLS_FOR_FIT = 10;

/** Nag-state file for this collector (separate from the skillpack ledger). */
export function usageNagStatePath(): string {
  return _nagPathOverride ?? gbrainPath('advisor-usage-nag-state.json');
}

let _nagPathOverride: string | null = null;

/** Test seam: point the nag state at a tmp file (null restores the default). */
export function __setUsageNagStatePathForTests(path: string | null): void {
  _nagPathOverride = path;
}

/**
 * Gate a finding through the nag engine (local runs only). Returns true when
 * the finding should surface; records the display so the ceiling counts.
 */
function nagAllows(state: NagState, packName: string, fingerprint: string): { show: boolean; next: NagState } {
  const key = { brain_id: 'host', source_id: 'mcp-usage', pack_name: packName };
  const prior = findNag(state, key);
  const decision = decideNagAction(prior, { pack_version: fingerprint });
  if (!decision.show) return { show: false, next: state };
  const entry = recordNagDisplay(prior, key, { pack_version: fingerprint, nowIso: new Date().toISOString() });
  return { show: true, next: upsertNag(state, entry) };
}

/** Resolve the surface a client row would get WITHOUT the server ceiling. */
function clientResolvedSurface(
  rowSurface: unknown,
  defaultSurface: string | null,
): string {
  if (isMcpSurface(rowSurface)) return rowSurface;
  return defaultSurface ?? 'full';
}

async function readClientSurfaces(ctx: AdvisorContext): Promise<Map<string, unknown> | null> {
  try {
    const rows = await ctx.engine.executeRaw<{ client_id: string; surface: unknown }>(
      `SELECT client_id, surface FROM oauth_clients`,
    );
    return new Map(rows.map((r) => [r.client_id, r.surface]));
  } catch {
    // Pre-v127 brain (no surface column) or no oauth_clients table: the fit
    // finding's fix command could not work anyway — skip check (a).
    return null;
  }
}

export const collectMcpClientFit: AdvisorCollector = {
  id: 'mcp-client-fit',
  collect: async (ctx) => {
    const findings: AdvisorFinding[] = [];

    let usage30: ClientOpUsage[];
    try {
      usage30 = await readClientOpUsage(ctx.engine, { days: 30 });
    } catch {
      return []; // mcp_request_log absent / engine quirk → no findings
    }
    const real30 = usage30.filter((u) => !u.likely_automation);

    // Nag state: loaded once, saved once, LOCAL runs only (remote is read-only).
    const local = !ctx.remote;
    let nag = local ? loadNagState({ statePath: usageNagStatePath() }) : null;

    // ---- (a) per-client starter fit -------------------------------------
    const surfaces = await readClientSurfaces(ctx);
    if (surfaces !== null) {
      let defaultSurface: string | null = null;
      try {
        defaultSurface = await resolveDefaultClientSurface(ctx.engine, ctx.config);
      } catch {
        defaultSurface = null;
      }
      const fits: ClientOpUsage[] = [];
      for (const u of real30) {
        if (u.total_calls < MIN_CALLS_FOR_FIT) continue;
        if (!surfaces.has(u.token_name)) continue; // legacy bearer token — no per-client surface row to inspect
        const resolved = clientResolvedSurface(surfaces.get(u.token_name), defaultSurface);
        if (resolved !== 'full') continue; // already narrowed (row or DCR default)
        if (!u.distinct_ops.every((op) => STARTER_OPS.has(op))) continue;
        fits.push(u);
      }
      if (fits.length > 0) {
        if (!local) {
          // Amendment 29: remote output carries aggregate counts ONLY.
          findings.push({
            id: 'mcp_starter_fit_aggregate',
            severity: 'info',
            title: `${fits.length} MCP client${fits.length === 1 ? '' : 's'} had observed successful HTTP calls in the trailing 30d window within STARTER_OPS — run \`gbrain advisor\` on the host for details.`,
            detail:
              'This is incomplete logging: stdio calls are not logged, and denied or error calls are not ' +
              'observations. A client row or default is not its effective surface for every request; ' +
              'scope and server-ceiling constraints can narrow it. Treat this as a deliberate operator ' +
              'review signal for future or infrequent needs. `rescope-client` can create an operator pin ' +
              'that prevents self-widening. Client identifiers are shown on the host CLI only.',
            fix: { command_argv: null },
            collector: 'mcp-client-fit',
            ask_user: true,
          });
        } else {
          for (const u of fits) {
            const fingerprint = `fit:${u.distinct_ops.join(',')}`;
            const gate = nagAllows(nag!, `fit:${u.token_name}`, fingerprint);
            nag = gate.next;
            if (!gate.show) continue;
            findings.push({
              id: `mcp_starter_fit:${u.token_name}`,
              severity: 'info',
              title: `MCP client "${u.token_name}" had ${u.total_calls} observed successful HTTP calls in the trailing 30d window within STARTER_OPS (${u.distinct_ops.length} ops).`,
              detail:
                'This is incomplete logging: stdio calls are not logged, and denied or error calls are not ' +
                'observations. The client row or default resolves to the full surface here, but that is ' +
                'not the effective surface for every request; scope and server-ceiling constraints can ' +
                'narrow it. Treat this as a deliberate operator review signal, not a claim about future ' +
                'or infrequent needs. Review the JSON usage report before acting; `rescope-client` can ' +
                'create an operator pin that prevents self-widening. Automation-shaped clients, >90% ' +
                'context_pack/delta, are excluded.',
              fix: { command_argv: ['gbrain', 'auth', 'clients', '--usage', '--days', '30', '--json'] },
              collector: 'mcp-client-fit',
              ask_user: true,
            });
          }
        }
      }
    }

    // Persist nag displays (local only, best-effort — a failed write costs one
    // extra display, never a report failure).
    if (local && nag) {
      try {
        saveNagState(nag, { statePath: usageNagStatePath() });
      } catch {
        /* best effort */
      }
    }

    return findings;
  },
};
