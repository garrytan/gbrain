/**
 * GBRA-287: a segmented page read while a new body publishes (forced probe).
 *
 * 1. Protects: a reader of a page stored in segments never refuses a healthy page `page_body_rows_unreadable` because a
 *    publish landed between its statements. A live read names its generation first and checks that generation's rows
 *    against that generation's size (`readSegmentedBody`, behind readPageSnapshot's read-back), and a live open whose
 *    generation a publish retired before its rows were read opens the new live generation (`openSegmentedBody`). A live read
 *    whose retired generation left only the rows the new body shares is checked against the size read with it, and a
 *    snapshot's streamed file never puts its frontmatter over a later revision's body (`unreadPageFile`).
 * 2. Fails when: the rows of one generation are checked against the next generation's body_bytes, or a retired
 *    generation's missing rows refuse the read instead of reading the live body, or a surviving prefix passes as a whole
 *    body, or the streamed body is opened live rather than at the snapshot's revision.
 * 3. PGLite. The interleaving is forced by an engine wrapper that publishes a new body (and, for the open, retires the old
 *    generation's rows as segment maintenance does once no version references them) at the exact point between reads.
 */
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { importFromFile } from '../src/core/import-file.ts';
import { readPageBodyPolicy } from '../src/core/page-body/limits.ts';
import { materializeSegmentedBody } from '../src/core/page-body/ingest.ts';
import { openSegmentedBody } from '../src/core/page-body/read-range.ts';
import { readTiledManifest } from '../src/core/page-body/body-tiling.ts';
import { parseMarkdown } from '../src/core/markdown.ts';

let engine: PGLiteEngine;
let dir: string;
const SLUG = 'notes/live-example';

const line = (tag: string, i: number) => '- ' + tag + String(i).padStart(9, '0') + ' acme-example journal line with enough text to fill a segment\n';
const truth = (tag: string, bytes: number) => '# Live Example\n\n' + Array.from({ length: Math.ceil(bytes / line(tag, 0).length) }, (_, i) => line(tag, i)).join('');

const published: Record<string, string> = {};

async function publish(tag: string, bytes: number, name = tag, title = 'Live Example', body = truth(tag, bytes)): Promise<void> {
  const file = join(dir, name + '.md');
  published[name] = '---\ntype: concept\ntitle: ' + title + '\n---\n\n' + body;
  writeFileSync(file, published[name]);
  expect(await importFromFile(engine, file, SLUG + '.md', { noEmbed: true, bodyPolicy: await readPageBodyPolicy(engine) })).toMatchObject({ status: 'imported' });
}

async function pageRow(): Promise<{ id: number; generation: number; bytes: number }> {
  const [row] = await engine.executeRaw<{ id: number; body_generation: number; body_bytes: number; body_storage: string }>(
    'SELECT id, body_generation, body_bytes, body_storage FROM pages WHERE slug=$1', [SLUG]);
  expect(row!.body_storage).toBe('segmented');
  return { id: Number(row!.id), generation: Number(row!.body_generation), bytes: Number(row!.body_bytes) };
}

/** The engine with `hook` run once, at the first call of `method` whose arguments `when` accepts, before or after the real call. */
function interleaved(method: 'readManifest' | 'executeRaw' | 'readPageSnapshot', when: (args: unknown[]) => boolean, at: 'before' | 'after', hook: () => Promise<void>): BrainEngine {
  let armed = true;
  return new Proxy(engine, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (key !== method) return typeof value === 'function' ? value.bind(target) : value;
      return async (...args: unknown[]) => {
        const fire = armed && when(args);
        if (fire) armed = false;
        if (fire && at === 'before') await hook();
        const out = await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
        if (fire && at === 'after') await hook();
        return out;
      };
    },
  }) as unknown as BrainEngine;
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 60_000);

