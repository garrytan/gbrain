/**
 * Coordinator-safe write helpers for local collectors (WhatsApp, LinkedIn).
 *
 * Routes page writes, timeline appends, and graph links through gbrain's
 * canonical operation handlers (`put_page`, `add_timeline_entry`, `add_link`)
 * so writes succeed identically on both unmanaged in-memory brains and
 * managed local/hosted brains with a writer coordinator.
 */
import type { BrainEngine } from '../engine.ts';
import { operations, type OperationContext } from '../operations.ts';

function makeCollectorContext(engine: BrainEngine, sourceId: string): OperationContext {
  return {
    engine,
    config: { engine: 'pglite' },
    sourceId,
    remote: false,
    dryRun: false,
    logger: {
      info: () => {},
      warn: (msg: string) => process.stderr.write(`[collector] WARN: ${msg}\n`),
      error: (msg: string) => process.stderr.write(`[collector] ERROR: ${msg}\n`),
    },
  };
}

function getOp(name: string) {
  const op = operations.find((o) => o.name === name);
  if (!op) throw new Error(`gbrain operation "${name}" is unavailable`);
  return op;
}

export async function collectorPutPage(
  engine: BrainEngine,
  opts: {
    sourceId: string;
    slug: string;
    content: string;
    sourceKind: string;
    sourceUri: string;
    ingestedVia: string;
  },
): Promise<{ skipped: boolean }> {
  const existing = await engine.getPage(opts.slug, { sourceId: opts.sourceId });
  const ctx = makeCollectorContext(engine, opts.sourceId);
  const putOp = getOp('put_page');
  const params: Record<string, unknown> = {
    slug: opts.slug,
    content: opts.content,
    source_id: opts.sourceId,
    source_kind: opts.sourceKind,
    source_uri: opts.sourceUri,
    ingested_via: opts.ingestedVia,
  };
  if (existing?.knowledge_revision) {
    params.expected_revision = existing.knowledge_revision;
  }
  const res = (await putOp.handler(ctx, params)) as Record<string, unknown>;
  const status = String(res?.status ?? '');
  return { skipped: status === 'skipped' || status === 'unchanged' || res?.unchanged === true };
}

export async function collectorAddTimelineEntry(
  engine: BrainEngine,
  opts: {
    sourceId: string;
    slug: string;
    date: string;
    summary: string;
    source: string;
  },
): Promise<boolean> {
  const ctx = makeCollectorContext(engine, opts.sourceId);
  const op = getOp('add_timeline_entry');
  const res = (await op.handler(ctx, {
    slug: opts.slug,
    date: opts.date,
    summary: opts.summary,
    source: opts.source,
    source_id: opts.sourceId,
  })) as Record<string, unknown>;
  if (typeof res?.added === 'boolean') return res.added;
  if (typeof res?.inserted === 'boolean') return res.inserted;
  return res?.skipped !== true;
}

export async function collectorAddLink(
  engine: BrainEngine,
  opts: {
    sourceId: string;
    from: string;
    to: string;
    context: string;
    linkSource: string;
  },
): Promise<void> {
  const ctx = makeCollectorContext(engine, opts.sourceId);
  const op = getOp('add_link');
  await op.handler(ctx, {
    from: opts.from,
    to: opts.to,
    context: opts.context,
    link_source: opts.linkSource,
    source_id: opts.sourceId,
  });
}
