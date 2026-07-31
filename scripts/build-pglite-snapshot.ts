#!/usr/bin/env bun
// scripts/build-pglite-snapshot.ts
//
// Tier 3 fast-restore: boot a fresh PGLite, run the full initSchema (forward
// bootstrap + PGLITE_SCHEMA_SQL + every migration), dump the post-init state
// to a tar fixture. Test files that read GBRAIN_PGLITE_SNAPSHOT can skip the
// 1-3 seconds of cold init and load the post-schema state directly.
//
// Output: test/fixtures/pglite-snapshot.tar (binary, gitignored)
//         test/fixtures/pglite-snapshot.metadata.json (gitignored)
//
// Metadata binds the tar checksum to the runtime-rendered test schema and full
// migration semantics. A mismatch makes the engine ignore the snapshot and
// run normal initSchema.
//
// Run: bun run scripts/build-pglite-snapshot.ts
//      (or: bun run build:pglite-snapshot)
//
// Re-run whenever you touch src/core/migrate.ts or src/schema.sql.

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import * as crypto from "node:crypto";

import { PGLiteEngine, createSnapshotMetadata } from "../src/core/pglite-engine.ts";
import { MIGRATIONS } from "../src/core/migrate.ts";
import { getPGLiteSchema } from "../src/core/pglite-schema.ts";
import { configureGateway } from "../src/core/ai/gateway.ts";

async function main() {
  const fixturePath = process.env.GBRAIN_PGLITE_SNAPSHOT_PATH || "test/fixtures/pglite-snapshot.tar";
  const replacedMetadataPath = fixturePath.replace(/\.tar(?:\.gz)?$/, ".metadata.json");
  const metadataPath = replacedMetadataPath === fixturePath
    ? `${fixturePath}.metadata.json`
    : replacedMetadataPath;
  mkdirSync(dirname(fixturePath), { recursive: true });

  // `bun run` does not load bunfig's test preload. Build explicitly with the
  // same legacy profile used by `bun test`; tests that choose another profile
  // receive a metadata mismatch and safely cold-initialize.
  const dims = Number(process.env.GBRAIN_PGLITE_SNAPSHOT_DIMS || "1536");
  const model = process.env.GBRAIN_PGLITE_SNAPSHOT_MODEL || "openai:text-embedding-3-large";
  if (!Number.isInteger(dims) || dims <= 0) {
    throw new Error(`invalid GBRAIN_PGLITE_SNAPSHOT_DIMS: ${process.env.GBRAIN_PGLITE_SNAPSHOT_DIMS}`);
  }
  configureGateway({ embedding_dimensions: dims, embedding_model: model, env: { ...process.env } });
  const renderedSchema = getPGLiteSchema(dims, model);

  console.log(`[build-pglite-snapshot] profile: ${model} / ${dims}d`);
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

  const metadata = createSnapshotMetadata(buffer, MIGRATIONS, renderedSchema, crypto);
  writeFileSync(fixturePath, buffer);
  writeFileSync(metadataPath, JSON.stringify(metadata, null, 2) + "\n");
  await engine.disconnect();

  console.log(`[build-pglite-snapshot] wrote ${fixturePath} (${buffer.length} bytes)`);
  console.log(`[build-pglite-snapshot] wrote ${metadataPath}`);
}

await main();
