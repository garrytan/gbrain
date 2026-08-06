import { z } from "zod";

import { sha256Bytes } from "./canonical.ts";
import { COE_ERROR_CODES, CoeContractError, type CoeErrorCode } from "./errors.ts";
import { ARTIFACT_STATUSES, CLAIM_STATUSES, canTransition } from "./transitions.ts";

export const COE_SCHEMA_VERSION = "1.0.0" as const;
export const COE_JSON_SCHEMA_DIALECT = "https://json-schema.org/draft/2020-12/schema" as const;

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const COE_ID_PATTERN = /^(?:src|snp|ndoc|evd|clm|cedge|vrf|ret|ans|acm|ctr|evt|pol)_[0-9a-f]{64}$/;
const DECIMAL_PATTERN = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;
const NON_NEGATIVE_DECIMAL_PATTERN = /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/;
const OBJECT_KEY_PATTERN = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/;

function objectKeyForContentHash(contentHash: string): string {
  const digest = contentHash.slice("sha256:".length);
  return `objects/sha256/${digest.slice(0, 2)}/${digest}`;
}

const NonEmptyStringSchema = z.string().min(1).refine((value) => value.trim().length > 0, {
  message: "String must contain a non-whitespace character",
});
const Sha256Schema = z.string().regex(SHA256_PATTERN);
const DecimalSchema = z.string().regex(DECIMAL_PATTERN);
const NonNegativeDecimalSchema = z.string().regex(NON_NEGATIVE_DECIMAL_PATTERN);
const TimestampSchema = z.iso.datetime({ offset: true });
const DateSchema = z.iso.date();
const SchemaVersionSchema = z.literal(COE_SCHEMA_VERSION);

function idSchema(prefix: string) {
  return z.string().regex(new RegExp(`^${prefix}_[0-9a-f]{64}$`));
}

function addDuplicateIssue(values: readonly (string | number)[], path: string, context: z.RefinementCtx): void {
  if (new Set(values).size !== values.length) {
    context.addIssue({
      code: "custom",
      path: [path],
      message: `${path} must not contain duplicates`,
    });
  }
}

export const ActorRefSchema = z.strictObject({
  actor_type: z.enum(["human", "service", "system", "llm"]),
  actor_id: NonEmptyStringSchema,
});

export type ActorRef = z.output<typeof ActorRefSchema>;

export const AccessScopeSchema = z
  .strictObject({
    brain_id: NonEmptyStringSchema,
    visibility: z.enum(["private", "workspace", "public"]),
    owner_principal: NonEmptyStringSchema,
    reader_principals: z.array(NonEmptyStringSchema),
    source_ids: z.array(idSchema("src")).min(1),
  })
  .superRefine((scope, context) => {
    addDuplicateIssue(scope.reader_principals, "reader_principals", context);
    addDuplicateIssue(scope.source_ids, "source_ids", context);
    if (scope.reader_principals.includes(scope.owner_principal)) {
      context.addIssue({
        code: "custom",
        path: ["reader_principals"],
        message: "owner_principal is implicit and must not be duplicated in reader_principals",
      });
    }
  });

export type AccessScope = z.infer<typeof AccessScopeSchema>;

const visibilityRank: Record<AccessScope["visibility"], number> = {
  private: 0,
  workspace: 1,
  public: 2,
};

function isSubset(child: readonly string[], parent: readonly string[]): boolean {
  return child.every((value) => parent.includes(value));
}

export function assertScopeDoesNotWiden(parent: AccessScope, child: AccessScope): void {
  const widens =
    child.brain_id !== parent.brain_id ||
    child.owner_principal !== parent.owner_principal ||
    visibilityRank[child.visibility] > visibilityRank[parent.visibility] ||
    !isSubset(child.reader_principals, parent.reader_principals) ||
    !isSubset(child.source_ids, parent.source_ids);

  if (widens) {
    throw new CoeContractError("scope_widening", "Derived scope must be equal to or narrower than its parent scope");
  }
}

export const RawLocatorSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("pdf_page"),
    page: z.number().int().positive(),
    bounding_box: z
      .strictObject({
        x: z.number().nonnegative(),
        y: z.number().nonnegative(),
        width: z.number().positive(),
        height: z.number().positive(),
      })
      .optional(),
  }),
  z.strictObject({
    kind: z.literal("line_range"),
    start_line: z.number().int().positive(),
    end_line: z.number().int().positive(),
  }),
  z.strictObject({
    kind: z.literal("html_selector"),
    selector: NonEmptyStringSchema,
    occurrence: z.number().int().nonnegative(),
  }),
  z.strictObject({
    kind: z.literal("byte_range"),
    start_byte: z.number().int().nonnegative(),
    end_byte: z.number().int().positive(),
  }),
  z.strictObject({
    kind: z.literal("block"),
    block_id: NonEmptyStringSchema,
  }),
  z.strictObject({
    kind: z.literal("table_cell"),
    table_id: NonEmptyStringSchema,
    row: z.number().int().nonnegative(),
    column: z.number().int().nonnegative(),
  }),
  z.strictObject({
    kind: z.literal("code_range"),
    path: NonEmptyStringSchema,
    start_line: z.number().int().positive(),
    end_line: z.number().int().positive(),
  }),
]).superRefine((locator, context) => {
  if (locator.kind === "line_range" && locator.end_line < locator.start_line) {
    context.addIssue({ code: "custom", path: ["end_line"], message: "end_line must not precede start_line" });
  }
  if (locator.kind === "code_range" && locator.end_line < locator.start_line) {
    context.addIssue({ code: "custom", path: ["end_line"], message: "end_line must not precede start_line" });
  }
  if (locator.kind === "byte_range" && locator.end_byte <= locator.start_byte) {
    context.addIssue({ code: "custom", path: ["end_byte"], message: "end_byte must be greater than start_byte" });
  }
});

