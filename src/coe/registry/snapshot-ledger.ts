import { randomUUID } from "node:crypto";

import {
  CoeContractError,
  type ActorRef,
  type LifecycleEventContract,
  type SourceContract,
  type SourceSnapshotContract,
  makeCoeId,
  parseCoeContract,
  sha256Bytes,
  sha256Canonical,
} from "../contracts/index.ts";
import { ContentAddressedStore } from "./content-addressed-store.ts";
import {
  CanonicalAcquisitionSchema,
  RedirectHopSchema,
  type AcquireSnapshotInput,
  type AcquireSnapshotResult,
  type CanonicalAcquisition,
  type RecordAcquisitionFailureInput,
  type RedirectHop,
  type SnapshotLedgerOptions,
  type SnapshotRetentionPolicy,
} from "./types.ts";

const DEFAULT_RETENTION: SnapshotRetentionPolicy = {
  staging_max_age_ms: 24 * 60 * 60 * 1000,
  preserve_retracted_objects: true,
  preserve_acquisition_journal: true,
};

const SENSITIVE_QUERY_PARAMETER = /(?:token|key|secret|signature|credential|password|auth)/i;

function normalizeMediaType(value: string): string {
  const mediaType = value.split(";", 1)[0]!.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(mediaType)) {
    throw new CoeContractError("invalid_contract", `Invalid media type: ${value}`);
  }
  return mediaType;
}

function normalizeHash(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = value.toLowerCase();
  if (!/^sha256:[0-9a-f]{64}$/.test(normalized)) {
    throw new CoeContractError("invalid_contract", "expected_sha256 must use sha256:<64 lowercase hex>");
  }
  return normalized;
}

function normalizeStoredUri(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new CoeContractError("invalid_contract", `Invalid acquisition URI: ${value}`);
  }
  if (!["https:", "http:", "file:"].includes(parsed.protocol)) {
    throw new CoeContractError("invalid_contract", `Unsupported acquisition URI scheme: ${parsed.protocol}`);
  }
  if (parsed.username || parsed.password) {
    throw new CoeContractError("policy_violation", "Acquisition URIs must not contain credentials");
  }
  for (const key of parsed.searchParams.keys()) {
    if (SENSITIVE_QUERY_PARAMETER.test(key)) {
      throw new CoeContractError("policy_violation", `Sensitive query parameter is forbidden in acquisition URI: ${key}`);
    }
  }
  parsed.hash = "";
  return parsed.toString();
}

function normalizeRedirects(
  requestedUri: string,
  finalUri: string,
  redirects: readonly RedirectHop[],
): RedirectHop[] {
  const normalized = redirects.map((redirect) =>
    RedirectHopSchema.parse({
      from_uri: normalizeStoredUri(redirect.from_uri),
      to_uri: normalizeStoredUri(redirect.to_uri),
      status_code: redirect.status_code,
    }),
  );
  let cursor = requestedUri;
  for (const redirect of normalized) {
    if (redirect.from_uri !== cursor) {
      throw new CoeContractError("invalid_contract", "Redirect chain is not contiguous");
    }
    cursor = redirect.to_uri;
  }
  if (cursor !== finalUri) {
    throw new CoeContractError("invalid_contract", "Redirect chain does not terminate at final_uri");
  }
  return normalized;
}

function quarantineReasons(content: Buffer, mediaType: string, expectedMediaTypes: readonly string[]): string[] {
  const reasons: string[] = [];
  if (content.byteLength === 0) reasons.push("empty_content");
  if (expectedMediaTypes.length > 0 && !expectedMediaTypes.includes(mediaType)) reasons.push("unexpected_media_type");
  const prefix = content.subarray(0, 4096);
  const ascii = prefix.toString("utf8").trimStart().toLowerCase();
  const looksPdf = prefix.subarray(0, 5).toString("ascii") === "%PDF-";
  const looksHtml = /^(?:<!doctype\s+html|<html|<head|<body)(?:\s|>)/i.test(ascii);

  if (mediaType === "application/pdf" && !looksPdf) reasons.push("mime_mismatch");
  if ((mediaType === "text/html" || mediaType === "application/xhtml+xml") && !looksHtml) {
    reasons.push("mime_mismatch");
  }
  if (mediaType.startsWith("text/") && content.includes(0)) reasons.push("mime_mismatch");
  if (mediaType === "application/json" && content.byteLength > 0) {
    try {
      JSON.parse(content.toString("utf8"));
    } catch {
      reasons.push("mime_mismatch");
    }
  }
  return [...new Set(reasons)];
}

