import { z } from "zod";

import {
  CoeContractError,
  assertScopeDoesNotWiden,
  SourceSchema,
  SourceSnapshotSchema,
  LifecycleEventSchema,
  type ActorRef,
  type LifecycleEventContract,
  type SourceContract,
  type SourceSnapshotContract,
} from "../contracts/index.ts";
import type { ArtifactStatus } from "../contracts/transitions.ts";

export const ACQUISITION_OUTCOMES = [
  "promoted",
  "duplicate",
  "quarantined",
  "rejected",
  "failed",
  "restored",
] as const;

export type AcquisitionOutcome = (typeof ACQUISITION_OUTCOMES)[number];

export const RedirectHopSchema = z.strictObject({
  from_uri: z.url(),
  to_uri: z.url(),
  status_code: z.number().int().min(300).max(399),
});

export type RedirectHop = z.output<typeof RedirectHopSchema>;

export interface AcquireSnapshotInput {
  source: SourceContract;
  content: string | Uint8Array;
  requested_uri: string;
  final_uri?: string;
  media_type: string;
  expected_media_types?: string[];
  acquisition_method: SourceSnapshotContract["acquisition_method"];
  acquired_at?: string;
  expected_sha256?: string;
  redirects?: RedirectHop[];
  created_by?: ActorRef;
}

export interface RecordAcquisitionFailureInput {
  source: SourceContract;
  requested_uri: string;
  final_uri?: string;
  acquisition_method: SourceSnapshotContract["acquisition_method"];
  error_code: string;
  redirects?: RedirectHop[];
  started_at?: string;
  finished_at?: string;
}

export const CanonicalAcquisitionSchema = z
  .strictObject({
    event_id: z.string().regex(/^evt_[0-9a-f]{64}$/),
    source: SourceSchema,
    snapshot: SourceSnapshotSchema.optional(),
    requested_uri: z.url(),
    final_uri: z.url(),
    acquisition_method: z.enum(["upload", "http", "filesystem", "api", "legacy_import"]),
    outcome: z.enum(ACQUISITION_OUTCOMES),
    expected_hash: z.string().regex(/^sha256:[0-9a-f]{64}$/).optional(),
    expected_media_types: z.array(z.string().min(1)).optional(),
    actual_hash: z.string().regex(/^sha256:[0-9a-f]{64}$/).optional(),
    error_code: z.string().min(1).optional(),
    quarantine_reasons: z.array(z.string().min(1)),
    redirects: z.array(RedirectHopSchema),
    lifecycle_events: z.array(LifecycleEventSchema),
    started_at: z.iso.datetime({ offset: true }),
    finished_at: z.iso.datetime({ offset: true }),
  })
  .superRefine((acquisition, context) => {
    if (acquisition.snapshot && acquisition.source.source_id !== acquisition.snapshot.source_id) {
      context.addIssue({
        code: "custom",
        path: ["snapshot", "source_id"],
        message: "An acquisition source must own its snapshot",
      });
    }
    if (acquisition.outcome === "failed") {
      if (acquisition.snapshot) {
        context.addIssue({ code: "custom", path: ["snapshot"], message: "A failed acquisition cannot create a snapshot" });
      }
      if (!acquisition.error_code) {
        context.addIssue({ code: "custom", path: ["error_code"], message: "A failed acquisition requires an error_code" });
      }
      return;
    }
    if (!acquisition.actual_hash) {
      context.addIssue({ code: "custom", path: ["actual_hash"], message: "A materialized acquisition requires an actual_hash" });
    }
  });

export type CanonicalAcquisition = z.output<typeof CanonicalAcquisitionSchema>;

export function assertCanonicalAcquisitionBindings(acquisition: CanonicalAcquisition): void {
  if (acquisition.snapshot && acquisition.source.source_id !== acquisition.snapshot.source_id) {
    throw new CoeContractError("invalid_contract", "Acquisition source does not own its snapshot");
  }
  if (acquisition.snapshot) {
    assertScopeDoesNotWiden(acquisition.source.scope, acquisition.snapshot.scope);
  }
}

export interface AcquireSnapshotResult {
  event_id: string;
  outcome: AcquisitionOutcome;
  snapshot?: SourceSnapshotContract;
  error_code?: string;
  quarantine_reasons: string[];
}

export interface ProjectedSnapshot {
  source: SourceContract;
  snapshot: SourceSnapshotContract;
  status: ArtifactStatus;
  retraction_event_id?: string;
  retraction_reason?: string;
}

export interface CoeSnapshotProjection {
  projectAcquisition(acquisition: CanonicalAcquisition): Promise<void>;
  getSnapshotStatus(snapshotId: string): Promise<ArtifactStatus | null>;
  applyLifecycleEvent(event: LifecycleEventContract): Promise<void>;
}

export interface SnapshotLedgerHooks {
  after_object_stored?: (acquisition: CanonicalAcquisition) => void | Promise<void>;
  after_records_written?: (acquisition: CanonicalAcquisition) => void | Promise<void>;
  after_projection?: (acquisition: CanonicalAcquisition) => void | Promise<void>;
}

export interface SnapshotRetentionPolicy {
  staging_max_age_ms: number;
  preserve_retracted_objects: true;
  preserve_acquisition_journal: true;
}

export interface SnapshotLedgerOptions {
  root: string;
  projection: CoeSnapshotProjection;
  clock?: () => Date;
  nonce?: () => string;
  hooks?: SnapshotLedgerHooks;
  retention?: Partial<SnapshotRetentionPolicy>;
}
