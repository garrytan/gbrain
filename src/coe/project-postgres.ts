import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import {
  CoeContractError,
  canonicalizeJson,
  sha256Bytes,
  sha256Canonical,
  type LifecycleEventContract,
} from "./contracts/index.ts";
import {
  CoeEvidenceLedger,
  InMemoryCoeEvidenceProjection,
  SqlCoeEvidenceProjection,
  type CanonicalEvidenceBundle,
  type CoeEvidenceProjection,
} from "./evidence/index.ts";
import {
  CoeSnapshotLedger,
  InMemoryCoeSnapshotProjection,
  SqlCoeSnapshotProjection,
  type CanonicalAcquisition,
  type CoeSnapshotProjection,
} from "./registry/index.ts";
import type { BrainEngine } from "../core/engine.ts";

export interface CoeProjectorExpectedCounts {
  sources: number;
  raw_objects: number;
  snapshots: number;
  acquisitions: number;
  acquisition_redirects: number;
  snapshot_events: number;
  normalized_documents: number;
  sections: number;
  mappings: number;
  evidence_items: number;
}

export interface CoePostgresProjectorArgs {
  mode: "dry-run" | "execute";
  allowReplay: boolean;
  registryRoot: string;
  expectedRegistryRoot: string;
  expectedHost: string;
  expectedPort: number;
  expectedDatabase: string;
  expectedRole: string;
  expectedCounts: CoeProjectorExpectedCounts;
  reportPath: string;
}

function positiveInteger(value: string | undefined, flag: string): number {
  if (!value || !/^\d+$/.test(value) || Number(value) <= 0 || !Number.isSafeInteger(Number(value))) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return Number(value);
}

function nonNegativeInteger(value: string | undefined, flag: string): number {
  if (value === undefined || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`${flag} must be a non-negative integer`);
  }
  return Number(value);
}

function required(values: Map<string, string>, flag: string): string {
  const value = values.get(flag);
  if (!value) throw new Error(`${flag} is required`);
  return value;
}

type CoePostgresClientTargetExpectation = Pick<
  CoePostgresProjectorArgs,
  "expectedHost" | "expectedPort" | "expectedDatabase" | "expectedRole"
>;

export function assertCoePostgresClientTarget(
  databaseUrl: unknown,
  expected: CoePostgresClientTargetExpectation,
): void {
  if (typeof databaseUrl !== "string" || databaseUrl.length === 0) {
    throw new CoeContractError("policy_violation", "gbrain PostgreSQL database_url is not configured");
  }

  let parsed: URL;
  try {
    if (databaseUrl !== databaseUrl.trim()) throw new Error("surrounding whitespace");
    parsed = new URL(databaseUrl);
  } catch {
    throw new CoeContractError("policy_violation", "gbrain PostgreSQL database_url is malformed");
  }

  if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
    throw new CoeContractError("policy_violation", "gbrain database_url must use a PostgreSQL protocol");
  }

  // postgres.js takes the effective role from URL.username and the effective
  // database from URL.pathname. Query parameters named user/database do not
  // override those connection fields; accepting them here would attest a
  // different target from the one the driver actually opens.
  let role: string;
  try {
    role = decodeURIComponent(parsed.username);
  } catch {
    throw new CoeContractError("policy_violation", "gbrain PostgreSQL database_url is malformed");
  }
  if (parsed.searchParams.has("user") || parsed.searchParams.has("database")) {
    throw new CoeContractError("policy_violation", "database_url must not contain user or database query parameters");
  }
  const database = parsed.pathname.startsWith("/") ? parsed.pathname.slice(1) : "";
  const port = parsed.port === "" ? Number.NaN : Number(parsed.port);

  if (parsed.hostname !== expected.expectedHost) {
    throw new CoeContractError("policy_violation", "database_url client host does not match the expected host");
  }
  if (port !== expected.expectedPort) {
    throw new CoeContractError("policy_violation", "database_url client port does not match the expected port");
  }
  if (database !== expected.expectedDatabase) {
    throw new CoeContractError("policy_violation", "database_url database does not match the expected database");
  }
  if (role !== expected.expectedRole) {
    throw new CoeContractError("policy_violation", "database_url role does not match the expected role");
  }
}

