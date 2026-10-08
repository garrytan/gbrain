import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runPhaseSynthesize } from '../src/core/cycle/synthesize.ts';
import { retryWriteAdmission } from '../src/core/persistence/admission-retry.ts';
import * as journal from '../src/core/persistence/journal.ts';
import { OperationError } from '../src/core/ops/contract.ts';
import { acquireWorktree, claimWorktree, getWorktreeBinding } from '../src/core/persistence/ownership.ts';
import { __setMaintenanceWriteWaitForTests } from '../src/core/persistence/maintenance-wait.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { configureGateway, resetGateway, __setChatTransportForTests, __setEmbedTransportForTests, __setDecideTransportForTests } from '../src/core/ai/gateway.ts';
import { flushDecideWrites } from '../src/core/ai/decide/store.ts';
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
}) => Promise<void>, outputCount = 1, outputBody?: string) {
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
              body: outputBody ?? `A memory strategy with [[people/example]]. Evidence item ${i}. Allegedly: "an entirely invented quotation that should lose its marks".`,
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
      await flushDecideWrites();
      __setDecideTransportForTests(null);
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

test('managed native synthesis quarantines interpretations around valid evidence before mirror/chunk publication', async () => {
  const supported = 'Reliable memories should survive every tool change.';
  const unsupported = [
    'The user completed the durability roadmap in 2026.',
    'The user completed the roadmap: "we charge for durability because reliable memories should survive every tool".',
  ];
  await fixture(async ({ engine, sourceId, root, opts }) => {
    const groundingConfig = {
      'decide.provider': 'typesafe:jev-1.13.0', 'decide.slots.grounding.mode': 'on',
      'decide.slots.grounding.threshold': '0.5', 'decide.slots.grounding.force_on': 'true',
      'decide.egress.private': 'allow', 'decide.egress.typesafe.conversation': 'allow',
      'decide.budget.daily_usd': '50',
    };
    const previousConfig = new Map(await Promise.all(Object.keys(groundingConfig).map(async key => [key, await engine.getConfig(key)] as const)));
    try {
      for (const [key, value] of Object.entries(groundingConfig)) await engine.setConfig(key, value);
      configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536,
        env: { TYPESAFE_API_KEY: 'sk-test-typesafe' } });
      const claims: string[] = [];
      __setDecideTransportForTests(async (_url, init) => {
        const payload = JSON.parse(init.body as string);
        const answers: Record<string, unknown> = {};
        for (const [id, question] of Object.entries<any>(payload.questions)) {
          claims.push(question.instructions.claim);
          answers[id] = { type: 'noul', noul: unsupported.includes(question.instructions.claim) ? 0.05 : 0.93 };
        }
        return new Response(JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 200, output_tokens: 3 } }));
      });
      const report = await runPhaseSynthesize(engine, opts);
      expect(report.status).toBe('ok');
      expect(claims).toEqual(expect.arrayContaining(unsupported));
      const slug = await outputSlug(engine, sourceId);
      const page = (await engine.readPageSnapshot(slug, { sourceId }))!.page;
      const rendered = readFileSync(join(root, `${slug}.md`), 'utf8');
      expect(page.compiled_truth).toContain(supported);
      expect(page.compiled_truth).not.toContain('completed');
      expect(page.frontmatter.unverified_claims).toEqual(expect.arrayContaining(unsupported.map(text =>
        expect.objectContaining({ text, reason: 'unsupported_paraphrase' }))));
      expect(rendered).toContain('unsupported_paraphrase');
      expect(rendered.slice(rendered.indexOf('\n---\n') + 5)).not.toContain('completed');
      const chunks = await engine.executeRaw<{ content: string }>('SELECT c.chunk_text AS content FROM content_chunks c JOIN pages p ON p.id=c.page_id WHERE p.slug=$1 AND p.source_id=$2', [slug, sourceId]);
      const chunkText = chunks.map(c => c.content).join('\n');
      expect(chunkText).toContain(supported);
      expect(chunkText).not.toContain('completed');
      expect((await engine.searchKeyword('Reliable memories', { limit: 5, sourceId })).some(hit => hit.slug === slug)).toBe(true);
      expect((await engine.searchKeyword('completed durability roadmap', { limit: 5, sourceId })).some(hit => hit.slug === slug)).toBe(false);
    } finally {
      await flushDecideWrites();
      for (const [key, value] of previousConfig) {
        if (value === null) await engine.unsetConfig(key);
        else await engine.setConfig(key, value);
      }
    }
  }, 1, [supported, ...unsupported, 'Related context: [[people/example]].'].join('\n\n'));
}, 120_000);

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

