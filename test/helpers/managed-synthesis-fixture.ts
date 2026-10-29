/**
 * The managed dream-synthesis fixture shared by test/managed-synthesis-postprocess.test.ts and the GBRA-130
 * pathological probes (test/pathological/a4-synthesize-postprocess.test.ts).
 */
import { expect, spyOn } from 'bun:test';
import * as childVerify from '../../src/core/cycle/synthesize-child-verify.ts';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { runPhaseSynthesize } from '../../src/core/cycle/synthesize.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { submitPageMutation } from '../../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { configureGateway, __setChatTransportForTests, __setEmbedTransportForTests, __setDecideTransportForTests } from '../../src/core/ai/gateway.ts';
import { flushDecideWrites } from '../../src/core/ai/decide/store.ts';
import { withEnv } from './with-env.ts';
import { freezeCorpusSessions } from './frozen-corpus.ts';

export const laterQuote = 'a legitimate later quotation from a completely different interview';

export interface SynthesisFixture {
  engine: BrainEngine; sourceId: string; root: string;
  opts: { brainDir: string; sourceId: string; dryRun: boolean; inputFile: string; date: string };
  calls: () => number; edit: (slug: string) => Promise<void>;
}

/**
 * A managed source per engine with one transcript and a stubbed provider: triage scores it 0.9 and the oneshot
 * child writes `outputCount` reflection pages (`outputBody`, or a body with one invented quotation).
 *
 * GBRA-60: a managed child verifies and stamps its pages before writing them (synthesize-child-verify.ts), which leaves
 * postprocessing nothing to do. Unless `childVerifies` is set the fixture's child cannot verify (as a job queued by an
 * older build, or a worker that cannot read the transcript), so these probes exercise postprocessing's backstop path.
 */
export async function managedSynthesisFixture(engines: BrainEngine[], run: (f: SynthesisFixture) => Promise<void>, outputCount = 1, outputBody?: string,
  childVerifies = false) {
  const unverified = childVerifies ? null : spyOn(childVerify, 'verifyChildPages').mockResolvedValue(null);
  try { for (const engine of engines) {
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
  } } finally { unverified?.mockRestore(); }
}

export async function outputSlug(engine: BrainEngine, sourceId: string): Promise<string> {
  const [row] = await engine.executeRaw<{ slug: string }>("SELECT slug FROM pages WHERE source_id=$1 AND slug LIKE 'wiki/personal/reflections/session-%'", [sourceId]);
  return row.slug;
}

export async function interruptAfterChild(engine: BrainEngine, sourceId: string, opts: Parameters<typeof runPhaseSynthesize>[1]) {
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
export async function childCommittedOrdinaryCycle({ engine, sourceId, root, opts, calls }: SynthesisFixture) {
  const corpus = join(root, '..', 'corpus');
  mkdirSync(corpus);
  writeFileSync(join(corpus, basename(opts.inputFile)), readFileSync(opts.inputFile));
  freezeCorpusSessions(corpus, sourceId);
  await engine.setConfig('dream.synthesize.session_corpus_dir', corpus);
  const ordinary = { brainDir: root, sourceId, dryRun: false };
  await interruptAfterChild(engine, sourceId, ordinary);
  const slug = await outputSlug(engine, sourceId);
  await engine.executeRaw("DELETE FROM config WHERE key='dream.synthesize.last_completion_ts'");
  return { ordinary, slug, jobsBefore: await engine.executeRaw('SELECT id FROM minion_jobs ORDER BY id'), spent: calls() };
}
