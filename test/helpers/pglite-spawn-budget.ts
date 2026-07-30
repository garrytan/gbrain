/**
 * Wall-clock budgets for serial tests that spawn the CLI against a **fresh**
 * PGLite brain.
 *
 * The `gbrain` PATH shim those tests also install lives in
 * `helpers/gbrain-shim.ts` — this file owns budgets only.
 *
 * A fresh PGLite brain is not cheap: `connect()` runs `PGlite.create()`
 * (Postgres compiled to WASM, `initdb` on first open) and then replays the
 * whole `MIGRATIONS` array in `src/core/migrate.ts` — 119 migrations as of
 * v0.42.66.0 — before the command under test does any work. On Linux/macOS CI
 * that lands inside the old 30-90s budgets. On Windows it does not.
 *
 * Measured on Windows 11 / 12 logical cores, Bun 1.x, PGLite file-backed under
 * `%TEMP%`, with 9-11 competing `bun` processes (the realistic dev-box case):
 *
 *   | what                                        | n | observed          |
 *   |---------------------------------------------|---|-------------------|
 *   | `bun run src/cli.ts --version` (spawn floor) | 2 | 11.3s / 28.9s     |
 *   | `init --migrate-only` (cold, 119 migrations) | 4 | 109-196s          |
 *   | `apply-migrations --yes` (full cascade)      | 1 | 698.3s            |
 *   | `apply-migrations --yes` (2nd run)           | 2 | 161s / 183s       |
 *   | `serve --http` → first 200 on `/health`      | 2 | 199s / 182s       |
 *   | `apply-migrations --list`                    | 3 | 8.0s-16.7s        |
 *
 * Worth knowing before anyone "optimises" the 119 migrations: they are not the
 * cost. Timestamping every `[N] name...` / `[N] ✓ name` line runMigrations
 * writes shows a 109.2s cold init split as ~89.9s BEFORE the first migration
 * line (bun start + `PGlite.create()` initdb + the schema blob), ~15s for all
 * 119 migrations together (median 0ms each), and ~4s after. Squashing the
 * migration list buys ~15s of ~110s. The lever that would actually matter is
 * the `GBRAIN_PGLITE_SNAPSHOT` fast-restore in `core/pglite-engine.ts`, which
 * today only applies to in-memory brains — these tests use file-backed ones.
 *
 * The budgets below are sized off the WORST observed value, not the mean,
 * because the spread is the point: two back-to-back reps of the same spawn
 * measured 11.3s and 28.9s (2.5x) purely from box contention. A budget at
 * 1.5x the max — the headroom `scripts/run-unit-parallel.sh` uses for its
 * shard cap — would re-introduce exactly the flake it is meant to prevent.
 *
 * These are ceilings for reporting a hang, NOT latency targets. Nothing gets
 * slower by raising them; a genuinely wedged run (the PGLite single-writer
 * lock deadlock `apply-migrations-pglite-spawn.serial.test.ts` guards) never
 * finishes and still trips them.
 *
 * Override per-run, e.g. on a slower box or when bisecting a real hang:
 *
 *   GBRAIN_TEST_PGLITE_BOOTSTRAP_MS=900000 bun test --max-concurrency=1 <file>
 *   GBRAIN_TEST_CASCADE_MS=300000 bun test --max-concurrency=1 <file>
 *   GBRAIN_TEST_CLI_SPAWN_MS=30000 bun test --max-concurrency=1 <file>
 *
 * To skip these files entirely in an inner edit loop, the repo's existing
 * `GBRAIN_SKIP_SUBPROCESS_TESTS=1` still applies.
 */
function resolveMs(envVar: string, fallbackMs: number): number {
  const raw = process.env[envVar];
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return fallbackMs;
}

/**
 * Budget for one CLI spawn that pays a cold PGLite bootstrap and then stops:
 * `init --migrate-only`, `serve --http` reaching `/health`, or a re-run of
 * `apply-migrations --yes` against an already-migrated brain (161s / 183s).
 * 420s ≈ 2.1x the 199.3s worst case measured above.
 *
 * NOT for the first `apply-migrations --yes` — see ORCHESTRATOR_CASCADE_MS.
 */
export const PGLITE_BOOTSTRAP_MS = resolveMs('GBRAIN_TEST_PGLITE_BOOTSTRAP_MS', 420_000);

/**
 * Budget for a CLI spawn that does NOT rebuild the schema (`--list`, a plain
 * HTTP GET against an already-running server). 120s ≈ 4x the 28.9s worst-case
 * cold-spawn floor, which dominates these — the command's own work is <2s.
 */
export const CLI_SPAWN_MS = resolveMs('GBRAIN_TEST_CLI_SPAWN_MS', 120_000);

/**
 * Budget for `apply-migrations --yes`, which is a WHOLE different cost class
 * from one bootstrap and must not reuse `PGLITE_BOOTSTRAP_MS`.
 *
 * It walks all 19 orchestrator migrations, and those shell out — 24
 * `execSync`/`runGbrainSubprocess` sites across `src/commands/migrations/*.ts`.
 * Each is a fresh Windows `bun` spawn. A full cascade against a fresh brain,
 * timestamped per orchestrator, measured **698.3s end-to-end, exit 0**:
 *
 *   v0.11.0  13.3s →  81.0s     v0.18.0  505s → 544s
 *   v0.12.0  81.0s → 219.0s     v0.18.1  544s → 615s
 *   v0.12.2 219.0s → 365.0s     v0.21.0  615s → 639s
 *   v0.13.0 365.0s → 477.2s     v0.22.4  639s → 669s
 *   v0.13.1 477.2s → 496.1s     v0.28.0 …  v0.32.2 → done at 698.3s
 *
 * That 698.3s predates the `readStats()` fix in `migrations/v0_12_0.ts`, where a
 * POSIX `2>/dev/null` inside an execSync string made cmd.exe burn a full 30s+
 * timeout and print `Access is denied.` — v0.12.0 and v0.12.2 alone cost ~280s
 * on that account. After the fix the same cascade measured **335.3s, exit 0**.
 *
 * 1500s is still the right number, because the 335s run happened on an unusually
 * quiet box: its `init` leg took 56.8s against the 109-196s seen everywhere else,
 * i.e. ~2x faster than typical. Scaled back to normal contention that cascade is
 * ~650s, and 1500s ≈ 2.1x it — the same multiplier applied to the bootstrap class
 * above, so both budgets are derived the same way rather than hand-picked.
 *
 * On Linux CI none of this bites, which is why the original 180s literal worked
 * there: no per-spawn cold-start tax. If this budget ever starts tripping, look
 * for a NEW stalled subprocess — do not just grow the number.
 */
export const ORCHESTRATOR_CASCADE_MS = resolveMs('GBRAIN_TEST_CASCADE_MS', 1_500_000);