const ExternalIdentifierSchema = z.strictObject({
  scheme: z.enum(["doi", "isbn", "pmid", "arxiv", "url", "custom"]),
  value: NonEmptyStringSchema,
});

const AuthorSchema = z.strictObject({
  display_name: NonEmptyStringSchema,
  identifier: NonEmptyStringSchema.optional(),
});

export const SourceSchema = z
  .strictObject({
    schema_version: SchemaVersionSchema,
    source_id: idSchema("src"),
    source_kind: z.enum(["paper", "book", "web_page", "dataset", "code", "note", "report", "media"]),
    title: NonEmptyStringSchema,
    canonical_uri: z.url().optional(),
    authors: z.array(AuthorSchema),
    publisher: NonEmptyStringSchema.optional(),
    published_at: DateSchema.optional(),
    language: z.string().regex(/^[a-z]{2,3}(?:-[A-Z]{2})?$/),
    license: NonEmptyStringSchema.optional(),
    external_identifiers: z.array(ExternalIdentifierSchema),
    scope: AccessScopeSchema,
    created_at: TimestampSchema,
    created_by: ActorRefSchema,
  })
  .superRefine((source, context) => {
    addDuplicateIssue(
      source.external_identifiers.map(({ scheme, value }) => `${scheme}:${value}`),
      "external_identifiers",
      context,
    );
    if (!source.scope.source_ids.includes(source.source_id)) {
      context.addIssue({
        code: "custom",
        path: ["scope", "source_ids"],
        message: "A source scope must include its own source_id",
      });
    }
  });

export type SourceContract = z.output<typeof SourceSchema>;

export const SourceSnapshotSchema = z
  .strictObject({
    schema_version: SchemaVersionSchema,
    snapshot_id: idSchema("snp"),
    source_id: idSchema("src"),
    acquired_at: TimestampSchema,
    acquisition_method: z.enum(["upload", "http", "filesystem", "api", "legacy_import"]),
    content_hash: Sha256Schema,
    byte_size: z.number().int().nonnegative(),
    media_type: NonEmptyStringSchema,
    object_key: z.string().regex(OBJECT_KEY_PATTERN),
    status: z.enum(ARTIFACT_STATUSES),
    supersedes_snapshot_id: idSchema("snp").optional(),
    retraction_reason: NonEmptyStringSchema.optional(),
    scope: AccessScopeSchema,
    created_by: ActorRefSchema,
  })
  .superRefine((snapshot, context) => {
    if (snapshot.object_key !== objectKeyForContentHash(snapshot.content_hash)) {
      context.addIssue({
        code: "custom",
        path: ["object_key"],
        message: "object_key must be derived from content_hash",
      });
    }
    if (snapshot.snapshot_id === snapshot.supersedes_snapshot_id) {
      context.addIssue({ code: "custom", path: ["supersedes_snapshot_id"], message: "A snapshot cannot supersede itself" });
    }
    if (snapshot.status === "retracted" && !snapshot.retraction_reason) {
      context.addIssue({ code: "custom", path: ["retraction_reason"], message: "A retracted snapshot requires a reason" });
    }
    if (snapshot.status !== "retracted" && snapshot.retraction_reason) {
      context.addIssue({ code: "custom", path: ["retraction_reason"], message: "Only a retracted snapshot may carry a retraction reason" });
    }
    if (!snapshot.scope.source_ids.includes(snapshot.source_id)) {
      context.addIssue({
        code: "custom",
        path: ["scope", "source_ids"],
        message: "A snapshot scope must include its source_id",
      });
    }
  });

export type SourceSnapshotContract = z.output<typeof SourceSnapshotSchema>;

const NormalizedSpanSchema = z
  .strictObject({
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
  })
  .refine((span) => span.end > span.start, {
    path: ["end"],
    message: "end must be greater than start",
  });

const SectionNodeSchema = z.strictObject({
  section_id: NonEmptyStringSchema,
  parent_section_id: NonEmptyStringSchema.optional(),
  ordinal: z.number().int().nonnegative(),
  level: z.number().int().nonnegative(),
  title: NonEmptyStringSchema.optional(),
  normalized_span: NormalizedSpanSchema,
  text_hash: Sha256Schema,
});

const NormalizedMappingSchema = z
  .strictObject({
    section_id: NonEmptyStringSchema,
    normalized_start: z.number().int().nonnegative(),
    normalized_end: z.number().int().positive(),
    raw_locator: RawLocatorSchema,
  })
  .refine((mapping) => mapping.normalized_end > mapping.normalized_start, {
    path: ["normalized_end"],
    message: "normalized_end must be greater than normalized_start",
  });

