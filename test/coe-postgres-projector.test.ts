import { describe, expect, test } from "bun:test";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { BrainEngine } from "../src/core/engine.ts";
import { makeCoeId, sha256Canonical, type SourceContract } from "../src/coe/contracts/index.ts";
import {
  CoeEvidenceLedger,
  InMemoryCoeEvidenceProjection,
  MarkdownDocumentNormalizer,
} from "../src/coe/evidence/index.ts";
import {
  CoeSnapshotLedger,
  InMemoryCoeSnapshotProjection,
} from "../src/coe/registry/index.ts";
import { SqlCoeSnapshotProjection } from "../src/coe/registry/sql-projection.ts";
import {
  assertCoePostgresClientTarget,
  assertCoeIdentitySubset,
  assertCoeProjectionSqlAllowed,
  assertCoeReplayProjection,
  assertCoeReportDestination,
  assertCoeStoredRecordIdentity,
  buildCoeRegistryProjectionPlan,
  createCoeRegistryReadOnlySnapshot,
  guardCoeProjectionEngine,
  parseCoePostgresProjectorArgs,
  preflightCoePostgresTarget,
  withCoeProjectionAdvisoryLock,
  type CoeProjectorEngine,
  type CoeRegistryProjectionPlan,
} from "../src/coe/project-postgres.ts";
import {
  runCoeProjectorCli,
  writeCoeProjectorReport,
} from "../scripts/project-coe-postgres.ts";

const registry = "/tmp/coe-registry";
const report = "/tmp/coe-report.json";

function validArgs(mode: "--dry-run" | "--execute" = "--dry-run"): string[] {
  return [
    mode,
    "--registry-root", registry,
    "--expected-registry-root", registry,
    "--expected-host", "127.0.0.1",
    "--expected-port", "55432",
    "--expected-database", "gbrain",
    "--expected-role", "coe_projector_r20260809",
    "--expected-sources", "4",
    "--expected-raw-objects", "5",
    "--expected-snapshots", "5",
    "--expected-acquisitions", "10",
    "--expected-acquisition-redirects", "0",
    "--expected-snapshot-events", "0",
    "--expected-normalized-documents", "5",
    "--expected-sections", "4881",
    "--expected-mappings", "4876",
    "--expected-evidence-items", "4876",
    "--report", report,
  ];
}

function validArgsForPaths(
  registryRoot: string,
  reportPath: string,
  mode: "--dry-run" | "--execute" = "--dry-run",
): string[] {
  const args = validArgs(mode);
  args[args.indexOf("--registry-root") + 1] = registryRoot;
  args[args.indexOf("--expected-registry-root") + 1] = registryRoot;
  args[args.indexOf("--report") + 1] = reportPath;
  return args;
}

