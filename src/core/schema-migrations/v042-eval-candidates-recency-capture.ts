import type { Migration } from './types.ts';

export const v042: Migration = {
  version: 42,
  name: 'eval_candidates_recency_capture',
  // v0.29.1 — capture agent-explicit recency + salience choices for replay
  // reproducibility (D11 codex resolution).
  //
  // Without these fields, `gbrain eval replay` cannot reproduce a captured
  // run: the live behavior depends on the resolved {salience, recency}
  // values, which are absent from v0.29.0's eval_candidates schema. Replays
  // of agent-explicit choices drift the same way as_of_ts replays drifted
  // before being captured.
  //
  // All columns are nullable + additive. Pre-v0.29.1 rows stay valid. The
  // NDJSON `schema_version` STAYS at 1 — the new fields are optional, and
  // gbrain-evals consumers that don't know about them ignore them
  // (standard permissive deserialization). No cross-repo coordination
  // required (codex pass-1 #C2 dissolved).
  //
  //   as_of_ts            — brain's logical NOW at capture (replay uses
  //                         this instead of wall-clock so old captures
  //                         reproduce identically against today's brain).
  //   salience_param      — what the caller passed (or NULL if omitted).
  //   recency_param       — same for recency.
  //   salience_resolved   — final value applied ('off' / 'on' / 'strong').
  //   recency_resolved    — same for recency.
  //   salience_source     — 'caller' or 'auto_heuristic'.
  //   recency_source      — same for recency.
  //
  // ADD COLUMN with no DEFAULT is metadata-only on PG 11+ and PGLite —
  // instant on tables of any size.
  sql: `
      ALTER TABLE eval_candidates ADD COLUMN IF NOT EXISTS as_of_ts          TIMESTAMPTZ;
      ALTER TABLE eval_candidates ADD COLUMN IF NOT EXISTS salience_param    TEXT;
      ALTER TABLE eval_candidates ADD COLUMN IF NOT EXISTS recency_param     TEXT;
      ALTER TABLE eval_candidates ADD COLUMN IF NOT EXISTS salience_resolved TEXT;
      ALTER TABLE eval_candidates ADD COLUMN IF NOT EXISTS recency_resolved  TEXT;
      ALTER TABLE eval_candidates ADD COLUMN IF NOT EXISTS salience_source   TEXT;
      ALTER TABLE eval_candidates ADD COLUMN IF NOT EXISTS recency_source    TEXT;
    `,
};