function sourceKey(sourceId: string): string {
  return `records/sources/${sourceId}.json`;
}

function snapshotKey(snapshotId: string): string {
  return `records/snapshots/${snapshotId}.json`;
}

function eventKey(eventId: string): string {
  return `records/events/${eventId}.json`;
}

function representationLockName(sourceId: string, mediaType: string): string {
  return sha256Canonical({ source_id: sourceId, media_type: mediaType });
}

export class CoeSnapshotLedger {
  private readonly store: ContentAddressedStore;
  private readonly clock: () => Date;
  private readonly nonce: () => string;
  private readonly retention: SnapshotRetentionPolicy;

  constructor(private readonly options: SnapshotLedgerOptions) {
    this.clock = options.clock ?? (() => new Date());
    this.nonce = options.nonce ?? randomUUID;
    this.store = new ContentAddressedStore(options.root, this.nonce);
    this.retention = {
      ...DEFAULT_RETENTION,
      ...options.retention,
      preserve_retracted_objects: true,
      preserve_acquisition_journal: true,
    };
    if (!Number.isFinite(this.retention.staging_max_age_ms) || this.retention.staging_max_age_ms < 0) {
      throw new CoeContractError("invalid_contract", "staging_max_age_ms must be a non-negative finite number");
    }
  }

  private async appendJournal(eventId: string, name: string, value: unknown): Promise<void> {
    await this.store.writeJsonOnce(`journal/${eventId}/${name}.json`, value);
  }

  private async getCanonicalSource(sourceId: string): Promise<SourceContract> {
    return parseCoeContract("source", await this.store.readJson(sourceKey(sourceId))) as SourceContract;
  }

  async getCanonicalSnapshot(snapshotId: string): Promise<SourceSnapshotContract> {
    return parseCoeContract("source_snapshot", await this.store.readJson(snapshotKey(snapshotId))) as SourceSnapshotContract;
  }

  private async findLatestSnapshot(sourceId: string, mediaType: string): Promise<SourceSnapshotContract | undefined> {
    const snapshots: SourceSnapshotContract[] = [];
    for (const key of await this.store.listKeys("records/snapshots")) {
      const snapshot = parseCoeContract("source_snapshot", await this.store.readJson(key)) as SourceSnapshotContract;
      if (snapshot.source_id === sourceId && snapshot.media_type === mediaType) snapshots.push(snapshot);
    }
    snapshots.sort((left, right) => {
      const timeDifference = Date.parse(right.acquired_at) - Date.parse(left.acquired_at);
      return timeDifference || right.snapshot_id.localeCompare(left.snapshot_id);
    });
    return snapshots[0];
  }

  private async loadAcquisition(key: string): Promise<CanonicalAcquisition> {
    const parsed = CanonicalAcquisitionSchema.safeParse(await this.store.readJson(key));
    if (!parsed.success) {
      throw new CoeContractError("invalid_contract", `Invalid acquisition journal entry: ${key}`);
    }
    return parsed.data;
  }

  async acquire(input: AcquireSnapshotInput): Promise<AcquireSnapshotResult> {
    const source = parseCoeContract("source", input.source) as SourceContract;
    const mediaType = normalizeMediaType(input.media_type);
    const lockName = representationLockName(source.source_id, mediaType);
    return this.store.withLock(lockName, () => this.acquireLocked(source, input, mediaType));
  }

