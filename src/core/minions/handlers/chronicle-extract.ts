/**
 * `chronicle_extract` Minion job handler (built-in; registered by registerBuiltinHandlers in src/commands/jobs.ts).
 */
import type { BrainEngine } from '../../engine.ts';
import type { MinionHandler } from '../types.ts';

/**
 * v0.42.x (#2390) — Life Chronicle event extraction. NOT protected (bounded
 * LLM spend per page; no shell). Enqueued by the put_page chronicle backstop
 * and by `gbrain chronicle backfill`. Idempotent (content-addressed event
 * slugs + projection upsert), so a retry re-runs to the same state.
 * #3387: registered via registerBuiltinJob (gateway-refresh wrap) — the
 * judge is a gateway chat call, so a stale worker gateway meant silent
 * no_events for every extraction.
 */
export function makeChronicleExtractHandler(engine: BrainEngine): MinionHandler {
  return async (job) => {
    const slug = typeof job.data.slug === 'string' ? job.data.slug : undefined;
    if (!slug) throw new Error('chronicle_extract job requires data.slug');
    const sourceId = typeof job.data.sourceId === 'string' ? job.data.sourceId : undefined;
    const { runChronicleExtract } = await import('../../chronicle/extract-events.ts');
    const { chronicleTz } = await import('../../chronicle/config.ts');
    const tz = await chronicleTz(engine);
    return await runChronicleExtract(engine, {
      slug,
      sourceId,
      tz,
      signal: (job as { signal?: AbortSignal }).signal,
    });
  };
}
