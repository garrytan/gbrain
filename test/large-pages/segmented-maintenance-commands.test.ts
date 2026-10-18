/**
 * Wave B PR 2 lane 2r-maint: whole-brain maintenance commands over a
 * segmented page (compiled_truth and timeline NULL, body in segments).
 *
 * 1. Protects: `gbrain integrity check` (sequential and the Postgres batch
 *    path) and `integrity auto` read a segmented page block by block and give
 *    the hits the same text stored inline gives (line numbers, fenced lines
 *    skipped); `reconcile-links` finds the same code refs; `reindex --aliases`
 *    writes the same alias rows (its body read back as strings within the
 *    single-string ceiling); `quarantine scan` lists the segmented page it
 *    does not re-check. None of them aborts at the segmented page.
 * 2. Fails when: a command reads `page.compiled_truth` of a segmented page
 *    (the throwing getter aborts the whole run), a streamed scan loses a hit
 *    at a block boundary, restarts fence state or line numbers per block, or
 *    a command skips a segmented page without saying so.
 * 3. Why existing coverage misses it: these commands' tests write inline
 *    pages only.
 * Seams: none; the CLI arm runs the real `gbrain integrity auto` in a child.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { segmentedPassWork } from '../../src/core/page-body/segment-blocks.ts';
import { scanIntegrity } from '../../src/commands/integrity.ts';
import { runReconcileLinks } from '../../src/commands/reconcile-links.ts';
import { extractCodeRefs } from '../../src/core/link-extraction.ts';
import { runReindexAliases } from '../../src/commands/reindex-aliases.ts';
import { runQuarantine } from '../../src/commands/quarantine.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { conversationBody } from '../helpers/conversation-page.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { withEnv } from '../helpers/with-env.ts';
import { runCli } from '../helpers/cli-spawn.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-segmented-maint-'));
const env = { GBRAIN_HOME: home, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined };
const engines: Array<{ engine: BrainEngine; config: Record<string, string> }> = [];
let diskEngine: PGLiteEngine;
const diskPath = join(home, 'disk-brain');
let closePostgres: (() => Promise<void>) | undefined;

const INLINE = 'people/inline-twin';
const SEGMENTED = 'people/segmented-twin';

/** About 1.3 MiB: integrity hits, external links, code refs and an alias declaration early, mid-body (one inside a code fence) and late. */
function twinPage(): string {
  const early = 'Alice Example tweeted about pricing, see [docs](https://example.com/early) and src/core/sync.ts:42.';
  const middle = '```text\nShe tweeted about the fenced example, [x](https://example.com/fenced) in lib/fenced.py\n```\n\n'
    + 'Bob posted on X about the launch: [mid](https://example.com/mid) lib/mid.py and [cited](https://x.com/a/status/1) in a tweet.';
  const late = 'Carol wrote a tweet about hiring. See [late](https://example.com/late) and src/core/late-ref.ts:7.\n\nAlice Example, also known as Ally Sample, joined the board.';
  return `---\ntype: person\ntitle: Alice Example\naliases: [Al Example]\n---\n\n${early}\n\n${conversationBody(600_000, { seed: 5 })}\n\n${middle}\n\n`
    + `${conversationBody(650_000, { seed: 6 })}\n\n${late}\n\n<!-- timeline -->\n\n- **2026-01-10** | Met about scripts/tl-ref.sh\n`;
}

async function twins(engine: BrainEngine): Promise<void> {
  const content = twinPage();
  await engine.setConfig('pages.segmented_storage', 'off');
  expect(await importFromContent(engine, INLINE, content, { sourceId: 'default', noEmbed: true })).toMatchObject({ status: 'imported' });
  await engine.setConfig('pages.segmented_storage', 'on');
  expect(await importFromContent(engine, SEGMENTED, content, { sourceId: 'default', noEmbed: true })).toMatchObject({ status: 'imported' });
  const rows = await engine.executeRaw<{ slug: string; body_storage: string }>('SELECT slug, body_storage FROM pages WHERE slug = ANY($1::text[]) ORDER BY slug', [[INLINE, SEGMENTED]]);
  expect(rows).toEqual([{ slug: INLINE, body_storage: 'inline' }, { slug: SEGMENTED, body_storage: 'segmented' }]);
}

beforeAll(async () => {
  const lite = new PGLiteEngine(); await lite.connect({}); await lite.initSchema();
  engines.push({ engine: lite, config: {} });
  diskEngine = new PGLiteEngine(); await diskEngine.connect({ database_path: diskPath }); await diskEngine.initSchema();
  if (process.env.DATABASE_URL) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL);
    engines.push({ engine: pg.engine, config: { engine: 'postgres', database_url: pg.databaseUrl } });
    closePostgres = pg.close;
  }
  await withEnv(env, async () => {
    for (const { engine } of engines) await twins(engine);
    await twins(diskEngine);
  });
  await diskEngine.disconnect();
  engines[0]!.config = { engine: 'pglite', database_path: diskPath };
}, 300_000);

