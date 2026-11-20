# The brain store: Calibration profiles

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

The `calibration_profiles` table: one row per generated calibration profile of a holder in a source. The
`calibration_profile` cycle phase writes it, `gbrain calibration` and the MCP `get_calibration_profile` op read the
newest row, the brainstorm and doctor checks read its bias tags and freshness, and `undo-wave` deletes a wave's rows.
This landing adds the native store and its N-API binding only. The shared SQL module
(`src/core/engine-sql/calibration-profiles.ts`) and the TypeScript members that would route a Rust brain here arrive in a
later landing, so nothing in TypeScript calls these members yet and no cross-engine parity file exists. Once wired, the
store serves the same five members as PGLite and Postgres. Timestamps cross the binding as ISO strings; the TypeScript members turn them into `Date`s. All five
members are in the `eval_capture` capability.

Keys (under `Z`, the eval-capture tag, in `eval_capture/calibration_profiles.rs`):

- `Z 0x20 <id u64 BE>` holds the row (JSON). Ids come from the counter `M calibration_profile_next_id`; a deleted
  row's id is never reused and a refused insert takes no id.
- `Z 0x21 <!(generated_at_us ^ 1<<63) BE8> <!id BE8>` holds the id: a time index. A forward scan reads the newest row
  first and, on one instant, the highest id first, which is `ORDER BY generated_at DESC, id DESC`.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.getLatestCalibrationProfile({ holder?, sourceId?, sourceIds? }?)` | the newest row that matches, or `null`. `holder` absent reads any holder. `sourceIds` present (even empty) wins over `sourceId`; an empty list matches nothing; an empty `sourceId` is no filter. The row has 16 columns: `id` (text), `source_id`, `holder`, `wave_version`, `generated_at` (ISO), `published`, `total_resolved`, `brier`, `accuracy`, `partial_rate`, `grade_completion`, `pattern_statements`, `active_bias_tags`, `voice_gate_passed`, `voice_gate_attempts`, `model_id` | `getLatestCalibrationProfile` |
| `brain.isCalibrationProfileUnchanged({ sourceId, holder, totalResolved, brier, accuracy, partialRate, modelId })` | whether the latest row of that source and holder holds this scorecard and model. REAL columns compare as `f32`; null equals null; no row is `false`. `invalid_argument` for a total outside `int4` | `isCalibrationProfileUnchanged` |
| `brain.insertCalibrationProfile(row)` | `null`. `generatedAt` (ISO), `waveVersion` and `published` are optional and default to now, `v0.36.1.0` and `false`. `constraint_violation` for a `NOT NULL` column left null; `invalid_argument` for a NUL byte, a bad timestamp, a number that is not a whole `int4` (`totalResolved`) or `int2` (`voiceGateAttempts`), or a double that overflows `REAL`; `source_not_found` when the source does not exist (the foreign key) | `insertCalibrationProfile` |
| `brain.readVoiceGateHealth(sourceIds?)` | `{ total, failures }` over rows with `generated_at >= now - 7 days` (no upper bound), of `sourceIds` when given (an empty list matches nothing); `failures` counts `voice_gate_passed = false` | `readVoiceGateHealth` |
| `brain.purgeCalibrationProfilesByWave(waveVersion, dryRun)` | the number of rows of that `wave_version`; unless `dryRun`, they are deleted (with their index entries) | `purgeCalibrationProfilesByWave` |

REAL columns (`brier`, `accuracy`, `partial_rate`, `grade_completion`) are kept as `f32` and read back as the shortest
decimal that names that `f32`, so `0.3` reads `0.3` on every engine. `cost_usd` and `judge_model_agreement` are always
null (no writer sets them) and are not stored. `domain_scorecards` is stored as sent; no member returns it.

Differences from PGLite:

- The newest-row tie-break `id DESC` and the `id` as text are new in the shared SQL, so all engines agree once the shared SQL
  lands; the old statements left ties to the planner.
- A NaN or infinite `REAL` value is native-only input, and the store refuses it with `invalid_argument` on both a write
  (`insertCalibrationProfile`) and a read (`isCalibrationProfileUnchanged`, whose `brier`, `accuracy` and `partialRate`
  are `REAL` parameters). PGLite and Postgres accept a `real` NaN, and `NaN IS NOT DISTINCT FROM NaN` is true there, so
  this refusal is a deliberate divergence.

Gaps:

- `undo-wave` also deletes `takes`, `take_grade_cache` and `take_nudge_log` rows through raw SQL. Only the
  `calibration_profiles` statement is a member; on a Rust brain the rest refuse (`engine_capability_missing`) until
  those tables are served.
- `eval_capture::calibration_profiles::remove_source_rows` (the `ON DELETE CASCADE` of the source foreign key) is wired
  into `cascade::remove_source_rows` and unit-tested, but the Rust store serves no source delete yet, so nothing calls
  it outside the tests.
