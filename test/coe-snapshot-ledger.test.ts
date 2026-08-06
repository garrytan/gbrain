import { lstat, mkdir, mkdtemp, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { canonicalizeJson, makeCoeId, sha256Bytes, type SourceContract } from "../src/coe/contracts/index.ts";
import {
  CoeSnapshotLedger,
  InMemoryCoeSnapshotProjection,
  SqlCoeSnapshotProjection,
  type AcquireSnapshotInput,
} from "../src/coe/registry/index.ts";
import { CanonicalAcquisitionSchema } from "../src/coe/registry/types.ts";
import { ContentAddressedStore } from "../src/coe/registry/content-addressed-store.ts";
import { PGLiteEngine } from "../src/core/pglite-engine.ts";

const FIXED_TIME = "2026-08-04T12:00:00.000Z";

function exampleSource(uri = "https://example.invalid/report"): SourceContract {
  const sourceId = makeCoeId("src", { canonical_uri: uri, source_kind: "report" });
  return {
    schema_version: "1.0.0",
    source_id: sourceId,
    source_kind: "report",
    title: "Example source",
    canonical_uri: uri,
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
    created_by: { actor_type: "system", actor_id: "coe-test" },
  };
}

function acquireInput(content: string | Uint8Array, mediaType = "text/plain"): AcquireSnapshotInput {
  return {
    source: exampleSource(),
    content,
    requested_uri: "https://example.invalid/report",
    final_uri: "https://example.invalid/report",
    media_type: mediaType,
    acquisition_method: "http",
    acquired_at: FIXED_TIME,
  };
}

async function listFiles(root: string): Promise<string[]> {
  const output: string[] = [];
  async function walk(path: string, prefix: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(join(path, entry.name), relative);
      else output.push(relative);
    }
  }
  await walk(root, "");
  return output.sort();
}

