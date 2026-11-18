**On an experimental Rust brain, the background writer gets two steps further with a queued `gbrain put`: it no longer stops at the scan for parked withdrawal mirrors or at the scan for effect recoveries. PGLite and Postgres brains send the same SQL as before.**

### Changed
- The effect worker's two recovery scans are typed engine calls: `listGatedMirrorRequests` (the withdrawal mirrors parked on the segmented-mirror writer gate) and `listEffectRecoveries` (the effects with a recovery due). Postgres and PGLite send the same SQL text as before, byte for byte, from one module (`src/core/engine-sql/persistence-effect-scans.ts`).
- On a Rust brain both scans answer an empty list, because the Rust store keeps no persistence worktrees. Arguments Postgres refuses are refused the same way: a host id that is not a uuid, a recovery cursor that is not a whole number, and a fractional or negative limit.
