import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  MIGRATIONS,
  MigrationDriftError,
  runMigrations,
} from "../src/core/migrate.ts";

const EXPECTED_RLS_TABLES = new Map([
  [67, 6],
  [68, 4],
]);

describe("CoE migrations fail closed on RLS", () => {
  for (const [version, tableCount] of EXPECTED_RLS_TABLES) {
    const migration = MIGRATIONS.find((candidate) => candidate.version === version)!;

    test(`migration ${version} enables RLS unconditionally`, async () => {
      const statements: string[] = [];
      await migration.handler!({
        kind: "postgres",
        runMigration: async (_version: number, sql: string) => {
          statements.push(sql);
        },
      } as never);

      expect(statements).toHaveLength(1);
      expect(statements[0]).not.toContain("rolbypassrls");
      expect(statements[0]!.match(/ENABLE ROW LEVEL SECURITY/g)).toHaveLength(tableCount);
    });

    test(`migration ${version} verify requires RLS on every table`, async () => {
      let inspectedSql = "";
      const verified = await migration.verify!({
        kind: "postgres",
        executeRaw: async (sql: string) => {
          inspectedSql = sql;
          return [{ count: tableCount - 1 }];
        },
      } as never);

      expect(inspectedSql).toContain("relrowsecurity");
      expect(verified).toBe(false);
    });
  }

  test("schema bootstrap enables all CoE tables outside the legacy conditional block", () => {
    const schema = readFileSync(resolve(import.meta.dir, "../src/schema.sql"), "utf8");
    const tail = schema.slice(schema.lastIndexOf("END $$;") + "END $$;".length);
    expect(tail.match(/ALTER TABLE coe_[a-z_]+ ENABLE ROW LEVEL SECURITY;/g)).toHaveLength(10);
  });

  test("migration 67 enforces source/snapshot and content-addressed SQL invariants", () => {
    const sql = MIGRATIONS.find((migration) => migration.version === 67)?.sql ?? "";
    expect(sql).toContain("UNIQUE (snapshot_id, source_id)");
    expect(sql).toContain("FOREIGN KEY (snapshot_id, source_id)");
    expect(sql.match(/object_key = 'objects\/sha256\/'/g)).toHaveLength(2);
  });

  test("migration 68 binds normalized-document object keys to their hashes", () => {
    const sql = MIGRATIONS.find((migration) => migration.version === 68)?.sql ?? "";
    expect(sql).toContain("object_key = 'objects/sha256/'");
  });

  test("an idempotent retry that still fails verification never advances schema version", async () => {
    const configuredVersions: string[] = [];
    const engine = {
      kind: "pglite",
      getConfig: async () => "66",
      setConfig: async (_key: string, value: string) => { configuredVersions.push(value); },
      runMigration: async () => undefined,
      executeRaw: async () => [{ count: 0 }],
    } as Record<string, unknown>;
    engine.transaction = async (operation: (transaction: unknown) => Promise<unknown>) => operation(engine);

    await expect(runMigrations(engine as never)).rejects.toBeInstanceOf(MigrationDriftError);
    expect(configuredVersions).toEqual([]);
  });
});