/** An ordinary (corpus) cycle whose child committed before postprocessing ran; the cooldown is unstamped. */
async function childCommittedOrdinaryCycle({ engine, sourceId, root, opts, calls }: Parameters<Parameters<typeof fixture>[0]>[0]) {
  const corpus = join(root, '..', 'corpus');
  mkdirSync(corpus);
  writeFileSync(join(corpus, basename(opts.inputFile)), readFileSync(opts.inputFile));
  await engine.setConfig('dream.synthesize.session_corpus_dir', corpus);
  const ordinary = { brainDir: root, sourceId, dryRun: false };
  await interruptAfterChild(engine, sourceId, ordinary);
  const slug = await outputSlug(engine, sourceId);
  await engine.executeRaw("DELETE FROM config WHERE key='dream.synthesize.last_completion_ts'");
  return { ordinary, slug, jobsBefore: await engine.executeRaw('SELECT id FROM minion_jobs ORDER BY id'), spent: calls() };
}

/**
 * #6051: deterministic contention injection. Each maintenance admission for
 * which `contended(slug)` holds fails with the exact error real admission
 * raises once its retry budget is spent (retryWriteAdmission on a 55P03 lock
 * timeout with no budget left), without waiting out that budget. Records stderr.
 */
function contendAdmissions(contended: (slug: string) => boolean) {
  let injected = 0, stderr = '';
  const write = spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as never);
  const admitWrite = journal.admitWrite;
  const spy = spyOn(journal, 'admitWrite').mockImplementation(async (engine, input, ...rest) => {
    if (!contended(input.slug)) return admitWrite(engine, input, ...rest);
    injected++;
    return retryWriteAdmission(input.requestId ?? 'contended', async () => {
      throw Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
    }, 0);
  });
  return { injected: () => injected, stderr: () => stderr, restore: () => { spy.mockRestore(); write.mockRestore(); } };
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