export const NormalizedDocumentSchema = z
  .strictObject({
    schema_version: SchemaVersionSchema,
    normalized_document_id: idSchema("ndoc"),
    snapshot_id: idSchema("snp"),
    content_hash: Sha256Schema,
    byte_size: z.number().int().positive(),
    object_key: z.string().regex(OBJECT_KEY_PATTERN),
    normalizer: z.strictObject({
      name: NonEmptyStringSchema,
      version: NonEmptyStringSchema,
      config_hash: Sha256Schema,
    }),
    sections: z.array(SectionNodeSchema).min(1),
    mappings: z.array(NormalizedMappingSchema).min(1),
    warnings: z.array(
      z.strictObject({
        code: NonEmptyStringSchema,
        message: NonEmptyStringSchema,
        severity: z.enum(["warning", "blocking"]),
        locator: RawLocatorSchema.optional(),
      }),
    ),
    scope: AccessScopeSchema,
    created_at: TimestampSchema,
  })
  .superRefine((document, context) => {
    if (document.object_key !== objectKeyForContentHash(document.content_hash)) {
      context.addIssue({
        code: "custom",
        path: ["object_key"],
        message: "object_key must be derived from content_hash",
      });
    }
    addDuplicateIssue(
      document.sections.map((section) => section.section_id),
      "sections",
      context,
    );
    addDuplicateIssue(
      document.sections.map((section) => section.ordinal),
      "sections.ordinal",
      context,
    );
    const sectionById = new Map(document.sections.map((section) => [section.section_id, section]));
    const rootIndexes = document.sections
      .map((section, index) => section.parent_section_id ? -1 : index)
      .filter((index) => index >= 0);
    if (rootIndexes.length !== 1) {
      context.addIssue({
        code: "custom",
        path: ["sections"],
        message: "A normalized document must contain exactly one root section",
      });
    }
    for (const [index, section] of document.sections.entries()) {
      if (section.ordinal !== index) {
        context.addIssue({
          code: "custom",
          path: ["sections", index, "ordinal"],
          message: "Section ordinals must be contiguous and match canonical array order",
        });
      }
      if (!section.parent_section_id) {
        if (
          section.ordinal !== 0 ||
          section.level !== 0 ||
          section.normalized_span.start !== 0 ||
          section.normalized_span.end !== document.byte_size
        ) {
          context.addIssue({
            code: "custom",
            path: ["sections", index],
            message: "The root section must be ordinal 0, level 0, and cover the normalized document",
          });
        }
      }
      const parent = section.parent_section_id
        ? sectionById.get(section.parent_section_id)
        : undefined;
      if (section.parent_section_id && !parent) {
        context.addIssue({
          code: "custom",
          path: ["sections", index, "parent_section_id"],
          message: "parent_section_id must reference another section in the document",
        });
      }
      if (section.parent_section_id === section.section_id) {
        context.addIssue({
          code: "custom",
          path: ["sections", index, "parent_section_id"],
          message: "A section cannot be its own parent",
        });
      }
      if (parent && parent.ordinal >= section.ordinal) {
        context.addIssue({
          code: "custom",
          path: ["sections", index, "parent_section_id"],
          message: "A parent section must precede its child, preventing cycles",
        });
      }
      if (parent && parent.level >= section.level) {
        context.addIssue({
          code: "custom",
          path: ["sections", index, "level"],
          message: "A child section level must be deeper than its parent",
        });
      }
      if (section.normalized_span.end > document.byte_size) {
        context.addIssue({
          code: "custom",
          path: ["sections", index, "normalized_span", "end"],
          message: "Section span exceeds normalized byte_size",
        });
      }
    }
    for (const [index, mapping] of document.mappings.entries()) {
      const section = sectionById.get(mapping.section_id);
      if (!section) {
        context.addIssue({
          code: "custom",
          path: ["mappings", index, "section_id"],
          message: "Mapping section_id must reference a section in the document",
        });
        continue;
      }
      if (
        mapping.normalized_start < section.normalized_span.start ||
        mapping.normalized_end > section.normalized_span.end
      ) {
        context.addIssue({
          code: "custom",
          path: ["mappings", index],
          message: "Mapping span must be contained by its section",
        });
      }
      if (mapping.normalized_end > document.byte_size) {
        context.addIssue({
          code: "custom",
          path: ["mappings", index, "normalized_end"],
          message: "Mapping span exceeds normalized byte_size",
        });
      }
      const prior = document.mappings[index - 1];
      if (prior && mapping.normalized_start < prior.normalized_end) {
        context.addIssue({
          code: "custom",
          path: ["mappings", index, "normalized_start"],
          message: "Mappings must be ordered and non-overlapping",
        });
      }
    }
  });

export type NormalizedDocumentContract = z.output<typeof NormalizedDocumentSchema>;
export type NormalizedSection = z.output<typeof SectionNodeSchema>;
export type NormalizedMapping = z.output<typeof NormalizedMappingSchema>;
export type NormalizedSpan = z.output<typeof NormalizedSpanSchema>;
export type RawLocator = z.output<typeof RawLocatorSchema>;

