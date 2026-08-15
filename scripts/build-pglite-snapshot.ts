#!/usr/bin/env bun
// scripts/build-pglite-snapshot.ts
//
// TZ pinned to UTC BEFORE any PGLite work: dumpDataDir bakes this process's
// TimeZone into the tar's cluster defaults. Building under the host zone made
// restored engines run sessions in the build machine's zone (the engine also
// re-pins at restore — this is the belt to that suspender, and it keeps any
// OTHER zone-derived state baked into the tar deterministic across hosts).
process.env.TZ = 'UTC';
//
// Tier 3 fast-restore: boot a fresh PGLite, run the full initSchema (forward
// bootstrap + PGLITE_SCHEMA_SQL + every migration), dump the post-init state
// to a tar fixture. Test files that read GBRAIN_PGLITE_SNAPSHOT can skip the
// 1-3 seconds of cold init and load the post-schema state directly.
//
// Output: test/fixtures/pglite-snapshot.tar (binary, gitignored)
//         test/fixtures/pglite-snapshot.version (hex SHA256 of MIGRATIONS SQL)
//
// The version file lets the engine detect snapshot staleness — if the tar's
// recorded version doesn't match the current MIGRATIONS hash, the engine
// ignores the snapshot and runs a normal initSchema.
//
// Run: bun run scripts/build-pglite-snapshot.ts
//      (or: bun run build:pglite-snapshot)
//
// Re-run whenever you touch src/core/migrate.ts or src/schema.sql.

