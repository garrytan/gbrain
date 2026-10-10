/**
 * #6398: an absent file must not turn a live DB page into an entity stub.
 * Protects the file, mirrored body, timeline, metadata and subsequent import.
 * Reverting recovery replaces the original prose with a stub; existing fence
 * tests seed a file or no page, not a rich DB-only baseline. Faults use engine
 * proxies, not a new production seam. Runs on PGLite and PostgreSQL.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { writeFactsToFence, type FenceInputFact } from '../src/core/facts/fence-write.ts';
import { parseMarkdown } from '../src/core/markdown.ts';
import { gbrainPath } from '../src/core/config.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const backends = testBackends();
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
beforeAll(async () => {
  if (backends.includes('pglite')) {
    const engine = new PGLiteEngine();
    await engine.connect({}); await engine.initSchema(); engines.push(engine);
  }
  if (backends.includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engines.push(pg.engine); closePostgres = pg.close;
  }
}, 120_000);
afterAll(async () => {
  for (const engine of engines) await engine.disconnect();
  await closePostgres?.();
});

const slug = 'people/archive-example';
const prose = '# Archive Example\n\nOriginal prose with Unicode café 東京 and a literal | pipe.';
const timeline = '- 2026-01-02: Original milestone';
const input: FenceInputFact = { fact: 'A newly remembered claim', kind: 'fact', notability: 'medium',
  source: 'test', visibility: 'private', embedding: null, sessionId: 'synthetic-session' };

async function fixture(run: (engine: BrainEngine, sourceId: string, root: string) => Promise<void>) {
  for (const engine of engines) {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-fence-db-only-'));
    const sourceId = `archive-${randomUUID().slice(0, 8)}`;
    try {
      await withEnv({ GBRAIN_HOME: join(root, 'home'), GBRAIN_AUDIT_DIR: join(root, 'audit') }, async () => {
        await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
        await engine.putPage(slug, { type: 'person', title: 'Archive Example', compiled_truth: prose, timeline,
          frontmatter: { visibility: 'private', custom: 'retained metadata' } }, { sourceId });
        await engine.addTag(slug, 'archival', { sourceId });
        await engine.addTag(slug, 'unicode', { sourceId });
        expect(existsSync(join(root, `${slug}.md`))).toBe(false);
        await run(engine, sourceId, root);
      });
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
}

function wrapped(engine: BrainEngine, overrides: Partial<BrainEngine>): BrainEngine {
  return new Proxy(engine, { get(target, prop, receiver) {
    if (prop in overrides) return Reflect.get(overrides, prop);
    const value = Reflect.get(target, prop, receiver);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}

for (const resolutionSource of ['exact_page', 'alias_exact'] as const) {
  test(`materializes the ${resolutionSource} DB-only page, preserving content through mirror and import`, async () => {
    await fixture(async (engine, sourceId, root) => {
      const original = await engine.getPage(slug, { sourceId });
      const result = await writeFactsToFence(engine, { sourceId, localPath: root, slug, resolutionSource }, [input]);
      expect(result.inserted).toBe(1);
      const text = readFileSync(join(root, `${slug}.md`), 'utf-8');
      const parsed = parseMarkdown(text, `${slug}.md`);
      expect(parsed.compiled_truth).toContain(prose);
      expect(parsed.compiled_truth).toContain(input.fact);
      expect(parsed.timeline).toBe(timeline);
      expect(parsed.frontmatter).toMatchObject({ visibility: 'private', custom: 'retained metadata' });
      expect(parsed.tags).toEqual(['archival', 'unicode']);
      const mirrored = await engine.getPage(slug, { sourceId });
      expect(mirrored!.compiled_truth).toContain(prose);
      expect(mirrored!.timeline).toBe(timeline);
      expect(mirrored!.content_hash).toBe(original!.content_hash);
      expect((await importFromContent(engine, slug, text, { sourceId, noEmbed: true })).status).toBe('imported');
      const imported = await engine.getPage(slug, { sourceId });
      expect(imported!.compiled_truth).toContain(prose);
      expect(imported!.timeline).toBe(timeline);
    });
  }, 60_000);
}

test('a missing recorded file is restored without minting a slug-derived twin', async () => {
  await fixture(async (engine, sourceId, root) => {
    await engine.putPage(slug, { type: 'person', title: 'Archive Example', compiled_truth: prose,
      timeline, source_path: 'Library/Original Name.md' }, { sourceId });
    const result = await writeFactsToFence(engine, { sourceId, localPath: root, slug, resolutionSource: 'exact_page' }, [input]);
    expect(result.inserted).toBe(1);
    expect(readFileSync(join(root, 'Library/Original Name.md'), 'utf-8')).toContain(prose);
    expect(existsSync(join(root, `${slug}.md`))).toBe(false);
  });
}, 60_000);

test('a DB-only body that cannot round-trip stays untouched', async () => {
  await fixture(async (engine, sourceId, root) => {
    const ambiguous = `${prose}\n\n<!-- timeline -->\n## Timeline\n\nEmbedded prose, not a timeline`;
    await engine.putPage(slug, { type: 'person', title: 'Archive Example', compiled_truth: ambiguous, timeline }, { sourceId });
    const result = await writeFactsToFence(engine, { sourceId, localPath: root, slug, resolutionSource: 'exact_page' }, [input]);
    expect(result).toMatchObject({ inserted: 0, fenceWriteFailed: true });
    expect(existsSync(join(root, `${slug}.md`))).toBe(false);
    expect((await engine.getPage(slug, { sourceId }))!.compiled_truth).toBe(ambiguous);
  });
}, 60_000);

test('never materializes a same-slug page from another source', async () => {
  await fixture(async (engine, sourceId, root) => {
    const emptySource = `empty-${randomUUID().slice(0, 8)}`;
    await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [emptySource, root]);
    const result = await writeFactsToFence(engine, { sourceId: emptySource, localPath: root, slug, resolutionSource: 'exact_page' }, [input]);
    expect(result.inserted).toBe(1);
    expect(readFileSync(join(root, `${slug}.md`), 'utf-8')).not.toContain(prose);
    expect((await engine.getPage(slug, { sourceId }))!.compiled_truth).toBe(prose);
  });
}, 60_000);

test('a failed baseline read creates no stub and inserts no fact', async () => {
  await fixture(async (engine, sourceId, root) => {
    const broken = wrapped(engine, { readPageSnapshot: async () => { throw new Error('synthetic baseline read failure'); } });
    const result = await writeFactsToFence(broken, { sourceId, localPath: root, slug, resolutionSource: 'exact_page' }, [input]);
    expect(result).toMatchObject({ inserted: 0, fenceWriteFailed: true });
    expect(existsSync(join(root, `${slug}.md`))).toBe(false);
    expect((await engine.getPage(slug, { sourceId }))!.compiled_truth).toBe(prose);
    const rows = await engine.executeRaw('SELECT id FROM facts WHERE source_id=$1', [sourceId]);
    expect(rows).toHaveLength(0);
    expect(readFileSync(gbrainPath('facts.write_failures.jsonl'), 'utf-8')).toContain('baseline');
  });
}, 60_000);

test('a newer DB revision during recovery is preserved without publishing stale file bytes', async () => {
  await fixture(async (engine, sourceId, root) => {
    let reads = 0;
    const racing = wrapped(engine, { readPageSnapshot: async (s, opts) => {
      if (++reads === 2) await engine.putPage(slug, { type: 'person', title: 'Archive Example',
        compiled_truth: `${prose}\n\nNew concurrent edit`, timeline }, { sourceId });
      return engine.readPageSnapshot(s, opts);
    } });
    const result = await writeFactsToFence(racing, { sourceId, localPath: root, slug, resolutionSource: 'exact_page' }, [input]);
    expect(result).toMatchObject({ inserted: 0, fenceWriteFailed: true });
    expect(existsSync(join(root, `${slug}.md`))).toBe(false);
    expect((await engine.getPage(slug, { sourceId }))!.compiled_truth).toContain('New concurrent edit');
    expect(await engine.executeRaw('SELECT id FROM facts WHERE source_id=$1', [sourceId])).toHaveLength(0);
  });
}, 60_000);
