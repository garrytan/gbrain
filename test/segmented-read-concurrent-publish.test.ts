/**
 * GBRA-287: a segmented page read while a new body publishes (forced probe).
 *
 * 1. Protects: a reader of a page stored in segments never refuses a healthy page `page_body_rows_unreadable` because a
 *    publish landed between its statements. A live read names its generation first and checks that generation's rows
 *    against that generation's size (`readSegmentedBody`, behind readPageSnapshot's read-back), and a live open whose
 *    generation a publish retired before its rows were read opens the new live generation (`openSegmentedBody`).
 * 2. Fails when: the rows of one generation are checked against the next generation's body_bytes, or a retired
 *    generation's missing rows refuse the read instead of reading the live body.
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

let engine: PGLiteEngine;
let dir: string;
const SLUG = 'notes/live-example';

const line = (tag: string, i: number) => '- ' + tag + String(i).padStart(9, '0') + ' acme-example journal line with enough text to fill a segment\n';
const truth = (tag: string, bytes: number) => '# Live Example\n\n' + Array.from({ length: Math.ceil(bytes / line(tag, 0).length) }, (_, i) => line(tag, i)).join('');

async function publish(tag: string, bytes: number): Promise<void> {
  const file = join(dir, tag + '.md');
  writeFileSync(file, '---\ntype: concept\ntitle: Live Example\n---\n\n' + truth(tag, bytes));
  expect(await importFromFile(engine, file, SLUG + '.md', { noEmbed: true, bodyPolicy: await readPageBodyPolicy(engine) })).toMatchObject({ status: 'imported' });
}

async function pageRow(): Promise<{ id: number; generation: number; bytes: number }> {
  const [row] = await engine.executeRaw<{ id: number; body_generation: number; body_bytes: number; body_storage: string }>(
    'SELECT id, body_generation, body_bytes, body_storage FROM pages WHERE slug=$1', [SLUG]);
  expect(row!.body_storage).toBe('segmented');
  return { id: Number(row!.id), generation: Number(row!.body_generation), bytes: Number(row!.body_bytes) };
}

/** The engine with `hook` run once, at the first call of `method` whose arguments `when` accepts, before or after the real call. */
function interleaved(method: 'readManifest' | 'executeRaw', when: (args: unknown[]) => boolean, at: 'before' | 'after', hook: () => Promise<void>): BrainEngine {
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
    expect(body.compiled_truth).toBe(truth('a', 2 * 1024 * 1024).trimEnd() === body.compiled_truth ? body.compiled_truth : truth('a', 2 * 1024 * 1024));
    expect(body.compiled_truth.startsWith('# Live Example\n\n- a000000000')).toBe(true);
    expect(body.compiled_truth).not.toContain('- b000000000');
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
});