import { writeFileSync, mkdirSync, existsSync, readFileSync, rmdirSync, rmSync, mkdtempSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import * as crypto from "node:crypto";

import { configureGateway, getEmbeddingDimensions, getEmbeddingModel } from "../src/core/ai/gateway.ts";
import { LEGACY_EMBEDDING_CONFIG } from "../test/helpers/legacy-embedding-config.ts";

import { PGLiteEngine, computeSnapshotSchemaHash } from "../src/core/pglite-engine.ts";
import { MIGRATIONS } from "../src/core/migrate.ts";
import { PGLITE_SCHEMA_SQL } from "../src/core/pglite-schema.ts";

function computeSchemaHash(): string {
  return computeSnapshotSchemaHash(MIGRATIONS, PGLITE_SCHEMA_SQL, crypto);
}

async function main() {
  const fixturePath = "test/fixtures/pglite-snapshot.tar";
  const versionPath = "test/fixtures/pglite-snapshot.version";
  const lockPath = "test/fixtures/.pglite-snapshot.lock";
  mkdirSync(dirname(fixturePath), { recursive: true });

  // W0 fix-wave: build under the EXACT embedding shape the test suite pins.
  // bunfig.toml preloads test/helpers/legacy-embedding-preload.ts, which
  // configures the gateway to the shared LEGACY_EMBEDDING_CONFIG (OpenAI
  // 1536-d) for every `bun test` file — so the snapshot's baked vector(dims)
  // columns MUST match that shape, not the builder machine's ambient config
  // (nor the shipped 1280-d default an unconfigured gateway falls back to).
  // Set in main(), not module scope: ESM hoists imports, so module-scope
  // placement implied an ordering it never had — config reads are lazy.
  configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: { ...process.env } });

  const schemaHash = computeSchemaHash();

  // W0 fix-wave (Tier-1 #16): idempotent short-circuit. Runners now call this
  // script UNCONDITIONALLY (build-if-missing left stale-but-present snapshots
  // permanently on the warn+slow path); a fresh snapshot exits in ~ms.
  const isFresh = () => {
    if (!existsSync(fixturePath) || !existsSync(versionPath)) return false;
    const lines = readFileSync(versionPath, "utf-8").trim().split("\n");
    return lines[0] === schemaHash
      && lines[1] === `dims=${getEmbeddingDimensions()}`
      && lines[2] === `model=${getEmbeddingModel()}`;
  };
  if (isFresh()) {
    console.log(`[build-pglite-snapshot] up to date (hash ${schemaHash.slice(0, 16)}...) — nothing to do`);
    return;
  }

  // GBRAIN_HOME isolation is only needed once we actually BUILD (the engine
  // boot reads config). Red-team catch: creating it before the isFresh()
  // short-circuit leaked one temp dir per invocation on the COMMON path
  // (this script runs on every `bun run test`).
  const hermeticHome = mkdtempSync(join(tmpdir(), "gbrain-snapshot-hermetic-"));
  process.env.GBRAIN_HOME = hermeticHome;

  // W0 fix-wave (D5.8): concurrency lock. Parallel shard runners / concurrent
  // Conductor workspaces invoking this simultaneously must not tear the tar.
  // mkdir is atomic; the loser polls until the winner finishes, then
  // re-checks freshness and exits.
  let ownLock = false;
  try {
    mkdirSync(lockPath);
    ownLock = true;
  } catch {
    console.log(`[build-pglite-snapshot] another builder holds ${lockPath}; waiting...`);
    const timeoutMs = Number(process.env.GBRAIN_SNAPSHOT_LOCK_TIMEOUT_MS) || 120_000;
    const deadline = Date.now() + timeoutMs;
    while (existsSync(lockPath) && Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 250));
    }
    if (isFresh()) {
      console.log(`[build-pglite-snapshot] concurrent builder finished; snapshot fresh`);
      return;
    }
    // Stale lock (crashed builder) or still-stale snapshot: TAKE OVER.
    // W0 ship-review catch: mkdirSync on a still-existing dir always throws
    // EEXIST — the original retry could never acquire, so a single crashed
    // builder left every future rebuild waiting the full deadline and then
    // proceeding UNLOCKED forever (the stale dir was never removed).
    // Red-team refinement: verify STALENESS (lock dir mtime older than the
    // full wait window) before the rmdir — two exhausted waiters would
    // otherwise each rmdir+mkdir and the second would steal the first's
    // just-created LIVE lock, re-opening the torn-tar window.
    try {
      if (existsSync(lockPath)) {
        const ageMs = Date.now() - statSync(lockPath).mtimeMs;
        if (ageMs > timeoutMs) {
          console.log(`[build-pglite-snapshot] stale lock (age ${Math.round(ageMs / 1000)}s > ${Math.round(timeoutMs / 1000)}s) — taking over`);
          rmdirSync(lockPath);
        }
      }
      mkdirSync(lockPath);
      ownLock = true;
    } catch { /* lock is LIVE (fresh mtime) or takeover raced; proceed unlocked as last resort */ }
  }
  try {
  console.log(`[build-pglite-snapshot] schema hash: ${schemaHash.slice(0, 16)}...`);
  console.log(`[build-pglite-snapshot] booting PGLite (in-memory)...`);
  const engine = new PGLiteEngine();

  // Bypass the env-aware short-circuit: we WANT a real init here.
  delete process.env.GBRAIN_PGLITE_SNAPSHOT;

  await engine.connect({});
  console.log(`[build-pglite-snapshot] running initSchema (forward bootstrap + ${MIGRATIONS.length} migrations)...`);
  const t0 = Date.now();
  await engine.initSchema();
  console.log(`[build-pglite-snapshot] initSchema completed in ${Date.now() - t0}ms`);

  console.log(`[build-pglite-snapshot] dumping data dir...`);
  const dump = await engine.db.dumpDataDir("none");
  const buffer = Buffer.from(await dump.arrayBuffer());

  // Write tar first, version LAST — the version file is the commit point, so
  // a crash between the writes leaves a stale-hash (ignored) snapshot, never
  // a fresh-looking torn one. Lines 2-3 record the embedding shape the
  // snapshot was baked with; the loader refuses a shape-mismatched snapshot
  // (the W0 1280-vs-1536 incident class).
  writeFileSync(fixturePath, buffer);
  writeFileSync(versionPath, `${schemaHash}\ndims=${getEmbeddingDimensions()}\nmodel=${getEmbeddingModel()}\n`);
  await engine.disconnect();

  console.log(`[build-pglite-snapshot] wrote ${fixturePath} (${buffer.length} bytes)`);
  console.log(`[build-pglite-snapshot] wrote ${versionPath}`);
  } finally {
    if (ownLock) { try { rmdirSync(lockPath); } catch { /* best effort */ } }
    try { rmSync(hermeticHome, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

await main();
