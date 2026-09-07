/**
 * trajectory-route.ts — the per-question trajectory lookup behind the
 * harness's trajectory routing (temporal / knowledge_update intents): extract
 * candidate entities from the question + retrieved slugs, resolve each to a
 * slug, and render the first non-empty trajectory block. Peeled from
 * src/commands/eval-longmemeval.ts.
 *
 * INVARIANT: best-effort. Any error (or a 5s findTrajectory stall) degrades to
 * "no block injected" — a routing failure never fails the question.
 */

import type { PGLiteEngine } from '../../core/pglite-engine.ts';
import type { TrajectoryPoint } from '../../core/engine.ts';
import { extractCandidateEntities } from '../../core/think/entity-extract.ts';
import { resolveEntitySlugWithSource, type ResolutionSource } from '../../core/entities/resolve.ts';
import { formatTrajectoryBlock } from '../../core/trajectory-format.ts';
import type { Intent } from './intent.ts';

export interface TrajectoryRoute {
  /** Rendered block for the reader prompt; empty when nothing was found. */
  block: string;
  points: number;
  entityResolved: string | null;
  resolutionSource: ResolutionSource | null;
}

export const EMPTY_TRAJECTORY_ROUTE: TrajectoryRoute = { block: '', points: 0, entityResolved: null, resolutionSource: null };

export async function routeTrajectory(
  engine: PGLiteEngine,
  question: string,
  retrievedSlugs: readonly string[],
  intent: Intent,
): Promise<TrajectoryRoute> {
  try {
    const candidates = extractCandidateEntities(question, [...retrievedSlugs]);
    for (const cand of candidates) {
      const resolved = await resolveEntitySlugWithSource(engine, 'default', cand.raw);
      if (!resolved) continue;
      // Unlike the think production path, the harness does NOT skip
      // fallback_slugify results: the extractor and the lookup both slugify
      // free-form entity names, so they cohere on the same fallback slug
      // and there are no canonical pages in the benchmark to protect.
      const points = await Promise.race([
        engine.findTrajectory({ entitySlug: resolved.slug, sourceId: 'default', remote: false, kind: 'all', limit: 100 }),
        new Promise<TrajectoryPoint[]>(resolve => { setTimeout(() => resolve([]), 5000); }),
      ]);
      if (points.length === 0) continue;
      const fmt = formatTrajectoryBlock(points, resolved.slug, { intent });
      if (fmt.rendered.length === 0) continue;
      return { block: fmt.rendered, points: fmt.emittedPoints, entityResolved: resolved.slug, resolutionSource: resolved.source };
    }
  } catch {
    // Best-effort: any error degrades to "no block injected".
  }
  return EMPTY_TRAJECTORY_ROUTE;
}