export const EvidenceItemSchema = z
  .strictObject({
    schema_version: SchemaVersionSchema,
    evidence_id: idSchema("evd"),
    snapshot_id: idSchema("snp"),
    normalized_document_id: idSchema("ndoc"),
    section_id: NonEmptyStringSchema,
    evidence_type: z.enum(["quote", "table_cell", "figure", "code_block", "metadata"]),
    normalized_text: NonEmptyStringSchema,
    text_hash: Sha256Schema,
    normalized_span: NormalizedSpanSchema,
    raw_locator: RawLocatorSchema,
    status: z.enum(ARTIFACT_STATUSES),
    supersedes_evidence_id: idSchema("evd").optional(),
    retraction_reason: NonEmptyStringSchema.optional(),
    scope: AccessScopeSchema,
    created_at: TimestampSchema,
  })
  .superRefine((evidence, context) => {
    if (evidence.evidence_id === evidence.supersedes_evidence_id) {
      context.addIssue({ code: "custom", path: ["supersedes_evidence_id"], message: "Evidence cannot supersede itself" });
    }
    if (evidence.status === "retracted" && !evidence.retraction_reason) {
      context.addIssue({ code: "custom", path: ["retraction_reason"], message: "Retracted evidence requires a reason" });
    }
    if (evidence.status !== "retracted" && evidence.retraction_reason) {
      context.addIssue({ code: "custom", path: ["retraction_reason"], message: "Only retracted evidence may carry a retraction reason" });
    }
    if (evidence.text_hash !== sha256Bytes(evidence.normalized_text)) {
      context.addIssue({
        code: "custom",
        path: ["text_hash"],
        message: "text_hash must be the SHA-256 hash of normalized_text UTF-8 bytes",
        params: { coe_error_code: "hash_mismatch" },
      });
    }
  });

export type EvidenceItemContract = z.output<typeof EvidenceItemSchema>;

export const CLAIM_TYPES = [
  "bibliographic",
  "numeric",
  "methodological",
  "process",
  "descriptive",
  "conclusion",
  "recommendation",
  "inference",
  "contradiction",
  "software_artifact",
] as const;

export const CLAIM_ORIGINS = [
  "direct_source",
  "derived_inference",
  "derived_recommendation",
  "human_authored",
  "system_generated",
  "imported_legacy",
] as const;

const ClaimValueSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("text"), value: NonEmptyStringSchema }),
  z.strictObject({ kind: z.literal("integer"), value: z.string().regex(/^-?(?:0|[1-9][0-9]*)$/) }),
  z.strictObject({ kind: z.literal("decimal"), value: DecimalSchema }),
  z.strictObject({ kind: z.literal("boolean"), value: z.boolean() }),
  z.strictObject({ kind: z.literal("date"), value: DateSchema }),
  z.strictObject({ kind: z.literal("quantity"), value: DecimalSchema, unit: NonEmptyStringSchema }),
]);

export const ClaimSchema = z
  .strictObject({
    schema_version: SchemaVersionSchema,
    claim_id: idSchema("clm"),
    claim_type: z.enum(CLAIM_TYPES),
    origin: z.enum(CLAIM_ORIGINS),
    subject: NonEmptyStringSchema,
    predicate: NonEmptyStringSchema,
    value: ClaimValueSchema,
    statement: NonEmptyStringSchema,
    status: z.enum(CLAIM_STATUSES),
    supersedes_claim_id: idSchema("clm").optional(),
    retraction_reason: NonEmptyStringSchema.optional(),
    scope: AccessScopeSchema,
    created_at: TimestampSchema,
    updated_at: TimestampSchema,
    created_by: ActorRefSchema,
  })
  .superRefine((claim, context) => {
    if (claim.claim_id === claim.supersedes_claim_id) {
      context.addIssue({ code: "custom", path: ["supersedes_claim_id"], message: "A claim cannot supersede itself" });
    }
    if (claim.origin === "derived_recommendation" && claim.claim_type !== "recommendation") {
      context.addIssue({
        code: "custom",
        path: ["claim_type"],
        message: "derived_recommendation origin requires recommendation claim_type",
      });
    }
    if (claim.origin === "derived_inference" && claim.claim_type !== "inference") {
      context.addIssue({
        code: "custom",
        path: ["claim_type"],
        message: "derived_inference origin requires inference claim_type",
      });
    }
    if (claim.claim_type === "recommendation" && claim.origin === "direct_source") {
      context.addIssue({
        code: "custom",
        path: ["origin"],
        message: "Recommendations must remain explicitly derived or authored",
      });
    }
    if (claim.claim_type === "inference" && claim.origin === "direct_source") {
      context.addIssue({
        code: "custom",
        path: ["origin"],
        message: "Inferences must remain explicitly derived or authored",
      });
    }
    if (claim.origin === "imported_legacy" && !["draft", "quarantined", "needs_review"].includes(claim.status)) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Imported legacy claims cannot enter a trusted status before verification",
      });
    }
    if (claim.status === "retracted" && !claim.retraction_reason) {
      context.addIssue({ code: "custom", path: ["retraction_reason"], message: "A retracted claim requires a reason" });
    }
    if (claim.status !== "retracted" && claim.retraction_reason) {
      context.addIssue({ code: "custom", path: ["retraction_reason"], message: "Only a retracted claim may carry a retraction reason" });
    }
    if (Date.parse(claim.updated_at) < Date.parse(claim.created_at)) {
      context.addIssue({ code: "custom", path: ["updated_at"], message: "updated_at must not precede created_at" });
    }
  });

