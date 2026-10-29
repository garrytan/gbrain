/**
 * Wave C PR 1G: the streamed generator's needles are found by decile keyword probes at 64 MiB.
 *
 * 1. Protects: test/helpers/conversation-stream.ts writes pages with flat memory (a fresh process writing 64 MiB peaks
 *    within 16 MiB of one writing 4 MiB), and once a 64 MiB page is committed to Git and indexed from the commit by managed sync
 *    (`pages.segmented_storage` on, no embeddings), a keyword search for each of its 10 decile needles finds it: 10/10.
 *    The large-page bench (scripts/bench-large-pages.ts) relies on both for its probes.
 * 2. Fails when: the generator buffers the page, a needle lands outside the indexed text, or a decile goes unfound.
 * 3. Runs on PGLite, and on Postgres when DATABASE_URL is set. Slow tier: about a minute per engine.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { operations, type OperationContext } from '../../src/core/operations.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { performManagedSync } from '../../src/core/persistence/sync-run.ts';
import { writeConversationFile } from '../helpers/conversation-stream.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';

const MiB = 1024 ** 2;
const home = mkdtempSync(join(tmpdir(), 'gbrain-stream-probes-'));
const env = { GBRAIN_HOME: home, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined };
afterAll(() => rmSync(home, { recursive: true, force: true }));

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
/** VmHWM of a fresh process that writes a `bytes` conversation file and exits. */
function writerPeakRss(bytes: number): number {
  const script = `const { writeConversationFile } = await import(${JSON.stringify(join(import.meta.dir, '../helpers/conversation-stream.ts'))});
writeConversationFile(${JSON.stringify(join(home, `peak-${bytes}.md`))}, ${bytes}, 3);
console.log(/^VmHWM:\\s+(\\d+) kB$/m.exec(require('node:fs').readFileSync('/proc/self/status', 'utf8'))[1]);`;
  const run = Bun.spawnSync([process.execPath, '-e', script], { stdout: 'pipe', stderr: 'pipe' });
  if (run.exitCode !== 0) throw new Error(`the writer child failed: ${run.stderr.toString()}`);
  return Number(run.stdout.toString().trim()) * 1024;
}
const search = operations.find(op => op.name === 'search')!;

for (const kind of testBackends()) describe(`streamed generator at 64 MiB (${kind})`, () => {
  let engine: BrainEngine;
  let close: () => Promise<void>;
  beforeAll(async () => {
    if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
    else { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); close = () => engine.disconnect(); }
  }, 120_000);
  afterAll(() => withEnv(env, async () => { await disposePersistenceConsumer(engine); await close(); }));

  test('flat memory while writing, then 10/10 decile keyword probes after Git commit and managed sync', () => withEnv(env, async () => {
    const root = join(home, `${kind}-content`);
    mkdirSync(join(root, 'notes'), { recursive: true });
    git(root, 'init', '-q');
    if (existsSync('/proc/self/status')) expect(writerPeakRss(64 * MiB) - writerPeakRss(4 * MiB)).toBeLessThan(16 * MiB);
    const file = writeConversationFile(join(root, 'notes/stream.md'), 64 * MiB, 11);
    git(root, 'add', 'notes/stream.md');
    git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', 'a 64 MiB page');

    await engine.setConfig('pages.segmented_storage', 'on');
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw("INSERT INTO sources(id,name,local_path,config) VALUES('stream-probes','stream-probes',$1,'{}'::jsonb)", [root]);
    await claimWorktree(engine, 'stream-probes', root);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
    for (let pass = 0; ; pass++) {
      const result = await performManagedSync(engine, { sourceId: 'stream-probes', noPull: true, noEmbed: true });
      if (result.status !== 'partial' || result.reason !== 'writer_pending' || pass === 60) break;
    }
    await disposePersistenceConsumer(engine);
    const [page] = await engine.executeRaw<{ body_storage: string; body_bytes: number | string; sealed: boolean }>(`SELECT body_storage, body_bytes,
      (text_projection_revision = knowledge_revision) IS TRUE AS sealed FROM pages WHERE source_id='stream-probes' AND slug='notes/stream' AND deleted_at IS NULL`);
    expect({ storage: page?.body_storage, sealed: page?.sealed }).toEqual({ storage: 'segmented', sealed: true });
    expect(Number(page!.body_bytes)).toBeGreaterThan(63 * MiB);

    const ctx: OperationContext = { engine, config: { engine: engine.kind, embedding_disabled: true }, sourceId: 'stream-probes',
      remote: false, dryRun: false, logger: { info() {}, warn() {}, error() {} } } as OperationContext;
    const found: number[] = [];
    for (const needle of file.needles) {
      const hits = await search.handler(ctx, { query: needle.word, match: 'keyword', limit: 5 }) as Array<{ slug: string }>;
      if (hits.some(hit => hit.slug === 'notes/stream')) found.push(needle.decile);
    }
    expect(found).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  }), 600_000);
});
