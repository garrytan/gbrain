/**
 * advisor/collect-mcp-client-fit.ts — E3: MCP surface right-sizing over
 * `mcp_request_log` (amendment 29 + D12).
 *
 * Two checks, both read-only, both riding the shared usage reader
 * (src/core/mcp-usage.ts — the same hygiene rules as the E4 CLI and the
 * derive-starter-ops script):
 *
 *  (a) Per-client fit: a client resolving to the FULL surface whose 30d
 *      distinct-op set fits inside STARTER_OPS is paying the ~100-tool
 *      catalog for a starter-sized workload. Finding carries the exact fix:
 *      `gbrain auth rescope-client <id> --surface starter`.
 *  (b) Set-level drift (the standing STARTER_OPS curator): top-10 most-used
 *      ops (ranked by CLIENT COUNT, not raw calls — D12) missing from
 *      STARTER_OPS, and starter members (excluding
 *      ALWAYS_INCLUDED_STARTER_OPS — verbs + whoami + request_tools + the
 *      agent lane) unused for 90d.
 *
 * Privacy (amendment 29): when the advisor runs REMOTE (ctx.remote), client
 * identifiers are REDACTED to aggregate counts ("2 clients fit the starter
 * surface — run gbrain advisor on the host for details"). Full per-client
 * detail is local-CLI-only. Op NAMES are not client identifiers and stay
 * visible in the drift finding on both surfaces.
 *
 * D12 exclusions: automation-shaped clients (>90% of calls are the
 * context_pack/delta boundary verbs — the hook-lane/turn-context signature;
 * there is no registered-name convention to key on, the hook lane is stdio
 * and never logs) are excluded from BOTH checks via
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
import { operations } from '../operations.ts';
import { readClientOpUsage, type ClientOpUsage } from '../mcp-usage.ts';
import {
  STARTER_OPS,
  ALWAYS_INCLUDED_STARTER_OPS,
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

/** How many top-used ops the drift check inspects for starter membership. */
export const DRIFT_TOP_N = 10;

/** Window for the "starter member unused" drift arm. */
export const DRIFT_UNUSED_WINDOW_DAYS = 90;

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
        if (!surfaces.has(u.token_name)) continue; // legacy bearer token — no per-client surface row to rescope
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
            title: `${fits.length} MCP client${fits.length === 1 ? '' : 's'} fit the starter surface — run \`gbrain advisor\` on the host for details.`,
            detail:
              'Each has 30 days of usage entirely inside STARTER_OPS while resolving to the full ' +
              'catalog. Client identifiers are shown on the host CLI only.',
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
              title: `MCP client "${u.token_name}" used only starter-surface ops for 30d (${u.distinct_ops.length} ops, ${u.total_calls} calls) but sees the full catalog.`,
              detail:
                'A right-sized catalog means fewer wrong-tool calls and a smaller tools/list ' +
                'prompt for that agent. The rescope takes effect on its next request; the client ' +
                'should re-issue tools/list. (HTTP clients only — stdio usage is not logged. ' +
                'Automation-shaped clients, >90% context_pack/delta, are excluded.)',
              fix: { command_argv: ['gbrain', 'auth', 'rescope-client', u.token_name, '--surface', 'starter'] },
              collector: 'mcp-client-fit',
              ask_user: true,
            });
          }
        }
      }
    }

    // ---- (b) set-level drift (the standing curator) ----------------------
    try {
      // Rank by CLIENT COUNT (D12: distinct-op sets, not raw call volume).
      const clientCountByOp = new Map<string, number>();
      for (const u of real30) {
        for (const op of u.distinct_ops) {
          clientCountByOp.set(op, (clientCountByOp.get(op) ?? 0) + 1);
        }
      }
      const topOps = [...clientCountByOp.entries()]
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        .slice(0, DRIFT_TOP_N)
        .map(([op]) => op);
      // localOnly ops are never proposable for a network surface (mirrors
      // derive-starter-ops); a logged localOnly name (old rows, CLI-actor
      // audit exception) must not produce an unactionable recommendation.
      const localOnlyOps = new Set(operations.filter((o) => o.localOnly).map((o) => o.name));
      const missingFromStarter = topOps.filter((op) => !STARTER_OPS.has(op) && !localOnlyOps.has(op));

      const usage90 = await readClientOpUsage(ctx.engine, { days: DRIFT_UNUSED_WINDOW_DAYS });
      const seen90 = new Set<string>();
      for (const u of usage90) {
        if (u.likely_automation) continue;
        for (const op of u.distinct_ops) seen90.add(op);
      }
      // Always-included-by-construction members (shared with surface.ts +
      // derive-starter-ops) never count as drift — including the agent lane,
      // whose usage would otherwise flag it "unused" forever.
      const unusedStarter = [...STARTER_OPS]
        .filter((op) => !ALWAYS_INCLUDED_STARTER_OPS.has(op) && !seen90.has(op))
        .sort();

      // Only meaningful once there is real traffic to curate against.
      if (real30.length > 0 && (missingFromStarter.length > 0 || unusedStarter.length > 0)) {
        const parts: string[] = [];
        if (missingFromStarter.length > 0) {
          parts.push(`top-used ops missing from STARTER_OPS: ${missingFromStarter.join(', ')}`);
        }
        if (unusedStarter.length > 0) {
          parts.push(`starter members unused for ${DRIFT_UNUSED_WINDOW_DAYS}d: ${unusedStarter.join(', ')}`);
        }
        const fingerprint = `drift:${missingFromStarter.join(',')}|${unusedStarter.join(',')}`;
        let show = true;
        if (local) {
          const gate = nagAllows(nag!, 'starter-drift', fingerprint);
          nag = gate.next;
          show = gate.show;
        }
        if (show) {
          findings.push({
            id: 'mcp_starter_ops_drift',
            severity: 'info',
            title: `STARTER_OPS has drifted from production usage (${parts.length === 2 ? 'both directions' : parts[0]!.split(':')[0]}).`,
            detail:
              parts.join('; ') +
              '. Re-derive with `bun run scripts/derive-starter-ops.ts` and paste the proposed ' +
              'block into src/mcp/surface.ts (the monotonicity test pins verbs ⊆ starter ⊆ full). ' +
              'Automation-shaped clients are excluded from these stats.',
            fix: { command_argv: null },
            collector: 'mcp-client-fit',
            ask_user: true,
          });
        }
      }
    } catch {
      /* drift check is best-effort — never blocks the fit findings */
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
