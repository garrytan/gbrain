import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { z } from "zod";

import { canonicalizeJson, makeCoeId, SourceSchema } from "../contracts/index.ts";
import { BoundedHttpClient, HttpAcquisitionError } from "./http-acquisition.ts";
import { CoeSnapshotLedger } from "./snapshot-ledger.ts";
import type { AcquisitionOutcome } from "./types.ts";

const MediaTypeSchema = z.string().regex(/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/);
const HashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const EntryIdSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const EvidenceClassSchema = z.enum(["official_primary", "official_artifact", "derived_internal"]);

const HttpPolicySchema = z.strictObject({
  allowed_hosts: z.array(z.string().min(1)).min(1),
  max_bytes: z.number().int().positive().max(512 * 1024 * 1024),
  timeout_ms: z.number().int().positive().max(120_000),
  max_redirects: z.number().int().min(0).max(10),
  user_agent: z.string().min(1).optional(),
});

const HttpEntrySchema = z.strictObject({
  entry_id: EntryIdSchema,
  transport: z.literal("http"),
  required: z.boolean(),
  evidence_class: EvidenceClassSchema,
  source: SourceSchema,
  uri: z.url(),
  expected_media_types: z.array(MediaTypeSchema).min(1),
  expected_sha256: HashSchema.optional(),
  max_bytes: z.number().int().positive().max(512 * 1024 * 1024).optional(),
});

const LocalEntrySchema = z.strictObject({
  entry_id: EntryIdSchema,
  transport: z.literal("filesystem"),
  required: z.boolean(),
  evidence_class: EvidenceClassSchema,
  source: SourceSchema,
  local_path: z.string().min(1),
  stored_uri: z.url(),
  media_type: MediaTypeSchema,
  expected_sha256: HashSchema.optional(),
  max_bytes: z.number().int().positive().max(16 * 1024 * 1024),
});

const PilotEntrySchema = z.discriminatedUnion("transport", [HttpEntrySchema, LocalEntrySchema]);

export const PilotManifestSchema = z
  .strictObject({
    schema_version: z.literal("1.0.0"),
    corpus_id: EntryIdSchema,
    http_policy: HttpPolicySchema,
    entries: z.array(PilotEntrySchema).min(1),
  })
  .superRefine((manifest, context) => {
    const allowedHosts = new Set(manifest.http_policy.allowed_hosts.map((host) => host.toLowerCase()));
    const entryIds = new Set<string>();
    const sourceRecords = new Map<string, string>();
    for (const [index, entry] of manifest.entries.entries()) {
      if (entryIds.has(entry.entry_id)) {
        context.addIssue({ code: "custom", path: ["entries", index, "entry_id"], message: "Duplicate entry_id" });
      }
      entryIds.add(entry.entry_id);

      const sourceRecord = canonicalizeJson(entry.source);
      const previousSource = sourceRecords.get(entry.source.source_id);
      if (previousSource && previousSource !== sourceRecord) {
        context.addIssue({ code: "custom", path: ["entries", index, "source"], message: "A source_id maps to conflicting records" });
      }
      sourceRecords.set(entry.source.source_id, sourceRecord);
      if (entry.source.canonical_uri) {
        const expectedSourceId = makeCoeId("src", {
          canonical_uri: entry.source.canonical_uri,
          source_kind: entry.source.source_kind,
        });
        if (entry.source.source_id !== expectedSourceId) {
          context.addIssue({ code: "custom", path: ["entries", index, "source", "source_id"], message: "Pilot source_id is not deterministic" });
        }
      }

      if (entry.evidence_class === "derived_internal" && entry.transport !== "filesystem") {
        context.addIssue({ code: "custom", path: ["entries", index, "transport"], message: "Derived internal material must be local" });
      }
      if (entry.transport === "http") {
        const uri = new URL(entry.uri);
        if (uri.protocol !== "https:" || !allowedHosts.has(uri.hostname.toLowerCase())) {
          context.addIssue({ code: "custom", path: ["entries", index, "uri"], message: "HTTP entry is outside the HTTPS host allowlist" });
        }
        if (uri.username || uri.password || (uri.port && uri.port !== "443")) {
          context.addIssue({ code: "custom", path: ["entries", index, "uri"], message: "HTTP entry contains credentials or a non-default port" });
        }
        for (const key of uri.searchParams.keys()) {
          if (/(?:token|key|secret|signature|credential|password|auth)/i.test(key)) {
            context.addIssue({ code: "custom", path: ["entries", index, "uri"], message: "HTTP entry contains a sensitive query parameter" });
          }
        }
        if ((entry.max_bytes ?? manifest.http_policy.max_bytes) > manifest.http_policy.max_bytes) {
          context.addIssue({ code: "custom", path: ["entries", index, "max_bytes"], message: "Entry max_bytes exceeds the corpus policy" });
        }
      } else {
        const segments = entry.local_path.split(/[\\/]+/);
        if (isAbsolute(entry.local_path) || segments.includes("..") || segments.includes(".") || entry.local_path.includes("\0")) {
          context.addIssue({ code: "custom", path: ["entries", index, "local_path"], message: "local_path must be a confined relative path" });
        }
        if (new URL(entry.stored_uri).protocol !== "file:") {
          context.addIssue({ code: "custom", path: ["entries", index, "stored_uri"], message: "Filesystem entries require a file: stored_uri" });
        }
      }
    }
  });

export type PilotManifest = z.output<typeof PilotManifestSchema>;
export type PilotEntry = PilotManifest["entries"][number];

