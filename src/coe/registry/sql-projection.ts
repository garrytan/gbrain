import type { BrainEngine } from "../../core/engine.ts";
import { executeRawJsonb } from "../../core/sql-query.ts";
import {
  CoeContractError,
  assertTransition,
  canonicalizeJson,
  sha256Canonical,
} from "../contracts/index.ts";
import type { ArtifactStatus } from "../contracts/transitions.ts";
import {
  assertCanonicalAcquisitionBindings,
  type CanonicalAcquisition,
  type CoeSnapshotProjection,
} from "./types.ts";
import type { LifecycleEventContract } from "../contracts/index.ts";

function recordHash(value: unknown): string {
  return `sha256:${sha256Canonical(value)}`;
}

function canonicalJsonValue(value: unknown): unknown {
  return JSON.parse(canonicalizeJson(value));
}

export class SqlCoeSnapshotProjection implements CoeSnapshotProjection {
  constructor(private readonly engine: BrainEngine) {}

  async projectAcquisition(acquisition: CanonicalAcquisition): Promise<void> {
    assertCanonicalAcquisitionBindings(acquisition);
    await this.engine.transaction(async (tx) => {
      const sourceHash = recordHash(acquisition.source);
      await executeRawJsonb(
        tx,
        `INSERT INTO coe_sources
           (source_id, schema_version, record_hash, record_json, scope_json, created_at)
         VALUES ($1, $2, $3, $5::jsonb, $6::jsonb, $4::timestamptz)
         ON CONFLICT (source_id) DO NOTHING`,
        [
          acquisition.source.source_id,
          acquisition.source.schema_version,
          sourceHash,
          acquisition.source.created_at,
        ],
        [canonicalJsonValue(acquisition.source), canonicalJsonValue(acquisition.source.scope)],
      );
      const sourceRows = await tx.executeRaw<{ record_hash: string }>(
        "SELECT record_hash FROM coe_sources WHERE source_id = $1",
        [acquisition.source.source_id],
      );
      if (sourceRows[0]?.record_hash !== sourceHash) {
        throw new CoeContractError("id_mismatch", "Source projection conflicts with canonical record");
      }

      if (acquisition.snapshot) {
        const snapshot = acquisition.snapshot;
        const snapshotHash = recordHash(snapshot);
        await tx.executeRaw(
          `INSERT INTO coe_raw_objects
             (content_hash, object_key, byte_size, created_at, verified_at)
           VALUES ($1, $2, $3, $4::timestamptz, $4::timestamptz)
           ON CONFLICT (content_hash) DO NOTHING`,
          [snapshot.content_hash, snapshot.object_key, snapshot.byte_size, snapshot.acquired_at],
        );
        const rawRows = await tx.executeRaw<{ object_key: string; byte_size: string | number }>(
          "SELECT object_key, byte_size FROM coe_raw_objects WHERE content_hash = $1",
          [snapshot.content_hash],
        );
        if (
          rawRows[0]?.object_key !== snapshot.object_key ||
          Number(rawRows[0]?.byte_size) !== snapshot.byte_size
        ) {
          throw new CoeContractError("hash_mismatch", "Raw-object projection conflicts with canonical object");
        }

        await executeRawJsonb(
          tx,
          `INSERT INTO coe_snapshots
             (snapshot_id, source_id, schema_version, content_hash, media_type, byte_size,
              object_key, supersedes_snapshot_id, initial_status, status, record_hash,
              record_json, scope_json, acquired_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $9, $10,
                   $12::jsonb, $13::jsonb, $11::timestamptz)
           ON CONFLICT (snapshot_id) DO NOTHING`,
          [
            snapshot.snapshot_id,
            snapshot.source_id,
            snapshot.schema_version,
            snapshot.content_hash,
            snapshot.media_type,
            snapshot.byte_size,
            snapshot.object_key,
            snapshot.supersedes_snapshot_id ?? null,
            snapshot.status,
            snapshotHash,
            snapshot.acquired_at,
          ],
          [canonicalJsonValue(snapshot), canonicalJsonValue(snapshot.scope)],
        );
        const snapshotRows = await tx.executeRaw<{ record_hash: string }>(
          "SELECT record_hash FROM coe_snapshots WHERE snapshot_id = $1",
          [snapshot.snapshot_id],
        );
        if (snapshotRows[0]?.record_hash !== snapshotHash) {
          throw new CoeContractError("id_mismatch", "Snapshot projection conflicts with canonical record");
        }
      }

      const acquisitionHash = recordHash(acquisition);
      await executeRawJsonb(
        tx,
        `INSERT INTO coe_acquisitions
           (event_id, source_id, snapshot_id, requested_uri, final_uri, acquisition_method,
            outcome, expected_hash, actual_hash, error_code, quarantine_reasons,
            record_hash, record_json, started_at, finished_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $14::jsonb,
                 $11, $15::jsonb, $12::timestamptz, $13::timestamptz)
         ON CONFLICT (event_id) DO NOTHING`,
        [
          acquisition.event_id,
          acquisition.source.source_id,
          acquisition.snapshot?.snapshot_id ?? null,
          acquisition.requested_uri,
          acquisition.final_uri,
          acquisition.acquisition_method,
          acquisition.outcome,
          acquisition.expected_hash ?? null,
          acquisition.actual_hash ?? null,
          acquisition.error_code ?? null,
          acquisitionHash,
          acquisition.started_at,
          acquisition.finished_at,
        ],
        [canonicalJsonValue(acquisition.quarantine_reasons), canonicalJsonValue(acquisition)],
      );
      const acquisitionRows = await tx.executeRaw<{ record_hash: string }>(
        "SELECT record_hash FROM coe_acquisitions WHERE event_id = $1",
        [acquisition.event_id],
      );
      if (acquisitionRows[0]?.record_hash !== acquisitionHash) {
        throw new CoeContractError("id_mismatch", "Acquisition event conflicts with canonical journal");
      }

      for (const [hop, redirect] of acquisition.redirects.entries()) {
        await tx.executeRaw(
          `INSERT INTO coe_acquisition_redirects
             (event_id, hop, from_uri, to_uri, status_code)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (event_id, hop) DO NOTHING`,
          [acquisition.event_id, hop, redirect.from_uri, redirect.to_uri, redirect.status_code],
        );
        const rows = await tx.executeRaw<{ from_uri: string; to_uri: string; status_code: number }>(
          `SELECT from_uri, to_uri, status_code
             FROM coe_acquisition_redirects WHERE event_id = $1 AND hop = $2`,
          [acquisition.event_id, hop],
        );
        if (
          rows[0]?.from_uri !== redirect.from_uri ||
          rows[0]?.to_uri !== redirect.to_uri ||
          Number(rows[0]?.status_code) !== redirect.status_code
        ) {
          throw new CoeContractError("id_mismatch", "Redirect hop conflicts with canonical journal");
        }
      }
      for (const event of acquisition.lifecycle_events) {
        await this.applyLifecycleEventInTransaction(tx, event);
      }
    });
  }

