/**
 * #6779: once a pattern page exists, the next patterns child rewrote the same slug with `put_page` and no
 * `expected_revision`, the write was refused `revision_required`, and the phase died `PATTERNS_CHILD_DEAD`.
 *
 * Protects: the child is told to read an existing page and send its revision (or append to / skip a page whose
 * read came back budget-summarized); a refused subagent write names the page's current revision so the child can
 * resend without guessing; a budget-summarized read keeps the revision.
 * Fails when: the OUTPUT POLICY drops the expected_revision instruction, the subagent refusal omits the current
 * revision, or the read-budget summary drops it.
 * Seams: `__testing.buildPatternsPrompt`, `buildBrainTools` (the subagent tool path) on a PGLite brain.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import { buildBrainTools } from '../src/core/minions/tools/brain-allowlist.ts';
import { __testing } from '../src/core/cycle/patterns.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

const SLUG = 'wiki/personal/patterns/fundraising-sprints';
const page = (body: string) => `---\ntitle: Fundraising sprints\ntype: note\n---\n${body}\n`;

let engine: PGLiteEngine;
let schemaVersion: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
  schemaVersion = (await engine.getConfig('version')) ?? '7';
}, 60_000);

afterAll(async () => { await engine.disconnect(); });

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('version', schemaVersion);
});

function childTools(readBudgetBytes?: number) {
  return buildBrainTools({ subagentId: 7, engine, config: { engine: 'pglite' } as GBrainConfig,
    allowedSlugPrefixes: ['wiki/personal/patterns/*'], sourceId: 'default', ...(readBudgetBytes ? { readBudgetBytes } : {}) });
}
const ctx = () => ({ engine, jobId: 7, remote: true as const });

describe('#6779 patterns OUTPUT POLICY', () => {
  test('tells the child to send an existing page revision as expected_revision, or append to or skip it', () => {
    const prompt = __testing.buildPatternsPrompt([], 3, 'wiki/personal/reflections', 'wiki/personal/patterns', '2026-10-16');
    expect(prompt).toContain('get_page');
    expect(prompt).toContain('expected_revision');
    expect(prompt).toContain('read_budget_exhausted');
    expect(prompt).toContain('add_timeline_entry');
    expect(prompt).toMatch(/skip/i);
  });
});

describe('#6779 subagent put_page on an existing page', () => {
  test('a write without expected_revision is refused naming the current revision; resending with it lands', async () => {
    const tools = childTools();
    const put = tools.find(t => t.name === 'brain_put_page')!;
    const created = await put.execute({ slug: SLUG, content: page('First sprint.') }, ctx()) as { revision: string };
    expect(created.revision).toMatch(/^[0-9a-f-]{36}$/);

    let refusal: (Error & { code?: string }) | undefined;
    try { await put.execute({ slug: SLUG, content: page('First sprint. Second sprint.') }, ctx()); } catch (e) { refusal = e as Error & { code?: string }; }
    expect(refusal?.code).toBe('revision_required');
    expect(refusal?.message).toContain('The page already exists; an expected revision is required.');
    expect(refusal?.message).toContain(created.revision);
    expect(refusal?.message).toContain('expected_revision');

    const updated = await put.execute({ slug: SLUG, content: page('First sprint. Second sprint.'), expected_revision: created.revision }, ctx()) as { revision: string };
    expect(updated.revision).not.toBe(created.revision);
  }, 60_000);

  test('a past-budget child gets a summary that keeps the revision and says to append or skip', async () => {
    const tools = childTools(16);
    const put = tools.find(t => t.name === 'brain_put_page')!;
    const created = await put.execute({ slug: SLUG, content: page('A long pattern page. '.repeat(50)) }, ctx()) as { revision: string };
    const summary = await tools.find(t => t.name === 'brain_get_page')!.execute({ slug: SLUG }, ctx()) as Record<string, unknown>;
    expect(summary.code).toBe('read_budget_exhausted');
    expect(summary.revision).toBe(created.revision);
    expect(String(summary.note)).toContain('add_timeline_entry');
    expect(String(summary.note)).toMatch(/skip/i);
  }, 60_000);
});