  async recordFailure(input: RecordAcquisitionFailureInput): Promise<AcquireSnapshotResult> {
    const source = parseCoeContract("source", input.source) as SourceContract;
    const requestedUri = normalizeStoredUri(input.requested_uri);
    const finalUri = normalizeStoredUri(input.final_uri ?? input.requested_uri);
    const redirects = normalizeRedirects(requestedUri, finalUri, input.redirects ?? []);
    const errorCode = input.error_code.trim().toLowerCase();
    if (!/^[a-z][a-z0-9_]{0,127}$/.test(errorCode)) {
      throw new CoeContractError("invalid_contract", "error_code must be a stable lowercase machine code");
    }
    const startedAt = input.started_at ?? this.clock().toISOString();
    const finishedAt = input.finished_at ?? this.clock().toISOString();
    const lockName = sha256Canonical({ source_id: source.source_id, requested_uri: requestedUri });
    return this.store.withLock(lockName, async () => {
      const eventId = makeCoeId("evt", {
        kind: "source_acquisition_failure",
        source_id: source.source_id,
        requested_uri: requestedUri,
        started_at: startedAt,
        nonce: this.nonce(),
      });
      const started = {
        event_id: eventId,
        source_id: source.source_id,
        requested_uri: requestedUri,
        started_at: startedAt,
      };
      await this.appendJournal(eventId, "000-started", started);
      await this.store.writeJsonOnce(sourceKey(source.source_id), source);
      const acquisition = CanonicalAcquisitionSchema.parse({
        event_id: eventId,
        source,
        requested_uri: requestedUri,
        final_uri: finalUri,
        acquisition_method: input.acquisition_method,
        outcome: "failed",
        error_code: errorCode,
        quarantine_reasons: [],
        redirects,
        lifecycle_events: [],
        started_at: startedAt,
        finished_at: finishedAt,
      });
      await this.appendJournal(eventId, "100-ready", acquisition);
      await this.options.projection.projectAcquisition(acquisition);
      await this.appendJournal(eventId, "300-failed", acquisition);
      return {
        event_id: eventId,
        outcome: "failed",
        error_code: errorCode,
        quarantine_reasons: [],
      };
    });
  }

