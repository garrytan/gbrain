/**
 * Scenario S9 — Broad synthesis prefers curated over map edges.
 *
 * Falsifies L2: "Prefer curated Markdown over inferred map edges when the
 * two disagree in emphasis or confidence."
 *
 * Current gap (spec §5): `broad-synthesis-route-service.ts` returns
 * `matched_nodes` from the map query as the primary payload. The service
 * does not co-present canonical curated notes and map-derived edges, so
 * there is no ranking step that can prefer curated over map. The redesign
 * treats this as a contract invariant; the code will need a ranking layer
 * that (a) separates canonical vs derived sources in the return shape and
 * (b) surfaces the curated claim first when the two disagree.
 *
 * Until that lands, S9 is a todo marker visible in the scenario index.
 */

import { describe, test } from 'bun:test';

describe('S9 — canonical-first synthesis', () => {
  test.todo(
    'S9 — broad synthesis returns curated note before map-derived edge when both exist for the same entity (spec §5, fix: add ranking step in broad-synthesis-route-service)',
    () => {},
  );

  test.todo(
    'S9 contradiction surface — when curated and map disagree, the map-derived claim becomes a Memory Candidate instead of co-equal synthesis material',
    () => {},
  );
});
