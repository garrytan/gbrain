**The autopilot's no-worker probe, atom auto-drain, source cooldown and idle checks no longer turn a Rust brain's "this engine cannot do that" into a quiet default.**

### Fixed
- The no-worker probe, the atom auto-drain submit and the per-source failure-cooldown read caught every error and carried on, so on a Rust brain the warning never fired, no source was drained and no cooldown applied, with nothing saying why. Each now lets the engine's `engine_capability_missing` refusal through; any other error is handled as before.
- The claim-time cooldown guard read the source row with raw SQL and, when that failed, treated the source as having never succeeded. It now reads it with `getSource`, so a Rust brain answers as PGLite and Postgres do.
- The self-upgrade idle check counted queued jobs with raw SQL and answered "not idle" on any error. It now counts them with `countJobsByStatus` and lets a capability refusal through.
