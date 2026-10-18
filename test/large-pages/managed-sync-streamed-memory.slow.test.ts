/**
 * Wave B (spec 3.1): managed sync of a page over the single-string ceiling
 * streams it, so its memory does not follow the page.
 *
 * Protects: `performManagedSync` of a committed 32 MiB conversation page on
 * PGLite (frozen by reference, streamed by its owner in the same process), in
 * a fresh child process, peaks (VmHWM, reset after setup) under 450 MiB above
 * the same child syncing a 1 MiB page (the single-string path), as the
 * streamed import does (segmented-ingest-memory.slow.test.ts), and retains
 * under 16 MiB more heap than it: the heap is sampled after a full GC at every
 * persistence seam the sync passes (freeze, preparation, staging, flip,
 * commit, projection) and at its end, and the largest sample is compared.
 * The two are measured in separate children, so the sampling GCs never lower
 * the peak.
 * The peak bound alone let through code that keeps the whole page alive (a
 * mutant holding every segment's text peaked 256 MiB above, under 450); the
 * retained bound is half the page, so holding it whole at any seam fails.
 * Fails when: the freeze or the preparation reads the file as one buffer or
 * string (the journal, the screen, the pinned-blob window), anything keeps
 * the whole page reachable across a seam, or the page is held instead of
 * published.
 * Seams: a child process per sync (VmHWM is per process); the process-wide
 * fault hook (fault-points.ts) as the sampling point; no mocks.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { conversationPage } from '../helpers/conversation-page.ts';

const REPO = resolve(import.meta.dir, '../..');
const PEAK_DELTA_LIMIT_MIB = 450;
const RETAINED_DELTA_LIMIT_MIB = 16;
const dir = mkdtempSync(join(tmpdir(), 'managed-sync-streamed-memory-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const CHILD = `
import { readFileSync, writeFileSync } from 'node:fs';
import { createEngine } from ${JSON.stringify(join(REPO, 'src/core/engine-factory.ts'))};
import { claimWorktree } from ${JSON.stringify(join(REPO, 'src/core/persistence/ownership.ts'))};
import { performManagedSync } from ${JSON.stringify(join(REPO, 'src/core/persistence/sync-run.ts'))};
import { disposePersistenceConsumer } from ${JSON.stringify(join(REPO, 'src/core/persistence/service.ts'))};
import { installFaultHook } from ${JSON.stringify(join(REPO, 'src/core/persistence/fault-points.ts'))};
const [root, brain, mode] = process.argv.slice(-3);
const engine = await createEngine({ engine: 'pglite', database_path: brain });
await engine.connect({ engine: 'pglite', database_path: brain });
await engine.initSchema();
await engine.setConfig('pages.segmented_storage', 'on');
await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES('memory','memory',$1,'{}')", [root]);
await claimWorktree(engine, 'memory', root);
await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
Bun.gc(true);
writeFileSync('/proc/self/clear_refs', '5');
let retained = 0;
let samples = 0;
const sample = () => { Bun.gc(true); retained = Math.max(retained, process.memoryUsage().heapUsed / 2 ** 20); samples++; };
if (mode === 'retained') installFaultHook(sample);
let result;
for (let pass = 0; pass < 30; pass++) {
  result = await performManagedSync(engine, { sourceId: 'memory', noPull: true, noEmbed: true });
  if (result.status !== 'partial') break;
}
if (mode === 'retained') { sample(); installFaultHook(undefined); }
const peak = Number(/^VmHWM:\\s+(\\d+) kB$/m.exec(readFileSync('/proc/self/status', 'utf8'))[1]) / 1024;
const [page] = await engine.executeRaw("SELECT body_storage FROM pages WHERE source_id='memory' AND slug='notes/memory-example'");
await disposePersistenceConsumer(engine);
await engine.disconnect();
console.log(JSON.stringify({ status: result.status, storage: page?.body_storage ?? null, peak, retained, samples }));
`;

function syncInChild(mib: number, mode: 'peak' | 'retained'): { status: string; storage: string | null; peak: number; retained: number; samples: number } {
  const root = join(dir, `repo-${mib}-${mode}`);
  mkdirSync(join(root, 'notes'), { recursive: true });
  writeFileSync(join(root, 'notes/memory-example.md'), conversationPage(mib * 2 ** 20, { seed: 1 }));
  const git = (...args: string[]) => execFileSync('git', ['-C', root, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q'); git('add', '-A'); git('-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'memory');
  const run = spawnSync(process.execPath, ['--no-env-file', '-e', CHILD, root, join(dir, `brain-${mib}-${mode}`), mode],
    { cwd: REPO, encoding: 'utf8', timeout: 300_000, maxBuffer: 1 << 22,
      env: { ...process.env, GBRAIN_HOME: join(dir, `home-${mib}-${mode}`), OPENAI_API_KEY: '', VOYAGE_API_KEY: '', ANTHROPIC_API_KEY: '' } });
  const line = run.stdout.trim().split('\n').pop() ?? '';
  if (run.status !== 0 || !line.startsWith('{')) throw new Error(`child sync of ${mib} MiB failed (${run.status}):\n${run.stderr.slice(-2000)}`);
  return JSON.parse(line);
}

describe.skipIf(!existsSync('/proc/self/status'))('managed sync streamed memory', () => {
  test(`a 32 MiB page syncs segmented, peaks under ${PEAK_DELTA_LIMIT_MIB} MiB and retains under ${RETAINED_DELTA_LIMIT_MIB} MiB above a 1 MiB one`, () => {
    const small = syncInChild(1, 'peak');
    const large = syncInChild(32, 'peak');
    const smallHeap = syncInChild(1, 'retained');
    const largeHeap = syncInChild(32, 'retained');
    expect(small.status).toBe('first_sync');
    expect(large).toMatchObject({ status: 'first_sync', storage: 'segmented' });
    expect(largeHeap).toMatchObject({ status: 'first_sync', storage: 'segmented' });
    process.stderr.write(`managed sync peak: 1 MiB ${small.peak.toFixed(0)} MiB, 32 MiB ${large.peak.toFixed(0)} MiB; `
      + `retained after GC: 1 MiB ${smallHeap.retained.toFixed(0)} MiB, 32 MiB ${largeHeap.retained.toFixed(0)} MiB (${largeHeap.samples} samples)\n`);
    expect(large.peak - small.peak).toBeLessThan(PEAK_DELTA_LIMIT_MIB);
    expect(largeHeap.samples).toBeGreaterThan(5);
    expect(largeHeap.retained - smallHeap.retained).toBeLessThan(RETAINED_DELTA_LIMIT_MIB);
  }, 600_000);
});