function isInside(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

export async function assertCoeReportDestination(registryRoot: string, reportPath: string): Promise<void> {
  const canonicalRegistry = await realpath(registryRoot);
  const missingSegments = [basename(reportPath)];
  let existingAncestor = resolve(dirname(reportPath));
  let canonicalAncestor: string;
  while (true) {
    try {
      canonicalAncestor = await realpath(existingAncestor);
      break;
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
      const parent = dirname(existingAncestor);
      if (parent === existingAncestor) throw error;
      missingSegments.unshift(basename(existingAncestor));
      existingAncestor = parent;
    }
  }
  if (isInside(canonicalRegistry, resolve(canonicalAncestor, ...missingSegments))) {
    throw new CoeContractError("policy_violation", "report destination resolves inside the registry");
  }
}

interface RegistrySnapshotFile {
  path: string;
  bytes: Buffer;
  sha256: string;
}

interface RegistrySnapshotScan {
  directories: string[];
  files: RegistrySnapshotFile[];
  manifest_hash: string;
}

export interface CoeRegistryReadOnlySnapshot {
  root: string;
  source_manifest_hash: string;
  cleanup(): Promise<void>;
}

export interface CoeRegistrySnapshotHooks {
  afterRootMetadata?: (absolutePath: string) => Promise<void> | void;
  afterDirectoryMetadata?: (absolutePath: string, relativePath: string) => Promise<void> | void;
  afterDirectoryEntryMetadata?: (absolutePath: string, relativePath: string) => Promise<void> | void;
  afterEntryMetadata?: (absolutePath: string, relativePath: string) => Promise<void> | void;
}

async function scanRegistryReadOnly(
  sourceRoot: string,
  hooks: CoeRegistrySnapshotHooks = {},
): Promise<RegistrySnapshotScan> {
  const resolvedRoot = resolve(sourceRoot);
  let rootMetadata;
  try {
    rootMetadata = await lstat(resolvedRoot);
  } catch (error) {
    throw new CoeContractError("policy_violation", `registry root is unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new CoeContractError("policy_violation", "registry root must be a real directory");
  }
  if (await realpath(resolvedRoot) !== resolvedRoot) {
    throw new CoeContractError("policy_violation", "registry root path must not traverse symbolic links");
  }
  await hooks.afterRootMetadata?.(resolvedRoot);

  const directories: string[] = [];
  const files: RegistrySnapshotFile[] = [];
  const walk = async (
    directoryHandle: Awaited<ReturnType<typeof open>>,
    expectedDirectory: Awaited<ReturnType<typeof lstat>>,
    relativeDirectory: string,
  ): Promise<void> => {
    const openedDirectory = await directoryHandle.stat();
    if (!openedDirectory.isDirectory()
      || openedDirectory.dev !== expectedDirectory.dev
      || openedDirectory.ino !== expectedDirectory.ino) {
      throw new CoeContractError(
        "policy_violation",
        `registry directory changed before scanning: ${relativeDirectory || "."}`,
      );
    }
    const directoryPath = `/proc/self/fd/${directoryHandle.fd}`;
    await hooks.afterDirectoryMetadata?.(directoryPath, relativeDirectory);
    if (relativeDirectory) directories.push(relativeDirectory);
    const entries = await readdir(directoryPath, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const anchoredPath = `${directoryPath}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        throw new CoeContractError("policy_violation", `registry entry must not be a symbolic link: ${relativePath}`);
      }
      const expected = await lstat(anchoredPath);
      if (entry.isDirectory()) {
        if (expected.isSymbolicLink() || !expected.isDirectory()) {
          throw new CoeContractError("policy_violation", `registry entry changed type before scanning: ${relativePath}`);
        }
        await hooks.afterDirectoryEntryMetadata?.(anchoredPath, relativePath);
        const childHandle = await open(
          anchoredPath,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
        try {
          await walk(childHandle, expected, relativePath);
        } finally {
          await childHandle.close();
        }
        continue;
      }
      if (!entry.isFile()) {
        throw new CoeContractError("policy_violation", `registry entry must be a regular file: ${relativePath}`);
      }
      if (expected.isSymbolicLink() || !expected.isFile()) {
        throw new CoeContractError("policy_violation", `registry entry changed type before reading: ${relativePath}`);
      }
      await hooks.afterEntryMetadata?.(anchoredPath, relativePath);
      const handle = await open(anchoredPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = await handle.stat();
        if (!opened.isFile()) {
          throw new CoeContractError("policy_violation", `registry entry changed type while reading: ${relativePath}`);
        }
        if (expected.dev !== opened.dev || expected.ino !== opened.ino) {
          throw new CoeContractError("policy_violation", `registry entry changed before reading: ${relativePath}`);
        }
        const bytes = await handle.readFile();
        const after = await handle.stat();
        if (opened.dev !== after.dev || opened.ino !== after.ino || opened.size !== after.size || opened.mtimeMs !== after.mtimeMs) {
          throw new CoeContractError("policy_violation", `registry entry changed while reading: ${relativePath}`);
        }
        files.push({ path: relativePath, bytes, sha256: sha256Bytes(bytes) });
      } finally {
        await handle.close();
      }
    }
  };
  const rootHandle = await open(
    resolvedRoot,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await walk(rootHandle, rootMetadata, "");
  } finally {
    await rootHandle.close();
  }
  directories.sort();
  files.sort((left, right) => left.path.localeCompare(right.path));
  return {
    directories,
    files,
    manifest_hash: sha256Canonical({
      directories,
      files: files.map(({ path, sha256 }) => ({ path, sha256 })),
    }),
  };
}

export async function createCoeRegistryReadOnlySnapshot(
  sourceRoot: string,
  hooks: CoeRegistrySnapshotHooks = {},
): Promise<CoeRegistryReadOnlySnapshot> {
  const before = await scanRegistryReadOnly(sourceRoot, hooks);
  const snapshotRoot = await mkdtemp(join(tmpdir(), "gbrain-coe-registry-snapshot-"));
  await chmod(snapshotRoot, 0o700);
  try {
    for (const directory of before.directories) {
      await mkdir(resolve(snapshotRoot, directory), { recursive: true, mode: 0o700 });
    }
    for (const file of before.files) {
      const destination = resolve(snapshotRoot, file.path);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      const handle = await open(
        destination,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await handle.writeFile(file.bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    const after = await scanRegistryReadOnly(sourceRoot);
    if (after.manifest_hash !== before.manifest_hash) {
      throw new CoeContractError("policy_violation", "registry changed while creating the read-only snapshot");
    }
    const copied = await scanRegistryReadOnly(snapshotRoot);
    if (copied.manifest_hash !== before.manifest_hash) {
      throw new CoeContractError("hash_mismatch", "read-only registry snapshot does not match its source");
    }
    return {
      root: snapshotRoot,
      source_manifest_hash: before.manifest_hash,
      cleanup: async () => rm(snapshotRoot, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(snapshotRoot, { recursive: true, force: true });
    throw error;
  }
}

export function parseCoePostgresProjectorArgs(argv: string[]): CoePostgresProjectorArgs {
  const dryRunCount = argv.filter((arg) => arg === "--dry-run").length;
  const executeCount = argv.filter((arg) => arg === "--execute").length;
  if (dryRunCount + executeCount !== 1) {
    throw new Error("exactly one of --dry-run or --execute is required");
  }

  const allowReplay = argv.includes("--allow-replay");
  const mode = dryRunCount === 1 ? "dry-run" : "execute";
  if (allowReplay && mode !== "execute") throw new Error("--allow-replay requires --execute");

  const booleanFlags = new Set(["--dry-run", "--execute", "--allow-replay"]);
  for (const flag of booleanFlags) {
    if (argv.filter((argument) => argument === flag).length > 1) throw new Error(`duplicate argument: ${flag}`);
  }
  const valueFlags = new Set([
    "--registry-root",
    "--expected-registry-root",
    "--expected-host",
    "--expected-port",
    "--expected-database",
    "--expected-role",
    "--expected-sources",
    "--expected-raw-objects",
    "--expected-snapshots",
    "--expected-acquisitions",
    "--expected-acquisition-redirects",
    "--expected-snapshot-events",
    "--expected-normalized-documents",
    "--expected-sections",
    "--expected-mappings",
    "--expected-evidence-items",
    "--report",
  ]);
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]!;
    if (booleanFlags.has(flag)) continue;
    if (!valueFlags.has(flag)) throw new Error(`unknown argument: ${flag}`);
    if (values.has(flag)) throw new Error(`duplicate argument: ${flag}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    values.set(flag, value);
    index += 1;
  }

  const registryRoot = resolve(required(values, "--registry-root"));
  const expectedRegistryRoot = resolve(required(values, "--expected-registry-root"));
  if (registryRoot !== expectedRegistryRoot) throw new Error("registry root does not match the expected registry root");
  const reportPath = resolve(required(values, "--report"));
  if (isInside(registryRoot, reportPath)) throw new Error("report path must be outside the registry");

  const expectedPort = positiveInteger(values.get("--expected-port"), "--expected-port");
  if (expectedPort > 65535) throw new Error("--expected-port must be between 1 and 65535");

  return {
    mode,
    allowReplay,
    registryRoot,
    expectedRegistryRoot,
    expectedHost: required(values, "--expected-host"),
    expectedPort,
    expectedDatabase: required(values, "--expected-database"),
    expectedRole: required(values, "--expected-role"),
    expectedCounts: {
      sources: nonNegativeInteger(values.get("--expected-sources"), "--expected-sources"),
      raw_objects: nonNegativeInteger(values.get("--expected-raw-objects"), "--expected-raw-objects"),
      snapshots: nonNegativeInteger(values.get("--expected-snapshots"), "--expected-snapshots"),
      acquisitions: nonNegativeInteger(values.get("--expected-acquisitions"), "--expected-acquisitions"),
      acquisition_redirects: nonNegativeInteger(
        values.get("--expected-acquisition-redirects"),
        "--expected-acquisition-redirects",
      ),
      snapshot_events: nonNegativeInteger(values.get("--expected-snapshot-events"), "--expected-snapshot-events"),
      normalized_documents: nonNegativeInteger(
        values.get("--expected-normalized-documents"),
        "--expected-normalized-documents",
      ),
      sections: nonNegativeInteger(values.get("--expected-sections"), "--expected-sections"),
      mappings: nonNegativeInteger(values.get("--expected-mappings"), "--expected-mappings"),
      evidence_items: nonNegativeInteger(values.get("--expected-evidence-items"), "--expected-evidence-items"),
    },
    reportPath,
  };
}

export const COE_PROJECTION_TABLES = [
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
] as const;

export type CoeProjectionTable = typeof COE_PROJECTION_TABLES[number];

const COE_PROJECTION_TABLE_SET = new Set<string>(COE_PROJECTION_TABLES);

export type CoeIdentityRecords = Record<string, Record<string, string>>;

export function assertCoeIdentitySubset(expected: CoeIdentityRecords, actual: CoeIdentityRecords): void {
  for (const [table, rows] of Object.entries(actual)) {
    const expectedRows = expected[table] ?? {};
    for (const [identity, hash] of Object.entries(rows)) {
      if (!(identity in expectedRows)) {
        throw new CoeContractError("policy_violation", `${table} contains an unexpected identity: ${identity}`);
      }
      if (expectedRows[identity] !== hash) {
        throw new CoeContractError("hash_mismatch", `${table} identity hash mismatch: ${identity}`);
      }
    }
  }
}

export function assertCoeStoredRecordIdentity(
  table: string,
  identity: string,
  expectedHash: string,
  storedHash: string,
  recordJson: unknown,
): void {
  if (storedHash !== expectedHash) {
    throw new CoeContractError("hash_mismatch", `${table} identity hash mismatch: ${identity}`);
  }
  if (`sha256:${sha256Canonical(recordJson)}` !== expectedHash) {
    throw new CoeContractError("hash_mismatch", `${table} record_json hash mismatch: ${identity}`);
  }
}

const COE_ALLOWED_READ_RELATIONS = new Set([
  ...COE_PROJECTION_TABLES.map((table) => `public.${table}`),
  "public.config",
  "public.gbrain_schema_version",
  "pg_catalog.pg_class",
  "pg_catalog.pg_locks",
  "pg_catalog.pg_namespace",
  "pg_catalog.pg_stat_activity",
]);

export function assertCoeProjectionSqlAllowed(sql: string): void {
  const normalized = sql.trim().replace(/;\s*$/, "");
  if (normalized.includes(";")) {
    throw new CoeContractError("policy_violation", "multiple SQL statements are forbidden during CoE projection");
  }
  const upper = normalized.toUpperCase();
  if (/^SELECT\b/i.test(normalized)) {
    const relations = [...normalized.matchAll(/\b(?:FROM|JOIN)\s+([a-z_][a-z0-9_.]*)/gi)]
      .map((match) => match[1]!.toLowerCase());
    for (const relation of relations) {
      if (!COE_ALLOWED_READ_RELATIONS.has(relation)) {
        throw new CoeContractError("policy_violation", `read outside the CoE allowlist: ${relation}`);
      }
    }
    return;
  }
  if (/^(DELETE|TRUNCATE)\b/.test(upper)) {
    throw new CoeContractError("policy_violation", "destructive SQL is forbidden during CoE projection");
  }
  if (/^(CREATE|ALTER|DROP|GRANT|REVOKE)\b/.test(upper)) {
    throw new CoeContractError("policy_violation", "DDL is forbidden during CoE projection");
  }

  const match = normalized.match(/^(INSERT\s+INTO|UPDATE)\s+public\.(coe_[a-z_]+)(?=\s|\()/i);
  if (!match || !COE_PROJECTION_TABLE_SET.has(match[2]!.toLowerCase())) {
    throw new CoeContractError("policy_violation", "SQL write outside the CoE allowlist");
  }
  const writeSources = [...normalized.matchAll(/\b(?:FROM|JOIN)\s+([a-z_][a-z0-9_.]*)/gi)]
    .map((sourceMatch) => sourceMatch[1]!.toLowerCase());
  for (const relation of writeSources) {
    const table = relation.startsWith("public.") ? relation.slice("public.".length) : "";
    if (!COE_PROJECTION_TABLE_SET.has(table)) {
      throw new CoeContractError("policy_violation", `write reads outside the CoE allowlist: ${relation}`);
    }
  }
}

export interface CoeRegistryProjectionPlan {
  snapshot_rebuild: {
    acquisitions: number;
    projected: number;
    lifecycle_events: number;
    retractions: number;
  };
  evidence_rebuild: { documents: number; evidence_items: number };
  table_counts: Record<CoeProjectionTable, number>;
  identity_hash: string;
}

const PLAN_IDENTITIES = new WeakMap<CoeRegistryProjectionPlan, CoeIdentityRecords>();
const PLAN_STATES = new WeakMap<CoeRegistryProjectionPlan, CoeIdentityRecords>();

function canonicalRecordHash(value: unknown): string {
  return `sha256:${sha256Canonical(value)}`;
}

function putCanonical<T>(map: Map<string, T>, key: string, value: T, kind: string): void {
  const existing = map.get(key);
  if (existing !== undefined && canonicalizeJson(existing) !== canonicalizeJson(value)) {
    throw new CoeContractError("id_mismatch", `${kind} identity maps to different canonical content`);
  }
  if (existing === undefined) map.set(key, structuredClone(value));
}

class PlanningSnapshotProjection implements CoeSnapshotProjection {
  readonly memory = new InMemoryCoeSnapshotProjection();
  readonly sources = new Map<string, CanonicalAcquisition["source"]>();
  readonly rawObjects = new Map<string, { object_key: string; byte_size: number }>();
  readonly snapshots = new Map<string, NonNullable<CanonicalAcquisition["snapshot"]>>();
  readonly acquisitions = new Map<string, CanonicalAcquisition>();
  readonly redirects = new Map<string, CanonicalAcquisition["redirects"][number]>();
  readonly events = new Map<string, LifecycleEventContract>();

  async projectAcquisition(acquisition: CanonicalAcquisition): Promise<void> {
    await this.memory.projectAcquisition(acquisition);
    putCanonical(this.sources, acquisition.source.source_id, acquisition.source, "Source");
    putCanonical(this.acquisitions, acquisition.event_id, acquisition, "Acquisition");
    if (acquisition.snapshot) {
      putCanonical(this.snapshots, acquisition.snapshot.snapshot_id, acquisition.snapshot, "Snapshot");
      putCanonical(
        this.rawObjects,
        acquisition.snapshot.content_hash,
        { object_key: acquisition.snapshot.object_key, byte_size: acquisition.snapshot.byte_size },
        "Raw object",
      );
    }
    acquisition.redirects.forEach((redirect, hop) => {
      putCanonical(this.redirects, `${acquisition.event_id}:${hop}`, redirect, "Redirect");
    });
    for (const event of acquisition.lifecycle_events) {
      putCanonical(this.events, event.event_id, event, "Lifecycle event");
    }
  }

  getSnapshotStatus(snapshotId: string) {
    return this.memory.getSnapshotStatus(snapshotId);
  }

  async applyLifecycleEvent(event: LifecycleEventContract): Promise<void> {
    await this.memory.applyLifecycleEvent(event);
    putCanonical(this.events, event.event_id, event, "Lifecycle event");
  }
}

class PlanningEvidenceProjection implements CoeEvidenceProjection {
  readonly memory = new InMemoryCoeEvidenceProjection();
  readonly bundles = new Map<string, CanonicalEvidenceBundle>();

  async projectBundle(bundle: CanonicalEvidenceBundle): Promise<void> {
    await this.memory.projectBundle(bundle);
    putCanonical(
      this.bundles,
      bundle.normalized_document.normalized_document_id,
      bundle,
      "Evidence bundle",
    );
  }
}

function sortedCanonicalValues<T>(map: Map<string, T>): T[] {
  return [...map.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, value]) => value);
}

async function buildCoeRegistryProjectionPlanFromSnapshot(registryRoot: string): Promise<CoeRegistryProjectionPlan> {
  const snapshotProjection = new PlanningSnapshotProjection();
  const snapshotLedger = new CoeSnapshotLedger({ root: resolve(registryRoot), projection: snapshotProjection });
  const snapshotRebuild = await snapshotLedger.rebuildProjection();
  const evidenceProjection = new PlanningEvidenceProjection();
  const evidenceLedger = new CoeEvidenceLedger({
    root: resolve(registryRoot),
    snapshotLedger,
    projection: evidenceProjection,
  });
  const evidenceRebuild = await evidenceLedger.rebuildProjection();

  const bundles = sortedCanonicalValues(evidenceProjection.bundles);
  const sections = bundles.reduce((total, bundle) => total + bundle.normalized_document.sections.length, 0);
  const mappings = bundles.reduce((total, bundle) => total + bundle.normalized_document.mappings.length, 0);
  const evidenceItems = bundles.reduce((total, bundle) => total + bundle.evidence_items.length, 0);
  const tableCounts: Record<CoeProjectionTable, number> = {
    coe_sources: snapshotProjection.sources.size,
    coe_raw_objects: snapshotProjection.rawObjects.size,
    coe_snapshots: snapshotProjection.snapshots.size,
    coe_acquisitions: snapshotProjection.acquisitions.size,
    coe_acquisition_redirects: snapshotProjection.redirects.size,
    coe_snapshot_events: snapshotProjection.events.size,
    coe_normalized_documents: bundles.length,
    coe_document_sections: sections,
    coe_normalized_mappings: mappings,
    coe_evidence_items: evidenceItems,
  };
  const identities = Object.fromEntries(
    COE_PROJECTION_TABLES.map((table) => [table, {} as Record<string, string>]),
  ) as CoeIdentityRecords;
  for (const [identity, value] of snapshotProjection.sources) {
    identities.coe_sources![identity] = canonicalRecordHash(value);
  }
  for (const [identity, value] of snapshotProjection.rawObjects) {
    identities.coe_raw_objects![identity] = canonicalRecordHash(value);
  }
  for (const [identity, value] of snapshotProjection.snapshots) {
    identities.coe_snapshots![identity] = canonicalRecordHash(value);
  }
  for (const [identity, value] of snapshotProjection.acquisitions) {
    identities.coe_acquisitions![identity] = canonicalRecordHash(value);
  }
  for (const [identity, value] of snapshotProjection.redirects) {
    identities.coe_acquisition_redirects![identity] = canonicalRecordHash(value);
  }
  for (const [identity, value] of snapshotProjection.events) {
    identities.coe_snapshot_events![identity] = canonicalRecordHash(value);
  }
  for (const bundle of bundles) {
    const document = bundle.normalized_document;
    identities.coe_normalized_documents![document.normalized_document_id] = canonicalRecordHash(document);
    for (const section of document.sections) {
      identities.coe_document_sections![`${document.normalized_document_id}:${section.section_id}`] =
        canonicalRecordHash(section);
    }
    for (const [ordinal, mapping] of document.mappings.entries()) {
      identities.coe_normalized_mappings![`${document.normalized_document_id}:${ordinal}`] =
        canonicalRecordHash(mapping);
    }
    for (const evidence of bundle.evidence_items) {
      identities.coe_evidence_items![evidence.evidence_id] = canonicalRecordHash(evidence);
    }
  }

  const retractionsBySnapshot = new Map(
    [...snapshotProjection.events.values()]
      .filter((event) => event.to_status === "retracted")
      .map((event) => [event.aggregate_id, event]),
  );
  const states: CoeIdentityRecords = {
    coe_snapshots: Object.fromEntries([...snapshotProjection.memory.snapshots].map(([identity, value]) => {
      const retraction = retractionsBySnapshot.get(identity);
      return [
        identity,
        canonicalRecordHash({
          status: value.status,
          retracted_at: retraction?.occurred_at ?? null,
          retraction_reason: value.retraction_reason ?? null,
          retraction_event_id: value.retraction_event_id ?? null,
        }),
      ];
    })),
    coe_acquisitions: Object.fromEntries([...snapshotProjection.acquisitions].map(([identity, value]) => [
      identity,
      canonicalRecordHash({ outcome: value.outcome, error_code: value.error_code ?? null }),
    ])),
    coe_evidence_items: Object.fromEntries(bundles.flatMap(({ evidence_items }) => evidence_items.map((value) => [
      value.evidence_id,
      canonicalRecordHash({
        status: value.status,
        retraction_reason: value.retraction_reason ?? null,
      }),
    ]))),
  };

  const plan: CoeRegistryProjectionPlan = {
    snapshot_rebuild: snapshotRebuild,
    evidence_rebuild: evidenceRebuild,
    table_counts: tableCounts,
    identity_hash: canonicalRecordHash(identities),
  };
  PLAN_IDENTITIES.set(plan, identities);
  PLAN_STATES.set(plan, states);
  return plan;
}

export async function buildCoeRegistryProjectionPlan(registryRoot: string): Promise<CoeRegistryProjectionPlan> {
  const snapshot = await createCoeRegistryReadOnlySnapshot(registryRoot);
  try {
    return await buildCoeRegistryProjectionPlanFromSnapshot(snapshot.root);
  } finally {
    await snapshot.cleanup();
  }
}

export interface CoeProjectorEngine {
  readonly kind: "postgres" | "pglite";
  executeRaw<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  transaction<T>(fn: (engine: CoeProjectorEngine) => Promise<T>): Promise<T>;
}

export interface CoePostgresPreflight {
  endpoint: { host: string; port: number; database: string };
  schema_version: number;
  tables: string[];
  rls_enabled: string[];
  counts: Record<CoeProjectionTable, number>;
  long_transactions: number;
  blocked_backends: number;
  ungranted_locks: number;
}

function sameStrings(left: string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertPlanCaps(args: CoePostgresProjectorArgs, plan: CoeRegistryProjectionPlan): void {
  const actual: CoeProjectorExpectedCounts = {
    sources: plan.table_counts.coe_sources,
    raw_objects: plan.table_counts.coe_raw_objects,
    snapshots: plan.table_counts.coe_snapshots,
    acquisitions: plan.table_counts.coe_acquisitions,
    acquisition_redirects: plan.table_counts.coe_acquisition_redirects,
    snapshot_events: plan.table_counts.coe_snapshot_events,
    normalized_documents: plan.table_counts.coe_normalized_documents,
    sections: plan.table_counts.coe_document_sections,
    mappings: plan.table_counts.coe_normalized_mappings,
    evidence_items: plan.table_counts.coe_evidence_items,
  };
  if (canonicalizeJson(actual) !== canonicalizeJson(args.expectedCounts)) {
    throw new CoeContractError("policy_violation", "registry projection counts differ from the mission caps");
  }
}

async function readCoeIdentityRecords(
  tx: Pick<CoeProjectorEngine, "executeRaw">,
): Promise<CoeIdentityRecords> {
  const identities = Object.fromEntries(
    COE_PROJECTION_TABLES.map((table) => [table, {} as Record<string, string>]),
  ) as CoeIdentityRecords;
  const hashRows = await tx.executeRaw<{
    table_name: string;
    identity: string;
    hash: string;
    record_json: unknown;
    projection_matches_record: boolean;
  }>(
    `SELECT 'coe_sources'::text AS table_name, source_id AS identity, record_hash AS hash, record_json,
            source_id = record_json->>'source_id'
            AND schema_version = record_json->>'schema_version'
            AND scope_json = record_json->'scope'
            AND created_at = (record_json->>'created_at')::timestamptz AS projection_matches_record
       FROM public.coe_sources
     UNION ALL SELECT 'coe_snapshots', snapshot_id, record_hash, record_json,
            snapshot_id = record_json->>'snapshot_id'
            AND source_id = record_json->>'source_id'
            AND schema_version = record_json->>'schema_version'
            AND content_hash = record_json->>'content_hash'
            AND media_type = record_json->>'media_type'
            AND byte_size = (record_json->>'byte_size')::bigint
            AND object_key = record_json->>'object_key'
            AND supersedes_snapshot_id IS NOT DISTINCT FROM record_json->>'supersedes_snapshot_id'
            AND initial_status = record_json->>'status'
            AND scope_json = record_json->'scope'
            AND acquired_at = (record_json->>'acquired_at')::timestamptz
       FROM public.coe_snapshots
     UNION ALL SELECT 'coe_acquisitions', event_id, record_hash, record_json,
            event_id = record_json->>'event_id'
            AND source_id = record_json#>>'{source,source_id}'
            AND snapshot_id IS NOT DISTINCT FROM record_json#>>'{snapshot,snapshot_id}'
            AND requested_uri = record_json->>'requested_uri'
            AND final_uri IS NOT DISTINCT FROM record_json->>'final_uri'
            AND acquisition_method = record_json->>'acquisition_method'
            AND outcome = record_json->>'outcome'
            AND expected_hash IS NOT DISTINCT FROM record_json->>'expected_hash'
            AND actual_hash IS NOT DISTINCT FROM record_json->>'actual_hash'
            AND error_code IS NOT DISTINCT FROM record_json->>'error_code'
            AND quarantine_reasons = record_json->'quarantine_reasons'
            AND started_at = (record_json->>'started_at')::timestamptz
            AND finished_at = (record_json->>'finished_at')::timestamptz
       FROM public.coe_acquisitions
     UNION ALL SELECT 'coe_normalized_documents', normalized_document_id, record_hash, record_json,
            normalized_document_id = record_json->>'normalized_document_id'
            AND snapshot_id = record_json->>'snapshot_id'
            AND schema_version = record_json->>'schema_version'
            AND content_hash = record_json->>'content_hash'
            AND byte_size = (record_json->>'byte_size')::bigint
            AND object_key = record_json->>'object_key'
            AND normalizer_name = record_json#>>'{normalizer,name}'
            AND normalizer_version = record_json#>>'{normalizer,version}'
            AND normalizer_config_hash = record_json#>>'{normalizer,config_hash}'
            AND scope_json = record_json->'scope'
            AND warnings_json = record_json->'warnings'
            AND created_at = (record_json->>'created_at')::timestamptz
       FROM public.coe_normalized_documents
     UNION ALL SELECT 'coe_document_sections', normalized_document_id || ':' || section_id, record_hash, record_json,
            section_id = record_json->>'section_id'
            AND parent_section_id IS NOT DISTINCT FROM record_json->>'parent_section_id'
            AND ordinal = (record_json->>'ordinal')::int
            AND level = (record_json->>'level')::int
            AND title IS NOT DISTINCT FROM record_json->>'title'
            AND normalized_start = (record_json#>>'{normalized_span,start}')::int
            AND normalized_end = (record_json#>>'{normalized_span,end}')::int
            AND text_hash = record_json->>'text_hash'
       FROM public.coe_document_sections
     UNION ALL SELECT 'coe_normalized_mappings', normalized_document_id || ':' || ordinal::text, record_hash, record_json,
            section_id IS NOT DISTINCT FROM record_json->>'section_id'
            AND normalized_start = (record_json->>'normalized_start')::int
            AND normalized_end = (record_json->>'normalized_end')::int
            AND raw_locator_json = record_json->'raw_locator'
       FROM public.coe_normalized_mappings
     UNION ALL SELECT 'coe_evidence_items', evidence_id, record_hash, record_json,
            evidence_id = record_json->>'evidence_id'
            AND snapshot_id = record_json->>'snapshot_id'
            AND normalized_document_id = record_json->>'normalized_document_id'
            AND section_id IS NOT DISTINCT FROM record_json->>'section_id'
            AND schema_version = record_json->>'schema_version'
            AND evidence_type = record_json->>'evidence_type'
            AND normalized_text = record_json->>'normalized_text'
            AND text_hash = record_json->>'text_hash'
            AND normalized_start = (record_json#>>'{normalized_span,start}')::int
            AND normalized_end = (record_json#>>'{normalized_span,end}')::int
            AND raw_locator_json = record_json->'raw_locator'
            AND initial_status = record_json->>'status'
            AND supersedes_evidence_id IS NOT DISTINCT FROM record_json->>'supersedes_evidence_id'
            AND scope_json = record_json->'scope'
            AND created_at = (record_json->>'created_at')::timestamptz
       FROM public.coe_evidence_items`,
  );
  for (const row of hashRows) {
    assertCoeStoredRecordIdentity(row.table_name, row.identity, row.hash, row.hash, row.record_json);
    if (row.projection_matches_record !== true) {
      throw new CoeContractError(
        "hash_mismatch",
        `${row.table_name} projected columns diverge from canonical record: ${row.identity}`,
      );
    }
    identities[row.table_name]![row.identity] = row.hash;
  }

  const rawRows = await tx.executeRaw<{ content_hash: string; object_key: string; byte_size: number | string }>(
    "SELECT content_hash, object_key, byte_size FROM public.coe_raw_objects",
  );
  for (const row of rawRows) {
    identities.coe_raw_objects![row.content_hash] = canonicalRecordHash({
      object_key: row.object_key,
      byte_size: Number(row.byte_size),
    });
  }
  const redirectRows = await tx.executeRaw<{
    event_id: string;
    hop: number | string;
    from_uri: string;
    to_uri: string;
    status_code: number | string;
  }>("SELECT event_id, hop, from_uri, to_uri, status_code FROM public.coe_acquisition_redirects");
  for (const row of redirectRows) {
    identities.coe_acquisition_redirects![`${row.event_id}:${Number(row.hop)}`] = canonicalRecordHash({
      from_uri: row.from_uri,
      to_uri: row.to_uri,
      status_code: Number(row.status_code),
    });
  }
  const eventRows = await tx.executeRaw<{
    event_id: string;
    event_json: unknown;
    projection_matches_event: boolean;
  }>(
    `SELECT event_id, event_json,
            event_id = event_json->>'event_id'
            AND snapshot_id = event_json->>'aggregate_id'
            AND event_type = event_json->>'event_type'
            AND from_status IS NOT DISTINCT FROM event_json->>'from_status'
            AND to_status IS NOT DISTINCT FROM event_json->>'to_status'
            AND reason_code IS NOT DISTINCT FROM event_json->>'reason_code'
            AND payload_hash = event_json->>'payload_hash'
            AND occurred_at = (event_json->>'occurred_at')::timestamptz AS projection_matches_event
       FROM public.coe_snapshot_events`,
  );
  for (const row of eventRows) {
    if (row.projection_matches_event !== true) {
      throw new CoeContractError(
        "hash_mismatch",
        `snapshot lifecycle-event columns diverge from canonical event: ${row.event_id}`,
      );
    }
    identities.coe_snapshot_events![row.event_id] = canonicalRecordHash(row.event_json);
  }
  return identities;
}

async function readCoeStateRecords(
  tx: Pick<CoeProjectorEngine, "executeRaw">,
): Promise<CoeIdentityRecords> {
  const states: CoeIdentityRecords = {};
  const rows = await tx.executeRaw<{ table_name: string; identity: string; state_json: unknown }>(
    `SELECT 'coe_snapshots'::text AS table_name, snapshot_id AS identity,
            jsonb_build_object(
              'status', status,
              'retracted_at', CASE WHEN retracted_at IS NULL THEN NULL
                ELSE to_char(retracted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END,
              'retraction_reason', retraction_reason,
              'retraction_event_id', retraction_event_id
            ) AS state_json
            FROM public.coe_snapshots
     UNION ALL SELECT 'coe_acquisitions', event_id,
            jsonb_build_object('outcome', outcome, 'error_code', error_code) FROM public.coe_acquisitions
     UNION ALL SELECT 'coe_evidence_items', evidence_id,
            jsonb_build_object('status', status, 'retraction_reason', retraction_reason)
            FROM public.coe_evidence_items`,
  );
  for (const row of rows) {
    (states[row.table_name] ??= {})[row.identity] = canonicalRecordHash(row.state_json);
  }
  return states;
}

export async function assertCoeReplayProjection(
  tx: Pick<CoeProjectorEngine, "executeRaw">,
  expectedIdentities: CoeIdentityRecords,
  expectedStates: CoeIdentityRecords,
): Promise<void> {
  assertCoeIdentitySubset(expectedIdentities, await readCoeIdentityRecords(tx));
  assertCoeIdentitySubset(expectedStates, await readCoeStateRecords(tx));
}

export async function assertCoeReplayProjectionPlan(
  tx: Pick<CoeProjectorEngine, "executeRaw">,
  plan: CoeRegistryProjectionPlan,
): Promise<void> {
  const expectedIdentities = PLAN_IDENTITIES.get(plan);
  if (!expectedIdentities) {
    throw new CoeContractError("policy_violation", "canonical replay identities are unavailable");
  }
  const expectedStates = PLAN_STATES.get(plan);
  if (!expectedStates) {
    throw new CoeContractError("policy_violation", "canonical replay states are unavailable");
  }
  await assertCoeReplayProjection(tx, expectedIdentities, expectedStates);
}

async function preflightCoePostgresTargetInTransaction(
  tx: CoeProjectorEngine,
  args: CoePostgresProjectorArgs,
  plan: CoeRegistryProjectionPlan,
): Promise<CoePostgresPreflight> {
  const databaseRows = await tx.executeRaw<{ database: string; role: string }>(
    "SELECT current_database() AS database, current_user AS role",
  );
  const database = databaseRows[0]?.database;
  if (database !== args.expectedDatabase) {
    throw new CoeContractError("policy_violation", "current_database() does not match the expected database");
  }
  if (databaseRows[0]?.role !== args.expectedRole) {
    throw new CoeContractError("policy_violation", "current_user does not match the expected role");
  }

  const versionRows = await tx.executeRaw<{ version: number | string }>(
    "SELECT value::int AS version FROM public.config WHERE key = 'version'",
  );
  const schemaVersion = Number(versionRows[0]?.version);
  if (schemaVersion !== 68) throw new CoeContractError("policy_violation", "database must be at schema version 68");

  const tableRows = await tx.executeRaw<{ table_name: string }>(
    "SELECT c.relname AS table_name FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'coe_%' ORDER BY c.relname",
  );
  const tables = tableRows.map(({ table_name }) => table_name);
  if (!sameStrings(tables, COE_PROJECTION_TABLES)) {
    throw new CoeContractError("policy_violation", "CoE table set mismatch");
  }

  const rlsRows = await tx.executeRaw<{ relname: string; relrowsecurity: boolean }>(
    "SELECT c.relname, c.relrowsecurity FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname LIKE 'coe_%' ORDER BY c.relname",
  );
  if (
    rlsRows.length !== COE_PROJECTION_TABLES.length ||
    rlsRows.some(({ relrowsecurity }) => relrowsecurity !== true)
  ) {
    throw new CoeContractError("policy_violation", "RLS is not enabled on every CoE table");
  }

  const countSql = COE_PROJECTION_TABLES.map((table) =>
    `SELECT '${table}'::text AS table_name, COUNT(*)::bigint::text AS count FROM public.${table}`
  ).join(" UNION ALL ");
  const countRows = await tx.executeRaw<{ table_name: CoeProjectionTable; count: number | string }>(countSql);
  const counts = Object.fromEntries(
    countRows.map(({ table_name, count }) => [table_name, Number(count)]),
  ) as Record<CoeProjectionTable, number>;
  if (Object.keys(counts).length !== COE_PROJECTION_TABLES.length) {
    throw new CoeContractError("policy_violation", "CoE count preflight is incomplete");
  }
  if (args.allowReplay) {
    for (const table of COE_PROJECTION_TABLES) {
      if (counts[table] > plan.table_counts[table]) {
        throw new CoeContractError("policy_violation", "replay target counts exceed the canonical plan");
      }
    }
    await assertCoeReplayProjectionPlan(tx, plan);
  } else if (Object.values(counts).some((count) => count !== 0)) {
    throw new CoeContractError("policy_violation", "target CoE tables are not empty");
  }

  const activityRows = await tx.executeRaw<{ long_transactions: number | string; blocked_backends: number | string }>(
    `SELECT
       COUNT(*) FILTER (WHERE pid <> pg_backend_pid() AND xact_start IS NOT NULL
         AND clock_timestamp() - xact_start > interval '5 minutes')::int AS long_transactions,
       COUNT(*) FILTER (WHERE pid <> pg_backend_pid() AND cardinality(pg_blocking_pids(pid)) > 0)::int AS blocked_backends
     FROM pg_catalog.pg_stat_activity WHERE datname = current_database()`,
  );
  const lockRows = await tx.executeRaw<{ ungranted_locks: number | string }>(
    `SELECT COUNT(*)::int AS ungranted_locks FROM pg_catalog.pg_locks l
     JOIN pg_catalog.pg_stat_activity a ON a.pid = l.pid
     WHERE a.datname = current_database() AND NOT l.granted`,
  );
  const longTransactions = Number(activityRows[0]?.long_transactions ?? 0);
  const blockedBackends = Number(activityRows[0]?.blocked_backends ?? 0);
  const ungrantedLocks = Number(lockRows[0]?.ungranted_locks ?? 0);
  if (longTransactions !== 0 || blockedBackends !== 0 || ungrantedLocks !== 0) {
    throw new CoeContractError("policy_violation", "database contention makes the projection ambiguous");
  }

  return {
    endpoint: { host: args.expectedHost, port: args.expectedPort, database },
    schema_version: schemaVersion,
    tables,
    rls_enabled: rlsRows.map(({ relname }) => relname),
    counts,
    long_transactions: longTransactions,
    blocked_backends: blockedBackends,
    ungranted_locks: ungrantedLocks,
  };
}

export async function preflightCoePostgresTarget(
  engine: CoeProjectorEngine,
  args: CoePostgresProjectorArgs,
  plan: CoeRegistryProjectionPlan,
): Promise<CoePostgresPreflight> {
  if (engine.kind !== "postgres") throw new CoeContractError("policy_violation", "PostgreSQL engine is required");
  assertPlanCaps(args, plan);
  return engine.transaction(async (tx) => {
    await tx.executeRaw("SET TRANSACTION READ ONLY");
    return preflightCoePostgresTargetInTransaction(tx, args, plan);
  });
}

export function guardCoeProjectionEngine(engine: BrainEngine): BrainEngine {
  let guardedEngine: BrainEngine;
  guardedEngine = new Proxy(engine, {
    get(target, property) {
      if (property === "executeRaw") {
        return async (sql: string, params?: unknown[]) => {
          assertCoeProjectionSqlAllowed(sql);
          return target.executeRaw(sql, params);
        };
      }
      if (property === "transaction") {
        return async <T>(fn: (tx: BrainEngine) => Promise<T>): Promise<T> => fn(guardedEngine);
      }
      if (property === "kind") return target.kind;
      const value = Reflect.get(target, property, target);
      if (typeof value === "function") {
        return () => {
          throw new CoeContractError(
            "policy_violation",
            `BrainEngine method ${String(property)} is outside the CoE projection allowlist`,
          );
        };
      }
      return value;
    },
  });
  return guardedEngine;
}

export interface CoeProjectionRunHooks {
  afterSnapshotRebuild?: () => Promise<void> | void;
}

export interface CoeProjectionRunReport {
  status: "dry-run" | "projected";
  registry_root: string;
  target: { host: string; port: number; database: string };
  plan: CoeRegistryProjectionPlan;
  preflight: CoePostgresPreflight;
  projection?: {
    snapshot_rebuild: CoeRegistryProjectionPlan["snapshot_rebuild"];
    evidence_rebuild: CoeRegistryProjectionPlan["evidence_rebuild"];
  };
  postflight?: CoePostgresPreflight;
}

export async function withCoeProjectionAdvisoryLock<T>(
  engine: Pick<BrainEngine, "transaction">,
  operation: (tx: BrainEngine) => Promise<T>,
  options: { readOnly?: boolean } = {},
): Promise<T> {
  return await engine.transaction(async (tx) => {
    if (options.readOnly === true) {
      await tx.executeRaw("SET TRANSACTION READ ONLY");
    }
    const rows = await tx.executeRaw<{ acquired: boolean }>(
      "SELECT pg_catalog.pg_try_advisory_xact_lock(1668246853, 68) AS acquired",
    );
    if (rows[0]?.acquired !== true) {
      throw new CoeContractError("policy_violation", "another CoE PostgreSQL projection holds the advisory lock");
    }
    return await operation(tx);
  });
}

export async function runCoePostgresProjection(
  engine: BrainEngine,
  args: CoePostgresProjectorArgs,
  hooks: CoeProjectionRunHooks = {},
): Promise<CoeProjectionRunReport> {
  const registrySnapshot = await createCoeRegistryReadOnlySnapshot(args.registryRoot);
  try {
    return await withCoeProjectionAdvisoryLock(engine, async (tx) => {
      const plan = await buildCoeRegistryProjectionPlanFromSnapshot(registrySnapshot.root);
      if (engine.kind !== "postgres") {
        throw new CoeContractError("policy_violation", "PostgreSQL engine is required");
      }
      assertPlanCaps(args, plan);
      const preflight = await preflightCoePostgresTargetInTransaction(
        tx as unknown as CoeProjectorEngine,
        args,
        plan,
      );
      if (args.mode === "dry-run") {
        return {
          status: "dry-run",
          registry_root: args.registryRoot,
          target: preflight.endpoint,
          plan,
          preflight,
        };
      }

      const guardedEngine = guardCoeProjectionEngine(tx);
      const snapshotLedger = new CoeSnapshotLedger({
        root: registrySnapshot.root,
        projection: new SqlCoeSnapshotProjection(guardedEngine),
      });
      const snapshotRebuild = await snapshotLedger.rebuildProjection();
      await hooks.afterSnapshotRebuild?.();
      const evidenceLedger = new CoeEvidenceLedger({
        root: registrySnapshot.root,
        snapshotLedger,
        projection: new SqlCoeEvidenceProjection(guardedEngine),
      });
      const evidenceRebuild = await evidenceLedger.rebuildProjection();
      if (
        canonicalizeJson(snapshotRebuild) !== canonicalizeJson(plan.snapshot_rebuild) ||
        canonicalizeJson(evidenceRebuild) !== canonicalizeJson(plan.evidence_rebuild)
      ) {
        throw new CoeContractError("policy_violation", "projection result differs from the verified registry plan");
      }

      const postflightArgs: CoePostgresProjectorArgs = {
        ...args,
        mode: "execute",
        allowReplay: true,
      };
      const postflight = await preflightCoePostgresTargetInTransaction(
        tx as unknown as CoeProjectorEngine,
        postflightArgs,
        plan,
      );
      if (canonicalizeJson(postflight.counts) !== canonicalizeJson(plan.table_counts)) {
        throw new CoeContractError("policy_violation", "postflight counts differ from the canonical plan");
      }
      return {
        status: "projected",
        registry_root: args.registryRoot,
        target: postflight.endpoint,
        plan,
        preflight,
        projection: {
          snapshot_rebuild: snapshotRebuild,
          evidence_rebuild: evidenceRebuild,
        },
        postflight,
      };
    }, { readOnly: args.mode === "dry-run" });
  } finally {
    await registrySnapshot.cleanup();
  }
}