  private async acquireLocked(
    source: SourceContract,
    input: AcquireSnapshotInput,
    mediaType: string,
  ): Promise<AcquireSnapshotResult> {
    const startedAt = this.clock().toISOString();
    const acquiredAt = input.acquired_at ?? startedAt;
    const requestedUri = normalizeStoredUri(input.requested_uri);
    const finalUri = normalizeStoredUri(input.final_uri ?? input.requested_uri);
    const redirects = normalizeRedirects(requestedUri, finalUri, input.redirects ?? []);
    const expectedHash = normalizeHash(input.expected_sha256);
    const expectedMediaTypes = [...new Set((input.expected_media_types ?? []).map(normalizeMediaType))];
    const content = typeof input.content === "string" ? Buffer.from(input.content, "utf8") : Buffer.from(input.content);
    const actualHash = sha256Bytes(content);
    const eventId = makeCoeId("evt", {
      kind: "source_acquisition",
      source_id: source.source_id,
      requested_uri: requestedUri,
      started_at: startedAt,
      nonce: this.nonce(),
    });

    await this.appendJournal(eventId, "000-started", {
      event_id: eventId,
      source_id: source.source_id,
      requested_uri: requestedUri,
      started_at: startedAt,
    });
    await this.store.writeJsonOnce(sourceKey(source.source_id), source);

    if (expectedHash && expectedHash !== actualHash) {
      const rejected = CanonicalAcquisitionSchema.parse({
        event_id: eventId,
        source,
        requested_uri: requestedUri,
        final_uri: finalUri,
        acquisition_method: input.acquisition_method,
        outcome: "rejected",
        expected_hash: expectedHash,
        ...(expectedMediaTypes.length > 0 ? { expected_media_types: expectedMediaTypes } : {}),
        actual_hash: actualHash,
        error_code: "hash_mismatch",
        quarantine_reasons: [],
        redirects,
        lifecycle_events: [],
        started_at: startedAt,
        finished_at: this.clock().toISOString(),
      });
      await this.appendJournal(eventId, "100-ready", rejected);
      await this.options.projection.projectAcquisition(rejected);
      await this.appendJournal(eventId, "300-rejected", rejected);
      return {
        event_id: eventId,
        outcome: "rejected",
        error_code: "hash_mismatch",
        quarantine_reasons: [],
      };
    }

    const stored = await this.store.storeObject(content, expectedHash);
    const reasons = quarantineReasons(content, mediaType, expectedMediaTypes);
    const snapshotId = makeCoeId("snp", {
      source_id: source.source_id,
      content_hash: stored.content_hash,
      media_type: mediaType,
    });

    let snapshot: SourceSnapshotContract;
    let created = false;
    let previous: SourceSnapshotContract | undefined;
    if (await this.store.exists(snapshotKey(snapshotId))) {
      snapshot = await this.getCanonicalSnapshot(snapshotId);
      if (
        snapshot.source_id !== source.source_id ||
        snapshot.content_hash !== stored.content_hash ||
        snapshot.media_type !== mediaType ||
        snapshot.object_key !== stored.object_key
      ) {
        throw new CoeContractError("id_mismatch", "Existing snapshot ID conflicts with acquired content");
      }
    } else {
      previous = await this.findLatestSnapshot(source.source_id, mediaType);
      snapshot = parseCoeContract("source_snapshot", {
        schema_version: "1.0.0",
        snapshot_id: snapshotId,
        source_id: source.source_id,
        acquired_at: acquiredAt,
        acquisition_method: input.acquisition_method,
        content_hash: stored.content_hash,
        byte_size: stored.byte_size,
        media_type: mediaType,
        object_key: stored.object_key,
        status: reasons.length > 0 ? "quarantined" : "active",
        ...(previous ? { supersedes_snapshot_id: previous.snapshot_id } : {}),
        scope: source.scope,
        created_by: input.created_by ?? source.created_by,
      }) as SourceSnapshotContract;
      created = true;
    }

    const outcome = created ? (reasons.length > 0 ? "quarantined" : "promoted") : "duplicate";
    const lifecycleEvents: LifecycleEventContract[] = [];
    if (created && previous && snapshot.status === "active") {
      const previousStatus = await this.options.projection.getSnapshotStatus(previous.snapshot_id);
      if (!previousStatus) {
        throw new CoeContractError(
          "policy_violation",
          "Canonical snapshot chain is ahead of its projection; rebuild projection before acquiring a successor",
        );
      }
      if (previousStatus === "active") {
        const supersessionPayload = {
          predecessor_snapshot_id: previous.snapshot_id,
          successor_snapshot_id: snapshot.snapshot_id,
          from_status: previousStatus,
          to_status: "superseded",
          occurred_at: startedAt,
        };
        lifecycleEvents.push(parseCoeContract("lifecycle_event", {
          schema_version: "1.0.0",
          event_id: makeCoeId("evt", { kind: "snapshot_supersession", ...supersessionPayload }),
          aggregate_type: "snapshot",
          aggregate_id: previous.snapshot_id,
          event_type: "status_changed",
          from_status: previousStatus,
          to_status: "superseded",
          reason_code: "superseded_by_new_snapshot",
          payload_hash: `sha256:${sha256Canonical(supersessionPayload)}`,
          actor: input.created_by ?? source.created_by,
          scope: previous.scope,
          occurred_at: startedAt,
        }) as LifecycleEventContract);
      }
    }
    const acquisition = CanonicalAcquisitionSchema.parse({
      event_id: eventId,
      source,
      snapshot,
      requested_uri: requestedUri,
      final_uri: finalUri,
      acquisition_method: input.acquisition_method,
      outcome,
      ...(expectedHash ? { expected_hash: expectedHash } : {}),
      ...(expectedMediaTypes.length > 0 ? { expected_media_types: expectedMediaTypes } : {}),
      actual_hash: actualHash,
      quarantine_reasons: reasons,
      redirects,
      lifecycle_events: lifecycleEvents,
      started_at: startedAt,
      finished_at: this.clock().toISOString(),
    });

    await this.appendJournal(eventId, "100-ready", acquisition);
    await this.options.hooks?.after_object_stored?.(acquisition);
    await this.store.writeJsonOnce(snapshotKey(snapshot.snapshot_id), snapshot);
    for (const event of lifecycleEvents) await this.store.writeJsonOnce(eventKey(event.event_id), event);
    await this.appendJournal(eventId, "200-records-written", acquisition);
    await this.options.hooks?.after_records_written?.(acquisition);
    await this.options.projection.projectAcquisition(acquisition);
    await this.options.hooks?.after_projection?.(acquisition);
    await this.appendJournal(eventId, `300-${outcome}`, acquisition);

    return { event_id: eventId, outcome, snapshot, quarantine_reasons: reasons };
  }

  async readSnapshotBytes(snapshotId: string): Promise<Buffer> {
    const snapshot = await this.getCanonicalSnapshot(snapshotId);
    return this.store.readObject(snapshot.object_key, snapshot.content_hash);
  }

