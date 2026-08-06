import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import { z } from "zod";

import { CoeContractError, canonicalizeJson, sha256Bytes } from "../src/coe/contracts/index.ts";
import {
  CoeEvidenceLedger,
  JsonDocumentNormalizer,
  MarkdownDocumentNormalizer,
  SqlCoeEvidenceProjection,
  createHtmlDocumentNormalizer,
  createPdfDocumentNormalizer,
  preflightDocumentParsers,
  type DocumentNormalizer,
  type NormalizeSnapshotResult,
} from "../src/coe/evidence/index.ts";
import {
  CoeSnapshotLedger,
  SqlCoeSnapshotProjection,
} from "../src/coe/registry/index.ts";
import { PGLiteEngine } from "../src/core/pglite-engine.ts";

const SnapshotReportSchema = z.object({
  corpus_id: z.string().min(1),
  complete: z.boolean(),
  entries: z.array(z.object({
    entry_id: z.string().min(1),
    required: z.boolean(),
    snapshot_id: z.string().regex(/^snp_[0-9a-f]{64}$/).optional(),
    content_hash: z.string().regex(/^sha256:[0-9a-f]{64}$/).optional(),
  })),
});

interface Arguments {
  snapshotReport: string;
  registryRoot?: string;
  databasePath?: string;
  reportPath?: string;
  reviewSamplePath?: string;
  validateOnly: boolean;
}

function usage(): never {
  process.stderr.write(
    "Usage: bun run scripts/normalize-coe-pilot.ts --snapshot-report PATH " +
      "--registry-root PATH --database-path PATH --report PATH --review-sample PATH [--validate-only]\n",
  );
  process.exit(64);
}

function parseArguments(argv: string[]): Arguments {
  const parsed: Arguments = { snapshotReport: "", validateOnly: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--validate-only") {
      parsed.validateOnly = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) usage();
    index += 1;
    if (argument === "--snapshot-report") parsed.snapshotReport = resolve(value);
    else if (argument === "--registry-root") parsed.registryRoot = resolve(value);
    else if (argument === "--database-path") parsed.databasePath = resolve(value);
    else if (argument === "--report") parsed.reportPath = resolve(value);
    else if (argument === "--review-sample") parsed.reviewSamplePath = resolve(value);
    else usage();
  }
  if (!parsed.snapshotReport) usage();
  if (!parsed.validateOnly && (
    !parsed.registryRoot || !parsed.databasePath || !parsed.reportPath || !parsed.reviewSamplePath
  )) usage();
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

function normalizedMediaType(mediaType: string): string {
  return mediaType.split(";", 1)[0]!.trim().toLowerCase();
}

async function buildNormalizers(): Promise<DocumentNormalizer[]> {
  return [
    new MarkdownDocumentNormalizer(),
    new JsonDocumentNormalizer(),
    await createHtmlDocumentNormalizer(),
    await createPdfDocumentNormalizer(),
  ];
}

function selectNormalizer(normalizers: DocumentNormalizer[], mediaType: string): DocumentNormalizer {
  const matches = normalizers.filter((normalizer) => normalizer.supports(mediaType));
  if (matches.length !== 1) {
    throw new CoeContractError(
      "policy_violation",
      matches.length === 0
        ? `No normalizer supports ${mediaType}`
        : `Multiple normalizers support ${mediaType}`,
    );
  }
  return matches[0]!;
}

function sampleIndexes(length: number): number[] {
  if (length <= 3) return Array.from({ length }, (_, index) => index);
  return [...new Set([0, Math.floor(length / 2), length - 1])];
}