export const ClaimEvidenceEdgeSchema = z.strictObject({
  schema_version: SchemaVersionSchema,
  edge_id: idSchema("cedge"),
  claim_id: idSchema("clm"),
  evidence_id: idSchema("evd"),
  relation: z.enum(["supports", "refutes", "contextualizes", "mentions"]),
  support_level: z.enum(["direct", "partial", "indirect", "insufficient"]),
  evidence_span: NormalizedSpanSchema.optional(),
  verification_run_id: idSchema("vrf").optional(),
  scope: AccessScopeSchema,
  created_at: TimestampSchema,
  created_by: ActorRefSchema,
});

const VerificationFindingSchema = z.strictObject({
  code: NonEmptyStringSchema,
  severity: z.enum(["info", "warning", "error", "blocking"]),
  message: NonEmptyStringSchema,
  evidence_ids: z.array(idSchema("evd")),
});

const ModelInvocationSchema = z.strictObject({
  provider_id: NonEmptyStringSchema,
  model_id: NonEmptyStringSchema,
  prompt_template_id: NonEmptyStringSchema,
  prompt_hash: Sha256Schema,
  response_hash: Sha256Schema,
});

export const VerificationRunSchema = z
  .strictObject({
    schema_version: SchemaVersionSchema,
    verification_run_id: idSchema("vrf"),
    claim_id: idSchema("clm"),
    verifier_type: z.enum([
      "numeric_recompute",
      "bibliographic",
      "source_alignment",
      "table",
      "code",
      "consistency",
      "human_review",
      "llm_judge",
    ]),
    method: z.enum(["deterministic", "manual", "llm", "hybrid"]),
    policy_id: idSchema("pol"),
    policy_version: NonEmptyStringSchema,
    status: z.enum(["pass", "fail", "inconclusive", "error"]),
    input_hash: Sha256Schema,
    output_hash: Sha256Schema,
    command: NonEmptyStringSchema.optional(),
    model: ModelInvocationSchema.optional(),
    reviewer: ActorRefSchema.optional(),
    metrics: z.array(
      z.strictObject({
        name: NonEmptyStringSchema,
        value: DecimalSchema,
        unit: NonEmptyStringSchema.optional(),
      }),
    ),
    findings: z.array(VerificationFindingSchema),
    scope: AccessScopeSchema,
    started_at: TimestampSchema,
    finished_at: TimestampSchema,
  })
  .superRefine((run, context) => {
    if (["llm", "hybrid"].includes(run.method) && !run.model) {
      context.addIssue({ code: "custom", path: ["model"], message: "LLM and hybrid verification must record the model invocation" });
    }
    if (run.verifier_type === "llm_judge" && !run.model) {
      context.addIssue({ code: "custom", path: ["model"], message: "llm_judge requires a model invocation" });
    }
    if (run.verifier_type === "llm_judge" && !["llm", "hybrid"].includes(run.method)) {
      context.addIssue({ code: "custom", path: ["method"], message: "llm_judge requires an llm or hybrid method" });
    }
    if (run.model && !["llm", "hybrid"].includes(run.method)) {
      context.addIssue({ code: "custom", path: ["model"], message: "Only llm or hybrid methods may record a model invocation" });
    }
    if ((run.method === "manual" || run.verifier_type === "human_review") && !run.reviewer) {
      context.addIssue({ code: "custom", path: ["reviewer"], message: "Manual review must identify its reviewer" });
    }
    if (Date.parse(run.finished_at) < Date.parse(run.started_at)) {
      context.addIssue({ code: "custom", path: ["finished_at"], message: "finished_at must not precede started_at" });
    }
    if (
      run.status === "pass" &&
      run.findings.some((finding) => finding.severity === "error" || finding.severity === "blocking")
    ) {
      context.addIssue({ code: "custom", path: ["findings"], message: "A passing run cannot contain error or blocking findings" });
    }
  });

const RetrievalCandidateSchema = z.strictObject({
  evidence_id: idSchema("evd"),
  rank: z.number().int().positive(),
  lexical_score: NonNegativeDecimalSchema.optional(),
  semantic_score: NonNegativeDecimalSchema.optional(),
  rerank_score: NonNegativeDecimalSchema.optional(),
  selected: z.boolean(),
  exclusion_reason: NonEmptyStringSchema.optional(),
});

