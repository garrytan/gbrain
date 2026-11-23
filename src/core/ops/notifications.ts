/**
 * Operator surface for outbound notification sinks (notifications/*): status, backfill, one-shot drain and retry.
 * Local-only: the trusted CLI on the brain host runs them (`gbrain notify-status`, `gbrain notify-backfill ...`).
 * Never import from '../operations.ts' here (cycle).
 */
import { opError, type Operation } from './contract.ts';
import { loadSinks, resetSinkConfigCache, sinkEnabled, NOTIFY_SINKS_ENV, NOTIFY_SINKS_KEY } from '../notifications/config.ts';
import { createSink, sinkTypes } from '../notifications/registry.ts';
import { outboxCounts, recentFailures, requeueFailed } from '../notifications/outbox.ts';
import { backfillCreated } from '../notifications/backfill.ts';
import { drainOnce } from '../notifications/dispatcher.ts';
import type { GBrainConfig } from '../config.ts';

const notify_status: Operation = {
  name: 'notify_status',
  mutating: false,
  idempotent: true,
  outputRedaction: { exempt: 'local-only operator status: sink names, types, events and queue counts; never credentials' },
  description: `Outbound notification sinks (${NOTIFY_SINKS_KEY} / ${NOTIFY_SINKS_ENV}): each sink, whether this host can deliver it, and the delivery queue by sink, event and status. Local-only. CLI: \`gbrain notify-status\`.`,
  params: {},
  scope: 'admin',
  localOnly: true,
  area: 'admin',
  handler: async (ctx) => {
    resetSinkConfigCache();
    const { sinks, error } = await loadSinks(ctx.engine, { fresh: true });
    return {
      config_error: error,
      sink_types: sinkTypes(),
      sinks: sinks.map(config => {
        const built = createSink(config);
        return { name: config.name, type: config.type, enabled: sinkEnabled(config), events: config.events ?? 'all', filter: config.filter ?? null,
          ready: 'error' in built ? built.error : built.sink.ready() ?? 'ready' };
      }),
      queue: await outboxCounts(ctx.engine),
      recent_failures: await recentFailures(ctx.engine),
    };
  },
  cliHints: { name: 'notify-status' },
};

const notify_backfill: Operation = {
  name: 'notify_backfill',
  mutating: true,
  writeInference: 'non_content',
  idempotent: true,
  outputRedaction: { exempt: 'local-only operator command: returns proposal ids and sink names only' },
  description: 'Queue take_proposal.created for proposals that are already pending, so the sinks post them (nothing posts the existing backlog on its own). Highest weight first, at most `limit` (default 20); each sink\'s filter applies and a proposal already queued for a sink is skipped. Local-only. CLI: `gbrain notify-backfill --limit 10 [--min-weight 0.7] [--sink <name>] [--id <proposal id>] [--dry-run]`.',
  params: {
    sink: { type: 'string', description: 'Only this sink (default every sink that receives take_proposal.created).' },
    min_weight: { type: 'number', description: 'Only proposals with at least this weight.' },
    limit: { type: 'number', description: 'Most proposals to queue (default 20, cap 1000).' },
    id: { type: 'number', description: 'Queue exactly this proposal (any status), e.g. to test a sink.' },
  },
  scope: 'admin',
  localOnly: true,
  area: 'admin',
  handler: async (ctx, p) => {
    const minWeight = p.min_weight === undefined ? undefined : Number(p.min_weight);
    if (minWeight !== undefined && (!Number.isFinite(minWeight) || minWeight < 0 || minWeight > 1)) throw opError('invalid_params', 'min_weight must be from 0 to 1.', 'Pass min_weight between 0 and 1.');
    const id = p.id === undefined ? undefined : Number(p.id);
    if (id !== undefined && (!Number.isSafeInteger(id) || id <= 0)) throw opError('invalid_params', 'id must be a proposal id.', 'Pass id: a proposal id from takes_proposals_list.');
    try {
      return await backfillCreated(ctx.engine, {
        ...(p.sink ? { sink: String(p.sink) } : {}), ...(minWeight !== undefined ? { minWeight } : {}),
        ...(p.limit !== undefined ? { limit: Number(p.limit) } : {}), ...(id !== undefined ? { ids: [id] } : {}), dryRun: ctx.dryRun,
      });
    } catch (error) {
      throw opError('invalid_params', error instanceof Error ? error.message : String(error), `Check ${NOTIFY_SINKS_KEY} with gbrain notify-status.`);
    }
  },
  cliHints: { name: 'notify-backfill' },
};

const notify_drain: Operation = {
  name: 'notify_drain',
  mutating: true,
  writeInference: 'non_content',
  idempotent: true,
  outputRedaction: { exempt: 'local-only operator command: returns delivery counts only' },
  description: 'Deliver every due notification now, once (a running `gbrain serve --http` does this every 10 s). Local-only. CLI: `gbrain notify-drain`.',
  params: {},
  scope: 'admin',
  localOnly: true,
  area: 'admin',
  handler: async (ctx) => {
    if (ctx.dryRun) return { dry_run: true, action: 'notify_drain' };
    return drainOnce(ctx.engine, { config: ctx.config as GBrainConfig, log: line => ctx.logger.warn(line) });
  },
  cliHints: { name: 'notify-drain' },
};

const notify_retry: Operation = {
  name: 'notify_retry',
  mutating: true,
  writeInference: 'non_content',
  idempotent: true,
  outputRedaction: { exempt: 'local-only operator command: returns a count only' },
  description: 'Put deliveries that gave up (status failed) back in the queue, e.g. after fixing a token or inviting the app to the channel. Local-only. CLI: `gbrain notify-retry [--sink <name>]`.',
  params: { sink: { type: 'string', description: 'Only this sink.' } },
  scope: 'admin',
  localOnly: true,
  area: 'admin',
  handler: async (ctx, p) => {
    if (ctx.dryRun) return { dry_run: true, action: 'notify_retry' };
    return { requeued: await requeueFailed(ctx.engine, p.sink ? String(p.sink) : undefined) };
  },
  cliHints: { name: 'notify-retry' },
};

export const notificationsOperations: Operation[] = [notify_status, notify_backfill, notify_drain, notify_retry];
