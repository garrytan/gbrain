/**
 * Pre-test setup: redirect audit-writer output (content-sanity,
 * shell-audit, supervisor-audit, slug-fallback, etc. — every module built
 * on `src/core/audit/audit-writer.ts`) to a per-run scratch directory
 * instead of the operator's real `~/.gbrain/audit/`.
 *
 * Why this exists (#2823): `audit-writer.ts::resolveAuditDir()` honors a
 * `GBRAIN_AUDIT_DIR` env override, but nothing in the shared test bootstrap
 * ever set it. Any test that exercises an audit-emitting code path without
 * wrapping the call in its own `withEnv({ GBRAIN_AUDIT_DIR: ... })` (most
 * don't — only the content-sanity-focused suites did) fell through to the
 * real default and appended fixture rows into the operator's live audit
 * trail. `test/import-file.test.ts`'s oversize-content boundary fixture
 * (`'borderline-slug'`, content just under `MAX_FILE_SIZE` but over
 * `DEFAULT_BYTES_BLOCK`) is the concrete offender named in the issue: it
 * fires a real `soft_block` content-sanity event on every run, landing in
 * `~/.gbrain/audit/content-sanity-YYYY-Www.jsonl` right alongside real
 * production signal that doctor's `content_sanity_audit_recent` check
 * reads.
 *
 * Fix: set `GBRAIN_AUDIT_DIR` once, globally, before any test file loads,
 * to a fresh `mkdtemp` directory unique to THIS process. Each
 * `scripts/run-unit-shard.sh` shard is its own `bun test` process, so each
 * shard gets its own scratch dir automatically — no cross-shard collision,
 * no manual cleanup needed (short-lived test process; OS reaps tmp, same
 * tradeoff `test/helpers/with-env.ts`'s `emptyHome()` documents).
 *
 * Individual test files that already manage their own isolated
 * `GBRAIN_AUDIT_DIR` per-test via `withEnv` (e.g.
 * `test/import-file-content-sanity.test.ts`, `test/audit/content-sanity-audit.test.ts`)
 * are unaffected — `withEnv` saves/restores around whatever this preload
 * set as the process-global default, same as any other env var.
 *
 * Only sets the var if it isn't already set, so a developer who exports
 * `GBRAIN_AUDIT_DIR` themselves (e.g. to inspect audit output after a
 * local run) keeps their override.
 *
 * Imported by `bunfig.toml` via
 * `preload = [..., "./test/helpers/audit-dir-preload.ts"]`.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (!process.env.GBRAIN_AUDIT_DIR) {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-test-audit-'));
  process.env.GBRAIN_AUDIT_DIR = dir;
  if (process.env.GBRAIN_DEBUG_PRELOAD === '1') {
    console.error(`[audit-dir-preload] GBRAIN_AUDIT_DIR=${dir}`);
  }
}
