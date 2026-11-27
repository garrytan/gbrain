import type { BrainEngine } from '../engine.ts';
import type { PageReadScope } from '../types.ts';
import { isEngineCapabilityRefusal } from '../engine-capability-refusal.ts';

export interface ProjectionReadinessScope extends PageReadScope {
  pageKind?: string;
  types?: string[];
  excludeSlugPrefixes?: string[];
}

/**
 * `by_design` (#6803): the only unsealed pages in scope are protected-OCR images,
 * which no repair seals (archived sources are already outside every live read).
 */
export interface ProjectionReadiness {
  status: 'ready' | 'projection_pending' | 'by_design' | 'unknown';
  ready: boolean;
  hint?: string;
}

/** The engine's readiness read (engine-sql/retrieval-coverage.ts): what the probe turns into a status. */
export interface ProjectionReadinessRow { pending: boolean; by_design: boolean }

type ReadinessEngine = Pick<BrainEngine, 'readProjectionReadinessGeneration' | 'readProjectionReadiness'>;

export const PROJECTION_READINESS_CACHE_ENV = 'GBRAIN_PROJECTION_READINESS_CACHE';
const MAX_ENTRIES_PER_ENGINE = 256;
let readinessCache = new WeakMap<object, Map<string, { generation: string; value: ProjectionReadiness }>>();

/** Test seam: forget every cached answer. */
export function __resetProjectionReadinessCacheForTests(): void { readinessCache = new WeakMap(); }

/** Every input the probe's SQL reads from the caller, normalized so equal scopes share one key. */
function scopeKey(scope: ProjectionReadinessScope): string {
  const sorted = (values?: string[]) => values === undefined ? null : [...new Set(values)].sort();
  return JSON.stringify([scope.sourceId ?? null, sorted(scope.sourceIds), scope.excludePrivate === true, scope.requireSafeChunks === true,
    scope.minTrust ?? null, scope.suppressFlagged === true, scope.pageKind ?? null, sorted(scope.types), sorted(scope.excludeSlugPrefixes)]);
}

/**
 * Whether the current text projections cover the visible scope. A repeat
 * call for the same scope reuses the last answer while the generation it was
 * computed under still holds (`readProjectionReadinessGeneration`: the page
 * clock, the pages relation file and the sources' archived flags; null, so
 * never cached, while this transaction has written or another session holds
 * a write on `pages`, or on an engine without one; a transaction open
 * elsewhere on the server leaves it on); `GBRAIN_PROJECTION_READINESS_CACHE=0`
 * always probes. An `unknown`
 * answer (the probe failed) is never reused. A refused engine capability is
 * not a failed probe: it throws (engine-capability-refusal.ts).
 */
export async function probeProjectionReadiness(
  engine: ReadinessEngine,
  scope: ProjectionReadinessScope = {},
): Promise<ProjectionReadiness> {
  if (process.env[PROJECTION_READINESS_CACHE_ENV] === '0') return probeUncached(engine, scope);
  const generation = await engine.readProjectionReadinessGeneration();
  if (generation === null) return probeUncached(engine, scope);
  const key = scopeKey(scope);
  let entries = readinessCache.get(engine);
  const hit = entries?.get(key);
  if (hit?.generation === generation) return hit.value;
  const value = await probeUncached(engine, scope);
  if (value.status === 'unknown') return value;
  if (!entries) readinessCache.set(engine, entries = new Map());
  if (entries.size >= MAX_ENTRIES_PER_ENGINE) entries.clear();
  entries.set(key, { generation, value });
  return value;
}

async function probeUncached(engine: ReadinessEngine, scope: ProjectionReadinessScope): Promise<ProjectionReadiness> {
  let row: ProjectionReadinessRow;
  try {
    row = await engine.readProjectionReadiness(scope);
    if (typeof row?.pending !== 'boolean') throw new Error('Invalid readiness result');
  } catch (err) {
    if (isEngineCapabilityRefusal(err)) throw err;
    return {
      status: 'unknown', ready: false,
      hint: 'Projection readiness could not be checked; do not treat these results as proof of a complete index. Run `gbrain doctor` locally to diagnose.',
    };
  }
  if (row.pending) {
    return {
      status: 'projection_pending', ready: false,
      hint: 'Current text projections are pending in the visible scope; results may be incomplete. Run `gbrain doctor` locally to inspect recovery. This read does not repair or embed content.',
    };
  }
  return { status: row.by_design ? 'by_design' : 'ready', ready: true };
}
