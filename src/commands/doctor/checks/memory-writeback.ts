/**
 * memory_writeback — the ambient-writeback diagnostics surface (WP6).
 *
 * One check answers requirement 10's four questions: is it on; what
 * mode/TTL/visibility actually resolve; which harness integrations are
 * installed (receipt says "installed", the live sentinel probe says "still
 * present", the drift compare says "still CURRENT" — all three reported,
 * OV-A3); and the recent inserted/duplicate/superseded/skipped/failed
 * counts.
 *
 * Counter honesty (OV-A11): the `remember` counters come from the local
 * verbs usage sidecar and cover ALL MCP callers — the wire cannot
 * distinguish an ambient save from an explicit one, and the label says so.
 * The backstop counters are PERSISTED results from the serve-side harvest
 * heartbeat (`event: 'writeback'`), never hook-side candidate counts. Both
 * stores are local, append-only, loss-tolerant observability — never a
 * source of truth (usage-log.ts / telemetry.ts posture).
 *
 * Intentionally-off is `status: 'ok'` with zero noise (the
 * integrations-memorable convention: a disabled opt-in is never a warn).
 */

import { existsSync, readFileSync } from 'node:fs';
import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { loadConfig } from '../../../core/config.ts';
import { resolveGbrainHome } from '../../../core/gbrain-home.ts';
import {
  resolveWritebackConfig,
  resolveWritebackConfigFromFile,
  AUTO_WRITEBACK_NOTICE_KEY,
} from '../../../core/facts/writeback-config.ts';
import { resolveDefaultVisibility } from '../../../core/facts/visibility.ts';
import { classifyBrainAudience } from '../../../core/facts/writeback-audience.ts';
import { readVerbUsage } from '../../../core/verbs/usage-log.ts';
import { readHeartbeatTail } from '../../../core/context/hook-heartbeat.ts';
import { readHarnessReceiptState } from '../../../core/bootstrap/format.ts';
import {
  probeAmbientBlock,
  renderAmbientInstructionBlock,
} from '../../../core/bootstrap/instructions-block.ts';
import {
  claudeUserMemoryPath,
  codexAgentsOverridePath,
  codexGlobalAgentsPath,
} from '../../../core/bootstrap/host-specs.ts';

export const MEMORY_WRITEBACK_CHECK_NAME = 'memory_writeback';

const COUNTER_WINDOW_DAYS = 7;

/** Every path an ambient block could live at: the receipt's recorded
 * `instructions` targets UNION the two canonical install paths — an
 * out-of-band or crashed-receipt install must still be findable (the
 * converge-on-off lane probes the same union). */
function ambientBlockCandidatePaths(): Array<{ host: string; path: string }> {
  const out: Array<{ host: string; path: string }> = [];
  const seen = new Set<string>();
  const push = (host: string, path: string | null | undefined) => {
    if (!path || seen.has(path)) return;
    seen.add(path);
    out.push({ host, path });
  };
  try { push('claude-code', claudeUserMemoryPath()); } catch { /* env-dependent */ }
  try { push('codex', codexGlobalAgentsPath()); } catch { /* env-dependent */ }
  try {
    const receipt = readHarnessReceiptState(resolveGbrainHome());
    if (receipt.state === 'ok') {
      for (const t of receipt.receipt.targets) {
        if (t.kind === 'instructions' && t.path) push(t.host, t.path);
      }
    }
  } catch { /* receipt probe is best-effort */ }
  return out;
}

