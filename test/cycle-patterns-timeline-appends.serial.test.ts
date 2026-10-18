/**
 * #6302: a patterns child mostly updates existing pattern pages with
 * add_timeline_entry. The phase now selects the entries it newly published by
 * write receipt, quote-verifies only those entries against this run's
 * reflections, stamps provenance on their pages and counts them in
 * `patterns_written`. Earlier verified content (a quote outside this run's
 * reflections, an older timeline entry the child re-appends) is left alone.
 * The child is scripted through the real brain tool and the subagent's
 * tool-execution ledger, so request ids and receipts are the production ones.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { createSegmentedPage } from './helpers/segmented-page.ts';

const PATTERN = 'wiki/personal/patterns/small-pieces';
const REPLAYED = '0b6a3f52-7d1e-4c8a-9f10-2a6b5c4d3e21';
let script: Array<Record<string, unknown>> = [];

mock.module('../src/core/ai/gateway.ts', () => ({
  probeChatModel: () => ({ ok: true }),
  isAvailable: () => false,
}));

mock.module('../src/core/cycle/synthesize.ts', () => ({
  loadAllowedSlugPrefixes: async () => ['wiki/personal/patterns/*'],
  loadOutputRoot: async () => 'wiki',
  runSubagentsInline: async (engine: BrainEngine, _queue: unknown, queueName: string) => runScriptedChild(engine, queueName),
}));

mock.module('../src/core/minions/wait-for-completion.ts', () => ({
  TimeoutError: class TimeoutError extends Error {},
  waitForCompletion: async (_queue: unknown, jobId: number) => ({ id: jobId, status: 'completed' }),
  waitForCompletionRenewing: async (_queue: unknown, jobId: number, opts?: { renew?: () => Promise<void> }) => {
    if (opts?.renew) await opts.renew();
    return { id: jobId, status: 'completed' };
  },
}));

const { runPhasePatterns } = await import('../src/core/cycle/patterns.ts');
const { buildBrainTools } = await import('../src/core/minions/tools/brain-allowlist.ts');
const { retainToolWriteRequestId } = await import('../src/core/minions/tool-write-identity.ts');
const { persistToolExecComplete, persistToolExecPending } = await import('../src/core/minions/handlers/subagent-persistence.ts');

/** The subagent handler's tool path for each scripted call: stable request id, pending row, execute, complete row. */
async function runScriptedChild(engine: BrainEngine, queueName: string): Promise<void> {
  const [job] = await engine.executeRaw<{ id: number }>('SELECT id FROM minion_jobs WHERE queue = $1 ORDER BY id DESC LIMIT 1', [queueName]);
  const jobId = Number(job!.id);
  const tools = buildBrainTools({ subagentId: jobId, engine, config: { engine: 'pglite' } as GBrainConfig,
    allowedSlugPrefixes: ['wiki/personal/patterns/*'], sourceId: 'default' });
  const tool = tools.find(t => t.name === 'brain_add_timeline_entry')!;
  for (const [ordinal, call] of script.entries()) {
    const input = { ...call };
    const toolUseId = `toolu_${ordinal}`;
    retainToolWriteRequestId(input, jobId, 1, ordinal, toolUseId, tool.name);
    await persistToolExecPending(engine, jobId, 1, ordinal, toolUseId, tool.name, input);
    const output = await tool.execute(input, { engine, jobId, remote: true });
    await persistToolExecComplete(engine, jobId, 1, ordinal, toolUseId, output);
  }
  await engine.executeRaw(`UPDATE minion_jobs SET status = 'completed' WHERE id = $1`, [jobId]);
}

let engine: PGLiteEngine;
let schemaVersion: string;
let brainDir: string;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
  schemaVersion = (await engine.getConfig('version')) ?? '7';
  brainDir = mkdtempSync(join(tmpdir(), 'gbrain-patterns-appends-'));
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
  rmSync(brainDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('version', schemaVersion);
  await engine.setConfig('models.dream.patterns', 'anthropic:claude-sonnet-4-6');
  await engine.setConfig('dream.quote_verify', 'true');
  for (const [i, body] of ['I keep saying "ship smaller pieces" when projects stall.', 'Again I told myself to ship smaller pieces.', 'Shipping smaller pieces worked this week.'].entries()) {
    await importFromContent(engine, `wiki/personal/reflections/r${i + 1}`, `---\ntype: note\ntitle: r${i + 1}\n---\n${body}\n`, { noEmbed: true, sourceId: 'default' });
  }
  // Verified by an earlier run against reflections this run does not read.
  await importFromContent(engine, PATTERN,
    `---\ntype: note\ntitle: Small pieces\ndream_generated: true\nquote_verified_at: '2026-10-01'\n---\nAn earlier run quoted "never ship on Fridays".\n\n<!-- timeline -->\n## Timeline\n\n- **2026-09-01** | wiki/personal/reflections/old — You said "keep a launch diary".\n`,
    { noEmbed: true, sourceId: 'default' });
  script = [];
});