export const RetrievalRunSchema = z
  .strictObject({
    schema_version: SchemaVersionSchema,
    retrieval_run_id: idSchema("ret"),
    query_hash: Sha256Schema,
    policy_id: idSchema("pol"),
    policy_version: NonEmptyStringSchema,
    filters: z.strictObject({
      brain_ids: z.array(NonEmptyStringSchema),
      source_ids: z.array(idSchema("src")),
      claim_types: z.array(z.enum(CLAIM_TYPES)),
      snapshot_statuses: z.array(z.enum(ARTIFACT_STATUSES)),
      as_of: TimestampSchema.optional(),
    }),
    candidates: z.array(RetrievalCandidateSchema),
    selected_evidence_ids: z.array(idSchema("evd")),
    request_scope: AccessScopeSchema,
    started_at: TimestampSchema,
    finished_at: TimestampSchema,
  })
  .superRefine((run, context) => {
    addDuplicateIssue(run.filters.brain_ids, "filters.brain_ids", context);
    addDuplicateIssue(run.filters.source_ids, "filters.source_ids", context);
    addDuplicateIssue(run.filters.claim_types, "filters.claim_types", context);
    addDuplicateIssue(run.filters.snapshot_statuses, "filters.snapshot_statuses", context);
    addDuplicateIssue(run.candidates.map(({ evidence_id }) => evidence_id), "candidates", context);
    addDuplicateIssue(run.candidates.map(({ rank }) => String(rank)), "candidates.rank", context);
    addDuplicateIssue(run.selected_evidence_ids, "selected_evidence_ids", context);
    const selectedCandidates = new Set(
      run.candidates.filter((candidate) => candidate.selected).map((candidate) => candidate.evidence_id),
    );
    for (const [index, evidenceId] of run.selected_evidence_ids.entries()) {
      if (!selectedCandidates.has(evidenceId)) {
        context.addIssue({
          code: "custom",
          path: ["selected_evidence_ids", index],
          message: "Selected evidence must be present in candidates with selected=true",
        });
      }
    }
    for (const [index, candidate] of run.candidates.entries()) {
      if (candidate.selected !== run.selected_evidence_ids.includes(candidate.evidence_id)) {
        context.addIssue({
          code: "custom",
          path: ["candidates", index, "selected"],
          message: "Candidate selection and selected_evidence_ids must agree",
        });
      }
      if (!candidate.selected && !candidate.exclusion_reason) {
        context.addIssue({
          code: "custom",
          path: ["candidates", index, "exclusion_reason"],
          message: "Unselected candidates must record an exclusion reason",
        });
      }
      if (candidate.selected && candidate.exclusion_reason) {
        context.addIssue({
          code: "custom",
          path: ["candidates", index, "exclusion_reason"],
          message: "Selected candidates cannot carry an exclusion reason",
        });
      }
    }
    if (run.filters.brain_ids.some((brainId) => brainId !== run.request_scope.brain_id)) {
      context.addIssue({
        code: "custom",
        path: ["filters", "brain_ids"],
        message: "Retrieval brain filters must remain inside request_scope",
      });
    }
    if (run.filters.source_ids.some((sourceId) => !run.request_scope.source_ids.includes(sourceId))) {
      context.addIssue({
        code: "custom",
        path: ["filters", "source_ids"],
        message: "Retrieval source filters must remain inside request_scope",
      });
    }
    if (Date.parse(run.finished_at) < Date.parse(run.started_at)) {
      context.addIssue({ code: "custom", path: ["finished_at"], message: "finished_at must not precede started_at" });
    }
  });

const AnswerClaimSchema = z.strictObject({
  answer_claim_id: idSchema("acm"),
  claim_id: idSchema("clm").optional(),
  claim_text: NonEmptyStringSchema,
  support_status: z.enum(["supported", "unsupported", "contested", "abstained"]),
  evidence_ids: z.array(idSchema("evd")),
  citation_markers: z.array(
    z.strictObject({
      marker: NonEmptyStringSchema,
      evidence_id: idSchema("evd"),
    }),
  ),
});

export const AnswerSchema = z
  .strictObject({
    schema_version: SchemaVersionSchema,
    answer_id: idSchema("ans"),
    retrieval_run_id: idSchema("ret"),
    query_hash: Sha256Schema,
    text: NonEmptyStringSchema,
    answer_claims: z.array(AnswerClaimSchema),
    lifecycle_status: z.enum(["draft", "quarantined", "released", "retracted"]),
    release_decision: z.enum(["not_evaluated", "pass", "fail"]),
    policy_id: idSchema("pol"),
    policy_version: NonEmptyStringSchema,
    scope: AccessScopeSchema,
    created_at: TimestampSchema,
    released_at: TimestampSchema.optional(),
    retraction_reason: NonEmptyStringSchema.optional(),
  })
  .superRefine((answer, context) => {
    addDuplicateIssue(
      answer.answer_claims.map(({ answer_claim_id }) => answer_claim_id),
      "answer_claims",
      context,
    );
    for (const [index, claim] of answer.answer_claims.entries()) {
      addDuplicateIssue(claim.evidence_ids, `answer_claims.${index}.evidence_ids`, context);
      addDuplicateIssue(
        claim.citation_markers.map(({ marker }) => marker),
        `answer_claims.${index}.citation_markers.marker`,
        context,
      );
      const cited = new Set(claim.citation_markers.map(({ evidence_id }) => evidence_id));
      if (claim.evidence_ids.some((evidenceId) => !cited.has(evidenceId))) {
        context.addIssue({
          code: "custom",
          path: ["answer_claims", index, "citation_markers"],
          message: "Every supporting evidence item must have a citation marker",
        });
      }
      if (claim.citation_markers.some(({ evidence_id }) => !claim.evidence_ids.includes(evidence_id))) {
        context.addIssue({
          code: "custom",
          path: ["answer_claims", index, "citation_markers"],
          message: "Citation markers must reference declared supporting evidence",
        });
      }
    }
    if (answer.lifecycle_status === "released") {
      if (answer.answer_claims.length === 0) {
        context.addIssue({ code: "custom", path: ["answer_claims"], message: "A released answer requires at least one claim" });
      }
      if (answer.release_decision !== "pass" || !answer.released_at) {
        context.addIssue({
          code: "custom",
          path: ["release_decision"],
          message: "Released answers require a passing decision and released_at",
        });
      }
      for (const [index, claim] of answer.answer_claims.entries()) {
        if (claim.support_status !== "supported" || claim.evidence_ids.length === 0) {
          context.addIssue({
            code: "custom",
            path: ["answer_claims", index],
            message: "Released answer claims must be supported by at least one evidence item",
          });
        }
      }
    }
    if (answer.lifecycle_status === "retracted" && !answer.retraction_reason) {
      context.addIssue({ code: "custom", path: ["retraction_reason"], message: "A retracted answer requires a reason" });
    }
    if (answer.lifecycle_status !== "retracted" && answer.retraction_reason) {
      context.addIssue({ code: "custom", path: ["retraction_reason"], message: "Only a retracted answer may carry a retraction reason" });
    }
    if (answer.released_at && Date.parse(answer.released_at) < Date.parse(answer.created_at)) {
      context.addIssue({ code: "custom", path: ["released_at"], message: "released_at must not precede created_at" });
    }
  });

