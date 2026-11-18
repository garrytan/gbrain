/**
 * edge_validity (temporal typed edges): how the brain's relationships stand in
 * time and what needs an agent's or the user's attention.
 *
 * Reports relationship state by status (live, ended, ended_unknown_date,
 * disputed, events), relationships whose state lags their evidence (the
 * extract cycle sweeps them), pages that still assert a relationship their
 * own timeline closed (stale compiled truth), open contradiction proposals
 * (and undated ones waiting for a date), plus the resolved read policy
 * (graph.edge_validity) and contradiction mode. Every figure is an indexed
 * count read through BrainEngine edgeValidityCounts; nothing calls a model.
 */
import type { BrainEngine } from '../../../core/engine.ts';
import type { Check } from '../../doctor.ts';
import { connectedEngine, type DoctorContext, type DoctorEntry } from '../context.ts';
import { edgeValidityEnabled } from '../../../core/link-validity.ts';
import { staleRelationshipKeys } from '../../../core/link-relationships.ts';

/** Stale-assertion pages `edge_validity` lists before it reports a floor. */
const STALE_ASSERTION_LIMIT = 20;

export interface EdgeValidityStats {
  read_policy: 'on' | 'off';
  contradiction_mode: string;
  relationships: Record<string, number>;
  lagging: number;
  stale_assertions: Array<{ slug: string; target: string; link_type: string; ended: string | null }>;
  /** #7145: more pages than the listed ones still state an ended relationship. */
  stale_assertions_capped?: true;
  proposals: { proposed: number; undated: number; applied: number };
}

export async function edgeValidityStats(engine: BrainEngine, sourceIds?: readonly string[]): Promise<EdgeValidityStats | null> {
  const counts = await engine.edgeValidityCounts({ sourceIds, staleLimit: STALE_ASSERTION_LIMIT + 1 });
  if (!counts) return null;
  const { byStatus, stale, proposals } = counts;
  const lagging = (await staleRelationshipKeys(engine, 1000)).length;
  return {
    read_policy: (await edgeValidityEnabled(engine)) ? 'on' : 'off',
    contradiction_mode: (await engine.getConfig('dream.edge_contradictions.mode')) ?? 'propose (default)',
    relationships: Object.fromEntries(byStatus.map(r => [r.status, Number(r.n)])),
    lagging,
    stale_assertions: stale.slice(0, STALE_ASSERTION_LIMIT),
    ...(stale.length > STALE_ASSERTION_LIMIT ? { stale_assertions_capped: true } : {}),
    proposals,
  };
}

export function edgeValidityVerdict(stats: EdgeValidityStats | null, opts: { thinClient?: boolean } = {}): Omit<Check, 'name'> {
  if (!stats) return { status: 'ok', message: 'Relationship state tables not present yet (run gbrain apply-migrations).' };
  const host = (cmd: string) => opts.thinClient ? `ask the brain host operator to run: ${cmd}` : `run: ${cmd}`;
  const counts = Object.entries(stats.relationships).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${v} ${k}`).join(', ') || 'none yet';
  const parts = [`relationships: ${counts}`, `read policy ${stats.read_policy}`, `contradiction mode ${stats.contradiction_mode}`];
  const fixes: string[] = [];
  if (stats.lagging > 0) { parts.push(`${stats.lagging}${stats.lagging >= 1000 ? '+' : ''} lag their evidence`); fixes.push(host('gbrain extract --stale (the dream cycle also sweeps them)')); }
  if (stats.stale_assertions.length) {
    const first = stats.stale_assertions[0];
    parts.push(`${stats.stale_assertions.length}${stats.stale_assertions_capped ? '+' : ''} page(s) still state a relationship their timeline ended (e.g. ${first.slug}: ${first.link_type} ${first.target}, ended ${first.ended})`);
    fixes.push(`ask the user before rewriting: ${first.slug} still says ${first.link_type} ${first.target}; the timeline says it ended ${first.ended}`);
  }
  if (stats.proposals.proposed || stats.proposals.undated) {
    parts.push(`${stats.proposals.proposed} contradiction proposal(s) open, ${stats.proposals.undated} waiting for a date`);
    fixes.push(host('gbrain edge-proposals list --json'));
  }
  const warn = stats.stale_assertions.length > 0 || stats.proposals.proposed > 0;
  return {
    status: warn ? 'warn' : 'ok',
    message: `${parts.join('; ')}${fixes.length ? `. Next: ${fixes.join('; ')}` : ''}`,
    details: { ...stats, ...(fixes.length ? { fix: fixes } : {}) },
  };
}

async function runEdgeValidity(ctx: DoctorContext): Promise<Check[]> {
  const engine = connectedEngine(ctx);
  const checks: Check[] = [];
  ctx.progress.heartbeat('edge_validity');
  try {
    const stats = await edgeValidityStats(engine, ctx.orphanRatioSourceId ? [ctx.orphanRatioSourceId] : undefined);
    checks.push({ name: 'edge_validity', ...edgeValidityVerdict(stats) });
  } catch (err) {
    checks.push({ name: 'edge_validity', status: 'warn', message: `Relationship state could not be read: ${err instanceof Error ? err.message : String(err)}. Health is unknown.` });
  }
  return checks;
}

export const edgeValidityEntry: DoctorEntry = { name: 'edge_validity', emits: ['edge_validity'], run: runEdgeValidity };