export async function buildMemoryWritebackCheck(engine: BrainEngine | null): Promise<Check> {
  try {
    const fileCfg = loadConfig();
    if (!engine) {
      // Engine-free doctor run: report the file-plane mirror honestly and
      // stop — the DB plane (the authoritative gate), audience, and counters
      // need a connection.
      const fileWb = resolveWritebackConfigFromFile(fileCfg);
      return {
        name: MEMORY_WRITEBACK_CHECK_NAME,
        status: 'ok',
        message: fileWb.enabled
          ? `ambient writeback ${fileWb.mode} per the file-plane mirror (database unreachable — DB plane is authoritative; re-run with the engine up for the full report)`
          : 'ambient writeback off (default; file-plane mirror — database unreachable)',
        details: { mode: fileWb.mode, mode_valid: fileWb.mode_valid, transient_ttl: fileWb.transient_ttl, ttl_valid: fileWb.ttl_valid, plane: 'file-mirror-only' },
      };
    }
    const wb = await resolveWritebackConfig(engine, fileCfg);
    const fileWb = resolveWritebackConfigFromFile(fileCfg);
    const nudgeShown = await engine.getConfig(AUTO_WRITEBACK_NOTICE_KEY).catch(() => null);
    const audience = await classifyBrainAudience(engine, fileCfg);
    const backstopVisibility = await resolveDefaultVisibility(engine).catch(() => 'private' as const);

    const details: Record<string, unknown> = {
      mode: wb.mode,
      mode_valid: wb.mode_valid,
      ...(wb.raw_mode && !wb.mode_valid ? { raw_mode: wb.raw_mode } : {}),
      transient_ttl: wb.transient_ttl,
      ttl_valid: wb.ttl_valid,
      instruction_visibility: wb.visibility,
      backstop_visibility: backstopVisibility,
      visibility_note: 'world = readable by agents authorized on THIS brain, not the public internet',
      audience: audience.audience,
      audience_reasons: audience.reasons,
      nudge_shown: nudgeShown === 'true',
      ...(wb.read_error ? { read_error: true } : {}),
      ...(wb.plane_drift ? { plane_drift: true } : {}),
      counters_note: `local, append-only, loss-tolerant observability over the last ${COUNTER_WINDOW_DAYS}d — never a source of truth`,
    };

    // Plane comparison (the dual-write design's promised surfacing): the DB
    // row is authoritative at runtime; a disagreeing file mirror means a
    // failed dual-write, a foreign writer, or another machine's `config set`
    // on a shared Postgres brain — the Stop hook (file-gated) and the serve
    // gate (DB-gated) are now acting on DIFFERENT truths.
    const planeDrifted = !wb.read_error && (fileWb.raw_mode ?? '') !== (wb.raw_mode ?? '');
    if (planeDrifted) {
      details.file_mirror_mode = fileWb.raw_mode ?? '(unset)';
    }

    if (!wb.enabled) {
      const offProblems: string[] = [];
      if (wb.read_error) {
        offProblems.push('the writeback config could not be read (fail-closed off THIS run — the real state is unknown; re-run with the database reachable)');
      } else if (!wb.mode_valid) {
        offProblems.push(`memory.auto_writeback='${wb.raw_mode}' is unrecognized (expected off|salient|all) — resolved to off. Fix: gbrain config set memory.auto_writeback salient`);
      }
      if (planeDrifted && !wb.read_error) {
        offProblems.push(`DB plane resolves '${wb.raw_mode ?? 'unset'}' but the file mirror says '${fileWb.raw_mode ?? 'unset'}' — planes diverged (banked turns are held, not extracted, until re-synced). Fix: gbrain config set memory.auto_writeback <off|salient|all> (dual-writes both planes)`);
      }
      // Off-but-still-instructing (red-team review, this wave): an installed
      // block keeps directing every NEW session to save via `remember` (an
      // ungated write op) — the off switch is incomplete until converged.
      const lingering: string[] = [];
      for (const c of ambientBlockCandidatePaths()) {
        try {
          if (!existsSync(c.path)) continue;
          const probe = probeAmbientBlock(readFileSync(c.path, 'utf8'));
          if (probe.state !== 'absent') lingering.push(`${c.host} (${c.path})`);
        } catch { /* per-path probe is best-effort */ }
      }
      if (lingering.length) {
        details.lingering_instruction_blocks = lingering;
        offProblems.push(`ambient writeback is off but instruction blocks are still installed for ${lingering.join(', ')} — new sessions keep saving. Remove: gbrain bootstrap harness --yes (converges on off)`);
      }
      return {
        name: MEMORY_WRITEBACK_CHECK_NAME,
        status: offProblems.length ? 'warn' : 'ok',
        message: offProblems.length
          ? `ambient writeback off: ${offProblems.join('; ')}`
          : 'ambient writeback off (default). Enable: gbrain config set memory.auto_writeback salient',
        details,
      };
    }

    const problems: string[] = [];
    if (!wb.ttl_valid) {
      problems.push(`memory.auto_writeback_transient_ttl is invalid — using '${wb.transient_ttl}'`);
    }
    if (planeDrifted) {
      problems.push(`file mirror says '${fileWb.raw_mode ?? 'unset'}' while the DB plane resolves '${wb.raw_mode}' — the engine-free Stop hook is acting on the wrong truth. Re-sync: gbrain config set memory.auto_writeback ${wb.raw_mode}`);
    }

    // Harness instruction blocks: receipt (installed) vs live probe (present)
    // vs drift compare (current). All engine-free local reads.
    const blocks: Array<Record<string, unknown>> = [];
    try {
      const receipt = readHarnessReceiptState(resolveGbrainHome());
      if (receipt.state === 'ok') {
        // Both hosts render the identical body today — computed once.
        const expectedBody = renderAmbientInstructionBlock({
          mode: wb.mode as 'salient' | 'all',
          transientTtl: wb.transient_ttl,
          visibility: wb.visibility,
          serveUrl: receipt.receipt.url,
        });
        for (const t of receipt.receipt.targets) {
          if (t.kind !== 'instructions' || !t.path) continue;
          const entry: Record<string, unknown> = { host: t.host, path: t.path, receipt_state: t.state };
          // A FAILED receipt target is a standing warn regardless of what the
          // live probe says (codex re-review): the one physical-survival path
          // — a strip that THREW during smoke rollback — leaves a
          // healthy-looking block on disk directing sessions at a rolled-back
          // endpoint, and only this receipt state knows.
          if (t.state === 'failed') {
            problems.push(`${t.host} instruction block target previously FAILED (${t.error ?? 'unknown reason'}) — converge: gbrain bootstrap harness --yes (or --remove)`);
          }
          if (!existsSync(t.path)) {
            entry.probe = 'missing';
            problems.push(`${t.host} instruction block missing at ${t.path} — re-run: gbrain bootstrap harness --yes`);
          } else {
            const probe = probeAmbientBlock(readFileSync(t.path, 'utf8'));
            if (probe.state === 'absent' || probe.state === 'damaged') {
              entry.probe = probe.state === 'damaged' ? 'damaged' : 'missing';
              problems.push(`${t.host} instruction block ${probe.state === 'damaged' ? 'has damaged markers' : 'missing'} at ${t.path} — re-run: gbrain bootstrap harness --yes`);
            } else if (probe.interior !== expectedBody) {
              entry.probe = 'drift';
              // The combo converges even when the file-plane posture stamp is
              // stale (e.g. facts.default_visibility flipped on ANOTHER
              // machine of a shared Postgres brain): the config set re-stamps
              // the mirror from DB truth, then the harness re-renders from it.
              problems.push(`${t.host} instruction block is stale (config changed since install) — re-run: gbrain config set memory.auto_writeback ${wb.mode} && gbrain bootstrap harness --yes`);
            } else {
              entry.probe = 'current';
            }
          }
          if (t.host === 'codex') {
            try {
              if (existsSync(codexAgentsOverridePath())) {
                entry.override_blocked = true;
                problems.push('codex ignores AGENTS.md while AGENTS.override.md exists — the installed block is dead (merge it into the override file or remove the override)');
              }
            } catch { /* env-dependent — best effort */ }
          }
          blocks.push(entry);
        }
      }
      details.instruction_blocks = blocks;
    } catch { /* receipt probe is best-effort */ }

    // Validity-lapsed facts (read-time TTL, WP5) — informational.
    try {
      const rows = await engine.executeRaw<{ n: number | string }>(
        `SELECT count(*)::int AS n FROM facts WHERE valid_until <= now() AND expired_at IS NULL`,
      );
      details.validity_lapsed_facts = Number(rows[0]?.n ?? 0);
    } catch { /* pre-facts brains */ }

    // remember outcomes over MCP (ALL callers) — verbs usage sidecar.
    try {
      const events = await readVerbUsage({ days: COUNTER_WINDOW_DAYS });
      const remembers = events.filter((e) => e.verb === 'remember');
      const c = { inserted: 0, duplicate: 0, superseded: 0, failed: 0 };
      for (const e of remembers) {
        if (!e.ok) { c.failed++; continue; }
        const s = (e as { remember_status?: string }).remember_status;
        if (s === 'inserted') c.inserted++;
        else if (s === 'duplicate') c.duplicate++;
        else if (s === 'superseded') c.superseded++;
      }
      details.remember_over_mcp_7d = { ...c, note: 'all MCP callers — ambient and explicit saves are indistinguishable on the wire' };
    } catch { /* sidecar unreadable — counters stay absent */ }

    // Backstop lanes — persisted serve-side results + hook-side gate skips.
    try {
      const cutoff = Date.now() - COUNTER_WINDOW_DAYS * 24 * 60 * 60 * 1000;
      const tail = (await readHeartbeatTail(2000)).filter((e) => {
        const t = Date.parse(e.ts);
        return Number.isFinite(t) && t >= cutoff;
      });
      const harvest = tail.filter((e) => e.event === 'writeback');
      const bank = tail.filter((e) => e.event === 'writeback-bank');
      details.backstop_7d = {
        inserted: harvest.reduce((n, e) => n + (e.inserted ?? 0), 0),
        duplicate: harvest.reduce((n, e) => n + (e.duplicate ?? 0), 0),
        superseded: harvest.reduce((n, e) => n + (e.superseded ?? 0), 0),
        // 'degraded' bank events are INFRA faults only (IPC down, stale
        // serve, parse/scan failures) — by-design gate skips ride
        // outcome:'ok' since this wave, so this bucket no longer counts
        // every "Thanks" as a skip.
        skipped: harvest.filter((e) => e.outcome === 'ok' && e.reason && e.inserted === undefined).length
          + bank.filter((e) => e.outcome === 'degraded').length,
        failed: harvest.filter((e) => e.outcome === 'error').length,
        // flush_skip_* = the turn IS banked; only the prompt-harvest enqueue
        // was declined (cap/queue policy) — the sweep extracts it later.
        turns_banked: bank.filter((e) => e.reason === 'wb_scheduled' || e.reason === 'wb_banked' || e.reason?.startsWith('flush_skip_')).length,
      };
    } catch { /* heartbeat unreadable — counters stay absent */ }

    return {
      name: MEMORY_WRITEBACK_CHECK_NAME,
      status: problems.length ? 'warn' : 'ok',
      message: problems.length
        ? `ambient writeback ${wb.mode}: ${problems.join('; ')}`
        : `ambient writeback ${wb.mode} (ttl ${wb.transient_ttl}, template visibility ${wb.visibility}, audience ${audience.audience})`,
      details,
    };
  } catch (e) {
    return {
      name: MEMORY_WRITEBACK_CHECK_NAME,
      status: 'warn',
      message: `memory_writeback check failed: ${e instanceof Error ? e.message : String(e)}`,
      details: {},
    };
  }
}
