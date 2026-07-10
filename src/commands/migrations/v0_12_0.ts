/**
 * v0.12.0 migration orchestrator - Knowledge Graph auto-wire.
 *
 * This migration must be safe in the packaged Windows desktop flow. It runs
 * entirely in-process: no PATH lookup, no gbrain.exe/pmbrain.exe subprocess,
 * and no user-facing manual command requirement.
 */

import type { BrainEngine } from '../../core/engine.ts';
import { loadConfig, toEngineConfig } from '../../core/config.ts';
import { createEngine } from '../../core/engine-factory.ts';
import { extractLinksFromDB, extractTimelineFromDB } from '../extract.ts';
import type { Migration, OrchestratorOpts, OrchestratorResult, OrchestratorPhaseResult } from './types.ts';

interface ConfigCheckResult {
  status: 'enabled' | 'disabled' | 'unknown';
  raw?: string;
}

interface StatsSnapshot {
  page_count: number;
  link_count: number;
  timeline_entry_count: number;
}

async function createMigrationEngine(): Promise<BrainEngine> {
  const cfg = loadConfig();
  if (!cfg) {
    throw new Error('PMBrain config not found; save setup before applying migrations.');
  }
  const engine = await createEngine(toEngineConfig(cfg));
  await engine.connect(toEngineConfig(cfg));
  return engine;
}

async function closeMigrationEngine(engine: BrainEngine): Promise<void> {
  try { await engine.disconnect(); } catch { /* best-effort */ }
}

async function phaseASchema(engine: BrainEngine, opts: OrchestratorOpts): Promise<OrchestratorPhaseResult> {
  if (opts.dryRun) return { name: 'schema', status: 'skipped', detail: 'dry-run' };
  try {
    await engine.initSchema();
    return { name: 'schema', status: 'complete' };
  } catch (e) {
    return { name: 'schema', status: 'failed', detail: e instanceof Error ? e.message : String(e) };
  }
}

async function phaseBConfigCheck(
  engine: BrainEngine,
  opts: OrchestratorOpts,
): Promise<OrchestratorPhaseResult & { autoLink: ConfigCheckResult }> {
  if (opts.dryRun) {
    return { name: 'config', status: 'skipped', detail: 'dry-run', autoLink: { status: 'unknown' } };
  }

  let raw = '';
  try {
    raw = (await engine.getConfig('auto_link') ?? '').trim();
  } catch {
    raw = '';
  }

  const lc = raw.toLowerCase();
  const disabled = ['false', '0', 'no', 'off'].includes(lc);
  const result: ConfigCheckResult = {
    status: disabled ? 'disabled' : (raw === '' ? 'unknown' : 'enabled'),
    raw: raw || undefined,
  };
  if (disabled) {
    console.log('  Note: auto_link is explicitly disabled (config: auto_link=' + raw + ').');
    console.log('  Skipping backfill phases. Re-enable with: pmbrain config set auto_link true');
  }
  return { name: 'config', status: 'complete', detail: result.status, autoLink: result };
}

async function phaseCBackfillLinks(engine: BrainEngine, opts: OrchestratorOpts): Promise<OrchestratorPhaseResult> {
  if (opts.dryRun) return { name: 'backfill_links', status: 'skipped', detail: 'dry-run' };
  try {
    const result = await extractLinksFromDB(engine, false, true, undefined, undefined);
    return { name: 'backfill_links', status: 'complete', detail: `${result.created} links from ${result.pages} pages` };
  } catch (e) {
    return { name: 'backfill_links', status: 'failed', detail: e instanceof Error ? e.message : String(e) };
  }
}

async function phaseDBackfillTimeline(engine: BrainEngine, opts: OrchestratorOpts): Promise<OrchestratorPhaseResult> {
  if (opts.dryRun) return { name: 'backfill_timeline', status: 'skipped', detail: 'dry-run' };
  try {
    const result = await extractTimelineFromDB(engine, false, true, undefined, undefined);
    return { name: 'backfill_timeline', status: 'complete', detail: `${result.created} entries from ${result.pages} pages` };
  } catch (e) {
    return { name: 'backfill_timeline', status: 'failed', detail: e instanceof Error ? e.message : String(e) };
  }
}

async function readStats(engine: BrainEngine): Promise<StatsSnapshot | null> {
  try {
    const stats = await engine.getStats();
    return {
      page_count: stats.page_count,
      link_count: stats.link_count,
      timeline_entry_count: stats.timeline_entry_count,
    };
  } catch {
    return null;
  }
}

