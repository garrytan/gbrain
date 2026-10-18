/**
 * Wave B (spec 2.2, 3.1): a streamed import's memory does not follow the page.
 *
 * Protects: importing a 32 MiB conversation page through importFromFile on
 * PGLite (the streamed segmented path), in a fresh child process,
 * - holds under 32 MiB of live heap more than before the import once every
 *   segment text is staged (after a full GC; ~12 MiB measured, ~117 MiB when
 *   outline headings pinned their segment texts), and
 * - peaks (VmHWM, reset after schema init) under 450 MiB above the same child
 *   importing a 1 MiB page through the same entry point (the single-string
 *   path; the streamed path starts above PAGE_MAX_BYTES): ~300 MiB measured,
 *   ~600 with PGLite's own bytea codec, ~860 without a collection per staging
 *   batch, ~1180 with neither fix.
 * Fails when: segment metadata keeps substrings of the segment text (outline
 * headings, dates: the manifest rows pinned the whole decoded body), staging
 * batches pile up garbage between collections, or PGLite's per-byte bytea
 * codec comes back.
 * Why existing coverage misses it: segmented-ingest.test.ts checks rows and
 * bytes, body-scan-memory.test.ts only pass 1.
 * Seams: a child process per import (VmHWM is per process); bun:jsc heapStats
 * after Bun.gc(true) at the `segmented:texts_staged` fault point; no mocks.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { conversationPage } from '../helpers/conversation-page.ts';

const REPO = resolve(import.meta.dir, '../..');
const RETAINED_LIMIT_MIB = 32;
const PEAK_DELTA_LIMIT_MIB = 450;
const dir = mkdtempSync(join(tmpdir(), 'segmented-ingest-memory-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const CHILD = `
import { readFileSync, writeFileSync } from 'node:fs';
import { heapStats } from 'bun:jsc';
import { createEngine } from ${JSON.stringify(join(REPO, 'src/core/engine-factory.ts'))};
import { importFromFile } from ${JSON.stringify(join(REPO, 'src/core/import-file.ts'))};
import { readPageBodyPolicy } from ${JSON.stringify(join(REPO, 'src/core/page-body/limits.ts'))};
import { installFaultHook } from ${JSON.stringify(join(REPO, 'src/core/persistence/fault-points.ts'))};
const [file, brain] = process.argv.slice(-2);
const live = () => { Bun.gc(true); const s = heapStats(); return (s.heapSize + s.extraMemorySize) / 2 ** 20; };
const engine = await createEngine({ engine: 'pglite', database_path: brain });
await engine.connect({ engine: 'pglite', database_path: brain });
await engine.initSchema();
await engine.setConfig('pages.segmented_storage', 'on');
const bodyPolicy = await readPageBodyPolicy(engine);
const start = live();
writeFileSync('/proc/self/clear_refs', '5');
let retained = null;
installFaultHook(async point => { if (point === 'segmented:texts_staged') retained = live() - start; });
const result = await importFromFile(engine, file, 'notes/memory-example.md', { noEmbed: true, bodyPolicy });
const peak = Number(/^VmHWM:\\s+(\\d+) kB$/m.exec(readFileSync('/proc/self/status', 'utf8'))[1]) / 1024;
await engine.disconnect();
console.log(JSON.stringify({ status: result.status, error: result.error ?? null, peak, retained }));
`;

function importInChild(mib: number): { status: string; error: string | null; peak: number; retained: number | null } {
  const file = join(dir, `page-${mib}.md`);
  writeFileSync(file, conversationPage(mib * 2 ** 20, { seed: 1 }));
  const run = spawnSync(process.execPath, ['--no-env-file', '-e', CHILD, file, join(dir, `brain-${mib}`)],
    { cwd: REPO, encoding: 'utf8', timeout: 300_000, maxBuffer: 1 << 22 });
  rmSync(file, { force: true });
  const line = run.stdout.trim().split('\n').pop() ?? '';
  if (run.status !== 0 || !line.startsWith('{')) throw new Error(`child import of ${mib} MiB failed (${run.status}):\n${run.stderr.slice(-2000)}`);
  return JSON.parse(line);
}

describe.skipIf(!existsSync('/proc/self/status'))('segmented ingest memory', () => {
  test(`a 32 MiB import retains under ${RETAINED_LIMIT_MIB} MiB while staged and peaks under ${PEAK_DELTA_LIMIT_MIB} MiB above a 1 MiB one`, () => {
    const small = importInChild(1);
    const large = importInChild(32);
    expect(small.status).toBe('imported');
    expect(large).toMatchObject({ status: 'imported', error: null });
    expect(large.retained).not.toBeNull();
    expect(large.retained!).toBeLessThan(RETAINED_LIMIT_MIB);
    expect(large.peak - small.peak).toBeLessThan(PEAK_DELTA_LIMIT_MIB);
  }, 600_000);
});