afterAll(async () => {
  await withEnv(env, async () => {
    for (const { engine } of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
    await diskEngine.disconnect();
    await closePostgres?.();
  });
  rmSync(home, { recursive: true, force: true });
});

async function capture(fn: () => Promise<unknown>): Promise<string> {
  const orig = console.log;
  const lines: string[] = [];
  console.log = (...a: unknown[]) => { lines.push(a.map(String).join(' ')); };
  try { await fn(); } finally { console.log = orig; }
  return lines.join('\n');
}

const of = <T extends { slug: string }>(hits: T[], slug: string) => hits.filter(h => h.slug === slug).map(({ slug: _slug, ...rest }) => rest);

describe('maintenance commands over a segmented page', () => {
  test('integrity check: the segmented twin gets the inline twin\'s hits, read block by block (sequential and batch paths)', async () => withEnv(env, async () => {
    for (const { engine } of engines) {
      for (const limit of [Infinity, 500]) {
        const before = { ...segmentedPassWork };
        const res = await scanIntegrity(engine, { limit });
        expect(res.skipped).toEqual([]);
        const bare = of(res.bareHits, INLINE), external = of(res.externalHits, INLINE);
        expect(bare.map(h => h.phrase)).toEqual(['tweeted about', 'wrote a tweet']);
        expect(external.map(h => h.url)).toEqual(['https://example.com/early', 'https://example.com/mid', 'https://x.com/a/status/1', 'https://example.com/late']);
        expect(bare.at(-1)!.line).toBeGreaterThan(5_000);
        expect(of(res.bareHits, SEGMENTED)).toEqual(bare);
        expect(of(res.externalHits, SEGMENTED)).toEqual(external);
        expect(segmentedPassWork.blocks - before.blocks).toBeGreaterThan(1_000_000);
      }
    }
  }), 300_000);

  test('integrity auto --dry-run: the CLI walks past the segmented page and counts its hits like the inline twin\'s', async () => {
    for (const { config } of engines) {
      const cliHome = mkdtempSync(join(home, 'cli-'));
      mkdirSync(join(cliHome, '.gbrain'), { recursive: true });
      writeFileSync(join(cliHome, '.gbrain', 'config.json'), JSON.stringify({ ...config, embedding_disabled: true }));
      const out = await runCli(['integrity', 'auto', '--dry-run', '--skip-urls', '--fresh'], { home: cliHome, timeoutMs: 180_000 });
      expect({ exit: out.exitCode, stderr: out.exitCode ? out.stderr : '' }).toEqual({ exit: 0, stderr: '' });
      expect(out.stdout).toContain('Pages processed: 2');
      expect(out.stdout).toContain('Skipped (<0.5): 4');
      expect(out.stdout).not.toContain('Pages not scanned');
    }
  }, 600_000);

  test('reconcile-links: the segmented twin yields the inline twin\'s code refs and the walk completes', async () => withEnv(env, async () => {
    for (const { engine } of engines) {
      const inline = (await engine.getPage(INLINE, { sourceId: 'default' }))!;
      const expected = extractCodeRefs(`${inline.compiled_truth}\n${inline.timeline}`);
      expect(expected.map(ref => ref.path)).toEqual(['src/core/sync.ts', 'lib/fenced.py', 'lib/mid.py', 'src/core/late-ref.ts', 'scripts/tl-ref.sh']);
      const dry = await capture(() => runReconcileLinks(engine, { dryRun: true }).then(r => console.log(JSON.stringify(r))));
      expect(JSON.parse(dry)).toMatchObject({ status: 'ok', codeRefsFound: 2 * expected.length });
      expect(JSON.parse(dry).skipped).toBeUndefined();
      const applied = await capture(() => runReconcileLinks(engine).then(r => console.log(JSON.stringify(r))));
      expect(JSON.parse(applied)).toMatchObject({ status: 'ok', edgesAttempted: 2 * expected.length });
    }
  }), 300_000);

  test('reindex --aliases: the segmented twin gets the inline twin\'s alias rows, declared ones included', async () => withEnv(env, async () => {
    for (const { engine } of engines) {
      const out = await capture(() => runReindexAliases(engine, ['--source', 'default', '--json']));
      const result = JSON.parse(out);
      expect(result.skipped).toBeUndefined();
      expect(result.body_not_scanned).toBeUndefined();
      const aliases = async (slug: string) => (await engine.executeRaw<{ alias_norm: string; origin: string }>(
        'SELECT alias_norm, origin FROM page_aliases WHERE source_id=$1 AND slug=$2 ORDER BY origin, alias_norm', ['default', slug]));
      const inline = await aliases(INLINE);
      expect(inline.map(a => a.origin)).toContain('declared');
      expect(inline.map(a => a.origin)).toContain('frontmatter');
      expect(await aliases(SEGMENTED)).toEqual(inline);
    }
  }), 300_000);

  test('quarantine scan: the segmented page is listed as not re-checked and the scan goes on', async () => withEnv(env, async () => {
    for (const { engine } of engines) {
      for (const args of [['scan', '--json'], ['scan', '--apply', '--no-embed', '--json']]) {
        const result = JSON.parse(await capture(() => runQuarantine(engine, args)));
        expect(result.scanned).toBe(2);
        expect(result.skipped).toEqual([{ slug: SEGMENTED, source_id: 'default', reason: 'page_body_segmented', message: expect.stringContaining('not re-checked') }]);
      }
    }
  }), 300_000);
});
