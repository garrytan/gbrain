import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { z } from "zod";

import {
  RawLocatorSchema,
  canonicalizeJson,
  sha256Bytes,
} from "../src/coe/contracts/index.ts";

const HashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const TimestampSchema = z.string().datetime({ offset: true });

const ReviewSampleSchema = z.strictObject({
  entry_id: z.string().min(1),
  source_uri: z.string().min(1),
  snapshot_id: z.string().regex(/^snp_[0-9a-f]{64}$/),
  snapshot_content_hash: HashSchema,
  media_type: z.string().min(1),
  normalized_document_id: z.string().regex(/^ndoc_[0-9a-f]{64}$/),
  evidence_id: z.string().regex(/^evd_[0-9a-f]{64}$/),
  section_id: z.string().min(1),
  normalized_span: z.strictObject({
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
  }).refine(({ start, end }) => end > start),
  raw_locator: RawLocatorSchema,
  raw_excerpt: z.string(),
  normalized_text: z.string().min(1),
  operator_decision: z.enum(["pending", "approved", "rejected"]),
  operator_notes: z.string().min(1).nullable(),
});

const ReviewFileSchema = z.strictObject({
  schema_version: z.literal("1.0.0"),
  corpus_id: z.string().min(1),
  generated_at: TimestampSchema,
  instructions: z.string().min(1),
  sample_set_hash: HashSchema,
  status: z.enum(["pending_human_review", "approved", "rejected"]),
  review: z.strictObject({
    reviewer_principal: z.string().min(1).nullable(),
    reviewed_at: TimestampSchema.nullable(),
    notes: z.string().min(1).nullable(),
  }),
  samples: z.array(ReviewSampleSchema).min(1),
});

const ReportSchema = z.object({
  complete: z.boolean(),
  human_mapping_review: z.object({
    sample_size: z.number().int().positive(),
    sample_set_hash: HashSchema,
  }),
});

function usage(): never {
  process.stderr.write(
    "Usage: bun run scripts/check-coe-mapping-review.ts --review-sample PATH --report PATH\n",
  );
  process.exit(64);
}

const values = new Map<string, string>();
const argv = process.argv.slice(2);
for (let index = 0; index < argv.length; index += 2) {
  const key = argv[index];
  const value = argv[index + 1];
  if (!key || !value || !["--review-sample", "--report"].includes(key)) usage();
  values.set(key, resolve(value));
}
const reviewPath = values.get("--review-sample");
const reportPath = values.get("--report");
if (!reviewPath || !reportPath || values.size !== 2) usage();

const review = ReviewFileSchema.parse(JSON.parse(await readFile(reviewPath, "utf8")));
const report = ReportSchema.parse(JSON.parse(await readFile(reportPath, "utf8")));
const immutableSamples = review.samples.map(({ operator_decision: _decision, operator_notes: _notes, ...sample }) => sample);
const recomputedHash = sha256Bytes(canonicalizeJson(immutableSamples));
if (
  recomputedHash !== review.sample_set_hash ||
  recomputedHash !== report.human_mapping_review.sample_set_hash
) {
  throw new Error("Mapping-review sample hash differs from its immutable pilot report anchor");
}
if (review.samples.length !== report.human_mapping_review.sample_size) {
  throw new Error("Mapping-review sample count differs from its pilot report anchor");
}

const rejected = review.samples.filter(({ operator_decision }) => operator_decision === "rejected").length;
const pending = review.samples.filter(({ operator_decision }) => operator_decision === "pending").length;
const derivedStatus = rejected > 0 ? "rejected" : pending > 0 ? "pending_human_review" : "approved";
if (review.status !== derivedStatus) {
  throw new Error(`Review envelope status must be ${derivedStatus}`);
}
if (derivedStatus !== "pending_human_review" && (!review.review.reviewer_principal || !review.review.reviewed_at)) {
  throw new Error("A completed mapping review requires a reviewer_principal and reviewed_at timestamp");
}

process.stdout.write(JSON.stringify({
  corpus_id: review.corpus_id,
  pilot_complete: report.complete,
  status: derivedStatus,
  samples: review.samples.length,
  approved: review.samples.length - pending - rejected,
  pending,
  rejected,
  sample_set_hash: recomputedHash,
}) + "\n");
if (!report.complete || derivedStatus !== "approved") process.exitCode = 2;
