/**
 * B-12: a phantom-redirect merge is lossless.
 *
 *   - Backlinks to the phantom move to the canonical page, and the phantom
 *     slug is recorded as an alias of the canonical.
 *   - The canonical fence lands in the page's recorded file (the shared
 *     write-target resolver), not a slug-named twin.
 *   - Expired and superseded history moves with the active rows instead of
 *     being hard-deleted, `superseded by #N` references follow the renumber,
 *     and the moved rows keep their ids through the canonical's next
 *     reconcile (DB row numbers equal the numbers written to disk).
 *   - A canonical chosen by fuzzy match must agree with the prefix
 *     candidates.
 *
 * Hermetic PGLite + tempdir brain.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { withEnv } from './helpers/with-env.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import { tryRedirectPhantom } from '../src/core/cycle/phantom-redirect.ts';
import { parseFactsFence } from '../src/core/facts-fence.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});

const FENCE = (rows: string): string => `# alice

## Facts

<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
${rows}
<!--- gbrain:facts:end -->
`;

async function putPage(slug: string, body: string, type = 'person', title = slug): Promise<void> {
  await engine.putPage(slug, { title, type: type as never, compiled_truth: body, frontmatter: {}, timeline: '' });
}

function withBrain<T>(fn: (brainDir: string) => Promise<T>): Promise<T> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phantom-merge-'));
  const brainDir = path.join(root, 'brain');
  fs.mkdirSync(brainDir, { recursive: true });
  fs.mkdirSync(path.join(root, 'audit'), { recursive: true });
  return withEnv({ GBRAIN_AUDIT_DIR: path.join(root, 'audit') }, async () => {
    try {
      return await fn(brainDir);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

function writeMd(brainDir: string, rel: string, body: string): void {
  fs.mkdirSync(path.dirname(path.join(brainDir, rel)), { recursive: true });
  fs.writeFileSync(path.join(brainDir, rel), body, 'utf-8');
}

async function redirect(brainDir: string) {
  const phantom = await engine.getPage('alice', { sourceId: 'default' });
  return tryRedirectPhantom(engine, phantom!, 'default', brainDir, false);
}

describe('phantom-redirect merge (B-12)', () => {
  test('backlinks move to the canonical and the phantom slug becomes an alias', async () => {
    await withBrain(async brainDir => {
      await putPage('people/alice-example', '# alice-example\n');
      writeMd(brainDir, 'people/alice-example.md', '# alice-example\n');
      await putPage('alice', FENCE('| 1 | Founded Acme | fact | 1.0 | world | high | 2017-01-01 |  | chat |  |'));
      writeMd(brainDir, 'alice.md', FENCE('| 1 | Founded Acme | fact | 1.0 | world | high | 2017-01-01 |  | chat |  |'));
      await putPage('meetings/2026-01-01-sync', 'Met alice.', 'meeting');
      await engine.addLink('meetings/2026-01-01-sync', 'alice', 'met', 'mentions');

      expect((await redirect(brainDir)).outcome).toBe('redirected');
      const backlinks = await engine.getBacklinks('people/alice-example');
      expect(backlinks.map(l => l.from_slug)).toEqual(['meetings/2026-01-01-sync']);
      expect(await engine.resolveSlugWithAlias('alice', 'default')).toBe('people/alice-example');
    });
  });

  test('the fence lands in the canonical page\'s recorded file', async () => {
    await withBrain(async brainDir => {
      await engine.executeRaw(`UPDATE sources SET local_path = $1 WHERE id = 'default'`, [brainDir]);
      await putPage('people/alice-example', '# Alice Example\n');
      await engine.executeRaw(`UPDATE pages SET source_path = 'People/Alice Example.md' WHERE slug = 'people/alice-example'`);
      writeMd(brainDir, 'People/Alice Example.md', '# Alice Example\n');
      await putPage('alice', FENCE('| 1 | Founded Acme | fact | 1.0 | world | high | 2017-01-01 |  | chat |  |'));
      writeMd(brainDir, 'alice.md', FENCE('| 1 | Founded Acme | fact | 1.0 | world | high | 2017-01-01 |  | chat |  |'));

      expect((await redirect(brainDir)).outcome).toBe('redirected');
      expect(fs.readFileSync(path.join(brainDir, 'People/Alice Example.md'), 'utf-8')).toContain('Founded Acme');
      expect(fs.existsSync(path.join(brainDir, 'people/alice-example.md'))).toBe(false);
    });
  });

  test('history moves with renumbered supersession links and ids survive the canonical reconcile', async () => {
    await withBrain(async brainDir => {
      const canonicalBody = FENCE('| 1 | Lives in Paris | fact | 1.0 | world | medium | 2015-01-01 |  | chat |  |');
      await putPage('people/alice-example', canonicalBody);
      writeMd(brainDir, 'people/alice-example.md', canonicalBody);
      const phantomBody = FENCE([
        '| 1 | ~~Works at Acme~~ | fact | 1.0 | world | medium | 2017-01-01 |  | chat | superseded by #2 |',
        '| 2 | Works at Beta | fact | 1.0 | world | medium | 2020-01-01 |  | chat |  |',
      ].join('\n'));
      await putPage('alice', phantomBody);
      writeMd(brainDir, 'alice.md', phantomBody);
      await runExtractFacts(engine, { slugs: ['alice', 'people/alice-example'] });
      const phantomIds = (await engine.executeRaw<{ id: number }>(
        `SELECT id FROM facts WHERE source_markdown_slug = 'alice' ORDER BY row_num`)).map(r => r.id);
      expect(phantomIds).toHaveLength(2);

      expect((await redirect(brainDir)).outcome).toBe('redirected');
      const fence = parseFactsFence(fs.readFileSync(path.join(brainDir, 'people/alice-example.md'), 'utf-8')).facts;
      expect(fence.map(f => [f.rowNum, f.claim, f.supersededBy ?? null])).toEqual([
        [1, 'Lives in Paris', null], [2, 'Works at Acme', 3], [3, 'Works at Beta', null],
      ]);

      // The canonical's body is refreshed from disk; its reconcile must keep the moved rows.
      await runExtractFacts(engine, { slugs: ['people/alice-example'] });
      const rows = await engine.executeRaw<{ id: number; row_num: number; expired: boolean; superseded_by: number | null }>(
        `SELECT id, row_num, expired_at IS NOT NULL AS expired, superseded_by FROM facts
          WHERE source_markdown_slug = 'people/alice-example' AND row_num IS NOT NULL ORDER BY row_num`);
      expect(rows.slice(1).map(r => r.id)).toEqual(phantomIds);
      expect(rows[1]).toMatchObject({ expired: true, superseded_by: phantomIds[1] });
      expect(await engine.executeRaw(`SELECT id FROM facts WHERE source_markdown_slug = 'alice'`)).toEqual([]);
    });
  });

  test('a fuzzy hit tied with the phantom itself never becomes the canonical', async () => {
    await withBrain(async brainDir => {
      await putPage('people/alice-example', '# alice-example\n');
      writeMd(brainDir, 'people/alice-example.md', '# alice-example\n');
      // Title "alice" scores 1.0, tied with the phantom slug, and sorts first.
      await putPage('agents/alice', '# alice\n', 'concept', 'alice');
      await putPage('alice', FENCE('| 1 | Founded Acme | fact | 1.0 | world | high | 2017-01-01 |  | chat |  |'));
      writeMd(brainDir, 'alice.md', FENCE('| 1 | Founded Acme | fact | 1.0 | world | high | 2017-01-01 |  | chat |  |'));
      const result = await redirect(brainDir);
      expect(result).toEqual({ outcome: 'redirected', canonical: 'people/alice-example' });
      expect(fs.existsSync(path.join(brainDir, 'agents/alice.md'))).toBe(false);
    });
  });
});
