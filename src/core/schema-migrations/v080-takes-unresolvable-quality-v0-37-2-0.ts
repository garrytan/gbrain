import type { Migration } from './types.ts';

export const v080: Migration = {
  version: 80,
  name: 'takes_unresolvable_quality_v0_37_2_0',
  // v0.37.2.0 hotfix (master) — accepts quality='unresolvable' as a 4th
  // valid resolution state. Unblocks production grading scripts that write
  // the 4th verdict type (the judge in grade-takes returns
  // correct|incorrect|partial|unresolvable, but v37's CHECKs only allowed
  // the first three).
  //
  // Two CHECKs to widen:
  //   (a) Table-level `takes_resolution_consistency` enumerates valid
  //       (quality, outcome) pairs. We add ('unresolvable', NULL).
  //   (b) Column-level CHECK on resolved_quality enumerates valid string
  //       values. Postgres auto-names this `takes_resolved_quality_check`
  //       when it's attached via ADD COLUMN ... CHECK. We drop it and
  //       re-add with the wider value list (named explicitly this time
  //       so future widening targets a known name).
  //
  // v0.38 note: master's v80 (this migration) shipped to master between
  // when this branch cut and the v0.38 ship. The v0.38 schema-pack
  // migrations renumbered to v81 + v82 to land cleanly above it. Order
  // matters because v80 drops + re-adds takes_resolved_quality_values
  // and v81 will drop takes_kind_check — both touch the takes table but
  // different constraints, no ordering hazard between them.
  idempotent: true,
  sql: `
      -- (b) Drop both possible names for the column-level CHECK:
      ALTER TABLE takes DROP CONSTRAINT IF EXISTS takes_resolved_quality_check;
      ALTER TABLE takes DROP CONSTRAINT IF EXISTS takes_resolved_quality_values;
      ALTER TABLE takes ADD CONSTRAINT takes_resolved_quality_values CHECK (
        resolved_quality IS NULL
        OR resolved_quality IN ('correct', 'incorrect', 'partial', 'unresolvable')
      );

      -- (a) Widen the (quality, outcome) consistency CHECK.
      ALTER TABLE takes DROP CONSTRAINT IF EXISTS takes_resolution_consistency;
      ALTER TABLE takes ADD CONSTRAINT takes_resolution_consistency CHECK (
        (resolved_quality IS NULL             AND resolved_outcome IS NULL)
        OR (resolved_quality = 'correct'      AND resolved_outcome = true)
        OR (resolved_quality = 'incorrect'    AND resolved_outcome = false)
        OR (resolved_quality = 'partial'      AND resolved_outcome IS NULL)
        OR (resolved_quality = 'unresolvable' AND resolved_outcome IS NULL)
      );
    `,
};