  async getSnapshotStatus(snapshotId: string): Promise<ArtifactStatus | null> {
    const rows = await this.engine.executeRaw<{ status: ArtifactStatus }>(
      "SELECT status FROM coe_snapshots WHERE snapshot_id = $1",
      [snapshotId],
    );
    return rows[0]?.status ?? null;
  }

  private async applyLifecycleEventInTransaction(tx: BrainEngine, event: LifecycleEventContract): Promise<void> {
    const existingEvents = await tx.executeRaw<{ payload_hash: string; event_json: unknown }>(
      "SELECT payload_hash, event_json FROM coe_snapshot_events WHERE event_id = $1",
      [event.event_id],
    );
    if (existingEvents.length > 0) {
      if (
        existingEvents[0]?.payload_hash !== event.payload_hash ||
        canonicalizeJson(existingEvents[0]?.event_json) !== canonicalizeJson(event)
      ) {
        throw new CoeContractError("id_mismatch", "Lifecycle event ID maps to different content");
      }
      return;
    }

    if (!event.from_status || !event.to_status || event.aggregate_type !== "snapshot") {
      throw new CoeContractError("invalid_contract", "Snapshot lifecycle event requires from_status and to_status");
    }
    const rows = await tx.executeRaw<{ status: ArtifactStatus }>(
      "SELECT status FROM coe_snapshots WHERE snapshot_id = $1",
      [event.aggregate_id],
    );
    const current = rows[0]?.status;
    if (!current) throw new CoeContractError("invalid_contract", "Cannot transition an unprojected snapshot");
    if (current !== event.from_status) {
      throw new CoeContractError(
        "invalid_transition",
        `Snapshot lifecycle expected ${event.from_status}, found ${current}`,
      );
    }
    assertTransition("snapshot", current, event.to_status);
    await executeRawJsonb(
      tx,
      `INSERT INTO coe_snapshot_events
         (event_id, snapshot_id, event_type, from_status, to_status, reason_code,
          payload_hash, event_json, occurred_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $9::jsonb, $8::timestamptz)`,
      [
        event.event_id,
        event.aggregate_id,
        event.event_type,
        event.from_status,
        event.to_status,
        event.reason_code,
        event.payload_hash,
        event.occurred_at,
      ],
      [canonicalJsonValue(event)],
    );
    const updated = event.to_status === "retracted"
      ? await tx.executeRaw<{ snapshot_id: string }>(
          `UPDATE coe_snapshots
              SET status = 'retracted', retracted_at = $2::timestamptz,
                  retraction_reason = $3, retraction_event_id = $4
            WHERE snapshot_id = $1 AND status = $5
            RETURNING snapshot_id`,
          [event.aggregate_id, event.occurred_at, event.reason_code, event.event_id, current],
        )
      : await tx.executeRaw<{ snapshot_id: string }>(
          `UPDATE coe_snapshots SET status = $2
            WHERE snapshot_id = $1 AND status = $3
            RETURNING snapshot_id`,
          [event.aggregate_id, event.to_status, current],
        );
    if (updated.length !== 1) {
      throw new CoeContractError("invalid_transition", "Snapshot status changed concurrently during lifecycle event");
    }
  }

  async applyLifecycleEvent(event: LifecycleEventContract): Promise<void> {
    await this.engine.transaction((tx) => this.applyLifecycleEventInTransaction(tx, event));
  }
}