export const ContradictionSchema = z
  .strictObject({
    schema_version: SchemaVersionSchema,
    contradiction_id: idSchema("ctr"),
    left_claim_id: idSchema("clm"),
    right_claim_id: idSchema("clm"),
    status: z.enum(["open", "confirmed", "resolved", "dismissed"]),
    resolution: z.enum(["unresolved", "supersedes", "coexists", "source_error", "claim_error"]),
    verification_run_ids: z.array(idSchema("vrf")),
    resolution_note: NonEmptyStringSchema.optional(),
    scope: AccessScopeSchema,
    created_at: TimestampSchema,
    updated_at: TimestampSchema,
  })
  .superRefine((contradiction, context) => {
    if (contradiction.left_claim_id === contradiction.right_claim_id) {
      context.addIssue({ code: "custom", path: ["right_claim_id"], message: "A claim cannot contradict itself" });
    }
    if (contradiction.status === "resolved" && contradiction.resolution === "unresolved") {
      context.addIssue({ code: "custom", path: ["resolution"], message: "Resolved contradictions require a resolution" });
    }
    addDuplicateIssue(contradiction.verification_run_ids, "verification_run_ids", context);
    if (Date.parse(contradiction.updated_at) < Date.parse(contradiction.created_at)) {
      context.addIssue({ code: "custom", path: ["updated_at"], message: "updated_at must not precede created_at" });
    }
  });

export const LifecycleEventSchema = z
  .strictObject({
    schema_version: SchemaVersionSchema,
    event_id: idSchema("evt"),
    aggregate_type: z.enum(["claim", "snapshot", "evidence", "verification", "retrieval", "answer", "contradiction"]),
    aggregate_id: z.string().regex(COE_ID_PATTERN),
    event_type: z.enum(["created", "status_changed", "verification_recorded", "scope_changed", "invalidated", "released"]),
    from_status: NonEmptyStringSchema.optional(),
    to_status: NonEmptyStringSchema.optional(),
    reason_code: NonEmptyStringSchema,
    payload_hash: Sha256Schema,
    actor: ActorRefSchema,
    scope: AccessScopeSchema,
    occurred_at: TimestampSchema,
  })
  .superRefine((event, context) => {
    const expectedPrefix = {
      claim: "clm_",
      snapshot: "snp_",
      evidence: "evd_",
      verification: "vrf_",
      retrieval: "ret_",
      answer: "ans_",
      contradiction: "ctr_",
    }[event.aggregate_type];
    if (!event.aggregate_id.startsWith(expectedPrefix)) {
      context.addIssue({
        code: "custom",
        path: ["aggregate_id"],
        message: "aggregate_id prefix must match aggregate_type",
      });
    }
    if (event.event_type === "status_changed") {
      if (!event.from_status || !event.to_status) {
        context.addIssue({ code: "custom", path: ["to_status"], message: "Status changes require from_status and to_status" });
      } else if (!["claim", "snapshot", "evidence"].includes(event.aggregate_type)) {
        context.addIssue({
          code: "custom",
          path: ["aggregate_type"],
          message: "status_changed is only available for aggregates with a closed transition map",
        });
      } else if (!canTransition(event.aggregate_type as "claim" | "snapshot" | "evidence", event.from_status, event.to_status)) {
        context.addIssue({ code: "custom", path: ["to_status"], message: "The recorded lifecycle transition is not allowed" });
      }
    } else if (event.from_status || event.to_status) {
      context.addIssue({
        code: "custom",
        path: ["from_status"],
        message: "Only status_changed events may carry from_status or to_status",
      });
    }
  });

export type LifecycleEventContract = z.output<typeof LifecycleEventSchema>;

const ClaimPolicySchema = z.strictObject({
  claim_type: z.enum(CLAIM_TYPES),
  required_verifiers: z.array(
    z.enum(["numeric_recompute", "bibliographic", "source_alignment", "table", "code", "consistency", "human_review"]),
  ),
  minimum_direct_support: z.number().int().nonnegative(),
  human_review_required: z.boolean(),
});

