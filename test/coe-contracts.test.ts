import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  COE_COMPATIBILITY_POLICY,
  COE_SCHEMA_VERSION,
  COE_SCHEMAS_V1,
  COE_TRANSITIONS,
  CanonicalizationError,
  CoeContractError,
  type CoeErrorCode,
  type CoeSchemaName,
  type TransitionDomain,
  assertScopeDoesNotWiden,
  assertTransition,
  canTransition,
  canonicalizeJson,
  coeJsonSchema,
  makeCoeId,
  parseCoeContract,
  parseJsonCoeContract,
  sha256Canonical,
  upgradeCoeContract,
} from "../src/coe/contracts/index.ts";

const repositoryRoot = resolve(import.meta.dir, "..");

interface ValidFixture {
  schema_name: CoeSchemaName;
  value: unknown;
}

interface Mutation {
  operation: "set";
  path: Array<string | number>;
  value: unknown;
}

interface InvalidFixture {
  case_id: string;
  schema_name: CoeSchemaName;
  expected_code: CoeErrorCode;
  mutations: Mutation[];
}

const validFixtures = JSON.parse(
  readFileSync(resolve(repositoryRoot, "fixtures/coe/valid/v1.json"), "utf8"),
) as ValidFixture[];
const invalidFixtures = JSON.parse(
  readFileSync(resolve(repositoryRoot, "fixtures/coe/invalid/v1-mutations.json"), "utf8"),
) as InvalidFixture[];

const validBySchema = new Map(validFixtures.map((fixture) => [fixture.schema_name, fixture.value]));

function applyMutation(target: unknown, mutation: Mutation): void {
  if (mutation.path.length === 0) throw new Error("Fixture mutations require a non-empty path");
  let cursor: unknown = target;
  for (const segment of mutation.path.slice(0, -1)) {
    if (typeof segment === "number") {
      if (!Array.isArray(cursor)) throw new Error(`Expected array at ${String(segment)}`);
      cursor = cursor[segment];
    } else {
      if (typeof cursor !== "object" || cursor === null || Array.isArray(cursor)) {
        throw new Error(`Expected object at ${segment}`);
      }
      cursor = (cursor as Record<string, unknown>)[segment];
    }
  }

  const finalSegment = mutation.path.at(-1)!;
  if (typeof finalSegment === "number") {
    if (!Array.isArray(cursor)) throw new Error(`Expected array at ${String(finalSegment)}`);
    cursor[finalSegment] = structuredClone(mutation.value);
  } else {
    if (typeof cursor !== "object" || cursor === null || Array.isArray(cursor)) {
      throw new Error(`Expected object at ${finalSegment}`);
    }
    (cursor as Record<string, unknown>)[finalSegment] = structuredClone(mutation.value);
  }
}

function expectContractError(action: () => unknown, expectedCode: CoeErrorCode): void {
  try {
    action();
    throw new Error(`Expected CoeContractError(${expectedCode})`);
  } catch (error) {
    expect(error).toBeInstanceOf(CoeContractError);
    expect((error as CoeContractError).code).toBe(expectedCode);
  }
}

