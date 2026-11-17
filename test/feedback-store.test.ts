/**
 * Use-attributed retrieval feedback storage and rating on PGLite: moving-average
 * math, per-element idempotency, receipts, revision handling, authority and
 * the rate_answer refusals.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { insertRetrievalEvents, readWeights } from '../src/core/feedback/store.ts';
import { rateAnswer } from '../src/core/feedback/rate.ts';
import {
  _resetFeedbackRecordingForTests, answerIdTime, canTeachSource, drainFeedbackQueue, droppedFeedbackEvents, isAnswerPending,
  mintAnswerId, QUEUE_CAP, recordAnswer,
} from '../src/core/feedback/record.ts';
import { __listDrainerNamesForTest } from '../src/core/background-work.ts';
import { _resetFeedbackSettingsCacheForTests } from '../src/core/feedback/settings.ts';
import { retrievalFeedbackUpgradeNotice } from '../src/core/feedback/upgrade-notice.ts';

let engine: PGLiteEngine;

function localCtx(): OperationContext {
  return { engine, config: {} as OperationContext['config'], remote: false, logger: console } as unknown as OperationContext;
}

async function hashOf(slug: string, source = 'default'): Promise<string> {
  const rows = await engine.executeRaw<{ content_hash: string }>(
    'SELECT content_hash FROM pages WHERE slug = $1 AND source_id = $2', [slug, source]);
  return rows[0]!.content_hash;
}

async function seedEvent(id: string, slugs: string[], opts: { op?: 'query' | 'think'; cited?: string[]; clientId?: string } = {}) {
  const pages = [];
  for (const [rank, slug] of slugs.entries()) {
    pages.push({ source_id: 'default', slug, content_hash: await hashOf(slug), rank, cited: (opts.cited ?? []).includes(slug) });
  }
  await insertRetrievalEvents(engine, [{
    id, client_id: opts.clientId ?? 'local', op: opts.op ?? 'query', pages,
    links: [{ source_id: 'default', edge_key: 'people/alice-example|works_at|companies/acme-example', to_slug: 'companies/acme-example' }],
  }]);
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  for (const slug of ['people/alice-example', 'companies/acme-example', 'notes/meeting-example']) {
    await engine.putPage(slug, { type: slug.startsWith('people') ? 'person' : 'note', title: slug, compiled_truth: `about ${slug}` });
  }
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM retrieval_weights');
  await engine.executeRaw('DELETE FROM retrieval_events');
  await engine.executeRaw('DELETE FROM config WHERE key LIKE $1', ['feedback.%']);
  await engine.setConfig('feedback.enabled', 'true');
  await engine.setConfig('feedback.implicit', 'true');
  _resetFeedbackSettingsCacheForTests();
  _resetFeedbackRecordingForTests();
});

describe('defaults', () => {
  test('a brain that never set feedback.enabled records nothing and returns no answer id', async () => {
    await engine.executeRaw('DELETE FROM config WHERE key LIKE $1', ['feedback.%']);
    _resetFeedbackSettingsCacheForTests();
    expect(await recordAnswer(localCtx(), { op: 'query', pages: [{ slug: 'people/alice-example' }] })).toBeNull();
    const notice = await retrievalFeedbackUpgradeNotice(engine);
    expect(notice?.join('\n')).toContain('foresights config set feedback.enabled true');
    await engine.setConfig('feedback.enabled', 'false');
    expect(await retrievalFeedbackUpgradeNotice(engine)).toBeNull();
  });
});

describe('answer ids', () => {
  test('mint and decode the timestamp', () => {
    const now = 1_790_000_000_000;
    const id = mintAnswerId(now);
    expect(id).toMatch(/^ans_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(answerIdTime(id)).toBe(now);
    expect(answerIdTime('ans_nope')).toBeNull();
  });
});

describe('rate_answer', () => {
  test('whole-answer rating moves each page and the path edge by the moving average', async () => {
    const id = mintAnswerId(Date.now() - 120_000);
    await seedEvent(id, ['people/alice-example', 'companies/acme-example']);
    const receipt = await rateAnswer(localCtx(), { answer_id: id, rating: 5 });
    expect(receipt.applied.map(a => a.ref).sort()).toEqual([
      'default:companies/acme-example', 'default:people/alice-example',
      'default:people/alice-example|works_at|companies/acme-example',
    ]);
    for (const a of receipt.applied) {
      expect(a.weight_before).toBe(0.5);
      expect(a.weight_after).toBeCloseTo(0.55, 4);
      expect(a.multiplier).toBeCloseTo(1.01, 4);
    }
    const weights = await readWeights(engine, 'page', [{ source_id: 'default', key: 'people/alice-example' }]);
    expect(weights.get('default:people/alice-example')).toBeCloseTo(0.55, 4);
  });

  test('identical retry returns the same receipt and does not compound', async () => {
    const id = mintAnswerId(Date.now() - 120_000);
    await seedEvent(id, ['people/alice-example']);
    const first = await rateAnswer(localCtx(), { answer_id: id, rating: 1 });
    const second = await rateAnswer(localCtx(), { answer_id: id, rating: 1 });
    expect(second.applied).toEqual(first.applied);
    const weights = await readWeights(engine, 'page', [{ source_id: 'default', key: 'people/alice-example' }]);
    expect(weights.get('default:people/alice-example')).toBeCloseTo(0.45, 4);
  });

  test('targeted ratings touch only the named pages and can differ per page', async () => {
    const id = mintAnswerId(Date.now() - 120_000);
    await seedEvent(id, ['people/alice-example', 'companies/acme-example']);
    const receipt = await rateAnswer(localCtx(), {
      answer_id: id,
      pages: [{ ref: 'default:people/alice-example', rating: 1 }, { ref: 'companies/acme-example', rating: 5 }],
    });
    expect(receipt.applied.map(a => [a.ref, a.weight_after])).toEqual(expect.arrayContaining([
      ['default:people/alice-example', 0.45], ['default:companies/acme-example', 0.55],
    ]));
    expect(receipt.applied.some(a => a.kind === 'link')).toBe(false);
    const again = await rateAnswer(localCtx(), { answer_id: id, pages: [{ ref: 'default:people/alice-example', rating: 5 }] });
    expect(again.applied).toEqual([]);
    expect(again.skipped).toEqual([{ kind: 'page', ref: 'default:people/alice-example', reason: 'already_rated', rating: 1 }]);
  });

  test('a think answer rates its cited pages only', async () => {
    const id = mintAnswerId(Date.now() - 120_000);
    await seedEvent(id, ['people/alice-example', 'notes/meeting-example'], { op: 'think', cited: ['notes/meeting-example'] });
    const receipt = await rateAnswer(localCtx(), { answer_id: id, rating: 5 });
    expect(receipt.applied.filter(a => a.kind === 'page').map(a => a.ref)).toEqual(['default:notes/meeting-example']);
  });

  test('a page edited after the answer is skipped as stale_revision', async () => {
    const id = mintAnswerId(Date.now() - 120_000);
    await seedEvent(id, ['notes/meeting-example']);
    await engine.putPage('notes/meeting-example', { type: 'note', title: 'notes/meeting-example', compiled_truth: 'corrected text' });
    const receipt = await rateAnswer(localCtx(), { answer_id: id, rating: 1 });
    expect(receipt.applied).toEqual([]);
    expect(receipt.skipped[0]).toEqual({ kind: 'page', ref: 'default:notes/meeting-example', reason: 'stale_revision' });
  });

  test('an edited page reads at half its learned deviation', async () => {
    const id = mintAnswerId(Date.now() - 120_000);
    await seedEvent(id, ['companies/acme-example']);
    await rateAnswer(localCtx(), { answer_id: id, rating: 5 });
    await engine.putPage('companies/acme-example', { type: 'note', title: 'companies/acme-example', compiled_truth: 'rewritten' });
    const weights = await readWeights(engine, 'page', [{ source_id: 'default', key: 'companies/acme-example' }]);
    expect(weights.get('default:companies/acme-example')).toBeCloseTo(0.525, 4);
  });

  test('refusals carry their codes', async () => {
    const ctx = localCtx();
    const id = mintAnswerId(Date.now() - 120_000);
    await seedEvent(id, ['people/alice-example', 'companies/acme-example']);
    await expect(rateAnswer(ctx, { answer_id: id, rating: 9 })).rejects.toMatchObject({ code: 'invalid_rating' });
    await expect(rateAnswer(ctx, { answer_id: id, pages: [{ ref: 'default:nope', rating: 3 }] })).rejects.toMatchObject({ code: 'ref_not_in_answer' });
    await expect(rateAnswer(ctx, { answer_id: mintAnswerId(Date.now() - 120_000), rating: 3 })).rejects.toMatchObject({ code: 'answer_unavailable' });
    await expect(rateAnswer(ctx, { answer_id: mintAnswerId(), rating: 3 })).rejects.toMatchObject({ code: 'answer_pending' });
    const other = mintAnswerId(Date.now() - 120_000);
    await seedEvent(other, ['people/alice-example'], { clientId: 'client-b' });
    await expect(rateAnswer(ctx, { answer_id: other, rating: 3 })).rejects.toMatchObject({ code: 'answer_not_yours' });
    await engine.setConfig('feedback.enabled', 'false');
    _resetFeedbackSettingsCacheForTests();
    await expect(rateAnswer(ctx, { answer_id: id, rating: 3 })).rejects.toMatchObject({ code: 'feedback_disabled' });
  });
});

describe('authority', () => {
  const base = { remote: true, transport: 'http' as const, sourceId: 'default' };
  test('owner CLI and stdio may teach; grants must be unrestricted write on that source', () => {
    expect(canTeachSource({ remote: false, sourceId: 'default' }, 'default')).toBe(true);
    expect(canTeachSource({ remote: true, transport: 'stdio', sourceId: 'default' }, 'default')).toBe(true);
    expect(canTeachSource({ ...base, auth: { clientId: 'c', scopes: ['read'] } as never }, 'default')).toBe(false);
    expect(canTeachSource({ ...base, auth: { clientId: 'c', scopes: ['write'] } as never }, 'default')).toBe(true);
    expect(canTeachSource({ ...base, auth: { clientId: 'c', scopes: ['write'] } as never }, 'other')).toBe(false);
    expect(canTeachSource({ ...base, auth: { clientId: 'c', scopes: ['write'], boundSlugPrefixes: ['notes/'] } as never }, 'default')).toBe(false);
    expect(canTeachSource({ ...base, auth: { clientId: 'c', scopes: ['write'], allowedOperations: ['query'] } as never }, 'default')).toBe(false);
    expect(canTeachSource({ ...base, viaSubagent: true, auth: { clientId: 'c', scopes: ['write'] } as never }, 'default')).toBe(false);
  });
});

describe('recordAnswer', () => {
  test('records through the queue, applies the citation signal, and returns a rateable id', async () => {
    const meta = await recordAnswer(localCtx(), {
      op: 'think',
      pages: [
        { source_id: 'default', slug: 'notes/meeting-example', content_hash: await hashOf('notes/meeting-example'), cited: true },
        { source_id: 'default', slug: 'people/alice-example', content_hash: await hashOf('people/alice-example') },
      ],
    });
    expect(meta?.feedback.rateable).toBe(true);
    expect(meta?.answer_id).toMatch(/^ans_/);
    expect(meta?.feedback.how_to_rate).toContain('rate_answer');
    await drainFeedbackQueue(5000);
    const weights = await readWeights(engine, 'page', [
      { source_id: 'default', key: 'notes/meeting-example' }, { source_id: 'default', key: 'people/alice-example' },
    ]);
    expect(weights.get('default:notes/meeting-example')).toBeCloseTo(0.5125, 4);
    expect(weights.has('default:people/alice-example')).toBe(false);
  });

  test('readers and disabled brains record nothing', async () => {
    const reader = { ...localCtx(), remote: true, transport: 'http', auth: { clientId: 'r', scopes: ['read'] } } as unknown as OperationContext;
    const meta = await recordAnswer(reader, { op: 'query', pages: [{ source_id: 'default', slug: 'people/alice-example' }] });
    expect(meta).toEqual({ feedback: { rateable: false, reason: 'not_authorized' } });
    expect(await recordAnswer(localCtx(), { op: 'query', pages: [] })).toEqual({ feedback: { rateable: false, reason: 'empty' } });
    await engine.setConfig('feedback.enabled', 'false');
    _resetFeedbackSettingsCacheForTests();
    expect(await recordAnswer(localCtx(), { op: 'query', pages: [{ slug: 'people/alice-example' }] })).toBeNull();
    await drainFeedbackQueue(5000);
    const rows = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM retrieval_events');
    expect(rows[0]!.n).toBe(0);
  });
});

describe('write-behind queue', () => {
  async function withBlockedWrites(run: (release: () => void) => Promise<void>): Promise<void> {
    const original = engine.executeRaw.bind(engine);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    (engine as unknown as { executeRaw: typeof original }).executeRaw = (async (sql: string, params?: unknown[]) => {
      if (sql.includes('INSERT INTO retrieval_events')) await gate;
      return original(sql, params);
    }) as typeof original;
    try {
      await run(release);
    } finally {
      release();
      (engine as unknown as { executeRaw: typeof original }).executeRaw = original;
    }
  }

  test('a rating that races its answer gets answer_pending, then succeeds once the write lands', async () => {
    await withBlockedWrites(async (release) => {
      const meta = await recordAnswer(localCtx(), { op: 'query', pages: [{ source_id: 'default', slug: 'people/alice-example', content_hash: await hashOf('people/alice-example') }] });
      const id = meta!.answer_id!;
      expect(isAnswerPending(id)).toBe(true);
      await expect(rateAnswer(localCtx(), { answer_id: id, rating: 5 })).rejects.toMatchObject({ code: 'answer_pending' });
      expect(await drainFeedbackQueue(50)).toEqual({ unfinished: 1 });
      release();
      expect(await drainFeedbackQueue(5000)).toEqual({ unfinished: 0 });
      expect(isAnswerPending(id)).toBe(false);
      const receipt = await rateAnswer(localCtx(), { answer_id: id, rating: 5 });
      expect(receipt).toBeTruthy();
    });
  });

  test('overflow drops the oldest answers, counts them, and never blocks the caller', async () => {
    await withBlockedWrites(async (release) => {
      const ids: string[] = [];
      for (let i = 0; i < QUEUE_CAP + 5; i++) {
        const meta = await recordAnswer(localCtx(), { op: 'query', pages: [{ source_id: 'default', slug: 'notes/meeting-example' }] });
        ids.push(meta!.answer_id!);
      }
      expect(droppedFeedbackEvents()).toBe(4);
      expect(isAnswerPending(ids[1]!)).toBe(false);
      expect(isAnswerPending(ids.at(-1)!)).toBe(true);
      expect((await drainFeedbackQueue(50)).unfinished).toBe(QUEUE_CAP + 1);
      release();
      expect(await drainFeedbackQueue(10_000)).toEqual({ unfinished: 0 });
    });
    const rows = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM retrieval_events');
    expect(rows[0]!.n).toBe(QUEUE_CAP + 1);
  });

  test('the queue drains on CLI exit and before disconnect', () => {
    expect(__listDrainerNamesForTest()).toContain('retrieval-feedback');
  });
});
