/**
 * v0.46.3 migration — ZeroEntropy sunset notice (detect-and-notify ONLY).
 *
 * ZeroEntropy's hosted API shuts down on ZEROENTROPY_SUNSET_DATE (see
 * src/core/ai/defaults.ts). This orchestrator:
 *
 *   A. Detects the HOST brain's exposure via src/core/ze-exposure.ts
 *      (effective-model resolution — env → file → legacy fallback; plus the
 *      resolved reranker and ZE-backed custom columns). Read-only.
 *   B. When exposed (or exposure is UNKNOWN — fail-safe): prints the ACTION
 *      REQUIRED block and appends one idempotent pending-host-work entry
 *      pointing the host agent at skills/migrations/v0.46.3.0.md.
 *
 * It performs NO config writes, NO pinning, and NEVER invokes
 * `migrate embeddings` (the migration costs money and needs a target key the
 * user may not have — that decision belongs to the user/agent via the
 * playbook). The v0.46.3 split-default keeps existing brains fully working
 * until the date; this migration is purely the loud, durable notification.
 *
 * UNKNOWN handling: returns `complete` with detail `exposure_unknown` — NOT
 * `partial`. Three consecutive partials would wedge the whole migration chain
 * behind `--force-retry` (apply-migrations.ts); the stage-2 upgrade banner and
 * `gbrain doctor` carry the ongoing nag instead.
 *
 * Host-scoped: apply-migrations runs once per host (global completed.jsonl).
 * Mounted/team brains are covered by the per-brain stage-2 banner + doctor.
 *
 * NOTE: `apply-migrations --dry-run` exits before invoking orchestrators —
 * the `opts.dryRun` path here is exercised by tests, not by that CLI flag.
 */

import { existsSync, readFileSync, mkdirSync, appendFileSync } from 'fs';
import { join } from 'path';

import type {
  Migration,
  OrchestratorOpts,
  OrchestratorResult,
  OrchestratorPhaseResult,
} from './types.ts';
import { loadConfig, loadConfigFileOnly, toEngineConfig, gbrainPath } from '../../core/config.ts';
import { ZEROENTROPY_SUNSET_DATE } from '../../core/ai/defaults.ts';
import { createEngine } from '../../core/engine-factory.ts';
import type { BrainEngine } from '../../core/engine.ts';

const MIGRATION_VERSION = '0.46.3';
const PLAYBOOK_SKILL = 'skills/migrations/v0.46.3.0.md';

function pendingHostWorkDir(): string { return gbrainPath('migrations'); }
function pendingHostWorkPath(): string { return join(pendingHostWorkDir(), 'pending-host-work.jsonl'); }

interface PendingHostWorkEntry {
  migration: string;
  ts: string;
  skill: string;
  reason: string;
}

function existingEntryForVersion(version: string): boolean {
  const p = pendingHostWorkPath();
  if (!existsSync(p)) return false;
  try {
    const raw = readFileSync(p, 'utf-8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed) as PendingHostWorkEntry;
        if (obj.migration === version) return true;
      } catch { /* skip malformed */ }
    }
  } catch { /* read error */ }
  return false;
}

function emitHostWork(reason: string): OrchestratorPhaseResult {
  try {
    if (existingEntryForVersion(MIGRATION_VERSION)) {
      return { name: 'host-work', status: 'skipped', detail: 'already recorded' };
    }
    mkdirSync(pendingHostWorkDir(), { recursive: true });
    const entry: PendingHostWorkEntry = {
      migration: MIGRATION_VERSION,
      ts: new Date().toISOString(),
      skill: PLAYBOOK_SKILL,
      reason,
    };
    // Torn-write guard: a prior crashed writer can leave the file without a
    // trailing newline; appending directly would concatenate onto the torn
    // line, producing one unparseable line that existingEntryForVersion skips
    // forever — losing THE deliverable of this migration. Ensure separation.
    let prefix = '';
    if (existsSync(pendingHostWorkPath())) {
      const raw = readFileSync(pendingHostWorkPath(), 'utf-8');
      if (raw.length > 0 && !raw.endsWith('\n')) prefix = '\n';
    }
    appendFileSync(pendingHostWorkPath(), prefix + JSON.stringify(entry) + '\n');
    return { name: 'host-work', status: 'complete', detail: pendingHostWorkPath() };
  } catch (e) {
    return {
      name: 'host-work',
      status: 'failed',
      detail: e instanceof Error ? e.message : String(e),
    };
  }
}