function walkJson(value: unknown, visit: (record: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) {
    for (const item of value) walkJson(item, visit);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const record = value as Record<string, unknown>;
  visit(record);
  for (const child of Object.values(record)) walkJson(child, visit);
}

describe("CoE Lite v1 executable contracts", () => {
  for (const fixture of validFixtures) {
    test(`accepts the valid ${fixture.schema_name} fixture`, () => {
      expect(() => parseCoeContract(fixture.schema_name, fixture.value)).not.toThrow();
    });
  }

  for (const fixture of invalidFixtures) {
    test(`rejects invalid fixture ${fixture.case_id}`, () => {
      const base = validBySchema.get(fixture.schema_name);
      expect(base).toBeDefined();
      const mutated = structuredClone(base);
      for (const mutation of fixture.mutations) applyMutation(mutated, mutation);
      expectContractError(() => parseCoeContract(fixture.schema_name, mutated), fixture.expected_code);
    });
  }

  test("validates the checked-in fail-closed policy", () => {
    const policy = JSON.parse(readFileSync(resolve(repositoryRoot, "policies/coe/coe-lite-v1.json"), "utf8"));
    expect(() => parseCoeContract("policy", policy)).not.toThrow();
    expect(policy.fail_closed).toBe(true);
    expect(policy.llm_judge.can_release).toBe(false);
  });

  test("uses stable errors for malformed JSON and unsupported versions", () => {
    expectContractError(() => parseJsonCoeContract("claim", "{"), "invalid_json");
    const source = structuredClone(validBySchema.get("source")) as Record<string, unknown>;
    source.schema_version = "2.0.0";
    expectContractError(() => parseCoeContract("source", source), "unsupported_schema_version");
  });

  test("binds snapshot object_key to content_hash", () => {
    const snapshot = structuredClone(validBySchema.get("source_snapshot")) as Record<string, unknown>;
    snapshot.object_key = `objects/sha256/${"f".repeat(2)}/${"f".repeat(64)}`;
    expectContractError(() => parseCoeContract("source_snapshot", snapshot), "invalid_contract");
  });

  test("binds normalized document object_key to content_hash", () => {
    const document = structuredClone(validBySchema.get("normalized_document")) as Record<string, unknown>;
    document.object_key = `objects/sha256/${"f".repeat(2)}/${"f".repeat(64)}`;
    expectContractError(() => parseCoeContract("normalized_document", document), "invalid_contract");
  });

  test("rejects section forests and parent cycles in normalized documents", () => {
    const forest = structuredClone(validBySchema.get("normalized_document")) as Record<string, unknown>;
    const forestSections = forest.sections as Array<Record<string, unknown>>;
    forestSections.push({
      ...structuredClone(forestSections[0]),
      section_id: "section-2",
      ordinal: 1,
      level: 1,
    });
    expectContractError(() => parseCoeContract("normalized_document", forest), "invalid_contract");

    const cycle = structuredClone(validBySchema.get("normalized_document")) as Record<string, unknown>;
    const cycleSections = cycle.sections as Array<Record<string, unknown>>;
    cycleSections.push({
      ...structuredClone(cycleSections[0]),
      section_id: "section-2",
      parent_section_id: "section-3",
      ordinal: 1,
      level: 1,
    });
    cycleSections.push({
      ...structuredClone(cycleSections[0]),
      section_id: "section-3",
      parent_section_id: "section-2",
      ordinal: 2,
      level: 2,
    });
    expectContractError(() => parseCoeContract("normalized_document", cycle), "invalid_contract");
  });
});

describe("CoE Lite v1 canonicalization and identity", () => {
  test("normalizes key order, Unicode, and line endings reproducibly", () => {
    const left = { z: "line 1\r\nline 2", nested: { "cafe\u0301": -0, a: true } };
    const right = { nested: { a: true, "caf\u00e9": 0 }, z: "line 1\nline 2" };
    expect(canonicalizeJson(left)).toBe(canonicalizeJson(right));
    expect(sha256Canonical(left)).toBe(sha256Canonical(right));
    expect(canonicalizeJson([1, 2])).not.toBe(canonicalizeJson([2, 1]));
  });

  test("produces stable typed IDs and changes them when identity changes", () => {
    const first = makeCoeId("clm", { subject: "example", value: "42.0" });
    const repeated = makeCoeId("clm", { value: "42.0", subject: "example" });
    const changed = makeCoeId("clm", { subject: "example", value: "43.0" });
    expect(first).toBe(repeated);
    expect(first).toMatch(/^clm_[0-9a-f]{64}$/);
    expect(first).not.toBe(changed);
  });

  test("rejects non-JSON values and normalized-key collisions", () => {
    expect(() => canonicalizeJson({ value: Number.NaN })).toThrow(CanonicalizationError);
    expect(() => canonicalizeJson({ value: undefined })).toThrow(CanonicalizationError);
    expect(() => canonicalizeJson({ "caf\u00e9": 1, "cafe\u0301": 2 })).toThrow(CanonicalizationError);
  });
});

describe("CoE Lite v1 lifecycle and scope gates", () => {
  test("the transition helper exactly follows every closed adjacency map", () => {
    for (const domain of Object.keys(COE_TRANSITIONS) as TransitionDomain[]) {
      const transitions = COE_TRANSITIONS[domain] as Record<string, readonly string[]>;
      const statuses = Object.keys(transitions);
      for (const from of statuses) {
        for (const to of statuses) {
          expect(canTransition(domain, from, to)).toBe(transitions[from]!.includes(to));
        }
      }
    }
  });

  test("rejects unlisted, terminal, and self transitions", () => {
    expect(canTransition("claim", "verified", "retracted")).toBe(true);
    expect(canTransition("claim", "draft", "verified")).toBe(false);
    expect(canTransition("claim", "retracted", "draft")).toBe(false);
    expect(canTransition("evidence", "active", "active")).toBe(false);
    expectContractError(() => assertTransition("claim", "draft", "verified"), "invalid_transition");
  });

  test("allows scope narrowing and rejects scope widening", () => {
    const parent = {
      brain_id: "brain-example",
      visibility: "workspace" as const,
      owner_principal: "principal-owner",
      reader_principals: ["principal-reader", "principal-auditor"],
      source_ids: [
        "src_1111111111111111111111111111111111111111111111111111111111111111",
        "src_2222222222222222222222222222222222222222222222222222222222222222",
      ],
    };
    const child = {
      ...parent,
      visibility: "private" as const,
      reader_principals: ["principal-reader"],
      source_ids: ["src_1111111111111111111111111111111111111111111111111111111111111111"],
    };
    expect(() => assertScopeDoesNotWiden(parent, child)).not.toThrow();
    expectContractError(
      () => assertScopeDoesNotWiden(child, { ...child, visibility: "public" }),
      "scope_widening",
    );
  });
});

describe("CoE Lite v1 generated schemas and governance", () => {
  test("generated JSON Schema artifacts exactly match executable contracts", () => {
    const schemaDirectory = resolve(repositoryRoot, "schemas/coe/v1");
    for (const schemaName of Object.keys(COE_SCHEMAS_V1).sort() as CoeSchemaName[]) {
      const expected = `${JSON.stringify(coeJsonSchema(schemaName), null, 2)}\n`;
      const actual = readFileSync(resolve(schemaDirectory, `${schemaName}.schema.json`), "utf8");
      expect(actual).toBe(expected);
    }
  });

  test("manifest hashes cover every generated schema", () => {
    const schemaDirectory = resolve(repositoryRoot, "schemas/coe/v1");
    const manifest = JSON.parse(readFileSync(resolve(schemaDirectory, "manifest.json"), "utf8")) as {
      schema_version: string;
      artifacts: Array<{ name: string; file: string; sha256: string }>;
    };
    expect(manifest.schema_version).toBe(COE_SCHEMA_VERSION);
    expect(manifest.artifacts.map(({ name }) => name).sort()).toEqual(Object.keys(COE_SCHEMAS_V1).sort());
    for (const artifact of manifest.artifacts) {
      const serialized = readFileSync(resolve(schemaDirectory, artifact.file), "utf8");
      const digest = `sha256:${createHash("sha256").update(serialized, "utf8").digest("hex")}`;
      expect(artifact.sha256).toBe(digest);
    }
  });

  test("all modeled JSON objects reject unknown fields and expose no confidence property", () => {
    for (const schemaName of Object.keys(COE_SCHEMAS_V1) as CoeSchemaName[]) {
      walkJson(coeJsonSchema(schemaName), (record) => {
        if (record.type === "object" && record.properties) {
          expect(record.additionalProperties).toBe(false);
          expect(Object.prototype.hasOwnProperty.call(record.properties, "confidence")).toBe(false);
        }
      });
    }
  });

  test("freezes inaugural compatibility without inventing a prior version", () => {
    expect(COE_COMPATIBILITY_POLICY).toEqual({
      current_version: "1.0.0",
      readable_versions: ["1.0.0"],
      writable_version: "1.0.0",
      prior_released_version: null,
      unknown_version_behavior: "reject",
      upgrade_policy: "An explicit, tested N-1 upgrader is required before releasing v2.",
    });
    const currentSource = structuredClone(validBySchema.get("source"));
    expect(upgradeCoeContract("source", currentSource)).toEqual(parseCoeContract("source", currentSource));
    const nonexistentPredecessor = structuredClone(currentSource) as Record<string, unknown>;
    nonexistentPredecessor.schema_version = "0.9.0";
    expectContractError(
      () => upgradeCoeContract("source", nonexistentPredecessor),
      "unsupported_schema_version",
    );
  });

  test("contains exactly the ten accepted Phase 1 ADRs", () => {
    const adrDirectory = resolve(repositoryRoot, "docs/coe/adr");
    const expected = [
      "ADR-001-registre-canonique-et-projections.md",
      "ADR-002-identite-source-et-snapshot.md",
      "ADR-003-preuve-distincte-du-chunk.md",
      "ADR-004-cycle-de-vie-des-claims.md",
      "ADR-005-verification-typee.md",
      "ADR-006-usage-des-juges-llm.md",
      "ADR-007-projection-vers-gbrain.md",
      "ADR-008-contradictions-et-versionnement.md",
      "ADR-009-acl-et-propagation-des-scopes.md",
      "ADR-010-suppression-retraction-invalidation.md",
    ];
    expect(readdirSync(adrDirectory).sort()).toEqual(expected);
    for (const filename of expected) {
      expect(readFileSync(resolve(adrDirectory, filename), "utf8")).toContain("- Status: Accepted");
    }
  });
});
