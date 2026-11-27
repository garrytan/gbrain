/**
 * BrainEngine parity: the two reads `gbrain import` of an unchanged image makes (the seal probe) and the distrusted-provenance
 * check makes. On a Rust brain each stopped the command with a raw_sql refusal.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1)
 *    an unchanged image is skipped when sealed, needs fresh OCR when distrusted and imports when clean, through typed
 *    members (readImageSealProbe, readPageChunkerVersion).
 *  - Regression: a caller that reads through executeRaw stops the command on Rust with a typed raw_sql refusal.
 *  - Why existing coverage misses it: the member parity files test members, not these callers.
 *  - Seam: none. Pages are written with `putPage` and the import; the callers run as production code.
 */
import { afterAll, describe, expect } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { importImageFile } from '../../src/core/import-file.ts';
import { OCR_REQUIRED_ERROR, provenanceDistrusted } from '../../src/core/search/safe-chunks.ts';

const { parityTest } = parityArms(testBackends());

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const PROTECTED = '<!--- gbrain:takes:begin -->\nSYNTHETIC_PRIVATE_IMAGE_CANARY\n<!--- gbrain:takes:end -->';
const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

const note = (title: string, frontmatter: Record<string, unknown> = {}, type = 'note') =>
  ({ type: type as 'note', title, compiled_truth: `${title}.`, timeline: '', frontmatter });

describe('engine parity: image import seal probe and chunker version', () => {
  parityTest('gbrain import of an unchanged image reads its seal and chunker version: a sealed one is skipped, a distrusted one needs fresh OCR, a clean one imports', {
    methods: ['putPage', 'getPage', 'readImageSealProbe', 'readPageChunkerVersion'],
    timeout: 120_000,
  }, async (engine) => {
    const root = mkdtempSync(join(tmpdir(), 'gbrain-parity-image-'));
    roots.push(root);
    mkdirSync(join(root, 'images'), { recursive: true });
    const run = async (slug: string, protectedBody: boolean | null) => {
      const file = join(root, slug);
      writeFileSync(file, PNG);
      const first = await importImageFile(engine, file, slug, { noEmbed: true });
      // Untouched since its import: sealed past the fence and complete, so the unchanged image is skipped.
      if (protectedBody === null) {
        const again = await importImageFile(engine, file, slug, { noEmbed: true });
        return { first: first.status, again: again.status, error: again.error ?? null };
      }
      const page = (await engine.getPage(slug))!;
      // A body write that removes a protected fence leaves the page distrusted (chunker_version < 0).
      if (protectedBody) await engine.putPage(slug, { ...page, page_kind: 'image', compiled_truth: PROTECTED });
      await engine.putPage(slug, { ...page, page_kind: 'image', compiled_truth: 'Public caption.' });
      const again = await importImageFile(engine, file, slug, { noEmbed: true });
      return { first: first.status, again: again.status, error: again.error ?? null };
    };
    const answer = {
      distrusted: await run('images/distrusted-example.png', true), clean: await run('images/clean-example.png', false),
      sealed: await run('images/sealed-example.png', null),
    };
    expect(answer).toEqual({
      distrusted: { first: 'imported', again: 'skipped', error: OCR_REQUIRED_ERROR },
      clean: { first: 'imported', again: 'imported', error: null },
      sealed: { first: 'imported', again: 'skipped', error: null },
    });
    return answer;
  });

  parityTest('provenanceDistrusted reads the stored chunker version: negative after a write removed a protected fence, not before, false for no page', {
    methods: ['putPage', 'getPage', 'readPageChunkerVersion'],
  }, async (engine) => {
    const write = async (slug: string, protectedFirst: boolean) => {
      if (protectedFirst) await engine.putPage(slug, { ...note('Image'), page_kind: 'image', compiled_truth: PROTECTED });
      await engine.putPage(slug, { ...note('Image'), page_kind: 'image', compiled_truth: 'Public caption.' });
      return (await engine.getPage(slug))!.id;
    };
    const distrusted = await write('images/distrusted-example.png', true);
    const clean = await write('images/clean-example.png', false);
    const answer = {
      distrusted: await provenanceDistrusted(engine, distrusted), clean: await provenanceDistrusted(engine, clean),
      missing: await provenanceDistrusted(engine, 2_000_000_000), sign: Math.sign((await engine.readPageChunkerVersion(distrusted))!.chunker_version!),
      none: await engine.readPageChunkerVersion(2_000_000_000),
    };
    expect(answer).toEqual({ distrusted: true, clean: false, missing: false, sign: -1, none: null });
    return answer;
  });

  parityTest('the seal probe answers null for a page that is absent or not chunked by the sealing chunker', {
    methods: ['putPage', 'readImageSealProbe'],
    timeout: 60_000,
  }, async (engine) => {
    await engine.putPage('images/probe-direct', note('Probe direct'));
    const answer = {
      absent: await engine.readImageSealProbe('default', 'images/no-such-page'),
      unsealed: await engine.readImageSealProbe('default', 'images/probe-direct'),
    };
    expect(answer).toEqual({ absent: null, unsealed: null });
    return answer;
  });
});
