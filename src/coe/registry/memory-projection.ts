import { canonicalizeJson, CoeContractError, assertTransition } from "../contracts/index.ts";
import type {
  CanonicalAcquisition,
  CoeSnapshotProjection,
  ProjectedSnapshot,
} from "./types.ts";
import { assertCanonicalAcquisitionBindings } from "./types.ts";
import type { LifecycleEventContract } from "../contracts/index.ts";

export class InMemoryCoeSnapshotProjection implements CoeSnapshotProjection {
  readonly acquisitions = new Map<string, CanonicalAcquisition>();
  readonly snapshots = new Map<string, ProjectedSnapshot>();
  private readonly appliedEvents = new Map<string, string>();

  async projectAcquisition(acquisition: CanonicalAcquisition): Promise<void> {
    assertCanonicalAcquisitionBindings(acquisition);
    const existingAcquisition = this.acquisitions.get(acquisition.event_id);
    if (existingAcquisition && JSON.stringify(existingAcquisition) !== JSON.stringify(acquisition)) {
      throw new CoeContractError("id_mismatch", "Acquisition event ID maps to different content");
    }
    if (!existingAcquisition) this.acquisitions.set(acquisition.event_id, structuredClone(acquisition));

    if (acquisition.snapshot) {
      const snapshotId = acquisition.snapshot.snapshot_id;
      const existing = this.snapshots.get(snapshotId);
      if (existing) {
        if (
          existing.snapshot.content_hash !== acquisition.snapshot.content_hash ||
          existing.snapshot.source_id !== acquisition.snapshot.source_id ||
          existing.snapshot.media_type !== acquisition.snapshot.media_type
        ) {
          throw new CoeContractError("id_mismatch", "Snapshot ID maps to different immutable content");
        }
      } else {
        this.snapshots.set(snapshotId, {
          source: structuredClone(acquisition.source),
          snapshot: structuredClone(acquisition.snapshot),
          status: acquisition.snapshot.status,
        });
      }
    }
    for (const event of acquisition.lifecycle_events) await this.applyLifecycleEvent(event);
  }

  async getSnapshotStatus(snapshotId: string) {
    return this.snapshots.get(snapshotId)?.status ?? null;
  }

  async applyLifecycleEvent(event: LifecycleEventContract): Promise<void> {
    const serialized = canonicalizeJson(event);
    const existingEvent = this.appliedEvents.get(event.event_id);
    if (existingEvent) {
      if (existingEvent !== serialized) {
        throw new CoeContractError("id_mismatch", "Lifecycle event ID maps to different content");
      }
      return;
    }
    const projected = this.snapshots.get(event.aggregate_id);
    if (!projected) throw new CoeContractError("invalid_contract", "Cannot transition an unprojected snapshot");
    if (projected.status === event.to_status && projected.retraction_event_id === event.event_id) return;
    if (!event.from_status || !event.to_status) {
      throw new CoeContractError("invalid_contract", "Lifecycle event is missing from_status or to_status");
    }
    if (projected.status !== event.from_status) {
      throw new CoeContractError(
        "invalid_transition",
        `Snapshot lifecycle expected ${event.from_status}, found ${projected.status}`,
      );
    }
    assertTransition("snapshot", projected.status, event.to_status);
    projected.status = event.to_status as ProjectedSnapshot["status"];
    if (event.to_status === "retracted") {
      projected.retraction_event_id = event.event_id;
      projected.retraction_reason = event.reason_code;
    }
    this.appliedEvents.set(event.event_id, serialized);
  }

  clear(): void {
    this.acquisitions.clear();
    this.snapshots.clear();
    this.appliedEvents.clear();
  }
}
