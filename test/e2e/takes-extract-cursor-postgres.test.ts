/**
 * #5059 on Postgres: `takes extract --from-pages` continues with the
 * `(updated_at, id)` keyset cursor its previous run returned.
 *
 * Protects: postgres.js binds the exact timestamptz text and the page id, so
 * equal timestamps break on id and a page one microsecond older is neither
 * skipped nor repeated. Fails when: the cursor is truncated to a JS Date
 * (millisecond precision; postgres.js does that to a ::timestamptz-typed
 * parameter) or the ORDER BY lacks the id tie-break. Why new:
 * the unit tests run on PGLite, which binds parameters differently.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { getEngine, hasDatabase, setupDB, teardownDB } from './helpers.ts';
import { configureGateway, resetGateway, __setChatTransportForTests } from '../../src/core/ai/gateway.ts';
import { extractTakesFromPages } from '../../src/core/extract-takes-from-pages.ts';

const RUN = hasDatabase();
const d = RUN ? describe : describe.skip;

beforeAll(async () => {
  if (!RUN) return;
  await setupDB();
  configureGateway({ chat_model: 'anthropic:claude-haiku-4-5-20251001', env: { ANTHROPIC_API_KEY: 'sk-ant-test-cursor' } });
  __setChatTransportForTests(async () => ({
    text: '[]', blocks: [{ type: 'text' as const, text: '[]' }], stopReason: 'end' as const,
    usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'anthropic:claude-haiku-4-5-20251001', providerId: 'anthropic',
  }));
});

afterAll(async () => {
  if (!RUN) return;
  __setChatTransportForTests(null);
  resetGateway();
  await teardownDB();
});

d('takes extract keyset cursor on Postgres (#5059)', () => {
  test('ties break on id and microseconds survive the round trip', async () => {
    const engine = getEngine();
    const body = 'A narrative body long enough to clear the 200-char eligibility floor for this probe. '.repeat(4);
    const at: Record<string, string> = {
      'concepts/cursor-tie-a': '2030-01-02T03:04:05.123457Z',
      'concepts/cursor-tie-b': '2030-01-02T03:04:05.123457Z',
      'concepts/cursor-micro-older': '2030-01-02T03:04:05.123456Z',
    };
    for (const slug of Object.keys(at)) {
      await engine.putPage(slug, { type: 'concept', title: slug, compiled_truth: body, frontmatter: {} });
      await engine.executeRaw(`UPDATE pages SET updated_at = $2::text::timestamptz WHERE slug = $1`, [slug, at[slug]]);
    }
    const ids = await engine.executeRaw<{ slug: string; id: number }>(
      `SELECT slug, id FROM pages WHERE slug = ANY($1::text[]) ORDER BY updated_at DESC, id DESC`, [Object.keys(at)]);
    const visited: string[] = [];
    let before: { updatedAt: string; id: number } | undefined;
    for (let run = 0; run < 4; run++) {
      const r = await extractTakesFromPages(engine, { bootstrapEnabled: true, dryRun: true, maxPages: 1, ...(before ? { before } : {}) });
      if (r.next_before === null) {
        expect(r.pages_scanned).toBe(0);
        break;
      }
      const separator = r.next_before.lastIndexOf(',');
      before = { updatedAt: r.next_before.slice(0, separator), id: Number(r.next_before.slice(separator + 1)) };
      visited.push(ids.find((row) => Number(row.id) === before!.id)!.slug);
      if (run === 0) expect(before.updatedAt).toContain('.123457');
    }
    expect(visited).toEqual(ids.map((row) => row.slug));
  });
});