test('a revision_conflict phase failure keeps the suggestion that names the slug (#6242)', async () => {
  await fixture(async ({ engine, sourceId, opts, edit }) => {
    await interruptAfterChild(engine, sourceId, opts);
    const slug = await outputSlug(engine, sourceId);
    await edit(slug);
    const replay = await runPhaseSynthesize(engine, opts);
    expect(replay.status).toBe('fail');
    expect(replay.error?.code).toBe('SYNTH_PHASE_FAIL');
    expect(replay.details.error_code).toBe('revision_conflict');
    expect(replay.error?.hint).toContain(slug);
    expect(replay.error?.hint).toContain(sourceId);
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

test('#5854: a postprocess publish still pending after its wait is deferred, then finished by the next ordinary cycle', async () => {
  await fixture(async ({ engine, sourceId, root, opts, calls }) => {
    const corpus = join(root, '..', 'corpus');
    mkdirSync(corpus);
    writeFileSync(join(corpus, basename(opts.inputFile)), readFileSync(opts.inputFile));
    await engine.setConfig('dream.synthesize.session_corpus_dir', corpus);
    const ordinary = { brainDir: root, sourceId, dryRun: false };
    await interruptAfterChild(engine, sourceId, ordinary);
    const slug = await outputSlug(engine, sourceId);
    await engine.executeRaw("DELETE FROM config WHERE key='dream.synthesize.last_completion_ts'");
    const jobsBefore = await engine.executeRaw('SELECT id FROM minion_jobs ORDER BY id');
    const spent = calls();
    const lock = (await acquireWorktree((await getWorktreeBinding(engine, sourceId))!, 1000))!;
    __setMaintenanceWriteWaitForTests(300);
    let deferred: Awaited<ReturnType<typeof runPhaseSynthesize>>;
    try { deferred = await runPhaseSynthesize(engine, ordinary); }
    finally { __setMaintenanceWriteWaitForTests(null); await lock.release(); }
    expect(deferred.status).toBe('warn');
    expect(deferred.details.publish_pending).toBe(1);
    expect(deferred.details.publish_deferred).toBe('publish deferred (writer busy); finishes next cycle, no action needed');
    expect(deferred.details.pages_written).toBe(0);
    expect(await engine.getConfig('dream.synthesize.last_completion_ts')).toBeNull();
    const [pending] = await engine.executeRaw<{ request_id: string }>(
      "SELECT request_id::text FROM persistence_requests WHERE source_id=$1 AND slug=$2 AND intent->>'kind'='managed_maintenance_page'", [sourceId, slug]);
    expect(pending).toBeDefined();
    await disposePersistenceConsumer(engine);
    const next = await runPhaseSynthesize(engine, ordinary);
    expect(next.status).toBe('ok');
    expect(next.details.publish_pending).toBeUndefined();
    expect(next.details.written_slugs).toEqual([slug]);
    expect(calls()).toBe(spent);
    expect(await engine.executeRaw('SELECT id FROM minion_jobs ORDER BY id')).toEqual(jobsBefore);
    expect(await engine.executeRaw<{ request_id: string; state: string }>(
      "SELECT request_id::text, state FROM persistence_requests WHERE source_id=$1 AND slug=$2 AND intent->>'kind'='managed_maintenance_page'", [sourceId, slug]))
      .toEqual([{ request_id: pending.request_id, state: 'committed' }]);
    const snapshot = (await engine.readPageSnapshot(slug, { sourceId }))!;
    expect(snapshot.page.frontmatter.dream_generated).toBe(true);
    expect(snapshot.page.compiled_truth).not.toContain('"an entirely invented');
    expect(await engine.getConfig('dream.synthesize.last_completion_ts')).not.toBeNull();
  });
}, 120_000);

test('#6051: a contended output admission is deferred like a pending publish, then finished by the next cycle without new spend', async () => {
  await fixture(async f => {
    const { engine, sourceId, calls } = f;
    const { ordinary, slug, jobsBefore, spent } = await childCommittedOrdinaryCycle(f);
    const before = (await engine.readPageSnapshot(slug, { sourceId }))!;
    const outputRequests = () => engine.executeRaw<{ state: string }>(
      "SELECT state FROM persistence_requests WHERE source_id=$1 AND slug=$2 AND intent->>'kind'='managed_maintenance_page'", [sourceId, slug]);
    const contention = contendAdmissions((target) => target === slug);
    let deferred: Awaited<ReturnType<typeof runPhaseSynthesize>>;
    try { deferred = await runPhaseSynthesize(engine, ordinary); }
    finally { contention.restore(); }
    expect(contention.injected()).toBe(1);
    expect(deferred.status).toBe('warn');
    expect(deferred.details.publish_pending).toBe(1);
    expect(deferred.details.publish_deferred).toBe('publish deferred (writer busy); finishes next cycle, no action needed');
    expect(deferred.details.pages_written).toBe(0);
    expect(await engine.getConfig('dream.synthesize.last_completion_ts')).toBeNull();
    expect(await outputRequests()).toEqual([]);
    expect((await engine.readPageSnapshot(slug, { sourceId }))!.revision).toBe(before.revision);
    expect(contention.stderr()).toMatch(new RegExp(`${slug} \\(request [0-9a-f-]+\\) deferred, write admission blocked by database contention`));
    await disposePersistenceConsumer(engine);
    const next = await runPhaseSynthesize(engine, ordinary);
    expect(next.status).toBe('ok');
    expect(next.details.publish_pending).toBeUndefined();
    expect(next.details.written_slugs).toEqual([slug]);
    expect(calls()).toBe(spent);
    expect(await engine.executeRaw('SELECT id FROM minion_jobs ORDER BY id')).toEqual(jobsBefore);
    expect(await outputRequests()).toEqual([{ state: 'committed' }]);
    expect((await engine.readPageSnapshot(slug, { sourceId }))!.page.frontmatter.dream_generated).toBe(true);
    expect(await engine.getConfig('dream.synthesize.last_completion_ts')).not.toBeNull();
  });
}, 120_000);

test('#6051: a contended summary admission defers the summary, and the next cycle writes it', async () => {
  await fixture(async f => {
    const { engine, sourceId, root, calls } = f;
    const { ordinary, slug, spent } = await childCommittedOrdinaryCycle(f);
    // The output publish admits; every later admission (the summary) is contended.
    const contention = contendAdmissions((target) => target !== slug);
    let deferred: Awaited<ReturnType<typeof runPhaseSynthesize>>;
    try { deferred = await runPhaseSynthesize(engine, ordinary); }
    finally { contention.restore(); }
    expect(contention.injected()).toBeGreaterThan(0);
    expect(deferred.status).toBe('warn');
    expect(deferred.details.publish_pending).toBe(1);
    expect(deferred.details.written_slugs).toEqual([slug]);
    const summarySlug = String(deferred.details.summary_slug);
    expect(await engine.readPageSnapshot(summarySlug, { sourceId })).toBeNull();
    expect(contention.stderr()).toContain(`${summarySlug} deferred, write admission blocked by database contention`);
    expect(await engine.getConfig('dream.synthesize.last_completion_ts')).toBeNull();
    await disposePersistenceConsumer(engine);
    const next = await runPhaseSynthesize(engine, ordinary);
    expect(next.status).toBe('ok');
    expect(calls()).toBe(spent);
    expect((await engine.readPageSnapshot(summarySlug, { sourceId }))!.page.compiled_truth).toContain(`[[${slug}]]`);
    expect(readFileSync(join(root, `${summarySlug}.md`), 'utf8')).toContain(`[[${slug}]]`);
    expect(await engine.getConfig('dream.synthesize.last_completion_ts')).not.toBeNull();
  });
}, 120_000);

test('#6051: a storage error that is not admission contention still fails the phase and stays retryable', async () => {
  await fixture(async f => {
    const { engine, sourceId } = f;
    const { ordinary, slug } = await childCommittedOrdinaryCycle(f);
    const admitWrite = journal.admitWrite;
    const spy = spyOn(journal, 'admitWrite').mockImplementation(async (eng, input, ...rest) => {
      if (input.slug !== slug) return admitWrite(eng, input, ...rest);
      throw Object.assign(new OperationError('storage_error', 'Synthetic storage failure.', 'Synthetic hint.'), { detail: 'disk_full' });
    });
    let failed: Awaited<ReturnType<typeof runPhaseSynthesize>>;
    try { failed = await runPhaseSynthesize(engine, ordinary); }
    finally { spy.mockRestore(); }
    expect(failed.status).toBe('fail');
    expect(failed.details.publish_pending).toBeUndefined();
    expect(await engine.getConfig('dream.synthesize.last_completion_ts')).toBeNull();
    expect(await engine.executeRaw(
      "SELECT 1 FROM persistence_requests WHERE source_id=$1 AND slug=$2 AND intent->>'kind'='managed_maintenance_page'", [sourceId, slug])).toEqual([]);
  });
}, 120_000);
