/**
 * Slack → initiative fact routing.
 *
 * A Slack source writes one page per channel per day (`slack/<channel>/<day>`)
 * and the facts backstop extracts facts from it inside the Slack source, where
 * no initiative page lives (fact resolution is per source). This step re-homes
 * those facts: every live fact extracted from a day page of a channel an
 * initiative reads is remembered on the initiative page (in the initiatives
 * source) with the Slack channel and day as provenance.
 *
 * Runs after each sync of a Slack source and once more when an initiative is
 * finished. A per-source watermark (highest routed fact id, config
 * `initiatives.route_watermark.<source>`) keeps each run incremental; the
 * deterministic request id makes a re-run replay instead of writing twice.
 */
import type { BrainEngine } from '../engine.ts';
import { loadOperation } from '../operation-load.ts';
import type { InitiativesConfig } from './model.ts';
import { initiativeChannels, localContext, requestIdFor } from './store.ts';

const BATCH = 20;
const MAX_PER_RUN = 2000;
const REMEMBER_KINDS = ['event', 'preference', 'commitment', 'belief', 'fact'];

export const routeWatermarkKey = (slackSourceId: string) => `initiatives.route_watermark.${slackSourceId}`;

interface FactRow { id: number | string; fact: string; kind: string; valid_from: string | Date; source_session: string | null; visibility: string }

export interface RouteResult { scanned: number; routed: number; skipped: number; watermark: number; errors: string[] }

/** `connector:<source>:slack/<CHANNEL>/<YYYY-MM-DD>.md` → channel + day. */
export function slackOriginOf(session: string | null, slackSourceId: string): { channel: string; day: string } | null {
  if (!session) return null;
  const prefix = `connector:${slackSourceId}:`;
  if (!session.startsWith(prefix)) return null;
  const m = /^slack\/([A-Z0-9]+)\/(\d{4}-\d{2}-\d{2})(?:\.md)?$/.exec(session.slice(prefix.length));
  return m ? { channel: m[1], day: m[2] } : null;
}

export async function routeInitiativeFacts(engine: BrainEngine, cfg: InitiativesConfig, slackSourceId: string,
  opts: { channelNames?: Record<string, string>; onlyChannels?: string[] } = {}): Promise<RouteResult> {
  const result: RouteResult = { scanned: 0, routed: 0, skipped: 0, watermark: 0, errors: [] };
  const bound = await initiativeChannels(engine, cfg);
  const byChannel = new Map(bound.filter(b => !opts.onlyChannels || opts.onlyChannels.includes(b.channel)).map(b => [b.channel, b.initiative]));
  const key = routeWatermarkKey(slackSourceId);
  const start = Number(await engine.getConfig(key)) || 0;
  result.watermark = start;
  if (byChannel.size === 0) return result;
  const rows = await engine.executeRaw<FactRow>(
    `SELECT f.id, f.fact, f.kind, f.valid_from, f.source_session, f.visibility FROM facts f
      WHERE f.source_id = $1 AND f.id > $2 AND f.expired_at IS NULL AND f.source_session LIKE $3
      ORDER BY f.id LIMIT $4`,
    [slackSourceId, start, `connector:${slackSourceId}:slack/%`, MAX_PER_RUN],
  );
  const remember = await loadOperation('remember');
  if (!remember) throw new Error('remember operation unavailable');
  const ctx = localContext(engine, cfg.sourceId);
  // Group consecutive facts per initiative into remember batches.
  const pending = new Map<string, Array<{ row: FactRow; channel: string; day: string }>>();
  for (const row of rows) {
    result.scanned++;
    const origin = slackOriginOf(row.source_session, slackSourceId);
    const initiative = origin ? byChannel.get(origin.channel) : undefined;
    if (!origin || !initiative) { result.skipped++; continue; }
    const list = pending.get(initiative.slug) ?? [];
    list.push({ row, channel: origin.channel, day: origin.day });
    pending.set(initiative.slug, list);
  }
  let failedAt: number | null = null;
  for (const [slug, list] of pending) {
    for (let i = 0; i < list.length; i += BATCH) {
      const chunk = list.slice(i, i + BATCH);
      const items = chunk.map(({ row, channel, day }) => ({
        fact: row.fact,
        entity: slug,
        provenance: `Slack #${opts.channelNames?.[channel] ?? channel} ${day} (fact ${row.id} in source ${slackSourceId})`,
        kind: REMEMBER_KINDS.includes(row.kind) ? row.kind : 'fact',
        visibility: row.visibility === 'private' ? 'private' : 'world',
      }));
      try {
        await remember.handler({ ...ctx }, {
          items, source_id: cfg.sourceId, infer_entity: false, content_origin: 'tool_output',
          request_id: requestIdFor('route-facts', slackSourceId, slug, ...chunk.map(c => String(c.row.id))),
        });
        result.routed += chunk.length;
      } catch (err) {
        result.errors.push(`${slug}: ${(err as Error)?.message ?? String(err)}`);
        const first = Math.min(...chunk.map(c => Number(c.row.id)));
        failedAt = failedAt == null ? first : Math.min(failedAt, first);
      }
    }
  }
  // Advance only past what was routed: a failed batch is retried next run.
  const last = rows.length ? Number(rows[rows.length - 1].id) : start;
  const watermark = failedAt != null ? Math.max(start, failedAt - 1) : last;
  if (watermark > start) await engine.setConfig(key, String(watermark));
  result.watermark = watermark;
  return result;
}
