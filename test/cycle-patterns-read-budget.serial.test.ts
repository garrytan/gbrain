/**
 * #6297: a patterns child that read every existing pattern page in full
 * filled half a CLI model's window, because each turn replays the whole
 * transcript. The phase now gives the child a get_page byte budget
 * (`dream.patterns.child_read_budget_kb`, default 200 KB); past it a read
 * comes back as a short summary. The child is scripted the way the subagent
 * handler runs it: the job's own data feeds buildBrainTools, and each call
 * goes through the tool-execution ledger the budget counts from.
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

const PAGES = 60;
const PAGE_CHARS = 20_000;

mock.module('../src/core/ai/gateway.ts', () => ({
  probeChatModel: () => ({ ok: true }),
  isAvailable: () => false,
}));

mock.module('../src/core/cycle/synthesize.ts', () => ({
  loadAllowedSlugPrefixes: async () => ['wiki/personal/patterns/*'],
  loadOutputRoot: async () => 'wiki',
  runSubagentsInline: async (engine: BrainEngine, _queue: unknown, queueName: string) => readEveryPatternPage(engine, queueName),
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
const { persistToolExecComplete, persistToolExecPending } = await import('../src/core/minions/handlers/subagent-persistence.ts');

let jobId = 0;

/** The child reads every existing pattern page, as the patterns prompt invites. */
async function readEveryPatternPage(engine: BrainEngine, queueName: string): Promise<void> {
  const [job] = await engine.executeRaw<{ id: number; data: Record<string, unknown> | string }>('SELECT id, data FROM minion_jobs WHERE queue = $1 ORDER BY id DESC LIMIT 1', [queueName]);
  jobId = Number(job!.id);
  const data = (typeof job!.data === 'string' ? JSON.parse(job!.data) : job!.data) as { read_budget_bytes?: number };
  const tools = buildBrainTools({ subagentId: jobId, engine, config: { engine: 'pglite' } as GBrainConfig,
    allowedSlugPrefixes: ['wiki/personal/patterns/*'], sourceId: 'default', readBudgetBytes: data.read_budget_bytes });
  const tool = tools.find(t => t.name === 'brain_get_page')!;
  for (let i = 0; i < PAGES; i++) {
    const input = { slug: `wiki/personal/patterns/theme-${i}` };
    await persistToolExecPending(engine, jobId, 1, i, `toolu_${i}`, tool.name, input);
    const output = await tool.execute(input, { engine, jobId, remote: true });
    await persistToolExecComplete(engine, jobId, 1, i, `toolu_${i}`, output);
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
  brainDir = mkdtempSync(join(tmpdir(), 'gbrain-patterns-read-budget-'));
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
  rmSync(brainDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('version', schemaVersion);
  await engine.setConfig('models.dream.patterns', 'anthropic:claude-sonnet-4-6');
  for (let i = 1; i <= 3; i++) {
    await importFromContent(engine, `wiki/personal/reflections/r${i}`, `---\ntype: note\ntitle: r${i}\n---\nA recurring theme, take ${i}.\n`, { noEmbed: true, sourceId: 'default' });
  }
  const body = 'A long pattern page with many dated observations. '.repeat(Math.ceil(PAGE_CHARS / 51)).slice(0, PAGE_CHARS);
  for (let i = 0; i < PAGES; i++) {
    await importFromContent(engine, `wiki/personal/patterns/theme-${i}`, `---\ntype: note\ntitle: Theme ${i}\ndream_generated: true\n---\n${body}\n`, { noEmbed: true, sourceId: 'default' });
  }
}, 120_000);

async function readOutputs(): Promise<Array<Record<string, unknown>>> {
  const rows = await engine.executeRaw<{ output: unknown }>('SELECT output FROM subagent_tool_executions WHERE job_id = $1 ORDER BY ordinal', [jobId]);
  return rows.map(r => (typeof r.output === 'string' ? JSON.parse(r.output) : r.output) as Record<string, unknown>);
}

describe('patterns child get_page read budget (#6297)', () => {
  test('60 large pattern pages: the child transcript stays under the default 200 KB budget plus short summaries', async () => {
    const result = await runPhasePatterns(engine, { brainDir, dryRun: false });
    expect(result.status).toBe('ok');
    const outputs = await readOutputs();
    expect(outputs).toHaveLength(PAGES);
    const bytes = outputs.reduce((n, o) => n + Buffer.byteLength(JSON.stringify(o), 'utf8'), 0);
    expect(bytes).toBeLessThan(200 * 1024 + PAGES * 1024);
    expect(outputs[0]!.truncated).toBeUndefined();
    const summarized = outputs.filter(o => o.truncated === true);
    expect(summarized.length).toBeGreaterThan(PAGES / 2);
    expect(summarized[0]).toMatchObject({ code: 'read_budget_exhausted', slug: expect.stringMatching(/^wiki\/personal\/patterns\/theme-/), title: expect.stringMatching(/^Theme /) });
    expect(String(summarized[0]!.note)).toContain('add_timeline_entry');
  }, 120_000);

  test('0 turns the budget off: every page is read in full', async () => {
    await engine.setConfig('dream.patterns.child_read_budget_kb', '0');
    expect((await runPhasePatterns(engine, { brainDir, dryRun: false })).status).toBe('ok');
    const outputs = await readOutputs();
    expect(outputs.filter(o => o.truncated === true)).toHaveLength(0);
    expect(outputs.every(o => String(o.compiled_truth ?? '').length > PAGE_CHARS * 0.9)).toBe(true);
  }, 120_000);
});
