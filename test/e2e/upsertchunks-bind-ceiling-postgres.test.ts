/**
 * Postgres upsertChunks param-ceiling regression (E2E)
 *
 * postgres.js rejects any query with more than 65534 bound parameters, so a
 * single unbounded multi-row INSERT throws once a page chunks past ~4369 rows
 * (~15 params/row). upsertChunks must split the INSERT into batches. This is
 * the Postgres-engine analogue of the PGLite signed-int16 regression in
 * test/pglite-engine.test.ts (PGLite fails silently at 32767; postgres.js
 * fails loudly at 65534 — both are fixed by the same batching).
 *
 * Gated by DATABASE_URL — skips gracefully when no real Postgres is available.
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import type { ChunkInput, PageInput } from "../../src/core/types.ts";
import { hasDatabase, setupDB, teardownDB, getEngine } from "./helpers.ts";

const describeDB = hasDatabase() ? describe : describe.skip;

describeDB(
  "Postgres: upsertChunks past the postgres.js Bind param limit",
  () => {
    beforeAll(setupDB);
    afterAll(teardownDB);

    test("stores every chunk when params exceed the postgres.js max", async () => {
      const engine = getEngine();
      const page: PageInput = {
        type: "concept",
        title: "Many Chunks",
        compiled_truth: "page with many chunks",
      };
      await engine.putPage("test/many-chunks-pg", page);

      // ~15 params/row; 5000 rows => ~75000 params, past postgres.js's 65534 cap.
      const COUNT = 5000;
      const many: ChunkInput[] = Array.from({ length: COUNT }, (_, i) => ({
        chunk_index: i,
        chunk_text: `Chunk number ${i}`,
        chunk_source: "compiled_truth",
      }));
      await engine.upsertChunks("test/many-chunks-pg", many);

      const chunks = await engine.getChunks("test/many-chunks-pg");
      expect(chunks.length).toBe(COUNT);
      // Content stays intact and contiguous across batch boundaries.
      expect(chunks[0].chunk_text).toBe("Chunk number 0");
      expect(chunks[3000].chunk_text).toBe("Chunk number 3000");
      expect(chunks[COUNT - 1].chunk_text).toBe(`Chunk number ${COUNT - 1}`);
    });
  },
);
