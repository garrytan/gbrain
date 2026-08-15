import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import {
  BoundedHttpClient,
  CoeSnapshotLedger,
  SqlCoeSnapshotProjection,
  parsePilotManifest,
  runPilotManifest,
} from "../src/coe/registry/index.ts";
import { PGLiteEngine } from "../src/core/pglite-engine.ts";

interface Arguments {
  manifest: string;
  registryRoot?: string;
  databasePath?: string;
  reportPath?: string;
  validateOnly: boolean;
}

function usage(): never {
  process.stderr.write(
    "Usage: bun run scripts/acquire-coe-pilot.ts [--manifest PATH] " +
      "--registry-root PATH --database-path PATH --report PATH [--validate-only]\n",
  );
  process.exit(64);
}

function parseArguments(argv: string[]): Arguments {
  const parsed: Arguments = {
    manifest: resolve("fixtures/coe/pilot/science-one-coe/manifest.json"),
    validateOnly: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--validate-only") {
      parsed.validateOnly = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) usage();
    index += 1;
    if (argument === "--manifest") parsed.manifest = resolve(value);
    else if (argument === "--registry-root") parsed.registryRoot = resolve(value);
    else if (argument === "--database-path") parsed.databasePath = resolve(value);
    else if (argument === "--report") parsed.reportPath = resolve(value);
    else usage();
  }
  if (!parsed.validateOnly && (!parsed.registryRoot || !parsed.databasePath || !parsed.reportPath)) usage();
  if (parsed.registryRoot && parsed.databasePath && parsed.registryRoot === parsed.databasePath) {
    throw new Error("registry-root and database-path must be distinct");
  }
  return parsed;
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = resolve(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

const args = parseArguments(process.argv.slice(2));
const manifest = parsePilotManifest(JSON.parse(await readFile(args.manifest, "utf8")));
if (args.validateOnly) {
  process.stdout.write(`CoE pilot manifest valid: ${manifest.corpus_id} (${manifest.entries.length} entries)\n`);
  process.exit(0);
}

await mkdir(dirname(args.databasePath!), { recursive: true, mode: 0o700 });
const engine = new PGLiteEngine();
await engine.connect({ engine: "pglite", database_path: args.databasePath! });
try {
  await engine.initSchema();
  const projection = new SqlCoeSnapshotProjection(engine);
  const ledger = new CoeSnapshotLedger({ root: args.registryRoot!, projection });
  const recovery = await ledger.recoverPending();
  const rebuilt = await ledger.rebuildProjection();
  const report = await runPilotManifest({
    manifest,
    manifest_directory: dirname(args.manifest),
    ledger,
    http_client: new BoundedHttpClient(manifest.http_policy),
  });

  let verifiedSnapshots = 0;
  for (const entry of report.entries) {
    if (!entry.snapshot_id) continue;
    await ledger.readSnapshotBytes(entry.snapshot_id);
    verifiedSnapshots += 1;
  }
  const sourceCount = await engine.executeRaw<{ count: number }>("SELECT COUNT(*)::int AS count FROM coe_sources");
  const snapshotCount = await engine.executeRaw<{ count: number }>("SELECT COUNT(*)::int AS count FROM coe_snapshots");
  const acquisitionCount = await engine.executeRaw<{ count: number }>("SELECT COUNT(*)::int AS count FROM coe_acquisitions");
  const cleanup = await ledger.cleanupStaging();
  const capsule = {
    ...report,
    manifest_path: args.manifest,
    registry_root: args.registryRoot,
    projection_database_path: args.databasePath,
    recovery,
    rebuilt,
    verification: {
      verified_snapshots: verifiedSnapshots,
      projected_sources: Number(sourceCount[0]?.count ?? 0),
      projected_snapshots: Number(snapshotCount[0]?.count ?? 0),
      projected_acquisitions: Number(acquisitionCount[0]?.count ?? 0),
      staging_removed: cleanup.removed,
    },
  };
  await writeJsonAtomic(args.reportPath!, capsule);
  process.stdout.write(
    JSON.stringify({
      corpus_id: report.corpus_id,
      complete: report.complete,
      entries: report.entries.length,
      required_failures: report.required_failures,
      verified_snapshots: verifiedSnapshots,
      report: args.reportPath,
    }) + "\n",
  );
  if (!report.complete) process.exitCode = 2;
} finally {
  await engine.disconnect();
}
