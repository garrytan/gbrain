import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runPhaseSynthesize } from '../src/core/cycle/synthesize.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { configureGateway, resetGateway, __setChatTransportForTests, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { withEnv } from './helpers/with-env.ts';
import * as staleEmbedding from '../src/core/embed-stale.ts';
import { testBackends } from './helpers/test-backends.ts';

const backends = testBackends();
const engines: BrainEngine[] = [];
let dataDir: string;
let closePostgres: (() => Promise<void>) | undefined;
beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'gbrain-synth-postprocess-db-'));
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
  if (backends.includes('pglite')) {
    const engine = new PGLiteEngine();
    await engine.connect({ database_path: dataDir });
    await engine.initSchema();
    engines.push(engine);
  }
  if (backends.includes('postgres')) {
    const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
    engines.push(pg.engine);
    closePostgres = pg.close;
  }
}, 120_000);
afterAll(async () => {
  for (const engine of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
  await closePostgres?.();
  resetGateway();
  rmSync(dataDir, { recursive: true, force: true });
});

const laterQuote = 'a legitimate later quotation from a completely different interview';

async function fixture(run: (f: {
  engine: BrainEngine; sourceId: string; root: string;
  opts: { brainDir: string; sourceId: string; dryRun: boolean; inputFile: string; date: string };
  calls: () => number; edit: (slug: string) => Promise<void>;
}) => Promise<void>, outputCount = 1) {
  for (const engine of engines) {
    const dir = mkdtempSync(join(tmpdir(), 'gbrain-synth-postprocess-'));
    const root = join(dir, 'brain');
    mkdirSync(root);
    const sourceId = `synthesis-${randomUUID().slice(0, 8)}`;
    let calls = 0;
    try {
      await withEnv({ GBRAIN_HOME: join(dir, 'home'), ANTHROPIC_API_KEY: 'sk-test-synthesis' }, async () => {
        await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
        await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
        await engine.setConfig('sync.write_through', 'true');
        await claimWorktree(engine, sourceId, root);
        const ctx = { engine, sourceId, remote: false as const, config: { engine: engine.kind, embedding_disabled: true },
          dryRun: false, logger: { info() {}, warn() {}, error() {} } };
        await submitPageMutation(ctx, { operation: 'put_page', params: {
          slug: 'people/example', content: '---\ntitle: Example\ntype: note\n---\nExample evidence.', request_id: randomUUID(),
        } });
        const inputFile = join(root, '2026-09-20-session.txt');
        const quote = 'we charge for durability because reliable memories should survive every tool';
        writeFileSync(inputFile, `User: ${quote}.\n${'Assistant: Discuss the long term roadmap.\n'.repeat(15)}`);
        for (const [key, value] of Object.entries({
          'dream.synthesize.enabled': 'true', 'dream.synthesize.cooldown_hours': '0',
          'dream.synthesize.min_chars': '100', 'dream.synthesize.link_manifest': 'false',
          'dream.synthesize.mode': 'oneshot', 'dream.synthesize.quote_verify': 'true',
          'models.dream.synthesize': 'anthropic:claude-sonnet-4-6',
          'models.dream.triage': 'anthropic:claude-sonnet-4-6',
        })) await engine.setConfig(key, value);
        await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
        __setChatTransportForTests(async opts => {
          calls++;
          const hash = /hash suffix \(USE THIS in slugs\): ([a-z0-9-]+)/i.exec(String(opts.messages?.[0]?.content ?? ''))?.[1] ?? 'missing';
          const text = (opts.system ?? '').startsWith('You triage a conversation transcript')
            ? JSON.stringify({ score: 0.9, content_type: 'reflection', segments: [{ quote, note: 'evidence' }], entities: [], reasons: ['durable insight'] })
            : JSON.stringify({ pages: Array.from({ length: outputCount }, (_, i) => ({
              slug: `wiki/personal/reflections/session${i ? `-${i}` : ''}-${hash}`, title: `Session ${i}`, type: 'note',
              body: `A memory strategy with [[people/example]]. Evidence item ${i}. Allegedly: "an entirely invented quotation that should lose its marks".`,
            })), skipped: false });
          return { text, blocks: [{ type: 'text', text }], stopReason: 'end',
            usage: { input_tokens: 100, output_tokens: 100, cache_read_tokens: 0, cache_creation_tokens: 0 },
            model: opts.model!, providerId: 'anthropic' };
        });
        await run({ engine, sourceId, root, opts: { brainDir: root, sourceId, dryRun: false, inputFile, date: '2026-09-20' },
          calls: () => calls, edit: async slug => {
            const snapshot = (await engine.readPageSnapshot(slug, { sourceId }))!;
            await submitPageMutation(ctx, { operation: 'put_page', params: { slug,
              content: `---\ntitle: User revision\ntype: note\n---\nUser evidence: "${laterQuote}".`,
              expected_revision: snapshot.revision, request_id: randomUUID() } });
          } });
      });
    } finally {
      configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} });
      __setChatTransportForTests(null);
      __setEmbedTransportForTests(null);
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

async function outputSlug(engine: BrainEngine, sourceId: string): Promise<string> {
  const [row] = await engine.executeRaw<{ slug: string }>("SELECT slug FROM pages WHERE source_id=$1 AND slug LIKE 'wiki/personal/reflections/session-%'", [sourceId]);
  return row.slug;
}

async function interruptAfterChild(engine: BrainEngine, sourceId: string, opts: Parameters<typeof runPhaseSynthesize>[1]) {
  const controller = new AbortController();
  const result = await runPhaseSynthesize(engine, { ...opts, signal: controller.signal, yieldDuringPhase: async () => {
    const rows = await engine.executeRaw("SELECT id FROM minion_jobs WHERE status='completed' AND data->>'source_id'=$1", [sourceId]);
    if (rows.length) controller.abort();
  } });
  expect(result.status).toBe('fail');
  await disposePersistenceConsumer(engine);
  await engine.executeRaw('DELETE FROM dream_verdicts');
}

test('finalized synthesis never rewrites a later user quotation on same-transcript replay', async () => {
  await fixture(async ({ engine, sourceId, root, opts, calls, edit }) => {
    const first = await runPhaseSynthesize(engine, opts);
    expect(first.status).toBe('ok');
    expect(first.details.pages_written).toBe(1);
    const slug = await outputSlug(engine, sourceId);
    await edit(slug);
    const before = (await engine.readPageSnapshot(slug, { sourceId }))!;
    const path = join(root, `${slug}.md`);
    const bytes = readFileSync(path, 'utf8');
    const mtime = statSync(path).mtimeMs;
    const spent = calls();
    const receipts = await engine.executeRaw('SELECT id,state,outcome FROM persistence_requests WHERE source_id=$1 AND slug=$2 ORDER BY sequence', [sourceId, slug]);
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('DELETE FROM dream_verdicts');
    const replay = await runPhaseSynthesize(engine, opts);
    expect(replay.status).toBe('ok');
    expect(calls()).toBe(spent);
    expect((await engine.readPageSnapshot(slug, { sourceId }))!.revision).toBe(before.revision);
    expect(readFileSync(path, 'utf8')).toBe(bytes);
    expect(statSync(path).mtimeMs).toBe(mtime);
    expect(await engine.executeRaw('SELECT id,state,outcome FROM persistence_requests WHERE source_id=$1 AND slug=$2 ORDER BY sequence', [sourceId, slug])).toEqual(receipts);
    expect(replay.details.pages_written).toBe(0);
  });
}, 120_000);

test('interrupted synthesis postprocessing resumes once without rerunning either provider', async () => {
  await fixture(async ({ engine, sourceId, root, opts, calls }) => {
    await interruptAfterChild(engine, sourceId, opts);
    const slug = await outputSlug(engine, sourceId);
    expect((await engine.getPage(slug, { sourceId }))!.compiled_truth).toContain('"an entirely invented');
    const spent = calls();
    const recovered = await runPhaseSynthesize(engine, opts);
    expect(recovered.status).toBe('ok');
    expect(calls()).toBe(spent);
    expect(recovered.details.pages_written).toBe(1);
    const snapshot = (await engine.readPageSnapshot(slug, { sourceId }))!;
    expect(snapshot.page.compiled_truth).not.toContain('"an entirely invented');
    expect(snapshot.page.frontmatter.dream_generated).toBe(true);
    expect(readFileSync(join(root, `${slug}.md`), 'utf8')).toContain('dream_generated: true');
    await disposePersistenceConsumer(engine);
    const replay = await runPhaseSynthesize(engine, opts);
    expect(replay.status).toBe('ok');
    expect(replay.details.pages_written).toBe(0);
    expect((await engine.readPageSnapshot(slug, { sourceId }))!.revision).toBe(snapshot.revision);
    expect(calls()).toBe(spent);
  });
}, 120_000);

test('unfinished synthesis refuses an intervening user revision rather than adopting it', async () => {
  await fixture(async ({ engine, sourceId, root, opts, calls, edit }) => {
    await interruptAfterChild(engine, sourceId, opts);
    const slug = await outputSlug(engine, sourceId);
    await edit(slug);
    const snapshot = (await engine.readPageSnapshot(slug, { sourceId }))!;
    const path = join(root, `${slug}.md`);
    const bytes = readFileSync(path, 'utf8');
    const spent = calls();
    const replay = await runPhaseSynthesize(engine, opts);
    expect(replay.status).toBe('fail');
    expect(calls()).toBe(spent);
    expect((await engine.readPageSnapshot(slug, { sourceId }))!.revision).toBe(snapshot.revision);
    expect(readFileSync(path, 'utf8')).toBe(bytes);
  });
}, 120_000);

test('synthesis postprocessing refuses a concurrent edit after checking the child revision', async () => {
  await fixture(async ({ engine, sourceId, root, opts, calls, edit }) => {
    await interruptAfterChild(engine, sourceId, opts);
    const slug = await outputSlug(engine, sourceId);
    const read = engine.readPageSnapshot;
    let changed = false;
    const spy = spyOn(engine, 'readPageSnapshot').mockImplementation(async function (this: BrainEngine, target, options) {
      const snapshot = await read.call(this, target, options);
      if (this === engine && !changed && target === slug && options?.sourceId === sourceId) {
        changed = true;
        await edit(slug);
      }
      return snapshot;
    });
    const spent = calls();
    try {
      const result = await runPhaseSynthesize(engine, opts);
      expect(changed).toBe(true);
      expect(result.status).toBe('fail');
    } finally { spy.mockRestore(); }
    expect(calls()).toBe(spent);
    expect((await engine.readPageSnapshot(slug, { sourceId }))!.page.compiled_truth).toContain(`"${laterQuote}"`);
    expect(readFileSync(join(root, `${slug}.md`), 'utf8')).toContain(`"${laterQuote}"`);
  });
}, 120_000);

test('a committed postprocessing receipt survives interruption before the phase finishes', async () => {
  await fixture(async ({ engine, sourceId, root, opts, calls, edit }) => {
    await interruptAfterChild(engine, sourceId, opts);
    const slug = await outputSlug(engine, sourceId);
    const read = engine.readPageSnapshot;
    let interrupted = false;
    const spy = spyOn(engine, 'readPageSnapshot').mockImplementation(async function (this: BrainEngine, target, options) {
      if (this === engine && target.includes('dream-cycle-summaries/') && options?.sourceId === sourceId) {
        interrupted = true;
        throw new Error('simulated phase interruption after postprocessing commit');
      }
      return read.call(this, target, options);
    });
    const spent = calls();
    try {
      const result = await runPhaseSynthesize(engine, opts);
      expect(result.status).toBe('fail');
      expect(interrupted).toBe(true);
    } finally { spy.mockRestore(); }
    const processed = (await engine.readPageSnapshot(slug, { sourceId }))!;
    expect(processed.page.frontmatter.dream_generated).toBe(true);
    expect(processed.page.compiled_truth).not.toContain('"an entirely invented');
    const summarySlug = `dream-cycle-summaries/${opts.date}`;
    expect(await engine.readPageSnapshot(summarySlug, { sourceId })).toBeNull();
    expect(existsSync(join(root, `${summarySlug}.md`))).toBe(false);
    await edit(slug);
    const edited = (await engine.readPageSnapshot(slug, { sourceId }))!;
    const bytes = readFileSync(join(root, `${slug}.md`), 'utf8');
    await disposePersistenceConsumer(engine);
    const replay = await runPhaseSynthesize(engine, opts);
    expect(replay.status).toBe('ok');
    expect(replay.details.pages_written).toBe(0);
    expect(calls()).toBe(spent);
    expect((await engine.readPageSnapshot(slug, { sourceId }))!.revision).toBe(edited.revision);
    expect(readFileSync(join(root, `${slug}.md`), 'utf8')).toBe(bytes);
    const summary = (await engine.readPageSnapshot(summarySlug, { sourceId }))!;
    expect(summary.page.compiled_truth).toContain('**Pages written:** 1.');
    expect(summary.page.compiled_truth).toContain(`[[${slug}]]`);
    expect(readFileSync(join(root, `${summarySlug}.md`), 'utf8')).toContain(`[[${slug}]]`);
  });
}, 120_000);

test('same-date synthesis replay preserves the completed summary bytes and revision', async () => {
  await fixture(async ({ engine, sourceId, root, opts, calls, edit }) => {
    const first = await runPhaseSynthesize(engine, opts);
    expect(first.status).toBe('ok');
    const slug = await outputSlug(engine, sourceId);
    const summarySlug = String(first.details.summary_slug);
    const summaryPath = join(root, `${summarySlug}.md`);
    expect(readFileSync(summaryPath, 'utf8')).toContain(`[[${slug}]]`);
    const spent = calls();
    for (const userEdited of [false, true]) {
      if (userEdited) await edit(summarySlug);
      const before = (await engine.readPageSnapshot(summarySlug, { sourceId }))!;
      const bytes = readFileSync(summaryPath, 'utf8');
      const mtime = statSync(summaryPath).mtimeMs;
      const receipts = await engine.executeRaw('SELECT id,state,outcome FROM persistence_requests WHERE source_id=$1 ORDER BY sequence', [sourceId]);
      await disposePersistenceConsumer(engine);
      await engine.executeRaw('DELETE FROM dream_verdicts');
      const replay = await runPhaseSynthesize(engine, opts);
      expect(replay.status).toBe('ok');
      expect(replay.details.pages_written).toBe(0);
      expect(replay.details.reverse_write_count).toBe(0);
      expect(calls()).toBe(spent);
      expect((await engine.readPageSnapshot(summarySlug, { sourceId }))!.revision).toBe(before.revision);
      expect(readFileSync(summaryPath, 'utf8')).toBe(bytes);
      expect(statSync(summaryPath).mtimeMs).toBe(mtime);
      expect(await engine.executeRaw('SELECT id,state,outcome FROM persistence_requests WHERE source_id=$1 ORDER BY sequence', [sourceId])).toEqual(receipts);
    }
  });
}, 120_000);

test('partial multi-output recovery indexes every finalized output without republishing or embedding earlier outputs', async () => {
  await fixture(async ({ engine, sourceId, root, opts, calls }) => {
    await interruptAfterChild(engine, sourceId, opts);
    const outputs = await engine.executeRaw<{ slug: string }>(
      "SELECT slug FROM pages WHERE source_id=$1 AND slug LIKE 'wiki/personal/reflections/session-%' ORDER BY slug", [sourceId]);
    expect(outputs).toHaveLength(2);
    const [first, second] = outputs.map(row => row.slug);
    const read = engine.readPageSnapshot;
    let interrupted = false;
    const spy = spyOn(engine, 'readPageSnapshot').mockImplementation(async function (this: BrainEngine, target, options) {
      if (this === engine && target === second && options?.sourceId === sourceId) {
        interrupted = true;
        throw new Error('simulated interruption between output postprocessing commits');
      }
      return read.call(this, target, options);
    });
    const spent = calls();
    try {
      expect((await runPhaseSynthesize(engine, opts)).status).toBe('fail');
      expect(interrupted).toBe(true);
    } finally { spy.mockRestore(); }
    const firstSnapshot = (await engine.readPageSnapshot(first, { sourceId }))!;
    expect(firstSnapshot.page.frontmatter.dream_generated).toBe(true);
    expect((await engine.readPageSnapshot(second, { sourceId }))!.page.frontmatter.dream_generated).not.toBe(true);
    const firstBytes = readFileSync(join(root, `${first}.md`), 'utf8');
    const firstMtime = statSync(join(root, `${first}.md`)).mtimeMs;
    const firstReceipts = await engine.executeRaw('SELECT id,state,outcome FROM persistence_requests WHERE source_id=$1 AND slug=$2 ORDER BY sequence', [sourceId, first]);
    const embedded: string[] = [];
    configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536,
      env: { OPENAI_API_KEY: 'sk-test-synthesis-embedding' } });
    __setEmbedTransportForTests((async ({ values }: { values: string[] }) => {
      embedded.push(...values);
      return { embeddings: values.map(() => Array(1536).fill(0.01)) };
    }) as never);
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('DELETE FROM dream_verdicts');
    const embedScopes: string[][] = [];
    const embedPages = staleEmbedding.embedStalePages;
    const embedSpy = spyOn(staleEmbedding, 'embedStalePages').mockImplementation(async (...args) => {
      embedScopes.push([...args[1]]);
      return embedPages(...args);
    });
    let recovered: Awaited<ReturnType<typeof runPhaseSynthesize>>;
    try { recovered = await runPhaseSynthesize(engine, opts); }
    finally { embedSpy.mockRestore(); }
    expect(recovered.status).toBe('ok');
    expect(recovered.details.pages_written).toBe(1);
    expect(recovered.details.reverse_write_count).toBe(1);
    expect(recovered.details.written_slugs).toEqual([second]);
    expect(calls()).toBe(spent);
    expect((await engine.readPageSnapshot(first, { sourceId }))!.revision).toBe(firstSnapshot.revision);
    expect(readFileSync(join(root, `${first}.md`), 'utf8')).toBe(firstBytes);
    expect(statSync(join(root, `${first}.md`)).mtimeMs).toBe(firstMtime);
    expect(await engine.executeRaw('SELECT id,state,outcome FROM persistence_requests WHERE source_id=$1 AND slug=$2 ORDER BY sequence', [sourceId, first])).toEqual(firstReceipts);
    expect(embedded.length).toBeGreaterThan(0);
    expect(embedScopes).toEqual([[second]]);
    const summarySlug = String(recovered.details.summary_slug);
    const summary = (await engine.readPageSnapshot(summarySlug, { sourceId }))!;
    const summaryBytes = readFileSync(join(root, `${summarySlug}.md`), 'utf8');
    expect(summary.page.compiled_truth).toContain('**Pages written:** 2.');
    for (const { slug } of outputs) {
      expect(summary.page.compiled_truth).toContain(`[[${slug}]]`);
      expect(summaryBytes).toContain(`[[${slug}]]`);
    }
  }, 2);
}, 120_000);
