/**
 * Capacity split (#5728): the managed v0.13.1 grandfather refuses up front
 * only when the pages it can admit exceed the permanent request-ID caps.
 * Pages it skips (code and image pages, non-Markdown files) need no ID, so a
 * pass over only those completes even with exhausted IDs, while one
 * admissible page refuses before any page changes, naming the command.
 */
import { expect, test } from 'bun:test';
import { phaseCGrandfather } from '../src/commands/migrations/v0_13_1.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { managedBrain } from './helpers/managed-brain.ts';

const OPTS = { yes: true, dryRun: false, noAutopilotInstall: true };
const EXHAUSTED = 'persistence.limits.principal_lifetime_ids';

async function seedSkipped({ engine }: { engine: BrainEngine }) {
  await engine.putPage('code/example-script', { type: 'code', title: 'Example script', compiled_truth: 'print("hello")' });
  await engine.setConfig(EXHAUSTED, '0');
}

test('exhausted IDs do not block a pass that admits nothing', async () => {
  await managedBrain(async ({ engine }) => {
    const { result } = await phaseCGrandfather(engine, OPTS);
    expect(result.status).toBe('complete');
    expect(await engine.executeRaw('SELECT id FROM persistence_requests')).toEqual([]);
  }, { setup: seedSkipped });
}, 120_000);

test('one admissible page refuses up front with the capacity command', async () => {
  await managedBrain(async ({ engine }) => {
    const before = await engine.executeRaw('SELECT slug, frontmatter, knowledge_revision FROM pages ORDER BY slug');
    const { result } = await phaseCGrandfather(engine, OPTS);
    expect(result.status).toBe('failed');
    expect(result.detail).toStartWith('queue_capacity: Write capacity exhausted: principal permanent request IDs (0 used of 0).');
    expect(result.detail).toContain(`gbrain config set ${EXHAUSTED} `);
    expect(await engine.executeRaw('SELECT slug, frontmatter, knowledge_revision FROM pages ORDER BY slug')).toEqual(before);
  }, { setup: async brain => {
    await brain.engine.putPage('notes/example', { type: 'note', title: 'Example', compiled_truth: 'An ordinary note.' });
    await seedSkipped(brain);
  } });
}, 120_000);
