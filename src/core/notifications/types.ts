/**
 * The sink contract. A sink type is a factory from its config entry to an object that delivers outbox rows; register
 * a new type with `registerSinkType` (notifications/registry.ts) and name it in `notify.sinks`.
 */
import type { BrainEngine } from '../engine.ts';
import type { GBrainConfig } from '../config.ts';
import type { ConnectorFetch } from '../connectors/client.ts';
import type { SinkConfig } from './config.ts';
import type { OutboxRow } from './outbox.ts';

export interface SinkContext {
  engine: BrainEngine;
  /** The operation config decisions run with (accept writes a take). */
  config: GBrainConfig;
  log: (line: string) => void;
  fetchImpl?: ConnectorFetch;
}

export type DeliveryOutcome =
  | { status: 'delivered'; delivery?: Record<string, unknown> }
  | { status: 'skipped'; reason: string };

export interface NotificationSink {
  readonly name: string;
  readonly type: string;
  /** Null when this host can deliver (credentials present); otherwise why not. Rows wait while it cannot. */
  ready(): string | null;
  /** Deliver one row. Throw to retry with backoff; throw a NonRetryableSinkError to give up at once. */
  deliver(row: OutboxRow, ctx: SinkContext): Promise<DeliveryOutcome>;
}

export type SinkFactory = (config: SinkConfig) => NotificationSink;

/** A delivery that can never succeed as configured (bad channel, revoked token): fails the row without retries. */
export class NonRetryableSinkError extends Error {
  constructor(message: string) { super(message); this.name = 'NonRetryableSinkError'; }
}

/** The proposal snapshot every take_proposal.* event carries. */
export interface ProposalEventPayload {
  event: string;
  occurred_at: string;
  proposal: {
    id: number; source_id: string; page_slug: string; claim: string; kind: string; holder: string; weight: number;
    domain: string | null; status: string; proposed_at: string | null; promoted_row_num: number | null;
    acted_by: string | null; acted_at: string | null; acted_via: string | null; reason: string | null;
  };
}