async function phaseEVerify(
  engine: BrainEngine,
  opts: OrchestratorOpts,
  autoLinkDisabled: boolean,
): Promise<OrchestratorPhaseResult> {
  if (opts.dryRun) return { name: 'verify', status: 'skipped', detail: 'dry-run' };
  const stats = await readStats(engine);
  if (!stats) {
    return { name: 'verify', status: 'failed', detail: 'could not read PMBrain stats' };
  }

  console.log('');
  console.log('  Brain wire-up:');
  console.log(`    Pages:    ${stats.page_count}`);
  console.log(`    Links:    ${stats.link_count}`);
  console.log(`    Timeline: ${stats.timeline_entry_count}`);

  if (stats.page_count === 0) {
    console.log('  Empty brain - auto-link will wire entities as you write pages.');
    return { name: 'verify', status: 'complete', detail: 'empty_brain' };
  }

  if (autoLinkDisabled) {
    return { name: 'verify', status: 'complete', detail: 'auto_link_disabled_by_user' };
  }

  if (stats.link_count === 0 && stats.page_count > 0) {
    console.log('  Pages present but 0 links extracted. Likely no entity refs in content,');
    console.log('  or all entity refs target slugs that do not exist as pages.');
    console.log('  Try: pmbrain extract links --source db --dry-run');
    return { name: 'verify', status: 'complete', detail: 'no_extractable_refs' };
  }

  console.log('  Graph layer wired up.');
  return { name: 'verify', status: 'complete', detail: 'wired' };
}

async function orchestrator(opts: OrchestratorOpts): Promise<OrchestratorResult> {
  console.log('');
  console.log('=== v0.12.0 - Knowledge Graph auto-wire ===');
  if (opts.dryRun) console.log('  (dry-run; no side effects)');
  console.log('');

  const phases: OrchestratorPhaseResult[] = [];
  if (opts.dryRun) {
    for (const name of ['schema', 'config', 'backfill_links', 'backfill_timeline', 'verify']) {
      phases.push({ name, status: 'skipped', detail: 'dry-run' });
    }
    return finalizeResult(phases, 'complete');
  }

  const engine = await createMigrationEngine();
  try {
    const a = await phaseASchema(engine, opts);
    phases.push(a);
    if (a.status === 'failed') {
      return finalizeResult(phases, 'failed');
    }

    const b = await phaseBConfigCheck(engine, opts);
    phases.push({ name: b.name, status: b.status, detail: b.detail });
    const autoLinkDisabled = b.autoLink.status === 'disabled';

    if (autoLinkDisabled) {
      phases.push({ name: 'backfill_links', status: 'skipped', detail: 'auto_link disabled' });
      phases.push({ name: 'backfill_timeline', status: 'skipped', detail: 'auto_link disabled' });
    } else {
      phases.push(await phaseCBackfillLinks(engine, opts));
      phases.push(await phaseDBackfillTimeline(engine, opts));
    }

    phases.push(await phaseEVerify(engine, opts, autoLinkDisabled));
  } finally {
    await closeMigrationEngine(engine);
  }

  const overallStatus: 'complete' | 'partial' | 'failed' =
    phases.some(p => p.status === 'failed') ? 'partial' : 'complete';

  return finalizeResult(phases, overallStatus);
}

function finalizeResult(
  phases: OrchestratorPhaseResult[],
  status: 'complete' | 'partial' | 'failed',
): OrchestratorResult {
  return {
    version: '0.12.0',
    status,
    phases,
  };
}

export const v0_12_0: Migration = {
  version: '0.12.0',
  featurePitch: {
    headline: 'Knowledge Graph wires itself - every page write extracts typed links automatically',
    description:
      'Every PMBrain put_page now extracts entity references and creates typed links ' +
      '(attended, works_at, invested_in, founded, advises) with zero LLM calls. Hybrid ' +
      'search. Self-wiring graph. Backlink-boosted ranking. Ask "who works at Acme?" or ' +
      '"what did Bob invest in?" - answers vector search alone cannot reach.',
  },
  orchestrator,
};

export const __testing = {
  phaseASchema,
  phaseBConfigCheck,
  phaseCBackfillLinks,
  phaseDBackfillTimeline,
  phaseEVerify,
  readStats,
};
