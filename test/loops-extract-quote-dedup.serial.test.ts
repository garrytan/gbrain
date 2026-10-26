/**
 * #7289: the extractor's loop dedup key follows the verbatim quote, not the
 * model's paraphrase. Several items for one sentence, and re-extractions that
 * word it differently, land on one loop; distinct quotes stay distinct.
 *
 * Serial (R2): mock.module leaks across files in a shard process.
 * Synthetic data only.
 */

import { describe, test, expect, beforeAll, afterAll, mock } from 'bun:test';

let chatImpl: () => Promise<{ text: string; stopReason: string }> = async () => ({
  text: '{"commitments":[],"decisions_pending":[]}',
  stopReason: 'end',
});

mock.module('../src/core/ai/gateway.ts', () => ({
  isAvailable: (touchpoint: string) => touchpoint === 'chat',
  chat: async () => await chatImpl(),
  embedOne: async () => { throw new Error('embedOne must not be called'); },
  embed: async () => { throw new Error('embed must not be called'); },
}));

const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');
const { runLoopsExtract } = await import('../src/core/google/loops-extract.ts');

const SRC = 'src-google';
const SLUG = 'emails/2026/08/2026-08-20-dedup-thread-0a1b2c3d';
const THREAD = 'thread-0a1b2c3d';
const QUOTE = 'I will send you the deck by Friday.';
const OTHER_QUOTE = 'I will also share the budget next week.';

let engine: InstanceType<typeof PGLiteEngine>;

function commitment(text: string, quote: string) {
  return { direction: 'owed_by_me', text, counterparty_name: 'Sender A', counterparty_email: 'sender-a@example.com', due_iso: '2026-08-29', quote };
}

async function loops(): Promise<Array<{ id: number; dedup_key: string; summary: string }>> {
  return (await engine.executeRaw<{ id: number; dedup_key: string; summary: string }>(
    `SELECT id, dedup_key, summary FROM open_loops WHERE source_id = $1 AND thread_id = $2 ORDER BY id`, [SRC, THREAD])).map((r) => ({ ...r, id: Number(r.id) }));
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
  await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`, [SRC, 'src-google']);
  await engine.putPage(SLUG, {
    type: 'email',
    title: 'Re: deck',
    compiled_truth: `From: sender-a@example.com\n\nMe: ${QUOTE}\nMe: ${OTHER_QUOTE}\n`,
    frontmatter: { thread_id: THREAD, date: '2026-08-20T10:00:00Z' },
    effective_date: new Date('2026-08-20T10:00:00Z'),
  }, { sourceId: SRC });
}, 120_000);

afterAll(async () => {
  await engine.disconnect();
});

describe('extractor dedup follows the quote', () => {
  test('paraphrases of one sentence, within and across passes, are one loop', async () => {
    chatImpl = async () => ({
      text: JSON.stringify({
        commitments: [
          commitment('Send the deck by Friday', QUOTE),
          commitment('Send deck Friday', QUOTE),
          commitment('Share the deck by end of week', QUOTE.replace(' will ', '   will ')),
        ],
        decisions_pending: [],
      }),
      stopReason: 'end',
    });
    const first = await runLoopsExtract(engine, { slug: SLUG, sourceId: SRC });
    expect(first.status).toBe('extracted');
    expect(await loops()).toHaveLength(1);

    chatImpl = async () => ({
      text: JSON.stringify({ commitments: [commitment('Deliver the slide deck on Friday', QUOTE)], decisions_pending: [] }),
      stopReason: 'end',
    });
    await runLoopsExtract(engine, { slug: SLUG, sourceId: SRC });
    expect(await loops()).toHaveLength(1);
  });

  test('distinct quotes stay distinct loops', async () => {
    chatImpl = async () => ({
      text: JSON.stringify({
        commitments: [commitment('Send the deck by Friday', QUOTE), commitment('Share the budget', OTHER_QUOTE)],
        decisions_pending: [],
      }),
      stopReason: 'end',
    });
    await runLoopsExtract(engine, { slug: SLUG, sourceId: SRC });
    expect(await loops()).toHaveLength(2);
  });

  test('a loop written under the old text key is reused, not twinned', async () => {
    await engine.executeRaw(`DELETE FROM open_loops WHERE source_id = $1`, [SRC]);
    await engine.executeRaw(
      `INSERT INTO open_loops (source_id, dedup_key, loop_type, summary, evidence, thread_id, detector)
       VALUES ($1, 'commit:legacytextkey', 'commitment_owed_by_me', 'Send the deck by Friday', $2::text::jsonb, $3, 'llm_extract')`,
      [SRC, JSON.stringify([{ page_slug: SLUG, quote: QUOTE }]), THREAD]);
    chatImpl = async () => ({
      text: JSON.stringify({ commitments: [commitment('Get the deck over on Friday', QUOTE)], decisions_pending: [] }),
      stopReason: 'end',
    });
    await runLoopsExtract(engine, { slug: SLUG, sourceId: SRC });
    const rows = await loops();
    expect(rows).toHaveLength(1);
    expect(rows[0].dedup_key).toBe('commit:legacytextkey');
  });

  test('items with no verified quote still dedupe by text only', async () => {
    await engine.executeRaw(`DELETE FROM open_loops WHERE source_id = $1`, [SRC]);
    chatImpl = async () => ({
      text: JSON.stringify({
        commitments: [commitment('Call back on Monday', 'a quote the thread never contained'), commitment('Call back on Monday', 'another invented quote')],
        decisions_pending: [],
      }),
      stopReason: 'end',
    });
    await runLoopsExtract(engine, { slug: SLUG, sourceId: SRC });
    expect(await loops()).toHaveLength(1);
  });
});