export function parsePilotManifest(value: unknown): PilotManifest {
  return PilotManifestSchema.parse(value);
}

export interface PilotReportEntry {
  entry_id: string;
  required: boolean;
  evidence_class: PilotEntry["evidence_class"];
  outcome: AcquisitionOutcome;
  event_id: string;
  snapshot_id?: string;
  snapshot_status?: string;
  content_hash?: string;
  byte_size?: number;
  error_code?: string;
  quarantine_reasons: string[];
}

export interface PilotAcquisitionReport {
  schema_version: "1.0.0";
  corpus_id: string;
  generated_at: string;
  complete: boolean;
  required_failures: number;
  entries: PilotReportEntry[];
}

export interface RunPilotManifestOptions {
  manifest: PilotManifest;
  manifest_directory: string;
  ledger: CoeSnapshotLedger;
  http_client: BoundedHttpClient;
  clock?: () => Date;
}

class LocalAcquisitionError extends Error {
  constructor(readonly code: string) {
    super(`Local acquisition failed: ${code}`);
    this.name = "LocalAcquisitionError";
  }
}

function isContained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

async function readConfinedFile(directory: string, localPath: string, maxBytes: number): Promise<Buffer> {
  const candidate = resolve(directory, localPath);
  try {
    const rootRealPath = await realpath(directory);
    const fileInfo = await lstat(candidate);
    if (fileInfo.isSymbolicLink() || !fileInfo.isFile()) throw new LocalAcquisitionError("local_file_not_regular");
    const fileRealPath = await realpath(candidate);
    if (!isContained(rootRealPath, fileRealPath)) throw new LocalAcquisitionError("local_path_escape");
    const handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new LocalAcquisitionError("local_file_not_regular");
      if (stat.size > maxBytes) throw new LocalAcquisitionError("local_file_too_large");
      const content = await handle.readFile();
      if (content.byteLength > maxBytes) throw new LocalAcquisitionError("local_file_too_large");
      return content;
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof LocalAcquisitionError) throw error;
    throw new LocalAcquisitionError("local_file_unavailable");
  }
}

function reportEntry(
  entry: PilotEntry,
  result: Awaited<ReturnType<CoeSnapshotLedger["acquire"]>>,
): PilotReportEntry {
  return {
    entry_id: entry.entry_id,
    required: entry.required,
    evidence_class: entry.evidence_class,
    outcome: result.outcome,
    event_id: result.event_id,
    ...(result.snapshot
      ? {
          snapshot_id: result.snapshot.snapshot_id,
          snapshot_status: result.snapshot.status,
          content_hash: result.snapshot.content_hash,
          byte_size: result.snapshot.byte_size,
        }
      : {}),
    ...(result.error_code ? { error_code: result.error_code } : {}),
    quarantine_reasons: result.quarantine_reasons,
  };
}

function passed(entry: PilotReportEntry): boolean {
  return (entry.outcome === "promoted" || entry.outcome === "duplicate") && entry.snapshot_status === "active";
}

export async function runPilotManifest(options: RunPilotManifestOptions): Promise<PilotAcquisitionReport> {
  const manifest = parsePilotManifest(options.manifest);
  const clock = options.clock ?? (() => new Date());
  const entries: PilotReportEntry[] = [];

  for (const entry of manifest.entries) {
    const startedAt = clock().toISOString();
    if (entry.transport === "http") {
      try {
        const fetched = await options.http_client.fetch(entry.uri, { max_bytes: entry.max_bytes });
        const result = await options.ledger.acquire({
          source: entry.source,
          content: fetched.content,
          requested_uri: fetched.requested_uri,
          final_uri: fetched.final_uri,
          media_type: fetched.media_type,
          expected_media_types: entry.expected_media_types,
          acquisition_method: "http",
          acquired_at: fetched.acquired_at,
          expected_sha256: entry.expected_sha256,
          redirects: fetched.redirects,
        });
        entries.push(reportEntry(entry, result));
      } catch (error) {
        if (!(error instanceof HttpAcquisitionError)) throw error;
        const result = await options.ledger.recordFailure({
          source: entry.source,
          requested_uri: error.requested_uri,
          final_uri: error.final_uri,
          acquisition_method: "http",
          error_code: error.code,
          redirects: error.redirects,
          started_at: startedAt,
          finished_at: clock().toISOString(),
        });
        entries.push(reportEntry(entry, result));
      }
      continue;
    }

    try {
      const content = await readConfinedFile(options.manifest_directory, entry.local_path, entry.max_bytes);
      const result = await options.ledger.acquire({
        source: entry.source,
        content,
        requested_uri: entry.stored_uri,
        final_uri: entry.stored_uri,
        media_type: entry.media_type,
        expected_media_types: [entry.media_type],
        acquisition_method: "filesystem",
        acquired_at: clock().toISOString(),
        expected_sha256: entry.expected_sha256,
      });
      entries.push(reportEntry(entry, result));
    } catch (error) {
      if (!(error instanceof LocalAcquisitionError)) throw error;
      const result = await options.ledger.recordFailure({
        source: entry.source,
        requested_uri: entry.stored_uri,
        acquisition_method: "filesystem",
        error_code: error.code,
        started_at: startedAt,
        finished_at: clock().toISOString(),
      });
      entries.push(reportEntry(entry, result));
    }
  }

  const requiredFailures = entries.filter((entry) => entry.required && !passed(entry)).length;
  return {
    schema_version: "1.0.0",
    corpus_id: manifest.corpus_id,
    generated_at: clock().toISOString(),
    complete: requiredFailures === 0,
    required_failures: requiredFailures,
    entries,
  };
}
