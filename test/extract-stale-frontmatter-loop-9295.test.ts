/**
 * #9295: on the default config (`autopilot.incremental_extract_include_frontmatter` off) the stale sweep rewrites only
 * an origin's body wanted-link rows, but the staleness check also counted its frontmatter rows, so a page whose
 * frontmatter names a page written later stayed stale after every sweep and the `extract` job chained continuations
 * without end. Now a sweep counts only the producers it re-resolves (the frontmatter row stays unchecked, so turning
 * the frontmatter sweep on still finds it), and a continuation chains only while the remaining count falls.
 * PGLite always; PostgreSQL when DATABASE_URL is set (test/postgres-unit-arms.txt). A managed brain re-resolves both
 * producers, so its sweep settles the page.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { makeExtractHandler } from '../src/core/minions/handlers/extract.ts';
import { extractStaleFromDB } from '../src/commands/extract.ts';
import { readExtractionLag } from '../src/core/extraction-lag.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { BLOCK_MAX_BYTES } from '../src/core/page-body/segment-blocks.ts';
import { setCliOptions } from '../src/core/cli-options.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { testBackends } from './helpers/test-backends.ts';

const ORIGIN = 'people/alice-example';
const TARGET = 'companies/acme-toolkit';
const MAX_CHAIN = 6;

const ctxOf = (engine: BrainEngine): OperationContext => ({ engine, config: { engine: engine.kind, embedding_disabled: true }, sourceId: 'default',
  remote: false, dryRun: false, logger: { info() {}, warn() {}, error() {} } }) as OperationContext;
const put = (ctx: OperationContext, slug: string, type: string, frontmatter = '') => submitPageMutation(ctx, { operation: 'put_page',
  params: { slug, request_id: randomUUID(), content: `---\ntype: ${type}\ntitle: ${slug}\n${frontmatter}---\n\n${slug} notes.\n` } });
const wanted = (engine: BrainEngine) => engine.executeRaw<{ producer: string; target_ref: string }>('SELECT producer, target_ref FROM wanted_links ORDER BY producer');
const queued = async (engine: BrainEngine) => engine.executeRaw<{ id: number; data: Record<string, unknown> }>(
  "SELECT id, data FROM minion_jobs WHERE name = 'extract' AND status = 'waiting' ORDER BY id");

/** Runs the stale job, then each continuation it queues, as the worker would; returns how many continuations ran. */
async function runChain(engine: BrainEngine, between?: () => Promise<void>): Promise<number> {
  const handler = makeExtractHandler(engine);
  await handler({ id: 1, data: { stale: true } } as never);
  for (let n = 1; n <= MAX_CHAIN; n++) {
    const [next] = await queued(engine);
    if (!next) return n - 1;
    await engine.executeRaw("UPDATE minion_jobs SET status = 'completed' WHERE id = $1", [next.id]);
    await between?.();
    await handler({ id: Number(next.id), data: next.data } as never);
  }
  return MAX_CHAIN + 1;
}

async function frontmatterLoop(engine: BrainEngine, ctx: OperationContext): Promise<void> {
  await put(ctx, ORIGIN, 'person', 'founded: ["acme-toolkit"]\n');
  expect(await wanted(engine)).toEqual([{ producer: 'frontmatter', target_ref: 'acme-toolkit' }]);
  await extractStaleFromDB(engine, { dryRun: false, jsonMode: true, quiet: true, catchUp: true });
  await put(ctx, TARGET, 'company');
}

beforeAll(() => setCliOptions({ quiet: true, progressJson: false, progressInterval: 1000, explain: false, timeoutMs: null, brain: null }));

for (const kind of testBackends()) {
  describe(`stale extract continuations, unmanaged repo-less brain (${kind}) (#9295)`, () => {
    let engine: BrainEngine;
    let close: (() => Promise<void>) | undefined;
    beforeEach(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema(); engine = lite; close = () => lite.disconnect(); }
    }, 120_000);
    afterEach(async () => { await close?.(); close = undefined; });
    afterAll(async () => { await close?.(); });

    test('a frontmatter reference to a page written later does not chain the sweep without end', async () => {
      await frontmatterLoop(engine, ctxOf(engine));
      expect(await runChain(engine)).toBeLessThanOrEqual(1);
      expect((await readExtractionLag(engine)).actionable).toBe(0);
      expect(await wanted(engine)).toEqual([{ producer: 'frontmatter', target_ref: 'acme-toolkit' }]);
    }, 300_000);

    test('the unchecked frontmatter row is still found once the frontmatter sweep is turned on', async () => {
      await frontmatterLoop(engine, ctxOf(engine));
      await runChain(engine);
      await engine.setConfig('autopilot.incremental_extract_include_frontmatter', 'true');
      expect((await readExtractionLag(engine)).actionable).toBe(1);
      await extractStaleFromDB(engine, { dryRun: false, jsonMode: true, quiet: true, catchUp: true });
      expect((await readExtractionLag(engine)).actionable).toBe(0);
      expect(await wanted(engine)).toEqual([]);
    }, 300_000);

    test('a continuation whose sweep leaves as many pages stale as before chains nothing', async () => {
      await engine.setConfig('pages.segmented_storage', 'on');
      const body = Array.from({ length: Math.ceil((BLOCK_MAX_BYTES + 2 * 1024 * 1024) / 32) }, (_, i) => 'code line ' + String(i).padStart(10, '0') + ' x = 1;\n').join('');
      expect((await importFromContent(engine, 'notes/archive', '---\ntitle: Archive\ntype: note\n---\n\n\`\`\`ts\n' + body + '\`\`\`\n',
        { sourceId: 'default', noEmbed: true })).status).toBe('imported');
      await put(ctxOf(engine), 'notes/first', 'note');
      let written = 0;
      const chained = await runChain(engine, async () => { await put(ctxOf(engine), `notes/later-${++written}`, 'note'); });
      expect(chained).toBeLessThanOrEqual(1);
    }, 600_000);
  });
}

describe('stale extract continuations, managed brain (#9295)', () => {
  test('the managed sweep re-resolves the frontmatter row and the chain ends', async () => {
    await managedBrain(async ({ engine, ctx }) => {
      await frontmatterLoop(engine, ctx);
      expect(await runChain(engine)).toBeLessThanOrEqual(1);
      expect((await readExtractionLag(engine)).actionable).toBe(0);
    });
  }, 300_000);
});
