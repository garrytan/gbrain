import type { Migration } from './types.ts';

export const v088: Migration = {
  version: 88,
  name: 'eval_candidates_schema_pack_per_source',
  // v0.39.0.0 schema-cathedral wave (T4 + T28 + E10 + E11 codex fold).
  // Renumbered v81→v82→v83→v88 across successive master merges. Final
  // renumber landed it after master's v0.38.1.0 agent-loop bundle.
  //
  // Adds `eval_candidates.schema_pack_per_source JSONB` so `gbrain
  // eval replay` reproduces the EXACT per-source closure that the
  // captured query ran against. Without this, a year-old replay
  // against an evolved pack returns different rows than the original
  // capture — eval becomes a moving target.
  //
  // Shape (E11 inline canonical snapshot):
  //   {
  //     "<source_id>": {
  //       "pack_name": "garry-pack",
  //       "pack_version": "1.2.0",
  //       "manifest_sha8": "ab12cd34",
  //       "alias_closure_resolved": {"person": ["person","researcher"], ...}
  //     },
  //     ...
  //   }
  //
  // Inline snapshot (E11): captures the FULL resolved alias graph at
  // query time so replay is self-contained — no dependency on the
  // pack file still existing in ~/.gbrain/schema-packs/. ~1KB per row
  // for a typical 50-type pack; ~10MB/year for a heavy user (10K
  // captured queries). Acceptable storage cost for permanent replay
  // reliability.
  //
  // Codex F8 (replay version-mismatch policy): replay fails closed by
  // default when captured pack identity drifts from the active. Pass
  // --use-captured-snapshot flag to replay against the inline closure
  // anyway.
  //
  // Pack identity = `<pack-name>@<version>+<manifest_sha8>` (codex F7).
  //
  // ADD COLUMN with no DEFAULT (NULL) is metadata-only on Postgres 11+
  // and PGLite 17.5; instant on tables of any size.
  idempotent: true,
  sql: `
      ALTER TABLE eval_candidates
        ADD COLUMN IF NOT EXISTS schema_pack_per_source JSONB NULL;
    `,
};