describe("CoE PostgreSQL projector argument contract", () => {
  test("accepts one explicit mode and exact mission bounds", () => {
    expect(parseCoePostgresProjectorArgs(validArgs())).toEqual({
      mode: "dry-run",
      allowReplay: false,
      registryRoot: resolve(registry),
      expectedRegistryRoot: resolve(registry),
      expectedHost: "127.0.0.1",
      expectedPort: 55432,
      expectedDatabase: "gbrain",
      expectedRole: "coe_projector_r20260809",
      expectedCounts: {
        sources: 4,
        raw_objects: 5,
        snapshots: 5,
        acquisitions: 10,
        acquisition_redirects: 0,
        snapshot_events: 0,
        normalized_documents: 5,
        sections: 4881,
        mappings: 4876,
        evidence_items: 4876,
      },
      reportPath: resolve(report),
    });
  });

  test("rejects missing or ambiguous execution mode", () => {
    expect(() => parseCoePostgresProjectorArgs(validArgs().filter((arg) => arg !== "--dry-run")))
      .toThrow("exactly one of --dry-run or --execute");
    expect(() => parseCoePostgresProjectorArgs(["--execute", ...validArgs()]))
      .toThrow("exactly one of --dry-run or --execute");
  });

  test("rejects registry drift, replay in dry-run, duplicate flags, and invalid caps", () => {
    const drifted = validArgs();
    drifted[drifted.indexOf("--expected-registry-root") + 1] = "/tmp/other-registry";
    expect(() => parseCoePostgresProjectorArgs(drifted)).toThrow("registry root does not match");
    expect(() => parseCoePostgresProjectorArgs([...validArgs(), "--allow-replay"]))
      .toThrow("--allow-replay requires --execute");
    expect(() => parseCoePostgresProjectorArgs([...validArgs("--execute"), "--allow-replay", "--allow-replay"]))
      .toThrow("duplicate argument: --allow-replay");
    const negative = validArgs();
    negative[negative.indexOf("--expected-sections") + 1] = "-1";
    expect(() => parseCoePostgresProjectorArgs(negative)).toThrow("non-negative integer");
  });

  test("rejects report paths inside the canonical registry", () => {
    const args = validArgs();
    args[args.indexOf("--report") + 1] = `${registry}/report.json`;
    expect(() => parseCoePostgresProjectorArgs(args)).toThrow("report path must be outside the registry");
  });

  test("rejects a report parent symlink that resolves inside the registry", async () => {
    const root = await mkdtemp(join(tmpdir(), "gbrain-coe-report-path-"));
    try {
      const actualRegistry = join(root, "registry");
      await mkdir(actualRegistry);
      const linkedParent = join(root, "report-link");
      await symlink(actualRegistry, linkedParent, "dir");
      await expect(assertCoeReportDestination(actualRegistry, join(linkedParent, "report.json")))
        .rejects.toThrow("report destination resolves inside the registry");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("CoE PostgreSQL client target contract", () => {
  test("accepts the exact effective PostgreSQL client target", () => {
    const args = parseCoePostgresProjectorArgs(validArgs());
    const passwordCanary = ["synthetic", "credential", "canary"].join("-");
    const databaseUrl = `postgresql://${args.expectedRole}:${passwordCanary}@${args.expectedHost}:${args.expectedPort}/${args.expectedDatabase}?sslmode=disable`;
    expect(() => assertCoePostgresClientTarget(databaseUrl, args)).not.toThrow();
  });

  test("rejects a client target mismatch before engine creation or connection", async () => {
    const root = await mkdtemp(join(tmpdir(), "gbrain-coe-client-target-"));
    try {
      const registryRoot = join(root, "registry");
      const reportPath = join(root, "reports", "report.json");
      await mkdir(registryRoot);
      let createCalls = 0;
      let connectCalls = 0;
      const reports: unknown[] = [];
      const passwordCanary = ["synthetic", "credential", "canary"].join("-");
      const databaseUrl = `postgresql://coe_projector_r20260809:${passwordCanary}@127.0.0.2:55432/gbrain`;
      await expect(runCoeProjectorCli(validArgsForPaths(registryRoot, reportPath), {
        loadConfiguration: () => ({ engine: "postgres", database_url: databaseUrl }),
        createEngine: () => {
          createCalls += 1;
          return {
            async connect() {
              connectCalls += 1;
            },
            async disconnect() {},
          };
        },
        runProjection: async () => {
          throw new Error("projection must not start for a mismatched client target");
        },
        writeReport: async (_path, value) => {
          reports.push(value);
        },
      })).rejects.toThrow("database_url client host does not match");
      expect(createCalls).toBe(0);
      expect(connectCalls).toBe(0);
      expect(JSON.stringify(reports)).not.toContain(passwordCanary);
      expect(JSON.stringify(reports)).not.toContain(databaseUrl);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("redacts a DSN and password from propagated errors and failure reports", async () => {
    const root = await mkdtemp(join(tmpdir(), "gbrain-coe-client-redaction-"));
    try {
      const registryRoot = join(root, "registry");
      const reportPath = join(root, "reports", "report.json");
      await mkdir(registryRoot);
      const args = parseCoePostgresProjectorArgs(validArgsForPaths(registryRoot, reportPath));
      const passwordCanary = ["must", "remain", "secret"].join("-");
      const databaseUrl = `postgresql://${args.expectedRole}:${passwordCanary}@${args.expectedHost}:${args.expectedPort}/${args.expectedDatabase}`;
      const reports: unknown[] = [];
      let propagatedMessage = "";
      try {
        await runCoeProjectorCli(validArgsForPaths(registryRoot, reportPath), {
          loadConfiguration: () => ({ engine: "postgres", database_url: databaseUrl }),
          createEngine: () => ({
            async connect() {
              throw new Error(`synthetic connection failure for ${databaseUrl}`);
            },
            async disconnect() {},
          }),
          runProjection: async () => {
            throw new Error("projection must not start after a connection failure");
          },
          writeReport: async (_path, value) => {
            reports.push(value);
          },
        });
      } catch (error) {
        propagatedMessage = error instanceof Error ? error.message : String(error);
      }
      const serializedReports = JSON.stringify(reports);
      expect(propagatedMessage).toContain("[REDACTED_DATABASE_URL]");
      expect(propagatedMessage).not.toContain(databaseUrl);
      expect(propagatedMessage).not.toContain(passwordCanary);
      expect(serializedReports).toContain("[REDACTED_DATABASE_URL]");
      expect(serializedReports).not.toContain(databaseUrl);
      expect(serializedReports).not.toContain(passwordCanary);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  const expectedClientTarget = parseCoePostgresProjectorArgs(validArgs());
  const rejectionPasswordCanary = ["never", "disclose", "this"].join("-");
  const rejectionCases: Array<{
    name: string;
    databaseUrl: unknown;
    expectedMessage: string;
  }> = [
    {
      name: "wrong client host",
      databaseUrl: `postgresql://${expectedClientTarget.expectedRole}:${rejectionPasswordCanary}@127.0.0.2:55432/gbrain`,
      expectedMessage: "database_url client host does not match",
    },
    {
      name: "wrong client port",
      databaseUrl: `postgresql://${expectedClientTarget.expectedRole}:${rejectionPasswordCanary}@127.0.0.1:55431/gbrain`,
      expectedMessage: "database_url client port does not match",
    },
    {
      name: "wrong database",
      databaseUrl: `postgresql://${expectedClientTarget.expectedRole}:${rejectionPasswordCanary}@127.0.0.1:55432/wrong_database`,
      expectedMessage: "database_url database does not match",
    },
    {
      name: "database overridden by a query parameter",
      databaseUrl: `postgresql://${expectedClientTarget.expectedRole}:${rejectionPasswordCanary}@127.0.0.1:55432/gbrain?database=wrong_database`,
      expectedMessage: "must not contain user or database query parameters",
    },
    {
      name: "wrong path database hidden by an expected query parameter",
      databaseUrl: `postgresql://${expectedClientTarget.expectedRole}:***@127.0.0.1:55432/wrong_database?database=gbrain`,
      expectedMessage: "must not contain user or database query parameters",
    },
    {
      name: "percent-encoded database alias that the driver would not decode",
      databaseUrl: `postgresql://${expectedClientTarget.expectedRole}:${rejectionPasswordCanary}@127.0.0.1:55432/gb%72ain`,
      expectedMessage: "database_url database does not match",
    },
    {
      name: "missing explicit client port",
      databaseUrl: `postgresql://${expectedClientTarget.expectedRole}:${rejectionPasswordCanary}@127.0.0.1/gbrain`,
      expectedMessage: "database_url client port does not match",
    },
    {
      name: "wrong role",
      databaseUrl: `postgresql://wrong_role:${rejectionPasswordCanary}@127.0.0.1:55432/gbrain`,
      expectedMessage: "database_url role does not match",
    },
    {
      name: "role overridden by a query parameter",
      databaseUrl: `postgresql://${expectedClientTarget.expectedRole}:${rejectionPasswordCanary}@127.0.0.1:55432/gbrain?user=wrong_role`,
      expectedMessage: "must not contain user or database query parameters",
    },
    {
      name: "wrong authority role hidden by an expected query parameter",
      databaseUrl: `postgresql://wrong_role:${rejectionPasswordCanary}@127.0.0.1:55432/gbrain?user=${expectedClientTarget.expectedRole}`,
      expectedMessage: "must not contain user or database query parameters",
    },

    {
      name: "non-PostgreSQL protocol",
      databaseUrl: `https://${expectedClientTarget.expectedRole}:${rejectionPasswordCanary}@127.0.0.1:55432/gbrain`,
      expectedMessage: "must use a PostgreSQL protocol",
    },
    {
      name: "absent DSN",
      databaseUrl: undefined,
      expectedMessage: "database_url is not configured",
    },
    {
      name: "malformed DSN",
      databaseUrl: "postgresql://[",
      expectedMessage: "database_url is malformed",
    },
  ];

  for (const rejection of rejectionCases) {
    test(`rejects ${rejection.name} without disclosing the DSN or password`, () => {
      let message = "";
      try {
        assertCoePostgresClientTarget(rejection.databaseUrl, expectedClientTarget);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain(rejection.expectedMessage);
      expect(message).not.toContain(rejectionPasswordCanary);
      if (typeof rejection.databaseUrl === "string") {
        expect(message).not.toContain(rejection.databaseUrl);
      }
    });
  }

  test("accepts a percent-encoded role exactly as postgres.js decodes it", () => {
    const encodedRole = expectedClientTarget.expectedRole.replace("_", "%5F");
    expect(() => assertCoePostgresClientTarget(
      `postgresql://${encodedRole}:***@127.0.0.1:55432/gbrain`,
      expectedClientTarget,
    )).not.toThrow();
  });
});

describe("CoE PostgreSQL projector command wiring", () => {
  test("exposes a dedicated script without acquisition or schema initialization", async () => {
    const packageJson = JSON.parse(await readFile(join(import.meta.dir, "../package.json"), "utf8"));
    expect(packageJson.scripts["coe:project-postgres"]).toBe("bun run scripts/project-coe-postgres.ts");
    const script = await readFile(join(import.meta.dir, "../scripts/project-coe-postgres.ts"), "utf8");
    expect(script).toContain("PostgresEngine");
    expect(script).toContain("runCoePostgresProjection");
    expect(script).not.toContain("initSchema");
    expect(script).not.toContain("fetch(");
    expect(script).not.toContain("BoundedHttpClient");
  });
});

describe("CoE registry projection plan", () => {
  test("refuses a missing source root without creating it", async () => {
    const root = join(tmpdir(), `coe-missing-${crypto.randomUUID()}`);
    await expect(createCoeRegistryReadOnlySnapshot(root)).rejects.toThrow("registry root");
    await expect(access(root)).rejects.toBeDefined();
  });

  test("rejects nested symlinks instead of silently skipping records", async () => {
    const root = await mkdtemp(join(tmpdir(), "coe-symlink-"));
    const external = join(tmpdir(), `coe-external-${crypto.randomUUID()}.json`);
    try {
      const sourceDirectory = join(root, "records", "sources");
      await mkdir(sourceDirectory, { recursive: true });
      await writeFile(join(sourceDirectory, "source.json"), "{}\n");
      const sourceName = (await readdir(sourceDirectory))[0]!;
      await writeFile(external, await readFile(join(sourceDirectory, sourceName)));
      await unlink(join(sourceDirectory, sourceName));
      await symlink(external, join(sourceDirectory, sourceName));
      await expect(createCoeRegistryReadOnlySnapshot(root)).rejects.toThrow("symbolic link");
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(external, { force: true });
    }
  });

  test("rejects a regular registry file replaced between metadata capture and open", async () => {
    const root = await mkdtemp(join(tmpdir(), "coe-inode-race-"));
    const path = join(root, "record.json");
    const displaced = join(root, "record-original.json");
    try {
      await writeFile(path, "original\n");
      await expect(createCoeRegistryReadOnlySnapshot(root, {
        afterEntryMetadata: async (_absolutePath, relativePath) => {
          if (relativePath !== "record.json") return;
          await rename(path, displaced);
          await writeFile(path, "replacement\n");
        },
      })).rejects.toThrow("changed before reading");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects the registry root replaced by a symlink after metadata validation", async () => {
    const container = await mkdtemp(join(tmpdir(), "coe-root-race-"));
    const root = join(container, "registry");
    const displaced = join(container, "registry-original");
    const external = join(container, "external");
    try {
      await mkdir(root);
      await mkdir(external);
      await writeFile(join(root, "trusted.json"), "trusted\n");
      await writeFile(join(external, "external.json"), "external\n");
      await expect(createCoeRegistryReadOnlySnapshot(root, {
        afterRootMetadata: async () => {
          await rename(root, displaced);
          await symlink(external, root, "dir");
        },
      })).rejects.toThrow();
    } finally {
      await rm(container, { recursive: true, force: true });
    }
  });

  test("rejects a child directory replaced by a symlink before descriptor open", async () => {
    const root = await mkdtemp(join(tmpdir(), "coe-child-dir-race-"));
    const child = join(root, "records");
    const displaced = join(root, "records-original");
    const external = join(root, "external");
    try {
      await mkdir(child);
      await mkdir(external);
      await writeFile(join(child, "trusted.json"), "trusted\n");
      await writeFile(join(external, "external.json"), "external\n");
      await expect(createCoeRegistryReadOnlySnapshot(root, {
        afterDirectoryEntryMetadata: async (_absolutePath, relativePath) => {
          if (relativePath !== "records") return;
          await rename(child, displaced);
          await symlink(external, child, "dir");
        },
      })).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("verifies the immutable registry and derives exact counts without writing it", async () => {
    const root = await mkdtemp(join(tmpdir(), "gbrain-coe-project-plan-"));
    try {
      const sourceId = makeCoeId("src", { canonical_uri: "https://example.invalid/project-plan" });
      const source: SourceContract = {
        schema_version: "1.0.0",
        source_id: sourceId,
        source_kind: "report",
        title: "Projection plan fixture",
        canonical_uri: "https://example.invalid/project-plan",
        authors: [],
        language: "en",
        external_identifiers: [],
        scope: {
          brain_id: "science-one-coe",
          visibility: "private",
          owner_principal: "projector-test",
          reader_principals: [],
          source_ids: [sourceId],
        },
        created_at: "2026-08-09T00:00:00.000Z",
        created_by: { actor_type: "system", actor_id: "projector-test" },
      };
      const snapshotLedger = new CoeSnapshotLedger({
        root,
        projection: new InMemoryCoeSnapshotProjection(),
        clock: () => new Date("2026-08-09T00:00:00.000Z"),
      });
      const acquired = await snapshotLedger.acquire({
        source,
        content: "# Heading\n\nOne fact.\n",
        requested_uri: source.canonical_uri!,
        final_uri: source.canonical_uri!,
        media_type: "text/plain",
        acquisition_method: "filesystem",
        acquired_at: "2026-08-09T00:00:00.000Z",
      });
      const evidenceLedger = new CoeEvidenceLedger({
        root,
        snapshotLedger,
        projection: new InMemoryCoeEvidenceProjection(),
        clock: () => new Date("2026-08-09T00:00:00.000Z"),
      });
      const normalized = await evidenceLedger.normalizeSnapshot(
        acquired.snapshot!.snapshot_id,
        new MarkdownDocumentNormalizer(),
      );

      const first = await buildCoeRegistryProjectionPlan(root);
      const second = await buildCoeRegistryProjectionPlan(root);
      expect(first).toEqual(second);
      expect(first.table_counts).toEqual({
        coe_sources: 1,
        coe_raw_objects: 1,
        coe_snapshots: 1,
        coe_acquisitions: 1,
        coe_acquisition_redirects: 0,
        coe_snapshot_events: 0,
        coe_normalized_documents: 1,
        coe_document_sections: normalized.normalized_document.sections.length,
        coe_normalized_mappings: normalized.normalized_document.mappings.length,
        coe_evidence_items: normalized.evidence_items.length,
      });
      expect(first.identity_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

const tableNames = [
  "coe_acquisition_redirects",
  "coe_acquisitions",
  "coe_document_sections",
  "coe_evidence_items",
  "coe_normalized_documents",
  "coe_normalized_mappings",
  "coe_raw_objects",
  "coe_snapshot_events",
  "coe_snapshots",
  "coe_sources",
];

function fixturePlan(): CoeRegistryProjectionPlan {
  const tableCounts = Object.fromEntries(tableNames.map((table) => [table, 0])) as CoeRegistryProjectionPlan["table_counts"];
  tableCounts.coe_sources = 4;
  tableCounts.coe_raw_objects = 5;
  tableCounts.coe_snapshots = 5;
  tableCounts.coe_acquisitions = 10;
  tableCounts.coe_acquisition_redirects = 0;
  tableCounts.coe_snapshot_events = 0;
  tableCounts.coe_normalized_documents = 5;
  tableCounts.coe_document_sections = 4881;
  tableCounts.coe_normalized_mappings = 4876;
  tableCounts.coe_evidence_items = 4876;
  return {
    snapshot_rebuild: { acquisitions: 1, projected: 1, lifecycle_events: 0, retractions: 0 },
    evidence_rebuild: { documents: 5, evidence_items: 4876 },
    table_counts: tableCounts,
    identity_hash: `sha256:${"0".repeat(64)}`,
  };
}

function fakePreflightEngine(options: {
  serverHost?: string;
  serverPort?: number;
  currentDatabase?: string;
  currentRole?: string;
  version?: number;
  tables?: string[];
  rlsDisabled?: string;
  counts?: Record<string, number>;
  longTransactions?: number;
  blockedBackends?: number;
  ungrantedLocks?: number;
} = {}) {
  const calls: string[] = [];
  const counts = options.counts ?? Object.fromEntries(tableNames.map((table) => [table, 0]));
  const engine: CoeProjectorEngine = {
    kind: "postgres",
    async transaction<T>(fn: (tx: CoeProjectorEngine) => Promise<T>): Promise<T> {
      return fn(engine);
    },
    async executeRaw<T = Record<string, unknown>>(sql: string): Promise<T[]> {
      calls.push(sql);
      let rows: Record<string, unknown>[];
      if (sql.includes("SET TRANSACTION READ ONLY")) rows = [];
      else if (sql.includes("inet_server_addr()")) rows = [{
        host: options.serverHost ?? "172.17.0.4/32",
        port: options.serverPort ?? 5432,
        database: options.currentDatabase ?? "gbrain",
      }];
      else if (sql.includes("current_database() AS database")) {
        rows = [{
          database: options.currentDatabase ?? "gbrain",
          role: options.currentRole ?? "coe_projector_r20260809",
        }];
      }
      else if (sql.includes("FROM public.config")) rows = [{ version: options.version ?? 68 }];
      else if (sql.includes("AS table_name FROM pg_catalog.pg_class")) {
        rows = (options.tables ?? tableNames).map((table_name) => ({ table_name }));
      } else if (sql.includes("FROM pg_catalog.pg_class")) {
        rows = (options.tables ?? tableNames).map((relname) => ({
          relname,
          relrowsecurity: relname !== options.rlsDisabled,
        }));
      } else if (sql.includes("UNION ALL") && sql.includes("table_name")) {
        rows = Object.entries(counts).map(([table_name, count]) => ({ table_name, count }));
      } else if (sql.includes("long_transactions")) rows = [{
        long_transactions: options.longTransactions ?? 0,
        blocked_backends: options.blockedBackends ?? 0,
      }];
      else if (sql.includes("ungranted_locks")) rows = [{ ungranted_locks: options.ungrantedLocks ?? 0 }];
      else throw new Error(`Unexpected SQL in test: ${sql}`);
      return rows as T[];
    },
  };
  return { engine, calls };
}

describe("CoE PostgreSQL target preflight", () => {
  test("accepts a Docker-published client endpoint when the server identity is internal", async () => {
    const { engine, calls } = fakePreflightEngine();
    const result = await preflightCoePostgresTarget(engine, parseCoePostgresProjectorArgs(validArgs()), fixturePlan());
    expect(result.endpoint).toEqual({ host: "127.0.0.1", port: 55432, database: "gbrain" });
    expect(result.schema_version).toBe(68);
    expect(result.counts).toEqual(
      Object.fromEntries(tableNames.map((table) => [table, 0])) as typeof result.counts,
    );
    expect(calls[0]).toContain("SET TRANSACTION READ ONLY");
    expect(calls.some((sql) => sql.includes("inet_server_addr()") || sql.includes("inet_server_port()"))).toBe(false);
    expect(calls.some((sql) => sql.includes("SELECT current_database() AS database"))).toBe(true);
  });

  test("rejects an incoherent current_database without consulting the server listener identity", async () => {
    const args = parseCoePostgresProjectorArgs(validArgs());
    const { engine, calls } = fakePreflightEngine({ currentDatabase: "wrong" });
    await expect(preflightCoePostgresTarget(engine, args, fixturePlan()))
      .rejects.toThrow("current_database() does not match the expected database");
    expect(calls.some((sql) => sql.includes("inet_server_addr()") || sql.includes("inet_server_port()"))).toBe(false);
  });

  test("rejects a connected PostgreSQL role that differs from the expected role", async () => {
    const args = parseCoePostgresProjectorArgs(validArgs());
    await expect(preflightCoePostgresTarget(
      fakePreflightEngine({ currentRole: "wrong_role" }).engine,
      args,
      fixturePlan(),
    )).rejects.toThrow("current_user does not match the expected role");
  });

  test("rejects schema, table, RLS, count, and contention drift", async () => {
    const args = parseCoePostgresProjectorArgs(validArgs());
    const plan = fixturePlan();
    await expect(preflightCoePostgresTarget(fakePreflightEngine({ version: 67 }).engine, args, plan))
      .rejects.toThrow("schema version 68");
    await expect(preflightCoePostgresTarget(fakePreflightEngine({ tables: tableNames.slice(1) }).engine, args, plan))
      .rejects.toThrow("CoE table set mismatch");
    await expect(preflightCoePostgresTarget(fakePreflightEngine({ rlsDisabled: tableNames[0] }).engine, args, plan))
      .rejects.toThrow("RLS is not enabled");
    await expect(preflightCoePostgresTarget(fakePreflightEngine({ counts: { ...Object.fromEntries(tableNames.map((table) => [table, 0])), coe_sources: 1 } }).engine, args, plan))
      .rejects.toThrow("target CoE tables are not empty");
    await expect(preflightCoePostgresTarget(fakePreflightEngine({ longTransactions: 1 }).engine, args, plan))
      .rejects.toThrow("database contention");
  });

  test("enforces the mission cap for each of the ten CoE tables", async () => {
    const args = parseCoePostgresProjectorArgs(validArgs());
    let checked = 0;
    for (const table of tableNames) {
      const plan = fixturePlan();
      const key = table as keyof CoeRegistryProjectionPlan["table_counts"];
      plan.table_counts[key] = plan.table_counts[key] + 1;
      await expect(preflightCoePostgresTarget(fakePreflightEngine().engine, args, plan))
        .rejects.toThrow("mission caps");
      checked += 1;
    }
    expect(checked).toBe(10);
  });
});

describe("CoE SQL write allowlist", () => {
  test("allows reads and CoE inserts/updates only", () => {
    expect(() => assertCoeProjectionSqlAllowed("SELECT current_database() AS database")).not.toThrow();
    expect(() => assertCoeProjectionSqlAllowed("INSERT INTO public.coe_sources (source_id) VALUES ($1)")).not.toThrow();
    expect(() => assertCoeProjectionSqlAllowed("UPDATE public.coe_snapshots SET status = $1 WHERE snapshot_id = $2")).not.toThrow();
    expect(() => assertCoeProjectionSqlAllowed("INSERT INTO pages (id) VALUES ($1)")).toThrow("outside the CoE allowlist");
    expect(() => assertCoeProjectionSqlAllowed("DELETE FROM public.coe_sources")).toThrow("destructive SQL is forbidden");
    expect(() => assertCoeProjectionSqlAllowed("TRUNCATE public.coe_sources")).toThrow("destructive SQL is forbidden");
    expect(() => assertCoeProjectionSqlAllowed("CREATE TABLE coe_extra(id int)")).toThrow("DDL is forbidden");
    expect(() => assertCoeProjectionSqlAllowed("SELECT * FROM pages")).toThrow("read outside");
    expect(() => assertCoeProjectionSqlAllowed("INSERT INTO public.coe_sources.foo VALUES (1)")).toThrow("outside");
    expect(() => assertCoeProjectionSqlAllowed("UPDATE public.coe_sources.foo SET x = 1")).toThrow("outside");
    expect(() => assertCoeProjectionSqlAllowed(
      "INSERT INTO public.coe_sources (source_id) SELECT id FROM public.pages",
    )).toThrow("write reads outside");
    expect(() => assertCoeProjectionSqlAllowed(
      "UPDATE public.coe_sources SET schema_version = pages.slug FROM public.pages",
    )).toThrow("write reads outside");
    expect(() => assertCoeProjectionSqlAllowed("SELECT 1; INSERT INTO pages (id) VALUES ($1)"))
      .toThrow("multiple SQL statements are forbidden");
  });
});

describe("CoE replay identity gate", () => {
  test("accepts canonical subsets and rejects unknown or conflicting rows", () => {
    const expected = { coe_sources: { src_a: "sha256:a", src_b: "sha256:b" } };
    expect(() => assertCoeIdentitySubset(expected, { coe_sources: { src_a: "sha256:a" } })).not.toThrow();
    expect(() => assertCoeIdentitySubset(expected, { coe_sources: { src_x: "sha256:x" } }))
      .toThrow("unexpected identity");
    expect(() => assertCoeIdentitySubset(expected, { coe_sources: { src_a: "sha256:wrong" } }))
      .toThrow("identity hash mismatch");
  });

  test("recomputes record hashes instead of trusting the stored hash column", () => {
    const canonical = { source_id: "src_abc", status: "active" };
    const expectedHash = `sha256:${sha256Canonical(canonical)}`;
    expect(() => assertCoeStoredRecordIdentity("coe_sources", "src_abc", expectedHash, expectedHash, canonical)).not.toThrow();
    expect(() => assertCoeStoredRecordIdentity(
      "coe_sources",
      "src_abc",
      expectedHash,
      expectedHash,
      { ...canonical, status: "retracted" },
    )).toThrow("record_json hash mismatch");
  });

  function replayEngine(
    recordJson: unknown,
    stateJson: unknown,
    storedHash: string,
    options: {
      table?: string;
      identity?: string;
      projectedMatch?: boolean;
      eventJson?: unknown;
      eventProjectedMatch?: boolean;
    } = {},
  ) {
    const calls: string[] = [];
    const table = options.table ?? "coe_sources";
    const identity = options.identity ?? "src_abc";
    return {
      calls,
      engine: {
        async executeRaw<T = Record<string, unknown>>(sql: string): Promise<T[]> {
          calls.push(sql);
          let rows: Record<string, unknown>[];
          if (sql.includes("record_hash AS hash")) {
            rows = [{
              table_name: table,
              identity,
              hash: storedHash,
              record_json: recordJson,
              projection_matches_record: options.projectedMatch ?? true,
            }];
          } else if (sql.includes("FROM public.coe_raw_objects")) {
            rows = [];
          } else if (sql.includes("FROM public.coe_acquisition_redirects")) {
            rows = [];
          } else if (sql.includes("FROM public.coe_snapshot_events")) {
            rows = options.eventJson === undefined ? [] : [{
              event_id: "evt_abc",
              event_json: options.eventJson,
              projection_matches_event: options.eventProjectedMatch ?? true,
            }];
          } else if (sql.includes("jsonb_build_object")) {
            rows = [{ table_name: table, identity, state_json: stateJson }];
          } else {
            throw new Error(`Unexpected replay SQL in test: ${sql}`);
          }
          return rows as T[];
        },
      },
    };
  }

  test("rejects record_json tampering through the complete replay gate", async () => {
    const canonical = { source_id: "src_abc", status: "active" };
    const expectedHash = `sha256:${sha256Canonical(canonical)}`;
    await expect(assertCoeReplayProjection(
      replayEngine({ ...canonical, status: "retracted" }, { status: "active" }, expectedHash).engine,
      { coe_sources: { src_abc: expectedHash } },
      { coe_sources: { src_abc: `sha256:${sha256Canonical({ status: "active" })}` } },
    )).rejects.toThrow("record_json hash mismatch");
  });

  test("rejects altered mutable projection state through the complete replay gate", async () => {
    const canonical = { snapshot_id: "snp_abc", status: "active" };
    const expectedHash = `sha256:${sha256Canonical(canonical)}`;
    const expectedState = {
      status: "active",
      retracted_at: null,
      retraction_reason: null,
      retraction_event_id: null,
    };
    const alteredState = {
      status: "retracted",
      retracted_at: "2026-08-09T00:00:00.000Z",
      retraction_reason: "tampered",
      retraction_event_id: "evt_tampered",
    };
    const replay = replayEngine(canonical, alteredState, expectedHash, {
      table: "coe_snapshots",
      identity: "snp_abc",
    });
    await expect(assertCoeReplayProjection(
      replay.engine,
      { coe_snapshots: { snp_abc: expectedHash } },
      { coe_snapshots: { snp_abc: `sha256:${sha256Canonical(expectedState)}` } },
    )).rejects.toThrow("identity hash mismatch");
    const stateSql = replay.calls.find((sql) => sql.includes("jsonb_build_object"));
    expect(stateSql).toBeDefined();
    expect(stateSql).not.toContain("'coe_sources'");
    expect(stateSql).not.toContain("'coe_normalized_documents'");
    expect(stateSql).toContain("retraction_event_id");
    expect(stateSql).toContain("'coe_evidence_items'");
    expect(stateSql).toContain("retraction_reason");
  });

  test("rejects scalar-column drift even when record_json and record_hash remain canonical", async () => {
    const canonical = { source_id: "src_abc", status: "active" };
    const expectedHash = `sha256:${sha256Canonical(canonical)}`;
    await expect(assertCoeReplayProjection(
      replayEngine(canonical, {}, expectedHash, { projectedMatch: false }).engine,
      { coe_sources: { src_abc: expectedHash } },
      { coe_sources: { src_abc: `sha256:${sha256Canonical({})}` } },
    )).rejects.toThrow("projected columns diverge");
  });

  test("rejects lifecycle-event scalar drift while event_json remains canonical", async () => {
    const canonical = { source_id: "src_abc", status: "active" };
    const expectedHash = `sha256:${sha256Canonical(canonical)}`;
    const event = { event_id: "evt_abc", aggregate_id: "snp_abc" };
    await expect(assertCoeReplayProjection(
      replayEngine(canonical, {}, expectedHash, {
        eventJson: event,
        eventProjectedMatch: false,
      }).engine,
      {
        coe_sources: { src_abc: expectedHash },
        coe_snapshot_events: { evt_abc: `sha256:${sha256Canonical(event)}` },
      },
      { coe_sources: { src_abc: `sha256:${sha256Canonical({})}` } },
    )).rejects.toThrow("lifecycle-event columns diverge");
  });
});

describe("CoE lifecycle-event scope binding", () => {
  test("rejects an event whose brain scope does not match the targeted snapshot", async () => {
    const engine = {
      kind: "postgres" as const,
      async transaction<T>(fn: (tx: CoeProjectorEngine) => Promise<T>): Promise<T> {
        return await fn(this);
      },
      async executeRaw<T = Record<string, unknown>>(sql: string): Promise<T[]> {
        if (sql.includes("FROM public.coe_snapshot_events")) return [];
        if (sql.includes("FROM public.coe_snapshots")) {
          return [{
            status: "active",
            scope_json: {
              brain_id: "brain-private",
              visibility: "private",
              owner_principal: "owner-a",
              reader_principals: [],
              source_ids: ["src_a"],
            },
          }] as T[];
        }
        throw new Error(`unexpected SQL after mismatch: ${sql}`);
      },
    };
    const projection = new SqlCoeSnapshotProjection(engine as never);

    await expect(projection.applyLifecycleEvent({
      schema_version: "1.0.0",
      event_id: "evt_scope_mismatch",
      aggregate_type: "snapshot",
      aggregate_id: "snp_private",
      event_type: "status_changed",
      from_status: "active",
      to_status: "retracted",
      reason_code: "test",
      payload_hash: `sha256:${"0".repeat(64)}`,
      actor: { principal_id: "operator", actor_type: "human" },
      scope: {
        brain_id: "brain-other",
        visibility: "private",
        owner_principal: "owner-a",
        reader_principals: [],
        source_ids: ["src_a"],
      },
      occurred_at: "2026-08-11T00:00:00.000Z",
    } as never)).rejects.toThrow("scope");
  });
});

function advisoryEngine(
  execute: (sql: string) => Record<string, unknown>[] | Promise<Record<string, unknown>[]>,
) : BrainEngine {
  const engine = {
    async executeRaw<T = Record<string, unknown>>(sql: string): Promise<T[]> {
      return await execute(sql) as T[];
    },
    async transaction<T>(fn: (tx: BrainEngine) => Promise<T>): Promise<T> {
      return await fn(engine as BrainEngine);
    },
  };
  return engine as BrainEngine;
}

describe("CoE PostgreSQL projector advisory lock", () => {
  test("keeps nested projection transactions inside the outer transaction", async () => {
    let nestedTransactions = 0;
    const engine = advisoryEngine(() => [{ acquired: true }]);
    const originalTransaction = engine.transaction.bind(engine);
    engine.transaction = async <T>(fn: (tx: BrainEngine) => Promise<T>): Promise<T> => {
      nestedTransactions += 1;
      return originalTransaction(fn);
    };
    const guarded = guardCoeProjectionEngine(engine);
    await guarded.transaction(async (tx) => {
      await tx.executeRaw("INSERT INTO public.coe_sources (source_id) VALUES ($1)", ["src_test"]);
    });
    expect(nestedTransactions).toBe(0);
  });

  test("sets dry-run read-only mode before acquiring the advisory lock", async () => {
    const calls: string[] = [];
    const engine = advisoryEngine((sql) => {
      calls.push(sql);
      return sql.includes("pg_try_advisory_xact_lock") ? [{ acquired: true }] : [];
    });
    await withCoeProjectionAdvisoryLock(engine, async () => undefined, { readOnly: true });
    expect(calls).toEqual([
      "SET TRANSACTION READ ONLY",
      expect.stringContaining("pg_try_advisory_xact_lock"),
    ]);
  });

  test("holds a transaction-scoped advisory lock around the whole execution", async () => {
    const calls: string[] = [];
    const engine = advisoryEngine((sql) => {
      calls.push(sql);
      return [{ acquired: true }];
    });
    let callbackEngine: unknown;
    await expect(withCoeProjectionAdvisoryLock(engine, async (tx) => {
      callbackEngine = tx;
      return "projected";
    })).resolves.toBe("projected");
    expect(callbackEngine).toBe(engine);
    expect(calls).toEqual([expect.stringContaining("pg_try_advisory_xact_lock")]);
  });

  test("refuses execution when the advisory lock is already held", async () => {
    let executed = false;
    const engine = advisoryEngine(() => [{ acquired: false }]);
    await expect(withCoeProjectionAdvisoryLock(engine, async () => {
      executed = true;
    })).rejects.toThrow("another CoE PostgreSQL projection holds the advisory lock");
    expect(executed).toBe(false);
  });

  test("preserves the primary execution error while the transaction releases the lock", async () => {
    const primaryError = new Error("primary projection failure");
    const engine = advisoryEngine(() => [{ acquired: true }]);
    await expect(withCoeProjectionAdvisoryLock(engine, async () => {
      throw primaryError;
    })).rejects.toBe(primaryError);
  });

  test("rejects a concurrent second execution while the first remains active", async () => {
    let locked = false;
    const engine = {
      async transaction<T>(fn: (tx: ReturnType<typeof advisoryEngine>) => Promise<T>): Promise<T> {
        const acquired = !locked;
        if (acquired) locked = true;
        const tx = advisoryEngine(() => [{ acquired }]);
        try {
          return await fn(tx);
        } finally {
          if (acquired) locked = false;
        }
      },
    };
    let releaseFirst!: () => void;
    const holdFirst = new Promise<void>((resolveHold) => {
      releaseFirst = resolveHold;
    });
    let markEntered!: () => void;
    const entered = new Promise<void>((resolveEntered) => {
      markEntered = resolveEntered;
    });
    const first = withCoeProjectionAdvisoryLock(engine, async () => {
      markEntered();
      await holdFirst;
      return "first";
    });
    await entered;
    await expect(withCoeProjectionAdvisoryLock(engine, async () => "second"))
      .rejects.toThrow("another CoE PostgreSQL projection holds the advisory lock");
    releaseFirst();
    await expect(first).resolves.toBe("first");
  });
});

describe("CoE PostgreSQL projector report publication", () => {
  test("rejects an ancestor replaced by a symlink before the report parent opens", async () => {
    const root = await mkdtemp(join(tmpdir(), "gbrain-coe-report-ancestor-race-"));
    try {
      const trusted = join(root, "trusted");
      const displaced = join(root, "trusted-original");
      const external = join(root, "external");
      await mkdir(join(trusted, "reports"), { recursive: true });
      await mkdir(join(external, "reports"), { recursive: true });
      const path = join(trusted, "reports", "report.json");
      await expect(writeCoeProjectorReport(path, { status: "projected" }, {
        beforeParentOpen: async () => {
          await rename(trusted, displaced);
          await symlink(external, trusted, "dir");
        },
      })).rejects.toThrow("report parent path changed");
      await expect(access(join(external, "reports", "report.json"))).rejects.toBeDefined();
      await expect(access(join(displaced, "reports", "report.json"))).rejects.toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("rejects a missing report directory through a registry symlink without creating it", async () => {
    const root = await mkdtemp(join(tmpdir(), "gbrain-coe-report-missing-symlink-"));
    try {
      const registryRoot = join(root, "registry");
      const linkedParent = join(root, "report-link");
      const createdInsideRegistry = join(registryRoot, "new-reports");
      await mkdir(registryRoot);
      await symlink(registryRoot, linkedParent, "dir");
      await expect(runCoeProjectorCli(
        validArgsForPaths(registryRoot, join(linkedParent, "new-reports", "report.json")),
        {},
      )).rejects.toThrow("report destination resolves inside the registry");
      await expect(access(createdInsideRegistry)).rejects.toBeDefined();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("refuses to overwrite a pre-existing final report", async () => {
    const root = await mkdtemp(join(tmpdir(), "gbrain-coe-report-existing-"));
    try {
      const path = join(root, "report.json");
      await writeFile(path, "sentinel\n");
      await expect(writeCoeProjectorReport(path, { status: "projected" })).rejects.toBeDefined();
      expect(await readFile(path, "utf8")).toBe("sentinel\n");
      expect(await readdir(root)).toEqual(["report.json"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("fails closed if the report parent is replaced after opening", async () => {
    const root = await mkdtemp(join(tmpdir(), "gbrain-coe-report-parent-race-"));
    try {
      const parent = join(root, "reports");
      const openedParent = join(root, "reports-opened");
      await mkdir(parent);
      const path = join(parent, "report.json");
      await expect(writeCoeProjectorReport(path, { status: "projected" }, {
        afterParentOpen: async () => {
          await rename(parent, openedParent);
          await mkdir(parent);
        },
      })).rejects.toThrow("report parent directory changed");
      await expect(access(path)).rejects.toBeDefined();
      expect(await readdir(parent)).toEqual([]);
      expect(await readdir(openedParent)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("refuses a final-path symlink without touching its target", async () => {
    const root = await mkdtemp(join(tmpdir(), "gbrain-coe-report-symlink-"));
    try {
      const target = join(root, "target.json");
      const path = join(root, "report.json");
      await writeFile(target, "sentinel\n");
      await symlink(target, path);
      await expect(writeCoeProjectorReport(path, { status: "projected" })).rejects.toBeDefined();
      expect((await lstat(path)).isSymbolicLink()).toBe(true);
      expect(await readFile(target, "utf8")).toBe("sentinel\n");
      expect((await readdir(root)).sort()).toEqual(["report.json", "target.json"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reports an explicit committed state when final report publication fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "gbrain-coe-report-commit-boundary-"));
    try {
      const registryRoot = join(root, "registry");
      const reportPath = join(root, "reports", "report.json");
      await mkdir(registryRoot);
      await expect(runCoeProjectorCli(validArgsForPaths(registryRoot, reportPath, "--execute"), {
        loadConfiguration: () => ({
          engine: "postgres",
          database_url: "postgresql://coe_projector_r20260809:synthetic@127.0.0.1:55432/gbrain",
        }),
        createEngine: () => ({ async connect() {}, async disconnect() {} }),
        runProjection: async () => ({ status: "projected" } as never),
        writeReport: async () => {
          throw new Error("synthetic publication failure");
        },
        writeStdout: () => {
          throw new Error("stdout must not announce an unpublished report");
        },
      })).rejects.toThrow("projection committed but final report publication failed");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("CoE PostgreSQL projector CLI error precedence", () => {
  test("preserves the projection error when disconnect also fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "gbrain-coe-cli-errors-"));
    try {
      const registryRoot = join(root, "registry");
      const reportPath = join(root, "reports", "report.json");
      await mkdir(registryRoot);
      const primaryError = new Error("primary projection failure");
      const cleanupError = new Error("disconnect failure");
      const reports: unknown[] = [];
      await expect(runCoeProjectorCli(validArgsForPaths(registryRoot, reportPath), {
        loadConfiguration: () => ({
          engine: "postgres",
          database_url: `postgresql://coe_projector_r20260809:${["synthetic", "credential"].join("-")}@127.0.0.1:55432/gbrain`,
        }),
        createEngine: () => ({
          async connect() {},
          async disconnect() {
            throw cleanupError;
          },
        }),
        runProjection: async () => {
          throw primaryError;
        },
        writeReport: async (_path, value) => {
          reports.push(value);
        },
        now: () => new Date("2026-08-09T00:00:00.000Z"),
        writeStdout: () => {
          throw new Error("stdout must not be written on failure");
        },
      })).rejects.toBe(primaryError);
      expect(reports).toHaveLength(1);
      expect(reports[0]).toMatchObject({
        status: "failed",
        stage: "dry-run",
        error: "primary projection failure",
        cleanup_error: "disconnect failure",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
