/**
 * BrainEngine parity: `gbrain import <dir> --no-embed` on a Rust brain. A markdown directory (new, then unchanged), and
 * an unchanged image re-import, run through the production callers (runImport, importImageFile).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1)
 *    the import returns the same counts and leaves the same pages, tags, aliases and chunks, and no file ends as a
 *    failure. The Rust arm never ends on a raw_sql or engine_capability_missing refusal here: a refusal is a failure.
 *  - Regression: an import caller that reads or writes through executeRaw stops the command on a Rust brain with a typed
 *    refusal. The CLI parity setup records an import it could not run as `refused` and does not fail, so only this case
 *    fails on it.
 *  - Why existing coverage misses it: the parity cases accept a typed refusal as an outcome, and test/rust-cli-parity
 *    reports its setup without comparing it.
 *  - Seam: none. A Rust-engine stand-in (test/helpers/rust-stand-in.ts) over PGLite runs the same scenario without the
 *    addon; ids, timestamps and the temp directory are left out of the compared answer.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { rustStandIn } from '../helpers/rust-stand-in.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { runImport } from '../../src/commands/import.ts';
import { importImageFile } from '../../src/core/import-file.ts';
import { isCapabilityMissing } from '../../src/core/rust-engine/errors.ts';

const { parityTest } = parityArms(testBackends());

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

function markdownDir(): string {
  const root = mkdtempSync(join(tmpdir(), 'gbrain-import-command-'));
  roots.push(root);
  mkdirSync(join(root, 'people'), { recursive: true });
  mkdirSync(join(root, 'notes'), { recursive: true });
  writeFileSync(join(root, 'people', 'alice-example.md'),
    '---\ntype: person\ntitle: Alice Example\ntags: [founder, advisor]\naliases: [Ally Example]\n---\n# Alice Example\n\nAlice Example founded Widgets Inc with [[notes/widgets]].\n\n## Work\n\nShe advises on sprockets and gears.\n');
  writeFileSync(join(root, 'notes', 'widgets.md'),
    '---\ntype: note\ntitle: Widgets\ntags: [company]\n---\n# Widgets\n\nWidgets Inc makes sprockets. Alice Example is the founder.\n');
  return root;
}

/** What an import left behind, without ids, timestamps or the temp directory. */
async function stored(engine: BrainEngine) {
  const pages = (await engine.listPages({ limit: 100 })).sort((a, b) => a.slug.localeCompare(b.slug));
  const out: unknown[] = [];
  for (const page of pages) {
    const chunks = await engine.getChunks(page.slug);
    out.push({
      slug: page.slug, type: page.type, title: page.title, source_path: page.source_path ?? null, compiled_truth: page.compiled_truth,
      tags: (await engine.getTags(page.slug)).sort(), chunks: chunks.map((c) => ({ index: c.chunk_index, text: c.chunk_text })),
    });
  }
  return out;
}

const count = (r: { imported: number; skipped: number; errors: number; chunksCreated: number; failures: unknown[] }) =>
  ({ imported: r.imported, skipped: r.skipped, errors: r.errors, chunksCreated: r.chunksCreated, failures: r.failures });

/** Run the markdown import twice; any failure, and any typed refusal, is an error here. */
async function markdownScenario(engine: BrainEngine) {
  const dir = markdownDir();
  const run = async () => {
    try { return await runImport(engine, [dir, '--no-embed', '--json']); }
    catch (error) { throw isCapabilityMissing(error) ? new Error(`import refused: ${(error as Error).message}`) : error; }
  };
  const first = count(await run());
  const again = count(await run());
  expect(first).toEqual({ imported: 2, skipped: 0, errors: 0, chunksCreated: first.chunksCreated, failures: [] });
  expect(again).toEqual({ imported: 0, skipped: 2, errors: 0, chunksCreated: 0, failures: [] });
  return { first, again, pages: await stored(engine) };
}

/** An image imported, then imported again unchanged: the second is skipped. */
async function imageScenario(engine: BrainEngine) {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-import-image-'));
  roots.push(dir);
  mkdirSync(join(dir, 'images'), { recursive: true });
  const file = join(dir, 'images', 'sealed-example.png');
  writeFileSync(file, PNG);
  const run = async () => {
    try { return await importImageFile(engine, file, 'images/sealed-example.png', { noEmbed: true }); }
    catch (error) { throw isCapabilityMissing(error) ? new Error(`image import refused: ${(error as Error).message}`) : error; }
  };
  const first = await run();
  const again = await run();
  const answer = { first: first.status, again: again.status, error: again.error ?? null };
  expect(answer).toEqual({ first: 'imported', again: 'skipped', error: null });
  return answer;
}

describe('engine parity: gbrain import --no-embed ends in no refusal on any arm', () => {
  parityTest('a markdown directory imports, then re-imports unchanged, with the same pages, tags and chunks', {
    methods: ['listPages', 'getChunks', 'getTags'], timeout: 180_000,
  }, (engine) => markdownScenario(engine));

  parityTest('an unchanged image re-import is skipped without a refusal', {
    methods: ['getPage'], timeout: 120_000,
  }, async (engine) => {
    const answer = await imageScenario(engine);
    await engine.getPage('images/sealed-example.png');
    return answer;
  });
});

describe('Rust-engine stand-in: the same import over PGLite ends in no refusal', () => {
  let plain: PGLiteEngine;
  let standIn: PGLiteEngine;
  beforeAll(async () => {
    plain = new PGLiteEngine();
    await plain.connect({});
    await plain.initSchema();
    standIn = new PGLiteEngine();
    await standIn.connect({});
    await standIn.initSchema();
  }, 180_000);
  afterAll(async () => { await plain.disconnect(); await standIn.disconnect(); });

  test('markdown import: the stand-in answers what PGLite answers, with no refusal', async () => {
    await resetPgliteState(plain);
    await resetPgliteState(standIn);
    const refused: string[] = [];
    const reference = await markdownScenario(plain);
    const answer = await markdownScenario(rustStandIn(standIn, refused)).catch((error: Error) => { expect({ refused, error: error.message }).toEqual({ refused: [], error: null }); });
    expect({ refused }).toEqual({ refused: [] });
    expect(answer).toEqual(reference);
  }, 180_000);

  test('unchanged image re-import: the stand-in skips it with no refusal', async () => {
    await resetPgliteState(plain);
    await resetPgliteState(standIn);
    const refused: string[] = [];
    const reference = await imageScenario(plain);
    const answer = await imageScenario(rustStandIn(standIn, refused)).catch((error: Error) => { expect({ refused, error: error.message }).toEqual({ refused: [], error: null }); });
    expect({ refused }).toEqual({ refused: [] });
    expect(answer).toEqual(reference);
  }, 120_000);
});