async function orchestrator(opts: OrchestratorOpts): Promise<OrchestratorResult> {
  const phases: OrchestratorPhaseResult[] = [];

  const config = loadConfig();
  const fileCfg = loadConfigFileOnly();
  if (!config && !fileCfg) {
    // No gbrain install on this host — nothing to notify about.
    phases.push({ name: 'detect', status: 'skipped', detail: 'no brain configured' });
    return { version: MIGRATION_VERSION, status: 'complete', phases };
  }

  let engine: BrainEngine | null = null;
  let exposure: import('../../core/ze-exposure.ts').ZeExposure | null = null;
  try {
    const { detectZeExposure } = await import('../../core/ze-exposure.ts');
    if (config) {
      try {
        engine = await createEngine(toEngineConfig(config));
        await engine.connect(toEngineConfig(config));
      } catch {
        engine = null; // DB probes will fail → tri-state handles it below.
      }
    }
    if (engine) {
      exposure = await detectZeExposure(engine, fileCfg);
      phases.push({
        name: 'detect',
        status: 'complete',
        detail:
          exposure.status === 'unknown'
            ? `exposure_unknown (failed probes: ${exposure.unknownProbes.join(', ')})`
            : exposure.status,
      });
    } else {
      // Config exists but the brain is unreachable: resolution-based exposure
      // still works from the file plane alone; DB-backed probes are unknown.
      // getConfig THROWS (not null): returning null would fabricate verified
      // claims from a DB we never reached — "no ZE custom columns" and "no
      // reranker override" would read as checked when they weren't. Throwing
      // routes those probes into unknownProbes (honest tri-state).
      const fakeEngine = {
        getConfig: async () => {
          throw new Error('brain unreachable');
        },
        executeRaw: async () => {
          throw new Error('brain unreachable');
        },
      } as unknown as BrainEngine;
      exposure = await detectZeExposure(fakeEngine, fileCfg);
      // Force fail-safe posture: probes could not run.
      if (exposure.status === 'clear') {
        exposure = { ...exposure, status: 'unknown', unknownProbes: ['engine_connect'] };
      }
      phases.push({
        name: 'detect',
        status: 'complete',
        detail: `brain unreachable — ${exposure.status}`,
      });
    }
  } catch (e) {
    phases.push({
      name: 'detect',
      status: 'complete',
      detail: `exposure_unknown (${e instanceof Error ? e.message : String(e)})`,
    });
    exposure = null;
  } finally {
    try { await engine?.disconnect(); } catch { /* best-effort */ }
  }

  const status = exposure?.status ?? 'unknown';
  if (status === 'clear') {
    // Unexposed brains complete as a no-op — no nag, no host work.
    return { version: MIGRATION_VERSION, status: 'complete', phases };
  }

  // Exposed OR unknown → print the notice + emit host work (fail-safe: when
  // we can't prove the brain is clear, nag rather than stay silent).
  if (exposure) {
    const { renderZeActionRequired } = await import('../../core/ze-exposure.ts');
    const banner = [
      '',
      '='.repeat(74),
      'ACTION REQUIRED — ZeroEntropy shutdown (v0.46.3 migration notice)',
      '='.repeat(74),
      renderZeActionRequired(exposure),
      '='.repeat(74),
      '',
    ].join('\n');
    // eslint-disable-next-line no-console
    console.error(banner);
  } else {
    // Detection itself crashed (exposure === null): still print a loud,
    // self-contained advisory — the host-work entry alone is silent until an
    // agent reads it, and the whole point of this migration is the notice.
    // eslint-disable-next-line no-console
    console.error(
      [
        '',
        '='.repeat(74),
        'ACTION REQUIRED — ZeroEntropy shutdown (v0.46.3 migration notice)',
        '='.repeat(74),
        'Exposure detection failed on this host, so this brain is treated as',
        `affected until proven otherwise. ZeroEntropy stops working on ${ZEROENTROPY_SUNSET_DATE}.`,
        'Run `gbrain doctor` (provider_sunset) and see the agent playbook:',
        `  ${PLAYBOOK_SKILL}`,
        '='.repeat(74),
        '',
      ].join('\n'),
    );
  }

  if (opts.dryRun) {
    phases.push({ name: 'host-work', status: 'skipped', detail: 'dry-run' });
    return { version: MIGRATION_VERSION, status: 'complete', phases };
  }

  const hostWork = emitHostWork(
    `ZeroEntropy hosted API sunset — embedding/reranker migration required (status: ${status})`,
  );
  phases.push(hostWork);

  // A FAILED host-work write (unwritable ~/.gbrain, full disk) is a different
  // class from `exposure_unknown`: the durable action item — this migration's
  // entire deliverable — was not recorded. Return `partial` so apply-migrations
  // retries on the next run and converges once writable; a persistently
  // unwritable dir earns the loud three-partial WEDGED warning. (`skipped` =
  // already recorded = fine.)
  const failedWrite = hostWork.status === 'failed';

  return {
    version: MIGRATION_VERSION,
    status: failedWrite ? 'partial' : 'complete',
    phases,
    pending_host_work: hostWork.status === 'complete' ? 1 : 0,
  };
}

export const v0_46_3: Migration = {
  version: MIGRATION_VERSION,
  featurePitch: {
    headline:
      'ZeroEntropy is shutting down 2026-09-04 — brains embedding or reranking with it must switch. New default: Voyage (voyage-4 + rerank-2.5, one key).',
    description:
      'Nothing changes automatically: existing brains keep working until the shutdown date. ' +
      'This migration detects whether your brain still resolves to ZeroEntropy (embedding, reranker, or custom columns) ' +
      'and, if so, records an action item for your agent at skills/migrations/v0.46.3.0.md. ' +
      'The one-command fix: `gbrain migrate embeddings --to voyage:voyage-4 --dim 1024 --dry-run` (cost preview), then `--yes`. ' +
      'OpenAI alternative can keep column widths up to 1536 (e.g. a 1280d brain: `--to openai:text-embedding-3-small --dim 1280`); `gbrain doctor` prints this brain\'s exact width-aware command. ' +
      'Reranker: `gbrain config set search.reranker.model voyage:rerank-2.5`.',
  },
  orchestrator,
};