  async recoverPending(): Promise<{ recovered: number; incomplete: number }> {
    let recovered = 0;
    let incomplete = 0;
    const journalKeys = await this.store.listKeys("journal");
    const eventIds = [...new Set(journalKeys.map((key) => key.split("/")[1]).filter(Boolean))];
    for (const eventId of eventIds) {
      const eventKeys = journalKeys.filter((key) => key.startsWith(`journal/${eventId}/`));
      if (eventKeys.some((key) => /\/3\d\d-/.test(key))) continue;
      const readyKey = eventKeys.find((key) => key.endsWith("/100-ready.json"));
      if (!readyKey) {
        incomplete += 1;
        continue;
      }
      const acquisition = await this.loadAcquisition(readyKey);
      await this.store.writeJsonOnce(sourceKey(acquisition.source.source_id), acquisition.source);
      if (acquisition.snapshot) {
        await this.store.readObject(acquisition.snapshot.object_key, acquisition.snapshot.content_hash);
        await this.store.writeJsonOnce(snapshotKey(acquisition.snapshot.snapshot_id), acquisition.snapshot);
      }
      for (const event of acquisition.lifecycle_events) {
        await this.store.writeJsonOnce(eventKey(event.event_id), event);
      }
      await this.options.projection.projectAcquisition(acquisition);
      await this.appendJournal(eventId!, `310-recovered-${acquisition.outcome}`, acquisition);
      recovered += 1;
    }
    return { recovered, incomplete };
  }

  async rebuildProjection(): Promise<{
    acquisitions: number;
    projected: number;
    lifecycle_events: number;
    retractions: number;
  }> {
    const journalKeys = await this.store.listKeys("journal");
    const acquisitions: CanonicalAcquisition[] = [];
    for (const key of journalKeys.filter((candidate) => candidate.endsWith("/100-ready.json"))) {
      acquisitions.push(await this.loadAcquisition(key));
    }
    acquisitions.sort((left, right) => {
      const timeDifference = Date.parse(left.started_at) - Date.parse(right.started_at);
      return timeDifference || left.event_id.localeCompare(right.event_id);
    });

    let acquisitionCount = 0;
    let pendingAcquisitions = acquisitions;
    const representedSnapshots = new Set<string>();
    while (pendingAcquisitions.length > 0) {
      const deferred: CanonicalAcquisition[] = [];
      let progress = 0;
      for (const acquisition of pendingAcquisitions) {
        const snapshot = acquisition.snapshot;
        if (snapshot?.supersedes_snapshot_id) {
          const predecessorStatus = await this.options.projection.getSnapshotStatus(snapshot.supersedes_snapshot_id);
          if (!predecessorStatus) {
            deferred.push(acquisition);
            continue;
          }
        }
        const canonicalSource = await this.getCanonicalSource(acquisition.source.source_id);
        if (sha256Canonical(canonicalSource) !== sha256Canonical(acquisition.source)) {
          throw new CoeContractError("id_mismatch", "Acquisition journal conflicts with canonical source record");
        }
        if (snapshot) {
          const canonicalSnapshot = await this.getCanonicalSnapshot(snapshot.snapshot_id);
          if (sha256Canonical(canonicalSnapshot) !== sha256Canonical(snapshot)) {
            throw new CoeContractError("id_mismatch", "Acquisition journal conflicts with canonical snapshot record");
          }
          await this.store.readObject(snapshot.object_key, snapshot.content_hash);
          representedSnapshots.add(snapshot.snapshot_id);
        }
        await this.options.projection.projectAcquisition(acquisition);
        acquisitionCount += 1;
        progress += 1;
      }
      if (progress === 0) {
        throw new CoeContractError("invalid_transition", "Canonical acquisitions cannot be rebuilt in causal order");
      }
      pendingAcquisitions = deferred;
    }

    let projected = representedSnapshots.size;
    for (const key of await this.store.listKeys("records/snapshots")) {
      const snapshot = parseCoeContract("source_snapshot", await this.store.readJson(key)) as SourceSnapshotContract;
      if (representedSnapshots.has(snapshot.snapshot_id)) continue;
      const source = await this.getCanonicalSource(snapshot.source_id);
      await this.store.readObject(snapshot.object_key, snapshot.content_hash);
      const fallbackUri = `file:///coe/source/${source.source_id}`;
      const uri = normalizeStoredUri(source.canonical_uri ?? fallbackUri);
      const acquisition = CanonicalAcquisitionSchema.parse({
        event_id: makeCoeId("evt", { kind: "projection_restore", snapshot_id: snapshot.snapshot_id }),
        source,
        snapshot,
        requested_uri: uri,
        final_uri: uri,
        acquisition_method: snapshot.acquisition_method,
        outcome: "restored",
        actual_hash: snapshot.content_hash,
        quarantine_reasons: snapshot.status === "quarantined" ? ["restored_quarantine"] : [],
        redirects: [],
        lifecycle_events: [],
        started_at: snapshot.acquired_at,
        finished_at: snapshot.acquired_at,
      });
      await this.options.projection.projectAcquisition(acquisition);
      acquisitionCount += 1;
      projected += 1;
    }

    let lifecycleEvents = 0;
    let retractions = 0;
    const events: LifecycleEventContract[] = [];
    for (const key of await this.store.listKeys("records/events")) {
      events.push(parseCoeContract("lifecycle_event", await this.store.readJson(key)) as LifecycleEventContract);
    }
    events.sort((left, right) => {
      const timeDifference = Date.parse(left.occurred_at) - Date.parse(right.occurred_at);
      return timeDifference || left.event_id.localeCompare(right.event_id);
    });
    let pending = events.filter((event) => event.aggregate_type === "snapshot" && event.from_status && event.to_status);
    while (pending.length > 0) {
      const deferred: LifecycleEventContract[] = [];
      let progress = 0;
      for (const event of pending) {
        const current = await this.options.projection.getSnapshotStatus(event.aggregate_id);
        if (current !== event.from_status && current !== event.to_status) {
          deferred.push(event);
          continue;
        }
        await this.options.projection.applyLifecycleEvent(event);
        lifecycleEvents += 1;
        if (event.to_status === "retracted") retractions += 1;
        progress += 1;
      }
      if (progress === 0) {
        throw new CoeContractError("invalid_transition", "Canonical lifecycle events cannot be replayed in causal order");
      }
      pending = deferred;
    }
    return { acquisitions: acquisitionCount, projected, lifecycle_events: lifecycleEvents, retractions };
  }