describe('patterns timeline appends are quote-verified and counted (#6302)', () => {
  test('an append quoting text absent from the reflections is quarantined; earlier verified content survives', async () => {
    script = [
      { slug: PATTERN, date: '2026-10-10', summary: 'You wrote "always test on staging" again', source: 'wiki/personal/reflections/r3' },
      { slug: PATTERN, date: '2026-10-11', summary: 'You repeat "ship smaller pieces"', source: 'wiki/personal/reflections/r1', request_id: REPLAYED },
      // The child re-appends an entry already on the page: its receipt says skipped, so it is not a new append.
      { slug: PATTERN, date: '2026-09-01', summary: 'You said "keep a launch diary".', source: 'wiki/personal/reflections/old' },
      // A replayed call returns its original receipt (status ok again); it is the same append, counted once.
      { slug: PATTERN, date: '2026-10-11', summary: 'You repeat "ship smaller pieces"', source: 'wiki/personal/reflections/r1', request_id: REPLAYED },
    ];
    const result = await runPhasePatterns(engine, { brainDir, dryRun: false, cycleDate: '2026-10-15' });
    expect(result.status).toBe('ok');
    const page = (await engine.getPage(PATTERN))!;
    expect(page.timeline).not.toContain('always test on staging');
    expect(page.timeline).toContain('ship smaller pieces');
    expect(page.timeline).toContain('keep a launch diary');
    expect(page.compiled_truth).toContain('never ship on Fridays');
    const claims = page.frontmatter.unverified_claims as Array<{ text: string; reason: string }>;
    expect(claims).toHaveLength(1);
    expect(claims[0]!.text).toContain('always test on staging');
    expect(claims[0]!.reason).toBe('quote_not_in_source');
    expect(page.frontmatter.quote_verified_at).toBe('2026-10-01');
    expect(page.frontmatter.dream_cycle_date).toBe('2026-10-15');
    expect(page.frontmatter.raw_trace_exempt).toBe(true);
    const rows = await engine.getTimeline(PATTERN, { sourceId: 'default' });
    expect(rows.map(r => r.summary).join('\n')).not.toContain('always test on staging');
    expect(result.details.patterns_written).toBe(1);
    expect(result.details.timeline_appends).toBe(2);
    expect(result.details.appended_unverified).toBe(4);
    expect(result.details.quote_verify).toMatchObject({ timeline_appends: { entries: 2, quarantined: 1, repaired: 0 } });
    expect(result.summary).toContain('1 pattern page(s) written/updated');
  });

  test('appends that all ground change nothing on the page but still count it as written', async () => {
    script = [{ slug: PATTERN, date: '2026-10-11', summary: 'You repeat "ship smaller pieces"', source: 'wiki/personal/reflections/r1' }];
    const result = await runPhasePatterns(engine, { brainDir, dryRun: false, cycleDate: '2026-10-15' });
    const page = (await engine.getPage(PATTERN))!;
    expect(page.frontmatter.unverified_claims).toBeUndefined();
    expect(page.timeline).toContain('ship smaller pieces');
    expect(result.details.patterns_written).toBe(1);
    expect(result.details.quote_verify).toMatchObject({ timeline_appends: { entries: 1, quarantined: 0, repaired: 0 } });
  });
});

describe('segmented reflections in an in-cycle patterns run (#6302 on segmented storage; direct cases on both engines in cycle-patterns-segmented.test.ts)', () => {
  test('a segmented reflection still grounds a quote: the segment reader supplies its body', async () => {
    await createSegmentedPage(engine, { slug: 'wiki/personal/reflections/r4', truth: 'Mondays I update my "weekly launch diary".\n',
      meta: { type: 'note', title: 'r4', frontmatter: {} } });
    script = [{ slug: PATTERN, date: '2026-10-11', summary: 'You keep a "weekly launch diary"', source: 'wiki/personal/reflections/r4' }];
    const result = await runPhasePatterns(engine, { brainDir, dryRun: false, cycleDate: '2026-10-15' });
    expect(result.status).toBe('ok');
    const page = (await engine.getPage(PATTERN))!;
    expect(page.timeline).toContain('weekly launch diary');
    expect(page.frontmatter.unverified_claims).toBeUndefined();
    expect(result.details.quote_verify).toMatchObject({ timeline_appends: { entries: 1, quarantined: 0, segmented_skipped: 0 } });
  });
});
