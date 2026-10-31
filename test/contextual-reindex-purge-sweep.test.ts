/**
 * Wave B PR 4 (lane 4a, G4): a per-chunk synopsis re-embed that a fact purge's pending derivation sweep blocked
 * (the page's paid synopsis was refused with purge_sweep_pending) is not reported `ok`, and its `next` points at the
 * sweep (doctor derivation_purge_sweeps and the continue command) instead of a spend cap. A spend cap's skip stays ok.
 */
import { describe, expect, test } from 'bun:test';
import { makeContextualReindexHandler } from '../src/core/minions/handlers/contextual-reindex-per-chunk.ts';
import type { ReembedPageResult } from '../src/core/contextual-retrieval-service.ts';

const engine = { async getPage() { return { source_id: 'default' }; }, async getConfig() { return null; } };
const job = { id: 7, data: { page_slug: 'notes/example' }, signal: new AbortController().signal } as never;
const handlerFor = (result: ReembedPageResult) => makeContextualReindexHandler({ engine: engine as never, reembedPage: async () => result });

describe('contextual_reindex_per_chunk: a synopsis blocked by a pending purge sweep', () => {
  test('is not ok, and next names the sweep check and the continue command', async () => {
    const out = await handlerFor({ kind: 'skipped', reason: 'purge_sweep_pending' })(job) as Record<string, any>;
    expect({ ok: out.ok, skip: out.skip_reason, check: String(out.next).includes('gbrain doctor --only derivation_purge_sweeps'),
      command: String(out.next).includes('gbrain forget --purge --status --request-id <request_id> --continue'), cap: String(out.next).includes('max_usd_per_page') })
      .toEqual({ ok: false, skip: 'purge_sweep_pending', check: true, command: true, cap: false });
  });

  test('a spend cap\'s skip stays ok', async () => {
    expect(await handlerFor({ kind: 'skipped', reason: 'budget_limited' })(job)).toEqual({ ok: true, mode_applied: 'skipped', chunks_embedded: 0, skip_reason: 'budget_limited' });
  });
});
