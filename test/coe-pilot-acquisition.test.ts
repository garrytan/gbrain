import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { makeCoeId, type SourceContract } from "../src/coe/contracts/index.ts";
import {
  BoundedHttpClient,
  CoeSnapshotLedger,
  InMemoryCoeSnapshotProjection,
  parsePilotManifest,
  runPilotManifest,
  type HttpClientDependencies,
  type PilotManifest,
} from "../src/coe/registry/index.ts";

const FIXED_TIME = "2026-08-04T12:00:00.000Z";

function source(canonicalUri: string, sourceKind: SourceContract["source_kind"]): SourceContract {
  const sourceId = makeCoeId("src", { canonical_uri: canonicalUri, source_kind: sourceKind });
  return {
    schema_version: "1.0.0",
    source_id: sourceId,
    source_kind: sourceKind,
    title: `Pilot ${sourceKind}`,
    canonical_uri: canonicalUri,
    authors: [],
    language: "en",
    external_identifiers: [],
    scope: {
      brain_id: "science-one-coe",
      visibility: "private",
      owner_principal: "principal-owner",
      reader_principals: [],
      source_ids: [sourceId],
    },
    created_at: FIXED_TIME,
    created_by: { actor_type: "system", actor_id: "coe-pilot-test" },
  };
}

function manifest(): PilotManifest {
  return parsePilotManifest({
    schema_version: "1.0.0",
    corpus_id: "science-one-coe-test",
    http_policy: {
      allowed_hosts: ["example.com"],
      max_bytes: 1024,
      timeout_ms: 1000,
      max_redirects: 1,
    },
    entries: [
      {
        entry_id: "official-page",
        transport: "http",
        required: true,
        evidence_class: "official_primary",
        source: source("https://example.com/page", "web_page"),
        uri: "https://example.com/page",
        expected_media_types: ["text/html"],
      },
      {
        entry_id: "temporarily-unavailable",
        transport: "http",
        required: true,
        evidence_class: "official_primary",
        source: source("https://example.com/unavailable", "web_page"),
        uri: "https://example.com/unavailable",
        expected_media_types: ["text/html"],
      },
      {
        entry_id: "derived-note",
        transport: "filesystem",
        required: true,
        evidence_class: "derived_internal",
        source: source("file:///coe-pilot/derived-note.md", "note"),
        local_path: "derived-note.md",
        stored_uri: "file:///coe-pilot/derived-note.md",
        media_type: "text/markdown",
        max_bytes: 1024,
      },
    ],
  });
}

describe("CoE pilot manifest acquisition", () => {
  let root: string;
  let projection: InMemoryCoeSnapshotProjection;
  let ledger: CoeSnapshotLedger;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "gbrain-coe-pilot-"));
    projection = new InMemoryCoeSnapshotProjection();
    ledger = new CoeSnapshotLedger({
      root: join(root, "registry"),
      projection,
      clock: () => new Date(FIXED_TIME),
      nonce: () => crypto.randomUUID(),
    });
    await writeFile(join(root, "derived-note.md"), "Derived only; not primary evidence.\n");
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("continues after a required HTTP failure and journals every attempt", async () => {
    const fetchImpl: HttpClientDependencies["fetch"] = async (input) => {
      if (String(input) === "https://example.com/unavailable") {
        return new Response("maintenance", {
          status: 503,
          headers: { "content-type": "text/plain" },
        });
      }
      return new Response("<!doctype html><html><body>official</body></html>", {
        headers: { "content-type": "text/html" },
      });
    };
    const bounded = new BoundedHttpClient(manifest().http_policy, {
      fetch: fetchImpl,
      resolve: async () => ["93.184.216.34"],
      clock: () => new Date(FIXED_TIME),
    });

    const report = await runPilotManifest({
      manifest: manifest(),
      manifest_directory: root,
      ledger,
      http_client: bounded,
      clock: () => new Date(FIXED_TIME),
    });

    expect(report.complete).toBe(false);
    expect(report.required_failures).toBe(1);
    expect(report.entries.map(({ outcome }) => outcome)).toEqual(["promoted", "failed", "promoted"]);
    expect(report.entries[1]?.error_code).toBe("http_status_503");
    expect(projection.acquisitions.size).toBe(3);
    expect(projection.snapshots.size).toBe(2);
  });

  test("does not mark a MIME-incoherent required snapshot complete", async () => {
    const oneEntry = manifest();
    oneEntry.entries = [oneEntry.entries[0]!];
    const bounded = new BoundedHttpClient(oneEntry.http_policy, {
      fetch: async () => new Response("plain response mislabeled by expectation", {
        headers: { "content-type": "text/plain" },
      }),
      resolve: async () => ["93.184.216.34"],
      clock: () => new Date(FIXED_TIME),
    });

    const report = await runPilotManifest({
      manifest: oneEntry,
      manifest_directory: root,
      ledger,
      http_client: bounded,
      clock: () => new Date(FIXED_TIME),
    });

    expect(report.complete).toBe(false);
    expect(report.required_failures).toBe(1);
    expect(report.entries[0]).toMatchObject({
      outcome: "quarantined",
      snapshot_status: "quarantined",
      quarantine_reasons: ["unexpected_media_type"],
    });
  });

  test("rejects duplicate entries and filesystem traversal before acquisition", () => {
    const value = structuredClone(manifest()) as unknown as Record<string, unknown>;
    const entries = value.entries as Array<Record<string, unknown>>;
    entries[2]!.entry_id = entries[0]!.entry_id;
    entries[2]!.local_path = "../escape.md";
    expect(() => parsePilotManifest(value)).toThrow();
  });
});