describe("CoE immutable snapshot ledger", () => {
  let root: string;
  let projection: InMemoryCoeSnapshotProjection;
  let ledger: CoeSnapshotLedger;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "gbrain-coe-ledger-"));
    projection = new InMemoryCoeSnapshotProjection();
    ledger = new CoeSnapshotLedger({
      root,
      projection,
      clock: () => new Date(FIXED_TIME),
      nonce: () => crypto.randomUUID(),
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("same source, representation, and bytes reuse one logical snapshot", async () => {
    const first = await ledger.acquire(acquireInput("stable content"));
    const second = await ledger.acquire(acquireInput("stable content"));

    expect(first.outcome).toBe("promoted");
    expect(second.outcome).toBe("duplicate");
    expect(second.snapshot?.snapshot_id).toBe(first.snapshot?.snapshot_id);
    expect(projection.snapshots.size).toBe(1);
    expect(projection.acquisitions.size).toBe(2);
  });

  test("concurrent identical acquisitions serialize to one canonical snapshot", async () => {
    const results = await Promise.all([
      ledger.acquire(acquireInput("concurrent content")),
      ledger.acquire(acquireInput("concurrent content")),
    ]);
    expect(results.map(({ outcome }) => outcome).sort()).toEqual(["duplicate", "promoted"]);
    expect(new Set(results.map(({ snapshot }) => snapshot?.snapshot_id)).size).toBe(1);
    expect(projection.snapshots.size).toBe(1);
    expect(projection.acquisitions.size).toBe(2);
  });

  test("changed bytes create a new snapshot linked to the prior representation", async () => {
    const first = await ledger.acquire(acquireInput("version one"));
    const second = await ledger.acquire({
      ...acquireInput("version two"),
      acquired_at: "2026-08-04T12:01:00.000Z",
    });

    expect(second.outcome).toBe("promoted");
    expect(second.snapshot?.snapshot_id).not.toBe(first.snapshot?.snapshot_id);
    expect(second.snapshot?.supersedes_snapshot_id).toBe(first.snapshot?.snapshot_id);
    expect(await projection.getSnapshotStatus(first.snapshot!.snapshot_id)).toBe("superseded");
    expect(projection.snapshots.size).toBe(2);
  });

  test("HTML and PDF remain distinct representations", async () => {
    const html = await ledger.acquire(acquireInput("<!doctype html><html><body>Example</body></html>", "text/html"));
    const pdf = await ledger.acquire({
      ...acquireInput(new TextEncoder().encode("%PDF-1.7\nsynthetic fixture\n%%EOF"), "application/pdf"),
      acquired_at: "2026-08-04T12:01:00.000Z",
    });

    expect(html.snapshot?.snapshot_id).not.toBe(pdf.snapshot?.snapshot_id);
    expect(html.snapshot?.media_type).toBe("text/html");
    expect(pdf.snapshot?.media_type).toBe("application/pdf");
  });

  test("an expected hash mismatch is rejected before raw promotion", async () => {
    const result = await ledger.acquire({
      ...acquireInput("tampered"),
      expected_sha256: `sha256:${"0".repeat(64)}`,
    });

    expect(result.outcome).toBe("rejected");
    expect(result.error_code).toBe("hash_mismatch");
    expect(result.snapshot).toBeUndefined();
    expect(projection.snapshots.size).toBe(0);
    expect((await listFiles(join(root, "objects"))).length).toBe(0);
  });

  test("transport failures are journaled without inventing a raw object or hash", async () => {
    const result = await ledger.recordFailure({
      source: exampleSource(),
      requested_uri: "https://example.invalid/start",
      final_uri: "https://example.invalid/report",
      acquisition_method: "http",
      error_code: "http_status_503",
      redirects: [
        {
          from_uri: "https://example.invalid/start",
          to_uri: "https://example.invalid/report",
          status_code: 302,
        },
      ],
      started_at: "2026-08-04T11:59:59.000Z",
    });

    expect(result.outcome).toBe("failed");
    expect(result.error_code).toBe("http_status_503");
    expect(result.snapshot).toBeUndefined();
    const acquisition = projection.acquisitions.get(result.event_id);
    expect(acquisition?.actual_hash).toBeUndefined();
    expect(acquisition?.redirects).toHaveLength(1);
    expect(projection.snapshots.size).toBe(0);
    expect((await listFiles(join(root, "objects"))).length).toBe(0);
    expect(await listFiles(join(root, "journal", result.event_id))).toEqual([
      "000-started.json",
      "100-ready.json",
      "300-failed.json",
    ]);

    projection.clear();
    const rebuilt = await ledger.rebuildProjection();
    expect(rebuilt.acquisitions).toBe(1);
    expect(projection.acquisitions.get(result.event_id)?.outcome).toBe("failed");
  });

  test("empty or MIME-incoherent bytes are preserved but quarantined", async () => {
    const empty = await ledger.acquire(acquireInput(""));
    const mismatched = await ledger.acquire({
      ...acquireInput("not a pdf", "application/pdf"),
      acquired_at: "2026-08-04T12:01:00.000Z",
    });

    expect(empty.outcome).toBe("quarantined");
    expect(empty.quarantine_reasons).toContain("empty_content");
    expect(mismatched.outcome).toBe("quarantined");
    expect(mismatched.quarantine_reasons).toContain("mime_mismatch");
    expect(await ledger.readSnapshotBytes(empty.snapshot!.snapshot_id)).toEqual(Buffer.alloc(0));
  });

  test("crash after canonical writes promotes no partial projection and is recoverable", async () => {
    const crashing = new CoeSnapshotLedger({
      root,
      projection,
      clock: () => new Date(FIXED_TIME),
      nonce: () => "crash-fixture",
      hooks: {
        after_records_written: () => {
          throw new Error("synthetic crash");
        },
      },
    });

    await expect(crashing.acquire(acquireInput("recoverable content"))).rejects.toThrow("synthetic crash");
    expect(projection.snapshots.size).toBe(0);

    const recovered = await ledger.recoverPending();
    expect(recovered.recovered).toBe(1);
    expect(projection.snapshots.size).toBe(1);
    expect((await ledger.recoverPending()).recovered).toBe(0);
  });

  test("crash after raw promotion but before snapshot-record write is recoverable", async () => {
    const crashing = new CoeSnapshotLedger({
      root,
      projection,
      clock: () => new Date(FIXED_TIME),
      nonce: () => "object-crash-fixture",
      hooks: {
        after_object_stored: () => {
          throw new Error("synthetic object-stage crash");
        },
      },
    });
    await expect(crashing.acquire(acquireInput("object-stage recovery"))).rejects.toThrow("synthetic object-stage crash");
    expect(projection.snapshots.size).toBe(0);
    expect((await ledger.recoverPending()).recovered).toBe(1);
    expect(projection.snapshots.size).toBe(1);
  });

  test("recovery restores bundled supersession events before projection replay", async () => {
    const first = await ledger.acquire(acquireInput("recovery predecessor"));
    const crashing = new CoeSnapshotLedger({
      root,
      projection,
      clock: () => new Date("2026-08-04T12:01:00.000Z"),
      nonce: () => "supersession-crash-fixture",
      hooks: {
        after_object_stored: () => {
          throw new Error("synthetic supersession crash");
        },
      },
    });
    await expect(crashing.acquire({
      ...acquireInput("recovery successor"),
      acquired_at: "2026-08-04T12:01:00.000Z",
    })).rejects.toThrow("synthetic supersession crash");

    expect((await ledger.recoverPending()).recovered).toBe(1);
    expect(await projection.getSnapshotStatus(first.snapshot!.snapshot_id)).toBe("superseded");
    const eventFiles = await listFiles(join(root, "records", "events"));
    expect(eventFiles).toHaveLength(1);

    projection.clear();
    const rebuilt = await ledger.rebuildProjection();
    expect(rebuilt.lifecycle_events).toBe(1);
    expect(await projection.getSnapshotStatus(first.snapshot!.snapshot_id)).toBe("superseded");
  });

  test("raw bytes rebuild a cleared projection and remain available after logical retraction", async () => {
    const acquired = await ledger.acquire(acquireInput("restorable content"));
    const snapshotId = acquired.snapshot!.snapshot_id;
    const immutableBefore = canonicalizeJson(await ledger.getCanonicalSnapshot(snapshotId));
    projection.clear();

    const rebuilt = await ledger.rebuildProjection();
    expect(rebuilt.projected).toBe(1);
    expect(projection.snapshots.has(snapshotId)).toBe(true);

    const event = await ledger.retractSnapshot(
      snapshotId,
      "superseded by reviewed material",
      { actor_type: "human", actor_id: "reviewer-example" },
    );
    expect(event.to_status).toBe("retracted");
    expect(await projection.getSnapshotStatus(snapshotId)).toBe("retracted");
    expect((await ledger.readSnapshotBytes(snapshotId)).toString("utf8")).toBe("restorable content");
    expect(canonicalizeJson(await ledger.getCanonicalSnapshot(snapshotId))).toBe(immutableBefore);
  });

  test("concurrent retractions publish only one canonical lifecycle event", async () => {
    const acquired = await ledger.acquire(acquireInput("concurrent retraction fixture"));
    const snapshotId = acquired.snapshot!.snapshot_id;

    const outcomes = await Promise.allSettled([
      ledger.retractSnapshot(snapshotId, "first concurrent reason", {
        actor_type: "human",
        actor_id: "reviewer-one",
      }),
      ledger.retractSnapshot(snapshotId, "second concurrent reason", {
        actor_type: "human",
        actor_id: "reviewer-two",
      }),
    ]);

    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.filter(({ status }) => status === "rejected");
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: "invalid_transition" });
    expect(await listFiles(join(root, "records", "events"))).toHaveLength(1);
    expect(await projection.getSnapshotStatus(snapshotId)).toBe("retracted");

    projection.clear();
    await expect(ledger.rebuildProjection()).resolves.toMatchObject({ retractions: 1 });
    expect(await projection.getSnapshotStatus(snapshotId)).toBe("retracted");
  });

  test("acquisition and predecessor retraction share one causal lifecycle lock", async () => {
    const first = await ledger.acquire(acquireInput("race predecessor"));
    let enterHook!: () => void;
    let releaseHook!: () => void;
    const hookEntered = new Promise<void>((resolve) => { enterHook = resolve; });
    const hookRelease = new Promise<void>((resolve) => { releaseHook = resolve; });
    const racingLedger = new CoeSnapshotLedger({
      root,
      projection,
      clock: () => new Date(FIXED_TIME),
      nonce: () => crypto.randomUUID(),
      hooks: {
        after_records_written: async () => {
          enterHook();
          await hookRelease;
        },
      },
    });

    const successorPromise = racingLedger.acquire({
      ...acquireInput("race successor"),
      acquired_at: "2026-08-04T12:01:00.000Z",
    });
    await hookEntered;
    const retractionPromise = ledger.retractSnapshot(
      first.snapshot!.snapshot_id,
      "concurrent predecessor retraction",
      { actor_type: "human", actor_id: "race-reviewer" },
    );
    await Bun.sleep(10);
    releaseHook();

    const [successor, retraction] = await Promise.all([successorPromise, retractionPromise]);
    expect(successor.outcome).toBe("promoted");
    expect(retraction.from_status).toBe("superseded");
    expect(await listFiles(join(root, "records", "events"))).toHaveLength(2);
    projection.clear();
    await expect(ledger.rebuildProjection()).resolves.toMatchObject({ lifecycle_events: 2, retractions: 1 });
    expect(await projection.getSnapshotStatus(first.snapshot!.snapshot_id)).toBe("retracted");
  });

  test("projection rebuild replays supersession and retraction lifecycle events", async () => {
    const first = await ledger.acquire(acquireInput("lifecycle version one"));
    const second = await ledger.acquire({
      ...acquireInput("lifecycle version two"),
      acquired_at: "2026-08-04T12:01:00.000Z",
    });
    await ledger.retractSnapshot(
      second.snapshot!.snapshot_id,
      "lifecycle rebuild fixture",
      { actor_type: "human", actor_id: "reviewer-example" },
    );
    projection.clear();

    const rebuilt = await ledger.rebuildProjection();

    expect(rebuilt).toEqual({ acquisitions: 2, projected: 2, lifecycle_events: 2, retractions: 1 });
    expect(await projection.getSnapshotStatus(first.snapshot!.snapshot_id)).toBe("superseded");
    expect(await projection.getSnapshotStatus(second.snapshot!.snapshot_id)).toBe("retracted");
  });

  test("redirect hops and acquisition outcomes are append-only", async () => {
    const result = await ledger.acquire({
      ...acquireInput("redirected"),
      requested_uri: "https://example.invalid/start",
      final_uri: "https://example.invalid/report",
      redirects: [
        {
          from_uri: "https://example.invalid/start",
          to_uri: "https://example.invalid/report",
          status_code: 302,
        },
      ],
    });
    const acquisition = projection.acquisitions.get(result.event_id);
    expect(acquisition?.redirects).toHaveLength(1);
    expect(acquisition?.redirects[0]?.status_code).toBe(302);
    expect(acquisition?.outcome).toBe("promoted");
  });

  test("retention cleanup removes stale staging only, never canonical objects", async () => {
    const acquired = await ledger.acquire(acquireInput("retained"));
    const staging = join(root, "staging", "orphan.part");
    await mkdir(join(root, "staging"), { recursive: true });
    await writeFile(staging, "partial");
    const old = new Date("2026-08-01T00:00:00Z");
    await utimes(staging, old, old);

    const cleanup = await ledger.cleanupStaging(new Date("2026-08-04T12:00:00Z"));
    expect(cleanup.removed).toBe(1);
    expect((await ledger.readSnapshotBytes(acquired.snapshot!.snapshot_id)).toString("utf8")).toBe("retained");
  });

  test("an old lock is never stolen automatically", async () => {
    const StoreWithTestTimeout = ContentAddressedStore as unknown as new (
      root: string,
      nonce: () => string,
      options: { lock_timeout_ms: number },
    ) => ContentAddressedStore;
    const store = new StoreWithTestTimeout(root, () => crypto.randomUUID(), { lock_timeout_ms: 20 });
    await store.listKeys("locks");
    const lockName = "a".repeat(64);
    const lockPath = join(root, "locks", `${lockName}.lock`);
    await writeFile(lockPath, "existing-owner", { mode: 0o600 });
    const old = new Date("2020-01-01T00:00:00Z");
    await utimes(lockPath, old, old);

    await expect(store.withLock(lockName, async () => "stolen")).rejects.toMatchObject({
      code: "policy_violation",
    });
    expect(await Bun.file(lockPath).text()).toBe("existing-owner");
  });

  test("constructing an unused store has no asynchronous filesystem side effect", async () => {
    const lazyRoot = join(root, "lazy-registry");
    new ContentAddressedStore(lazyRoot, () => crypto.randomUUID());
    await Bun.sleep(10);
    expect(await lstat(lazyRoot).then(() => true).catch(() => false)).toBe(false);
  });

  test("rejects a registry root that is itself a symlink", async () => {
    await ledger.recoverPending();
    const target = join(root, "registry-target");
    const linkedRoot = join(root, "registry-link");
    await mkdir(target, { mode: 0o700 });
    await symlink(target, linkedRoot, "dir");
    const linkedStore = new ContentAddressedStore(linkedRoot, () => crypto.randomUUID());

    await expect(linkedStore.listKeys("records")).rejects.toMatchObject({ code: "policy_violation" });
  });

  test("readJson rejects a final-component symlink even when its target is inside the root", async () => {
    const store = new ContentAddressedStore(root, () => crypto.randomUUID());
    await store.listKeys("records/sources");
    const outsideRecord = join(root, "outside-record.json");
    await writeFile(outsideRecord, canonicalizeJson({ trusted: false }), { mode: 0o600 });
    const key = `records/sources/src_${"b".repeat(64)}.json`;
    await symlink(outsideRecord, join(root, key));

    await expect(store.readJson(key)).rejects.toMatchObject({ code: "policy_violation" });
  });

  test("writeJsonOnce rejects a final-component symlink without altering its target", async () => {
    const store = new ContentAddressedStore(root, () => crypto.randomUUID());
    await store.listKeys("records/sources");
    const outsideRecord = join(root, "outside-collision.json");
    const original = `${canonicalizeJson({ trusted: false })}\n`;
    await writeFile(outsideRecord, original, { mode: 0o600 });
    const key = `records/sources/src_${"c".repeat(64)}.json`;
    await symlink(outsideRecord, join(root, key));

    await expect(store.writeJsonOnce(key, { trusted: false })).rejects.toMatchObject({ code: "policy_violation" });
    expect(await Bun.file(outsideRecord).text()).toBe(original);
  });

  test("rejects a managed parent replaced by a symlink", async () => {
    const store = new ContentAddressedStore(root, () => crypto.randomUUID());
    await store.listKeys("records/sources");
    const replacement = join(root, "replacement-sources");
    await mkdir(replacement, { mode: 0o700 });
    await rm(join(root, "records", "sources"), { recursive: true });
    await symlink(replacement, join(root, "records", "sources"), "dir");

    await expect(store.writeJsonOnce(`records/sources/src_${"d".repeat(64)}.json`, { value: 1 }))
      .rejects.toMatchObject({ code: "policy_violation" });
  });

  test("rejects a symlinked object parent without creating directories in its target", async () => {
    const store = new ContentAddressedStore(root, () => crypto.randomUUID());
    await store.listKeys("objects");
    const replacement = join(root, "replacement-objects");
    await mkdir(replacement, { mode: 0o700 });
    await rm(join(root, "objects"), { recursive: true });
    await symlink(replacement, join(root, "objects"), "dir");

    await expect(store.storeObject(Buffer.from("must-not-escape", "utf8")))
      .rejects.toMatchObject({ code: "policy_violation" });
    expect(await readdir(replacement)).toEqual([]);
  });

  test("detects raw-object corruption on every verified read", async () => {
    const acquired = await ledger.acquire(acquireInput("verified bytes"));
    const snapshot = await ledger.getCanonicalSnapshot(acquired.snapshot!.snapshot_id);
    await writeFile(join(root, snapshot.object_key), "corrupt bytes");
    await expect(ledger.readSnapshotBytes(snapshot.snapshot_id)).rejects.toMatchObject({ code: "hash_mismatch" });
  });

  test("computes the exact content hash recorded by the snapshot", async () => {
    const acquired = await ledger.acquire(acquireInput("hash fixture"));
    expect(acquired.snapshot?.content_hash).toBe(sha256Bytes("hash fixture"));
  });

  test("rejects a canonical acquisition whose source does not own its snapshot", async () => {
    const acquired = await ledger.acquire(acquireInput("source binding fixture"));
    const canonical = projection.acquisitions.get(acquired.event_id)!;
    const mismatched = {
      ...structuredClone(canonical),
      source: exampleSource("https://example.invalid/other-report"),
    };

    expect(CanonicalAcquisitionSchema.safeParse(mismatched).success).toBe(false);
    const isolated = new InMemoryCoeSnapshotProjection();
    await expect(isolated.projectAcquisition(mismatched)).rejects.toMatchObject({ code: "invalid_contract" });
  });

  test("rejects a canonical snapshot scope wider than its source", async () => {
    const acquired = await ledger.acquire(acquireInput("source scope fixture"));
    const widened = structuredClone(projection.acquisitions.get(acquired.event_id)!);
    widened.snapshot!.scope.reader_principals = ["principal-outsider"];

    expect(CanonicalAcquisitionSchema.safeParse(widened).success).toBe(true);
    const isolated = new InMemoryCoeSnapshotProjection();
    await expect(isolated.projectAcquisition(widened)).rejects.toMatchObject({ code: "scope_widening" });
  });

  test("memory projection rejects lifecycle events whose from_status is stale", async () => {
    const acquired = await ledger.acquire(acquireInput("lifecycle parity fixture"));
    const canonical = projection.acquisitions.get(acquired.event_id)!;
    const isolated = new InMemoryCoeSnapshotProjection();
    await isolated.projectAcquisition(canonical);
    const retraction = await ledger.retractSnapshot(
      acquired.snapshot!.snapshot_id,
      "parity fixture",
      { actor_type: "human", actor_id: "reviewer-example" },
    );

    await expect(isolated.applyLifecycleEvent({
      ...retraction,
      from_status: "quarantined",
    })).rejects.toMatchObject({ code: "invalid_transition" });
  });
});