async function buildReviewSamples(
  entryId: string,
  result: NormalizeSnapshotResult,
  normalizer: DocumentNormalizer,
  snapshotLedger: CoeSnapshotLedger,
) {
  const snapshot = await snapshotLedger.getCanonicalSnapshot(result.normalized_document.snapshot_id);
  const source = await snapshotLedger.getCanonicalSource(snapshot.source_id);
  const rawBytes = await snapshotLedger.readSnapshotBytes(snapshot.snapshot_id);
  const output = await normalizer.normalize({ bytes: rawBytes, snapshot });
  if (output.blocks.length !== result.evidence_items.length) {
    throw new CoeContractError("id_mismatch", "Review sample cannot align parser blocks with EvidenceItems");
  }
  return sampleIndexes(result.evidence_items.length).map((index) => {
    const evidence = result.evidence_items[index]!;
    const block = output.blocks[index]!;
    if (canonicalizeJson(evidence.raw_locator) !== canonicalizeJson(block.raw_locator)) {
      throw new CoeContractError("id_mismatch", "Review sample raw locator differs from canonical evidence");
    }
    return {
      entry_id: entryId,
      source_uri: source.canonical_uri,
      snapshot_id: snapshot.snapshot_id,
      snapshot_content_hash: snapshot.content_hash,
      media_type: snapshot.media_type,
      normalized_document_id: result.normalized_document.normalized_document_id,
      evidence_id: evidence.evidence_id,
      section_id: evidence.section_id,
      normalized_span: evidence.normalized_span,
      raw_locator: evidence.raw_locator,
      raw_excerpt: (block.raw_text ?? block.text).slice(0, 800),
      normalized_text: evidence.normalized_text.slice(0, 800),
      operator_decision: "pending",
      operator_notes: null,
    };
  });
}

const args = parseArguments(process.argv.slice(2));
const snapshotReport = SnapshotReportSchema.parse(JSON.parse(await readFile(args.snapshotReport, "utf8")));
if (!snapshotReport.complete) {
  throw new CoeContractError("policy_violation", "Phase 3 requires a complete Phase 2 snapshot report");
}
if (snapshotReport.entries.some((entry) => entry.required && !entry.snapshot_id)) {
  throw new CoeContractError("invalid_contract", "Every required pilot entry needs a snapshot ID");
}

const parserPreflight = await preflightDocumentParsers();
if (args.validateOnly) {
  process.stdout.write(JSON.stringify({
    corpus_id: snapshotReport.corpus_id,
    entries: snapshotReport.entries.length,
    parser_preflight: parserPreflight,
  }) + "\n");
  process.exit(0);
}

