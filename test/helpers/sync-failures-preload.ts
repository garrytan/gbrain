/**
 * Pre-test setup: redirect the sync failure ledger to a per-run scratch
 * directory instead of the operator's real `~/.gbrain/sync-failures.jsonl`.
 *
 * Why this exists: the suite deliberately exercises broken-fixture import and
 * sync paths (bad frontmatter, slug mismatches, unparseable YAML). Every one of
 * those records a row through `src/core/sync-failure-ledger.ts`, which resolved
 * to the gbrain home with no override — so fixture failures appended straight
 * into the operator's live ledger. That file is not inert: `gbrain doctor` reads
 * it and keeps warning until each entry is fixed or acknowledged, and the rows
 * carry commit attribution, so a fabricated `srcE / notes/bad.md` row looks
 * exactly like a real un-indexed page.
 *
 * Same shape and rationale as `audit-dir-preload.ts` (#2823), and deliberately a
 * DEDICATED var rather than a global `GBRAIN_HOME` redirect: pointing
 * GBRAIN_HOME at a scratch dir for the whole suite would also make
 * `loadConfig()` return null for every test that reads the real config — a much
 * wider blast radius than this problem needs, and
 * `test/gbrain-home-isolation.test.ts` asserts the unset-fallback behavior
 * directly.
 *
 * Each `scripts/run-unit-shard.sh` shard is its own `bun test` process, so each
 * gets its own scratch dir — no cross-shard collision, no cleanup needed (the
 * OS reaps tmp, the same tradeoff `test/helpers/with-env.ts` documents).
 *
 * Only sets the var if it isn't already set, so a developer who exports it to
 * inspect ledger output after a local run keeps their override. Tests that
 * manage their own value per-test via `withEnv` are unaffected.
 *
 * Imported by `bunfig.toml` via `preload`.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (!process.env.GBRAIN_SYNC_FAILURES_DIR) {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-test-syncfail-'));
  process.env.GBRAIN_SYNC_FAILURES_DIR = dir;
  if (process.env.GBRAIN_DEBUG_PRELOAD === '1') {
    console.error(`[sync-failures-preload] GBRAIN_SYNC_FAILURES_DIR=${dir}`);
  }
}
