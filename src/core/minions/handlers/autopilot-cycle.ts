/**
 * `autopilot-cycle` Minion job handler (built-in; registered by registerBuiltinHandlers in src/commands/jobs.ts).
 */
import type { BrainEngine } from '../../engine.ts';
import type { MinionHandler } from '../types.ts';
import { resolveJobPull } from './job-pull.ts';
import { isConnectorSourceKind } from '../../persistence/connector-identity.ts';
import { CONNECTOR_SOURCE_PHASES } from '../../cycle/phase-scope.ts';

/**
 * Autopilot-cycle handler: delegates to runCycle. Shares the exact same
 * phase set and ordering as `gbrain dream` and autopilot's inline path —
 * one source of truth for what the brain does overnight.
 *
 * Yields the event loop between phases so the worker's lock-renewal
 * timer (src/core/minions/worker.ts) can fire. Without this the v0.14
 * stall-death regression returns: long CPU-bound phases starve the
 * renewal callback and the stalled-sweeper kills the job.
 *
 * Phase failures surface as report.status='partial' (via runCycle's
 * derivation); the handler returns { partial, status, report } so
 * `gbrain jobs get <id>` shows the full structured report. Does NOT
 * throw on partial: a flaky phase must not block every future cycle.
 */
export function makeAutopilotCycleHandler(engine: BrainEngine): MinionHandler {
  return async (job) => {
    const { runCycle } = await import('../../cycle.ts');
    // v0.41.30 (T2): fall back to null (NOT cwd '.') when no repo is configured.
    // The queued cycle is the same primitive `gbrain dream` uses; a checkout-less
    // postgres brain should skip filesystem phases (no_brain_dir) and run the
    // DB-only phases (resolve_symbol_edges, embed, ...) — not silently lint/sync
    // against whatever directory the worker happens to be running in.
    // v0.38 (codex r1 P1-2 + P1-5): per-source dispatch threading.
    //   - source_id: when set, runCycle uses the per-source lock ID and
    //     writes last_full_cycle_at on success. Validated at handler entry
    //     so queue replays with malformed source_id dead-letter instead of
    //     reaching cycle code.
    //   - pull: when set, overrides the legacy hardcoded `true` so
    //     per-source dispatch can disable pull for local-only sources.
    //     Missing/undefined keeps the legacy `true` for back-compat.
    //   - Archive recheck: if source_id is set but the source was
    //     archived between fan-out and worker claim, skip cleanly.
    const rawSourceId = job.data.source_id;
    let sourceId: string | undefined;
    // issue #2227/#2194 (TODOS:634, codex #8): a per-source cycle must run its
    // FILESYSTEM phases (sync/lint/extract) against the SOURCE's own checkout,
    // not the global brain's. Pre-fix it inherited `repoPath` (the default
    // checkout) while writing DB freshness for `source_id` — mixed scope that
    // made cooldown/freshness attribute to the wrong source. We resolve the
    // source's `local_path` here and use it as the cycle's brainDir below.
    let sourceLocalPath: string | null = null;
    let connectorSource = false;
    if (rawSourceId !== undefined && rawSourceId !== null) {
      if (typeof rawSourceId !== 'string') {
        throw new Error(`autopilot-cycle: invalid source_id (not a string): ${JSON.stringify(rawSourceId)}`);
      }
      const { isValidSourceId } = await import('../../source-id.ts');
      if (!isValidSourceId(rawSourceId)) {
        // Dead-letter early — malformed source_id from queue replay shouldn't
        // reach cycle code. TS narrowing via isValidSourceId boolean shape
        // (assertValidSourceId would require static-import per TS2775).
        throw new Error(`autopilot-cycle: invalid source_id (regex): ${JSON.stringify(rawSourceId)}`);
      }
      // Archive recheck (codex r1 P1-5): cheap pre-cycle lookup. Returns
      // immediately if source is gone or archived; runCycle never even
      // acquires a lock. Also fetches local_path so FS phases bind to the
      // source's own checkout (the #2227/#2194 mixed-scope fix).
      const rows = await engine.executeRaw<{ archived: boolean | null; local_path: string | null; kind: string | null }>(
        `SELECT archived, local_path, config->>'kind' AS kind FROM sources WHERE id = $1`,
        [rawSourceId],
      );
      if (rows.length === 0) {
        return {
          partial: false,
          status: 'skipped',
          report: { reason: 'source_not_found', source_id: rawSourceId },
        };
      }
      if (rows[0].archived === true) {
        return {
          partial: false,
          status: 'skipped',
          report: { reason: 'source_archived', source_id: rawSourceId },
        };
      }
      sourceId = rawSourceId;
      // #5673: a connector source's local_path is never a brain directory.
      connectorSource = isConnectorSourceKind(rows[0].kind);
      sourceLocalPath = !connectorSource && typeof rows[0].local_path === 'string' && rows[0].local_path.length > 0
        ? rows[0].local_path
        : null;
    }

    // Effective checkout for FS phases. For a per-source cycle, bind to the
    // SOURCE's local_path (or null → skip FS phases for a pure-DB source);
    // NEVER fall through to the global repoPath, which would run sync/lint
    // against the wrong tree. Legacy (no source_id) keeps the global repoPath.
    const effectiveBrainDir: string | null = sourceId
      ? sourceLocalPath
      : typeof job.data.repoPath === 'string' ? job.data.repoPath : (await engine.getConfig('sync.repo_path')) ?? null;

    // Allow callers to select phases via job data (e.g. skip embed for
    // fast cycles). Validates against ALL_PHASES to prevent injection, then
    // normalizes per-source payloads to the freshness set (queue payloads
    // are machine-authored; see normalizeQueuedSourcePhases in cycle.ts).
    const { ALL_PHASES, normalizeQueuedSourcePhases } = await import('../../cycle.ts');
    const validPhases = new Set(ALL_PHASES);
    const requestedPhases = connectorSource
      ? (Array.isArray(job.data.phases) ? job.data.phases as string[] : CONNECTOR_SOURCE_PHASES).filter(p => CONNECTOR_SOURCE_PHASES.includes(p as any))
      : Array.isArray(job.data.phases)
        ? (job.data.phases as string[]).filter(p => validPhases.has(p as any))
        : undefined;
    const { phases: effectivePhases, rejected: phasesRejectedByNormalization } =
      normalizeQueuedSourcePhases(requestedPhases as any, sourceId);
    // An explicitly-empty phase list (arrived empty, or emptied by the
    // normalization) is a no-op — NOT an implicit run. The reason string is
    // honest about WHICH of the two happened.
    if (effectivePhases !== undefined && effectivePhases.length === 0) {
      return {
        partial: false,
        status: 'skipped',
        report: {
          reason: phasesRejectedByNormalization.length > 0
            ? 'all_phases_rejected_by_normalization'
            : 'empty_phase_list',
          ...(sourceId ? { source_id: sourceId } : {}),
          phases_rejected_by_normalization: phasesRejectedByNormalization,
        },
      };
    }

    const pull = resolveJobPull(job.data);

    // #2194 fix #2 / codex #5 (D4): claim-time cooldown guard. A job already
    // queued or retrying (max_attempts:2) can reach the worker after the
    // dispatch gate decided to back this source off. Skip it here as a NO-OP
    // (status 'skipped', NOT a failure — a failure would re-arm the cooldown).
    if (sourceId) {
      const { isSourceInCooldown } = await import('../../../commands/autopilot-fanout.ts');
      if (await isSourceInCooldown(engine, sourceId)) {
        return {
          partial: false,
          status: 'skipped',
          report: { reason: 'source_in_cooldown', source_id: sourceId },
        };
      }
    }

    const report = await runCycle(engine, {
      brainDir: effectiveBrainDir,
      pull,
      signal: job.signal, // propagate abort so cycle bails on timeout/cancel
      deadlineAtMs: job.deadlineAtMs, // #2781: phases budget sub-work from remaining time
      privateQueueOwnerJobId: job.id,
      ...(sourceId ? { sourceId } : {}),
      ...(effectivePhases !== undefined ? { phases: effectivePhases as any } : {}),
      yieldBetweenPhases: async () => {
        // Yield to the event loop so worker lock-renewal can fire.
        await new Promise<void>(r => setImmediate(r));
      },
    });

    return {
      partial: report.status === 'partial' || report.status === 'failed',
      status: report.status,
      report,
      // Surfaced so operators can see the queue-boundary normalization at
      // work in job results (runCycle never sees rejected phases, so its
      // excludedPhases skip-reporting cannot cover them).
      ...(phasesRejectedByNormalization.length > 0
        ? { phases_rejected_by_normalization: phasesRejectedByNormalization }
        : {}),
    };
  };
}