await mkdir(dirname(args.databasePath!), { recursive: true, mode: 0o700 });
const engine = new PGLiteEngine();
await engine.connect({ engine: "pglite", database_path: args.databasePath! });
try {
  await engine.initSchema();
  const snapshotLedger = new CoeSnapshotLedger({
    root: args.registryRoot!,
    projection: new SqlCoeSnapshotProjection(engine),
  });
  const snapshotRebuild = await snapshotLedger.rebuildProjection();
  const evidenceLedger = new CoeEvidenceLedger({
    root: args.registryRoot!,
    snapshotLedger,
    projection: new SqlCoeEvidenceProjection(engine),
  });
  const evidenceRebuild = await evidenceLedger.rebuildProjection();
  const normalizers = await buildNormalizers();
  const entries: unknown[] = [];
  const reviewSamples: unknown[] = [];
  let requiredFailures = 0;

  for (const entry of snapshotReport.entries) {
    if (!entry.snapshot_id) continue;
    try {
      const snapshot = await snapshotLedger.getCanonicalSnapshot(entry.snapshot_id);
      if (entry.content_hash && entry.content_hash !== snapshot.content_hash) {
        throw new CoeContractError("hash_mismatch", "Snapshot report hash differs from canonical snapshot");
      }
      const normalizer = selectNormalizer(normalizers, normalizedMediaType(snapshot.media_type));
      const result = await evidenceLedger.normalizeSnapshot(snapshot.snapshot_id, normalizer);
      const verification = await evidenceLedger.verifyBundle(
        result.normalized_document.normalized_document_id,
        normalizer,
      );
      reviewSamples.push(...await buildReviewSamples(entry.entry_id, result, normalizer, snapshotLedger));
      entries.push({
        entry_id: entry.entry_id,
        required: entry.required,
        snapshot_id: snapshot.snapshot_id,
        media_type: snapshot.media_type,
        normalizer: result.normalized_document.normalizer,
        outcome: result.outcome,
        normalized_document_id: result.normalized_document.normalized_document_id,
        normalized_content_hash: result.normalized_document.content_hash,
        evidence_items: result.evidence_items.length,
        sections: result.normalized_document.sections.length,
        mappings: result.normalized_document.mappings.length,
        warnings: result.normalized_document.warnings.length,
        blocking_warnings: result.normalized_document.warnings.filter(({ severity }) => severity === "blocking").length,
        raw_mapping_verified: verification.raw_mapping_verified,
      });
    } catch (error) {
      if (entry.required) requiredFailures += 1;
      entries.push({
        entry_id: entry.entry_id,
        required: entry.required,
        snapshot_id: entry.snapshot_id,
        outcome: "failed",
        error_code: error instanceof CoeContractError ? error.code : "unexpected_error",
        error_message: error instanceof Error ? error.message : "Unknown normalization error",
      });
    }
  }

  const documentCount = await engine.executeRaw<{ count: number }>(
    "SELECT COUNT(*)::int AS count FROM coe_normalized_documents",
  );
  const evidenceCount = await engine.executeRaw<{ count: number }>(
    "SELECT COUNT(*)::int AS count FROM coe_evidence_items",
  );
  const mappingCount = await engine.executeRaw<{ count: number }>(
    "SELECT COUNT(*)::int AS count FROM coe_normalized_mappings",
  );
  const sectionCount = await engine.executeRaw<{ count: number }>(
    "SELECT COUNT(*)::int AS count FROM coe_document_sections",
  );
  const complete = requiredFailures === 0 && entries.length === snapshotReport.entries.length;
  const reviewSampleHash = sha256Bytes(canonicalizeJson(reviewSamples.map((sample) => {
    const { operator_decision: _decision, operator_notes: _notes, ...immutable } = sample as {
      operator_decision: string;
      operator_notes: string | null;
      [key: string]: unknown;
    };
    return immutable;
  })));
  const report = {
    schema_version: "1.0.0",
    corpus_id: snapshotReport.corpus_id,
    generated_at: new Date().toISOString(),
    complete,
    required_failures: requiredFailures,
    snapshot_report_path: args.snapshotReport,
    registry_root: args.registryRoot,
    projection_database_path: args.databasePath,
    parser_preflight: parserPreflight,
    snapshot_rebuild: snapshotRebuild,
    evidence_rebuild: evidenceRebuild,
    entries,
    projection: {
      normalized_documents: Number(documentCount[0]?.count ?? 0),
      sections: Number(sectionCount[0]?.count ?? 0),
      mappings: Number(mappingCount[0]?.count ?? 0),
      evidence_items: Number(evidenceCount[0]?.count ?? 0),
    },
    human_mapping_review: {
      status: "pending",
      sample_path: args.reviewSamplePath,
      sample_size: reviewSamples.length,
      sample_set_hash: reviewSampleHash,
    },
  };
  await writeJsonAtomic(args.reviewSamplePath!, {
    schema_version: "1.0.0",
    corpus_id: snapshotReport.corpus_id,
    generated_at: report.generated_at,
    instructions: "Compare each raw_excerpt and locator with normalized_text; set every operator_decision, then record the human reviewer and matching envelope status.",
    sample_set_hash: reviewSampleHash,
    status: "pending_human_review",
    review: {
      reviewer_principal: null,
      reviewed_at: null,
      notes: null,
    },
    samples: reviewSamples,
  });
  await writeJsonAtomic(args.reportPath!, report);
  process.stdout.write(JSON.stringify({
    corpus_id: report.corpus_id,
    complete: report.complete,
    entries: entries.length,
    required_failures: requiredFailures,
    normalized_documents: report.projection.normalized_documents,
    evidence_items: report.projection.evidence_items,
    human_review: report.human_mapping_review.status,
    report: args.reportPath,
  }) + "\n");
  if (!complete) process.exitCode = 2;
} finally {
  await engine.disconnect();
}