describe("CoE snapshot SQL projection on PGLite", () => {
  let root: string;
  let engine: PGLiteEngine;
  let projection: SqlCoeSnapshotProjection;
  let ledger: CoeSnapshotLedger;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "gbrain-coe-pglite-"));
    engine = new PGLiteEngine();
    await engine.connect({ engine: "pglite" });
    await engine.initSchema();
    projection = new SqlCoeSnapshotProjection(engine);
    ledger = new CoeSnapshotLedger({
      root,
      projection,
      clock: () => new Date(FIXED_TIME),
      nonce: () => crypto.randomUUID(),
    });
  });

  afterAll(async () => {
    await engine.disconnect();
    await rm(root, { recursive: true, force: true });
  });

  test("projects, deduplicates, and retracts through the shared BrainEngine contract", async () => {
    const first = await ledger.acquire(acquireInput("pglite fixture"));
    const second = await ledger.acquire(acquireInput("pglite fixture"));
    const failed = await ledger.recordFailure({
      source: exampleSource(),
      requested_uri: "https://example.invalid/unavailable",
      acquisition_method: "http",
      error_code: "timeout",
    });
    expect(first.outcome).toBe("promoted");
    expect(second.outcome).toBe("duplicate");
    expect(failed.outcome).toBe("failed");

    const snapshotCount = await engine.executeRaw<{ count: number }>("SELECT COUNT(*)::int AS count FROM coe_snapshots");
    const acquisitionCount = await engine.executeRaw<{ count: number }>("SELECT COUNT(*)::int AS count FROM coe_acquisitions");
    expect(Number(snapshotCount[0]?.count)).toBe(1);
    expect(Number(acquisitionCount[0]?.count)).toBe(3);
    const failedRows = await engine.executeRaw<{ actual_hash: string | null; error_code: string }>(
      "SELECT actual_hash, error_code FROM coe_acquisitions WHERE event_id = $1",
      [failed.event_id],
    );
    expect(failedRows).toEqual([{ actual_hash: null, error_code: "timeout" }]);

    const retraction = await ledger.retractSnapshot(
      first.snapshot!.snapshot_id,
      "test retraction",
      { actor_type: "human", actor_id: "reviewer-example" },
    );
    expect(await projection.getSnapshotStatus(first.snapshot!.snapshot_id)).toBe("retracted");
    const eventCount = await engine.executeRaw<{ count: number }>("SELECT COUNT(*)::int AS count FROM coe_snapshot_events");
    expect(Number(eventCount[0]?.count)).toBe(1);
    await expect(projection.applyLifecycleEvent({
      ...retraction,
      actor: { actor_type: "human", actor_id: "different-reviewer" },
    })).rejects.toMatchObject({ code: "id_mismatch" });
  });
});