export const PolicySchema = z
  .strictObject({
    schema_version: SchemaVersionSchema,
    policy_id: idSchema("pol"),
    policy_version: NonEmptyStringSchema,
    name: NonEmptyStringSchema,
    fail_closed: z.boolean(),
    unknown_fields: z.literal("reject"),
    release: z.strictObject({
      require_verified_claims: z.boolean(),
      block_on_contradiction: z.boolean(),
      block_on_retracted_evidence: z.boolean(),
      require_complete_citations: z.boolean(),
    }),
    llm_judge: z.strictObject({
      enabled: z.boolean(),
      can_release: z.literal(false),
    }),
    claim_policies: z.array(ClaimPolicySchema),
    retention: z.strictObject({
      preserve_tombstones: z.boolean(),
      preserve_verification_runs: z.boolean(),
    }),
    compatibility: z.strictObject({
      readable_versions: z.array(NonEmptyStringSchema),
      writable_version: z.literal(COE_SCHEMA_VERSION),
    }),
    created_at: TimestampSchema,
  })
  .superRefine((policy, context) => {
    addDuplicateIssue(
      policy.claim_policies.map(({ claim_type }) => claim_type),
      "claim_policies",
      context,
    );
    addDuplicateIssue(policy.compatibility.readable_versions, "compatibility.readable_versions", context);
    for (const [index, claimPolicy] of policy.claim_policies.entries()) {
      addDuplicateIssue(claimPolicy.required_verifiers, `claim_policies.${index}.required_verifiers`, context);
    }
    if (!policy.compatibility.readable_versions.includes(COE_SCHEMA_VERSION)) {
      context.addIssue({
        code: "custom",
        path: ["compatibility", "readable_versions"],
        message: "The current schema version must be readable",
      });
    }
  });

export const COE_SCHEMAS_V1 = {
  source: SourceSchema,
  source_snapshot: SourceSnapshotSchema,
  normalized_document: NormalizedDocumentSchema,
  evidence_item: EvidenceItemSchema,
  claim: ClaimSchema,
  claim_evidence_edge: ClaimEvidenceEdgeSchema,
  verification_run: VerificationRunSchema,
  retrieval_run: RetrievalRunSchema,
  answer: AnswerSchema,
  contradiction: ContradictionSchema,
  lifecycle_event: LifecycleEventSchema,
  policy: PolicySchema,
} as const satisfies Record<string, z.ZodType>;

export type CoeSchemaName = keyof typeof COE_SCHEMAS_V1;

export const COE_COMPATIBILITY_POLICY = {
  current_version: COE_SCHEMA_VERSION,
  readable_versions: [COE_SCHEMA_VERSION],
  writable_version: COE_SCHEMA_VERSION,
  prior_released_version: null,
  unknown_version_behavior: "reject",
  upgrade_policy: "An explicit, tested N-1 upgrader is required before releasing v2.",
} as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseCoeContract<TName extends CoeSchemaName>(
  schemaName: TName,
  value: unknown,
): z.output<(typeof COE_SCHEMAS_V1)[TName]> {
  if (isRecord(value) && typeof value.schema_version === "string" && value.schema_version !== COE_SCHEMA_VERSION) {
    throw new CoeContractError(
      "unsupported_schema_version",
      `Schema version ${value.schema_version} is not readable; expected ${COE_SCHEMA_VERSION}`,
    );
  }

  const result = COE_SCHEMAS_V1[schemaName].safeParse(value);
  if (result.success) return result.data as z.output<(typeof COE_SCHEMAS_V1)[TName]>;

  const unknownField = result.error.issues.some((issue) => issue.code === "unrecognized_keys");
  const specializedCode = result.error.issues
    .map((issue) => (issue.code === "custom" ? issue.params?.coe_error_code : undefined))
    .find((code): code is CoeErrorCode =>
      typeof code === "string" && (COE_ERROR_CODES as readonly string[]).includes(code),
    );
  throw new CoeContractError(
    unknownField ? "unknown_field" : specializedCode ?? "invalid_contract",
    `Invalid ${schemaName} contract`,
    result.error.issues.map((issue) => ({
      path: issue.path.length === 0 ? "$" : `$.${issue.path.join(".")}`,
      message: issue.message,
    })),
  );
}

export function parseJsonCoeContract<TName extends CoeSchemaName>(
  schemaName: TName,
  serialized: string,
): z.output<(typeof COE_SCHEMAS_V1)[TName]> {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new CoeContractError("invalid_json", `Invalid JSON for ${schemaName}`);
  }
  return parseCoeContract(schemaName, value);
}

export function upgradeCoeContract<TName extends CoeSchemaName>(
  schemaName: TName,
  value: unknown,
): z.output<(typeof COE_SCHEMAS_V1)[TName]> {
  // v1 is the inaugural release, so the only valid upgrader is the validated identity path.
  // A future version must branch explicitly by declared source version before parsing its target.
  return parseCoeContract(schemaName, value);
}

export function coeJsonSchema(schemaName: CoeSchemaName): Record<string, unknown> {
  const generated = z.toJSONSchema(COE_SCHEMAS_V1[schemaName], {
    target: "draft-2020-12",
    unrepresentable: "any",
    cycles: "ref",
    reused: "ref",
  }) as Record<string, unknown>;

  return {
    $schema: COE_JSON_SCHEMA_DIALECT,
    $id: `https://gbrain.example/schemas/coe/v1/${schemaName}.schema.json`,
    title: `CoE Lite v1 ${schemaName}`,
    ...generated,
  };
}
