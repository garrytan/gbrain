/**
 * Paid page derivations under a model with no price (PR 4 lane 4b round 5, item 10), shared by the PGLite arm
 * (test/large-pages/conversation-facts-incremental-core.test.ts) and the Postgres arm
 * (test/e2e/conversation-facts-incremental-core-postgres.test.ts). No default changes and no price is invented: an unpriced
 * model reserves its ceiling estimate, so the per-page cap stops it after about one window. Fake extractors only.
 *
 * 1. Protects: when the facts, conversation facts or synopsis step stops (or books its reservation) because the
 *    model has no price, its derivation receipt says reason `unpriced_model` with the model id, and doctor
 *    derivation_unpriced_model warns with a fix naming pricing.overrides (gbrain pricing set <model> ...); once the price
 *    is registered the warning clears.
 * 2. Fails when: an unpriced stop reads as a plain cap stop (cap_reached) with no model, or doctor stays silent.
 */
import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { AppendBrain } from './append-brain.ts';
import { PAGE_EMBED_CAP_KEY } from '../../src/core/page-embedding-budget.ts';
import { PAGE_DERIVATION_CAP_KEY } from '../../src/core/page-spend.ts';
import { derivationUnpricedModelEntry } from '../../src/commands/doctor/checks/derivation-pricing.ts';
import { reembedPageWithContextualRetrieval } from '../../src/core/contextual-retrieval-service.ts';
import { __setChatTransportForTests, chat as gatewayChat, type ChatOpts, type ChatResult } from '../../src/core/ai/gateway.ts';
import { runExtractConversationFactsCore } from '../../src/commands/extract-conversation-facts.ts';
import type { DoctorContext } from '../../src/commands/doctor/context.ts';
import type { Check } from '../../src/commands/doctor.ts';
import { chatDays, chatPage, derivations, SOURCE } from './conversation-facts-incremental-cases.ts';

/** A model id gbrain ships no price for. */
export const UNPRICED = 'anthropic:claude-unpriced-example';

const doctor = async (engine: BrainEngine) => (await derivationUnpricedModelEntry.run({ engine } as unknown as DoctorContext) as Check[])
  .find(c => c.name === 'derivation_unpriced_model')!;
const receiptsOf = async (engine: BrainEngine, slug: string, kind: 'synopsis') => {
  const [page] = await engine.executeRaw<{ id: number }>("SELECT id FROM pages WHERE source_id='default' AND slug=$1", [slug]);
  return (await engine.readSegmentDerivations(Number(page!.id), { kind })).map(r => r.receipt as Record<string, unknown> | null).filter(Boolean);
};

export function defineDerivationUnpricedCases(opts: { getBrain: () => AppendBrain }): void {
  test('conversation facts under an unpriced model: the cap stop says unpriced_model with the model, doctor names pricing.overrides, a registered price clears it', async () => {
    const brain = opts.getBrain();
    const slug = `notes/unpriced-facts-${randomUUID().slice(0, 8)}`;
    await brain.engine.setConfig(PAGE_EMBED_CAP_KEY, 'off');
    await brain.engine.setConfig(PAGE_DERIVATION_CAP_KEY, '2');
    await brain.engine.setConfig('facts.extraction_model', UNPRICED);
    try {
      await brain.seed(slug, chatPage('Unpriced facts', chatDays(4400, 100, 41)));
      // Each window's call is answered by the unpriced model, so it books its whole reservation (the ceiling estimate).
      __setChatTransportForTests(async (o: ChatOpts): Promise<ChatResult> => ({ text: '{"facts":[]}', blocks: [], stopReason: 'end', model: UNPRICED, providerId: 'anthropic',
        usage: { input_tokens: Math.ceil(JSON.stringify(o.messages).length / 4), output_tokens: 32, cache_read_tokens: 0, cache_creation_tokens: 0 } }));
      const calls: string[] = [];
      await runExtractConversationFactsCore(brain.engine, { sourceId: 'default', slugs: [slug], sleepMs: 0, extractor: async input => {
        calls.push(input.turnText);
        await gatewayChat({ model: UNPRICED, messages: [{ role: 'user', content: input.turnText }], maxTokens: 64 });
        return [{ fact: 'Alice Example noted the window', kind: 'fact', entity_slug: null, source: SOURCE }];
      } }).finally(() => __setChatTransportForTests(null));
      const unread = (await derivations(brain.engine, slug)).receipts.filter(Boolean) as Array<Record<string, unknown>>;
      expect({ calls: calls.length, receipts: unread.map(r => ({ kind: r.kind, reason: r.reason, model: r.model })) })
        .toEqual({ calls: 1, receipts: [{ kind: 'unread_windows', reason: 'unpriced_model', model: UNPRICED }] });
      const check = await doctor(brain.engine);
      const models = (check.details as { models: Array<{ model: string; pipelines: string[] }> }).models;
      expect({ status: check.status, models: models.map(m => [m.model, m.pipelines]), fix: check.fix?.argv?.slice(0, 4), names: check.message.includes('pricing.overrides') })
        .toEqual({ status: 'warn', models: [[UNPRICED, ['conversation_facts']]], fix: ['gbrain', 'pricing', 'set', UNPRICED], names: true });
      await brain.engine.setConfig('pricing.overrides', JSON.stringify({ [UNPRICED]: { input: 0.5, output: 0.5 } }));
      expect((await doctor(brain.engine)).status).toBe('ok');
    } finally {
      await brain.engine.setConfig('facts.extraction_model', '');
      await brain.engine.setConfig('pricing.overrides', '');
      await brain.engine.setConfig(PAGE_DERIVATION_CAP_KEY, 'off');
    }
  }, 600_000);

  test('synopsis under an unpriced model: the refused reservation says unpriced_model with the model', async () => {
    const brain = opts.getBrain();
    const slug = `notes/unpriced-synopsis-${randomUUID().slice(0, 8)}`;
    await brain.engine.setConfig(PAGE_EMBED_CAP_KEY, '1000');
    await brain.engine.setConfig(PAGE_DERIVATION_CAP_KEY, '0.000001');
    try {
      await brain.seed(slug, chatPage('Unpriced synopsis', chatDays(4600, 100, 43)));
      let calls = 0;
      const out = await reembedPageWithContextualRetrieval({ engine: brain.engine, pageSlug: slug, sourceId: 'default', globalMode: 'per_chunk_synopsis', synopsisModel: UNPRICED,
        generateSynopsis: async () => { calls++; return { kind: 'success', synopsis: 'fixture synopsis' }; }, chunkConcurrency: 2 });
      const receipts = await receiptsOf(brain.engine, slug, 'synopsis');
      expect({ out, calls, receipts: receipts.map(r => ({ reason: r!.reason, model: r!.model })) })
        .toEqual({ out: { kind: 'skipped', reason: 'budget_limited' }, calls: 0, receipts: [{ reason: 'unpriced_model', model: UNPRICED }] });
    } finally {
      await brain.engine.setConfig(PAGE_DERIVATION_CAP_KEY, 'off');
      await brain.engine.setConfig(PAGE_EMBED_CAP_KEY, 'off');
    }
  }, 600_000);
}