beforeEach(async () => {
  await resetPgliteState(engine);
  await engine.setConfig('pages.segmented_storage', 'on');
  dir = mkdtempSync(join(tmpdir(), 'gbrain-seg-race-'));
  await publish('a', 2 * 1024 * 1024);
});

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('GBRA-287: segmented reads across a concurrent publish', () => {
  test('a live read-back keeps one generation when a body publishes between its rows and its size check', async () => {
    const before = await pageRow();
    const reader = interleaved('readManifest', () => true, 'after', () => publish('b', 3 * 1024 * 1024));
    const body = await materializeSegmentedBody(reader, before.id, 'default');
    const after = await pageRow();
    expect(after.generation).toBeGreaterThan(before.generation);
    expect(after.bytes).not.toBe(before.bytes);
    expect(body.compiled_truth).toBe(parseMarkdown(published.a!, SLUG + '.md').compiled_truth);
  }, 120_000);

  test('a live open whose generation a publish retired opens the new live body', async () => {
    const before = await pageRow();
    const isManifestRead = (args: unknown[]) => typeof args[0] === 'string' && (args[0] as string).includes('JOIN page_body_manifest m ON m.page_id=$1');
    const reader = interleaved('executeRaw', isManifestRead, 'before', async () => {
      await publish('b', 3 * 1024 * 1024);
      const live = await pageRow();
      await engine.executeRaw('DELETE FROM page_body_manifest WHERE page_id=$1 AND staging_id IS NULL AND gen_to IS NOT NULL AND gen_to<=$2', [live.id, live.generation]);
    });
    const body = await openSegmentedBody(reader, { pageId: before.id });
    const after = await pageRow();
    expect(after.generation).toBeGreaterThan(before.generation);
    expect(body.generation).toBe(after.generation);
    expect(body.rows.reduce((sum, row) => sum + row.byteLen, 0)).toBe(after.bytes);
  }, 120_000);

  test('a live read whose generation a publish retired, leaving only a shared prefix of its rows, reads the new generation whole', async () => {
    await publish('p', 2 * 1024 * 1024);
    const before = await pageRow();
    const half = truth('p', 1024 * 1024);
    await publish('p', 3 * 1024 * 1024, 'p-new-tail', 'Live Example', half + Array.from({ length: Math.ceil(2 * 1024 * 1024 / line('q', 0).length) }, (_, i) => line('q', i)).join(''));
    const live = await pageRow();
    await engine.executeRaw('DELETE FROM page_versions WHERE page_id=$1 AND body_generation=$2', [live.id, before.generation]);
    await engine.executeRaw('DELETE FROM page_body_manifest WHERE page_id=$1 AND staging_id IS NULL AND gen_to IS NOT NULL AND gen_to<=$2', [live.id, live.generation]);
    const prefix = await engine.readManifest(live.id, { generation: before.generation });
    expect(prefix.length).toBeGreaterThan(0);
    expect(prefix.reduce((sum, row) => sum + row.byteLen, 0)).toBeLessThan(before.bytes);
    let stale = true;
    const reader = new Proxy(engine, {
      get(target, key) {
        const value = Reflect.get(target, key, target);
        if (key !== 'executeRaw') return typeof value === 'function' ? value.bind(target) : value;
        return async (sql: string, params?: unknown[]) => {
          if (stale && /^SELECT body_generation(, body_bytes)? FROM pages/.test(sql)) { stale = false; return [{ body_generation: before.generation, body_bytes: before.bytes }]; }
          return target.executeRaw(sql, params as never);
        };
      },
    }) as unknown as BrainEngine;
    const read = await readTiledManifest(reader, before.id);
    expect(read.generation).toBe(live.generation);
    expect(read.rows.reduce((sum, row) => sum + row.byteLen, 0)).toBe(live.bytes);
  }, 120_000);

  test('the streamed file of a snapshot is never one revision\'s frontmatter over the next revision\'s body', async () => {
    const snapshot = await engine.readPageSnapshot(SLUG, { sourceId: 'default' });
    await publish('b', 2 * 1024 * 1024, 'b', 'Live Example Renamed');
    const { unreadPageFile } = await import('../src/core/persistence/page-prepare.ts');
    const { mayReprepare } = await import('../src/core/persistence/semantic.ts');
    const refused = await unreadPageFile(engine, snapshot!).then(() => null, (error: { code?: string }) => error);
    expect(refused).toMatchObject({ code: 'revision_conflict' });
    expect(mayReprepare({ operation: 'add_tag', intent: {} } as never, refused!)).toBe(true);
  }, 120_000);
});
