/**
 * B-14: the takes bootstrap from pages
 *   - never appends a claim the page's takes fence already holds (a rerun with
 *     includeCovered, or a page with a hand-added take, used to duplicate
 *     gradeable takes and skew calibration),
 *   - stops at a USD budget (`takes.bootstrap_budget_usd`, or the budgetUsd
 *     option), and
 *   - reports a failed chat call as a skipped page with its reason instead of
 *     looking like "nothing to extract".
 *
 * Hermetic PGLite + tempdir repo + gateway chat seam.
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { configureGateway, resetGateway, __setChatTransportForTests } from '../src/core/ai/gateway.ts';
import { extractTakesFromPages } from '../src/core/extract-takes-from-pages.ts';
import { parseTakesFence } from '../src/core/takes-fence.ts';

let engine: PGLiteEngine;
let repo: string;
let chatCalls = 0;
let reply: () => string = () => '[]';

const body = 'An opinion-bearing body long enough to clear the 200-char eligibility floor. '.repeat(5);

async function seed(slug: string): Promise<void> {
  await engine.putPage(slug, { type: 'concept', title: slug, compiled_truth: body, frontmatter: {} });
  writeFileSync(join(repo, `${slug}.md`), `# ${slug}\n\n${body}\n`, 'utf-8');
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  repo = mkdtempSync(join(tmpdir(), 'gb-takes-bootstrap-safety-'));
  mkdirSync(join(repo, 'concepts'), { recursive: true });
  await engine.setConfig('sync.repo_path', repo);
  configureGateway({ chat_model: 'anthropic:claude-haiku-4-5-20251001', env: { ANTHROPIC_API_KEY: 'sk-ant-test' } });
  __setChatTransportForTests(async () => {
    chatCalls++;
    const text = reply();
    return {
      text, blocks: [{ type: 'text' as const, text }], stopReason: 'end' as const,
      usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'anthropic:claude-haiku-4-5-20251001', providerId: 'anthropic',
    };
  });
});

afterAll(async () => {
  __setChatTransportForTests(null);
  resetGateway();
  await engine.disconnect();
  rmSync(repo, { recursive: true, force: true });
});

beforeEach(async () => {
  chatCalls = 0;
  await engine.executeRaw('DELETE FROM takes');
  await engine.executeRaw('DELETE FROM pages');
});

describe('takes bootstrap safety (B-14)', () => {
  test('a rerun never appends a claim the fence already holds', async () => {
    await seed('concepts/dedupe-example');
    reply = () => '[{"claim":"Remote work beats offices","kind":"take","weight":0.7}]';
    const first = await extractTakesFromPages(engine, { bootstrapEnabled: true });
    expect(first.claims_extracted).toBe(1);

    reply = () => '[{"claim":"remote work beats offices.","kind":"take","weight":0.6},{"claim":"Offices will empty by 2030","kind":"bet","weight":0.4}]';
    const second = await extractTakesFromPages(engine, { bootstrapEnabled: true, includeCovered: true });
    expect(second.claims_extracted).toBe(1);
    const fence = parseTakesFence(readFileSync(join(repo, 'concepts/dedupe-example.md'), 'utf-8')).takes;
    expect(fence.map(t => t.claim)).toEqual(['Remote work beats offices', 'Offices will empty by 2030']);
  });

  test('a failed chat call is a skipped page with its reason', async () => {
    await seed('concepts/outage-example');
    __setChatTransportForTests(async () => { throw Object.assign(new Error('invalid x-api-key'), { status: 401 }); });
    try {
      const result = await extractTakesFromPages(engine, { bootstrapEnabled: true });
      expect(result.claims_extracted).toBe(0);
      expect(result.pages_skipped).toBe(1);
      expect(result.skipped[0].slug).toBe('concepts/outage-example');
      expect(result.skipped[0].reason).toStartWith('llm_error:');
    } finally {
      __setChatTransportForTests(async () => {
        chatCalls++;
        const text = reply();
        return {
          text, blocks: [{ type: 'text' as const, text }], stopReason: 'end' as const,
          usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
          model: 'anthropic:claude-haiku-4-5-20251001', providerId: 'anthropic',
        };
      });
    }
  });

  test('a run stops at its USD budget before calling the model', async () => {
    await seed('concepts/budget-a');
    await seed('concepts/budget-b');
    reply = () => '[{"claim":"A claim","kind":"take","weight":0.5}]';
    const result = await extractTakesFromPages(engine, { bootstrapEnabled: true, budgetUsd: 0.0000001 });
    expect(chatCalls).toBe(0);
    expect(result.budget_exhausted).toBe(true);
    expect(result.claims_extracted).toBe(0);
    expect(result.next_before).toBeNull();
  });

  test('a budget-limited cursor resumes before the unclassified tail', async () => {
    await seed('concepts/budget-tail');
    await seed('concepts/budget-head');
    await engine.executeRaw(`UPDATE pages SET updated_at = '2030-01-02T03:04:05.123456Z'::timestamptz`);
    const [head] = await engine.executeRaw<{ id: number }>(
      'SELECT id FROM pages WHERE slug = $1', ['concepts/budget-head'],
    );
    reply = () => '[]';
    const first = await extractTakesFromPages(engine, { bootstrapEnabled: true, budgetUsd: 0.015 });
    expect(chatCalls).toBe(1);
    expect(first.budget_exhausted).toBe(true);
    expect(first.next_before).toEndWith(`,${head.id}`);
    const separator = first.next_before!.lastIndexOf(',');

    reply = () => '[{"claim":"The older page still gets classified","kind":"take","weight":0.5}]';
    const second = await extractTakesFromPages(engine, {
      bootstrapEnabled: true,
      before: {
        updatedAt: first.next_before!.slice(0, separator),
        id: Number(first.next_before!.slice(separator + 1)),
      },
    });
    expect(second.pages_scanned).toBe(1);
    expect(second.claims_extracted).toBe(1);
    expect(chatCalls).toBe(2);
  });

  test('the budget reads takes.bootstrap_budget_usd', async () => {
    await seed('concepts/budget-config');
    await engine.setConfig('takes.bootstrap_budget_usd', '0.0000001');
    try {
      const result = await extractTakesFromPages(engine, { bootstrapEnabled: true });
      expect(chatCalls).toBe(0);
      expect(result.budget_exhausted).toBe(true);
    } finally {
      await engine.unsetConfig('takes.bootstrap_budget_usd');
    }
  });
});
