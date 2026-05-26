import {
  buildRawIngestPlan,
  type RawIngestPlan,
  type RawIngestPolicy,
  type SourceItemRecord,
} from '../source-registry/raw-ingest.ts';
import type { SourceRecord } from '../services/source-registry-service.ts';

export interface ConnectorSourceItem {
  external_id: string;
  locator?: string | null;
  title?: string;
  body: string;
  created_at?: string | null;
  updated_at?: string | null;
  metadata_json?: Record<string, unknown>;
}

export interface ConnectorSyncInput {
  source: SourceRecord;
  items: ConnectorSourceItem[];
  policy: RawIngestPolicy;
  existing_items?: SourceItemRecord[];
  parser_version?: string;
  now: string;
}

export interface ConnectorSyncPlan {
  raw_ingest_plans: RawIngestPlan[];
  skipped_external_ids: string[];
}

export function planConnectorSync(input: ConnectorSyncInput): ConnectorSyncPlan {
  const existingByExternalId = new Map(
    (input.existing_items ?? []).map((item) => [item.external_id, item]),
  );
  const rawIngestPlans: RawIngestPlan[] = [];
  const skippedExternalIds: string[] = [];

  for (const connectorItem of input.items) {
    const plan = buildRawIngestPlan({
      source_id: input.source.id,
      external_id: connectorItem.external_id,
      origin_event: 'connector_sync',
      locator: connectorItem.locator,
      title: connectorItem.title,
      chunk_texts: [connectorItem.body],
      raw_text: connectorItem.body,
      parser_version: input.parser_version ?? `${input.source.kind}-connector:v1`,
      now: input.now,
    }, input.policy);

    plan.item.source_created_at = connectorItem.created_at ?? null;
    plan.item.source_updated_at = connectorItem.updated_at ?? null;
    plan.item.metadata_json = {
      ...connectorItem.metadata_json,
      connector_id: input.source.connector_id,
    };

    const existing = existingByExternalId.get(connectorItem.external_id);
    if (existing?.content_hash === plan.item.content_hash) {
      skippedExternalIds.push(connectorItem.external_id);
      continue;
    }

    rawIngestPlans.push(plan);
  }

  return {
    raw_ingest_plans: rawIngestPlans,
    skipped_external_ids: skippedExternalIds,
  };
}
