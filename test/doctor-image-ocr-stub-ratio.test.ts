/**
 * Tests for the `image_ocr_stub_ratio` doctor check (issue #2682).
 *
 * `ocr_health` (existing, v0.27.1) is a lifetime-cumulative counter check:
 * once ANY OCR call has ever succeeded, it reports 'ok' forever even if OCR
 * starts failing for every subsequent image. `image_ocr_stub_ratio` instead
 * looks at the actual content of image chunks created in the last 24h, so a
 * fresh OCR outage is visible independent of the brain's OCR history.
 *
 * Hermetic PGLite for the local-surface path (same pattern as
 * test/doctor-orphan-ratio.test.ts).
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runDoctor, type DoctorReport } from '../src/commands/doctor.ts';
import { setCliOptions } from '../src/core/cli-options.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let stdoutBuffer: string[];
const origLog = console.log;
const origErr = console.error;
const origExit = process.exit;

function captureCli(): void {
  stdoutBuffer = [];
  console.log = (msg?: unknown) => { stdoutBuffer.push(typeof msg === 'string' ? msg : String(msg)); };
  console.error = () => {};
  (process as { exit: unknown }).exit = (() => { throw new Error('__exit'); }) as unknown as typeof process.exit;
}

function restoreCli(): void {
  console.log = origLog;
  console.error = origErr;
  (process as { exit: unknown }).exit = origExit;
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  setCliOptions({ quiet: true, progressJson: false, progressInterval: 1000, explain: false, timeoutMs: null });
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
  restoreCli();
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM content_chunks');
  await engine.executeRaw('DELETE FROM pages');
});

async function runDoctorJson(): Promise<DoctorReport> {
  captureCli();
  try {
    // DON'T pass --fast — this check lives in the same DB-checks group as
    // ocr_health/image_assets, which --fast skips.
    await runDoctor(engine, ['--json']);
  } catch (e) {
    if (!(e instanceof Error && e.message === '__exit')) throw e;
  } finally {
    restoreCli();
  }
  for (let i = stdoutBuffer.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(stdoutBuffer[i]!);
      if (parsed && typeof parsed === 'object' && 'checks' in parsed) {
        return parsed as DoctorReport;
      }
    } catch {
      // skip non-JSON lines
    }
  }
  throw new Error('No DoctorReport JSON found in stdout');
}

function findCheck(report: DoctorReport, name: string) {
  return report.checks.find(c => c.name === name);
}

/**
 * Seed `n` image_asset chunks, each on its own page, with the given
 * chunk_text and an explicit created_at offset (hoursAgo=0 → now).
 */
async function seedImageChunks(
  prefix: string,
  n: number,
  chunkText: string,
  hoursAgo: number,
): Promise<void> {
  for (let i = 0; i < n; i++) {
    const slug = `${prefix}/img-${i}.png`;
    await engine.putPage(slug, {
      type: 'image', title: slug, compiled_truth: '', timeline: '', frontmatter: {},
    });
    const page = await engine.getPage(slug);
    await engine.executeRaw(
      `INSERT INTO content_chunks (page_id, chunk_index, chunk_text, chunk_source, modality, created_at)
       VALUES ($1, 0, $2, 'image_asset', 'image', now() - ($3 || ' hours')::interval)`,
      [page!.id, chunkText, String(hoursAgo)],
    );
  }
}

describe('runDoctor — image_ocr_stub_ratio check (issue #2682)', () => {
  test('OCR opt-in off → status ok, not applicable', async () => {
    await withEnv({ GBRAIN_EMBEDDING_IMAGE_OCR: undefined }, async () => {
      await seedImageChunks('a', 10, 'x', 1); // short stub text, would WARN if OCR were on
      const report = await runDoctorJson();
      const check = findCheck(report, 'image_ocr_stub_ratio');
      expect(check).toBeDefined();
      expect(check!.status).toBe('ok');
      expect(check!.message).toMatch(/off/i);
    });
  });

  test('OCR on, < 5 recent image chunks → vacuous status ok', async () => {
    await withEnv({ GBRAIN_EMBEDDING_IMAGE_OCR: 'true' }, async () => {
      await seedImageChunks('b', 3, 'x', 1); // 3 stubs, below the n=5 floor
      const report = await runDoctorJson();
      const check = findCheck(report, 'image_ocr_stub_ratio');
      expect(check!.status).toBe('ok');
      expect(check!.message).toMatch(/too few/i);
    });
  });

  test('OCR on, >50% recent stubs → warn (reproduces issue #2682\'s reported scenario)', async () => {
    await withEnv({ GBRAIN_EMBEDDING_IMAGE_OCR: 'true' }, async () => {
      // 8 stubs (short chunk_text, OCR failed) + 2 real OCR text (long) = 80% stub.
      await seedImageChunks('c-stub', 8, 'photo.png', 1);
      await seedImageChunks(
        'c-ok', 2,
        'A detailed OCR transcription of the visible text in this image, well over one hundred and twenty characters long so it does not count as a stub.',
        1,
      );
      const report = await runDoctorJson();
      const check = findCheck(report, 'image_ocr_stub_ratio');
      expect(check!.status).toBe('warn');
      expect(check!.message).toContain('8/10');
      expect(check!.message).toMatch(/may indicate OCR is failing/i);
    });
  });

  test('OCR on, <=50% recent stubs → status ok', async () => {
    await withEnv({ GBRAIN_EMBEDDING_IMAGE_OCR: 'true' }, async () => {
      // 2 stubs + 8 real OCR text = 20% stub.
      await seedImageChunks('d-stub', 2, 'photo.png', 1);
      await seedImageChunks(
        'd-ok', 8,
        'A detailed OCR transcription of the visible text in this image, well over one hundred and twenty characters long so it does not count as a stub.',
        1,
      );
      const report = await runDoctorJson();
      const check = findCheck(report, 'image_ocr_stub_ratio');
      expect(check!.status).toBe('ok');
      expect(check!.message).toContain('2/10');
    });
  });

  test('stubs older than 24h are excluded from the ratio', async () => {
    await withEnv({ GBRAIN_EMBEDDING_IMAGE_OCR: 'true' }, async () => {
      // 20 stale stubs (30h old) — would WARN if counted, but must be excluded.
      await seedImageChunks('e-old', 20, 'photo.png', 30);
      const report = await runDoctorJson();
      const check = findCheck(report, 'image_ocr_stub_ratio');
      // Zero chunks in the 24h window → vacuous 'ok', not 'warn'.
      expect(check!.status).toBe('ok');
      expect(check!.message).toMatch(/too few/i);
    });
  });

  test('JSON envelope shape — image_ocr_stub_ratio appears in checks[]', async () => {
    await withEnv({ GBRAIN_EMBEDDING_IMAGE_OCR: undefined }, async () => {
      const report = await runDoctorJson();
      const names = report.checks.map(c => c.name);
      expect(names).toContain('image_ocr_stub_ratio');
    });
  });
});