  async retractSnapshot(snapshotId: string, reason: string, actor: ActorRef): Promise<LifecycleEventContract> {
    if (!reason.trim()) throw new CoeContractError("invalid_contract", "Retraction reason is required");
    const snapshot = await this.getCanonicalSnapshot(snapshotId);
    const lockName = representationLockName(snapshot.source_id, snapshot.media_type);
    return this.store.withLock(lockName, async () => {
      const currentStatus = await this.options.projection.getSnapshotStatus(snapshotId);
      if (!currentStatus) throw new CoeContractError("invalid_contract", "Cannot retract a snapshot absent from the projection");
      if (currentStatus === "retracted") {
        throw new CoeContractError("invalid_transition", "Snapshot is already retracted");
      }
      const occurredAt = this.clock().toISOString();
      const payload = {
        snapshot_id: snapshotId,
        from_status: currentStatus,
        to_status: "retracted",
        reason,
        actor,
        occurred_at: occurredAt,
      };
      const event = parseCoeContract("lifecycle_event", {
        schema_version: "1.0.0",
        event_id: makeCoeId("evt", { kind: "snapshot_retraction", ...payload }),
        aggregate_type: "snapshot",
        aggregate_id: snapshotId,
        event_type: "status_changed",
        from_status: currentStatus,
        to_status: "retracted",
        reason_code: reason,
        payload_hash: `sha256:${sha256Canonical(payload)}`,
        actor,
        scope: snapshot.scope,
        occurred_at: occurredAt,
      }) as LifecycleEventContract;
      await this.store.writeJsonOnce(eventKey(event.event_id), event);
      await this.options.projection.applyLifecycleEvent(event);
      return event;
    });
  }

  async cleanupStaging(now = this.clock()): Promise<{ removed: number; cutoff: string }> {
    const cutoff = new Date(now.getTime() - this.retention.staging_max_age_ms);
    const removed = await this.store.cleanupStaging(cutoff);
    return { removed, cutoff: cutoff.toISOString() };
  }

}
