/**
 * System One S7 + S8 through the REAL synthesize phase on a managed PGLite
 * brain: S7 decides triage inside runPhaseSynthesize (no LLM triage call),
 * and S8 runs at the managed postprocess site (synthesize-postprocess.ts),
 * finishing before the page is published — the published revision and the
 * canonical markdown file never carry the unsupported unit. With both slots
 * off, the phase details carry no decide keys.
 * Serial: mutates the process-global gateway, chat and decide transports.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { runPhaseSynthesize } from '../../src/core/cycle/synthesize.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { submitPageMutation } from '../../src/core/persistence/page-mutations.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { configureGateway, resetGateway, __setChatTransportForTests, __setDecideTransportForTests } from '../../src/core/ai/gateway.ts';
import { flushDecideWrites, __resetDecideStoreForTests } from '../../src/core/ai/decide/store.ts';
import { withEnv } from '../helpers/with-env.ts';

const QUOTE = 'we charge for durability because reliable memories should survive every tool';
const SUPPORTED = 'Reliable memories should survive every tool change on the roadmap.';
const UNSUPPORTED = 'Reliable memories should never survive a tool change on the roadmap.';

let engine: PGLiteEngine;
let dataDir: string;
beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'gbrain-decide-phase-db-'));
  engine = new PGLiteEngine();
  await engine.connect({ database_path: dataDir });
  await engine.initSchema();
}, 120_000);
afterAll(async () => {
  __setChatTransportForTests(null);
  __setDecideTransportForTests(null);
  await disposePersistenceConsumer(engine);
  await engine.disconnect();
  resetGateway();
  rmSync(dataDir, { recursive: true, force: true });
});

async function managedRun(decideConfig: Record<string, string>, opts: { typesafeKey?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-decide-phase-'));
  const root = join(dir, 'brain');
  mkdirSync(root);
  const sourceId = `synthesis-${randomUUID().slice(0, 8)}`;
  const chatSystems: string[] = [];
  const decideQuestions: Array<{ type: string; text: string }> = [];
  try {
    return await withEnv({ GBRAIN_HOME: join(dir, 'home'), ANTHROPIC_API_KEY: 'sk-test-synthesis' }, async () => {
      configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: { ...(opts.typesafeKey === false ? {} : { TYPESAFE_API_KEY: 'sk-test-typesafe' }), ANTHROPIC_API_KEY: 'sk-test-synthesis' } });
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await engine.executeRaw(`DELETE FROM config WHERE key LIKE 'decide.%'`);
      await engine.executeRaw('DELETE FROM dream_verdicts');
      await engine.executeRaw('DELETE FROM decision_receipts');
      __resetDecideStoreForTests();
      await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', [sourceId, root]);
      await engine.setConfig('sync.write_through', 'true');
      await claimWorktree(engine, sourceId, root);
      const ctx = { engine, sourceId, remote: false as const, config: { engine: engine.kind, embedding_disabled: true },
        dryRun: false, logger: { info() {}, warn() {}, error() {} } };
      await submitPageMutation(ctx, { operation: 'put_page', params: {
        slug: 'people/example', content: '---\ntitle: Example\ntype: note\n---\nExample evidence.', request_id: randomUUID(),
      } });
      const inputFile = join(root, '2026-09-20-session.txt');
      writeFileSync(inputFile, `User: ${QUOTE}.\n${'Assistant: Discuss the long term roadmap.\n'.repeat(15)}`);
      for (const [key, value] of Object.entries({
        'dream.synthesize.enabled': 'true', 'dream.synthesize.cooldown_hours': '0',
        'dream.synthesize.min_chars': '100', 'dream.synthesize.link_manifest': 'false',
        'dream.synthesize.mode': 'oneshot', 'dream.synthesize.quote_verify': 'true',
        'models.dream.synthesize': 'anthropic:claude-sonnet-4-6', 'models.dream.triage': 'anthropic:claude-sonnet-4-6',
        ...decideConfig,
      })) await engine.setConfig(key, value);
      await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
      __setChatTransportForTests(async (opts) => {
        chatSystems.push((opts.system ?? '').slice(0, 40));
        const hash = /hash suffix \(USE THIS in slugs\): ([a-z0-9-]+)/i.exec(String(opts.messages?.[0]?.content ?? ''))?.[1] ?? 'missing';
        const text = (opts.system ?? '').startsWith('You triage a conversation transcript')
          ? JSON.stringify({ score: 0.9, content_type: 'reflection', segments: [{ quote: QUOTE, note: 'evidence' }], entities: [], reasons: ['llm triage'] })
          : JSON.stringify({ pages: [{ slug: `wiki/personal/reflections/session-${hash}`, title: 'Session', type: 'note',
            body: `A memory strategy with [[people/example]].\n\n${SUPPORTED}\n\n${UNSUPPORTED}\n\nAllegedly: "an entirely invented quotation that should lose its marks".` }], skipped: false });
        return { text, blocks: [{ type: 'text', text }], stopReason: 'end',
          usage: { input_tokens: 100, output_tokens: 100, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: opts.model!, providerId: 'anthropic' };
      });
      __setDecideTransportForTests(async (_url, init) => {
        const body = JSON.parse(init.body as string);
        const answers: Record<string, unknown> = {};
        for (const [id, q] of Object.entries<any>(body.questions)) {
          const text = q.instructions.window ?? q.instructions.claim ?? q.instructions.windows ?? '';
          decideQuestions.push({ type: id.split(':')[0]!, text });
          answers[id] = q.type === 'choice'
            ? { type: 'choice', choice: 'strategy', confidence: 0.9, probabilities: { strategy: 0.9 } }
            : { type: 'noul', noul: id.startsWith('triage') ? 0.9 : text.includes('never') ? 0.05 : 0.95 };
        }
        return new Response(JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 100, output_tokens: 2 } }));
      });
      const result = await runPhaseSynthesize(engine, { brainDir: root, sourceId, dryRun: false, inputFile, date: '2026-09-20' });
      const [row] = await engine.executeRaw<{ slug: string }>("SELECT slug FROM pages WHERE source_id=$1 AND slug LIKE 'wiki/personal/reflections/session-%'", [sourceId]);
      const snapshot = row ? await engine.readPageSnapshot(row.slug, { sourceId }) : null;
      const md = row ? readFileSync(join(root, `${row.slug}.md`), 'utf8') : '';
      await new Promise((r) => setTimeout(r, 30));
      await flushDecideWrites();
      const receipts = await engine.executeRaw<{ slot: string; outcome: string }>('SELECT slot, outcome FROM decision_receipts ORDER BY id');
      return { result, snapshot, md, chatSystems, decideQuestions, receipts };
    });
  } finally {
    __setChatTransportForTests(null);
    __setDecideTransportForTests(null);
    await disposePersistenceConsumer(engine);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    rmSync(dir, { recursive: true, force: true });
  }
}

const ON = {
  'decide.provider': 'typesafe:jev-1.13.0', 'decide.egress.private': 'allow', 'decide.egress.typesafe.conversation': 'allow',
  'decide.slots.triage.mode': 'on', 'decide.slots.triage.threshold': '0.5', 'decide.slots.triage.force_on': 'true',
  'decide.slots.grounding.mode': 'on', 'decide.slots.grounding.threshold': '0.5', 'decide.slots.grounding.force_on': 'true',
};

test('S7 decides triage in the phase and S8 quarantines before the managed publish', async () => {
  const r = await managedRun(ON);
  expect(r.result.status).toBe('ok');
  expect(r.chatSystems.some((s) => s.startsWith('You triage'))).toBe(false);
  const details = r.result.details as { triage: { decide?: { pass: number } }; synthesis: { grounding?: { quarantine: number; pass: number } } };
  expect(details.triage.decide).toMatchObject({ mode: 'on', pass: 1 });
  expect(details.synthesis.grounding).toMatchObject({ mode: 'on', quarantine: 1, pass: 1 });
  const page = r.snapshot!.page;
  expect(page.compiled_truth).toContain(SUPPORTED);
  expect(page.compiled_truth).not.toContain(UNSUPPORTED);
  expect(page.compiled_truth).not.toContain('"an entirely invented');
  expect((page.frontmatter.unverified_claims as Array<{ reason: string }>).map((x) => x.reason).sort()).toEqual(['quote_not_in_source', 'unsupported_paraphrase']);
  expect(r.md).not.toContain(`\n${UNSUPPORTED}`);
  expect(r.md).toContain('unsupported_paraphrase');
  expect(r.decideQuestions.filter((q) => q.type === 'grounding').map((q) => q.text).sort()).toEqual([SUPPORTED, UNSUPPORTED].sort());
  expect(new Set(r.receipts.map((x) => x.slot))).toEqual(new Set(['triage', 'grounding']));
}, 120_000);

test('without a TypeSafe key the phase makes no decide call and reports no decide keys', async () => {
  const r = await managedRun({}, { typesafeKey: false });
  expect(r.result.status).toBe('ok');
  expect(r.decideQuestions).toHaveLength(0);
  expect(r.chatSystems.some((s) => s.startsWith('You triage'))).toBe(true);
  const details = r.result.details as { triage: Record<string, unknown>; synthesis: Record<string, unknown> };
  expect('decide' in details.triage).toBe(false);
  expect('grounding' in details.synthesis).toBe(false);
  expect(r.snapshot!.page.compiled_truth).toContain(UNSUPPORTED);
  expect(r.receipts).toHaveLength(0);
}, 120_000);

test('with a TypeSafe key and no decide keys, S7 triage is on by default in the phase and S8 stays off', async () => {
  const r = await managedRun({});
  expect(r.result.status).toBe('ok');
  expect(r.chatSystems.some((s) => s.startsWith('You triage'))).toBe(false);
  const details = r.result.details as { triage: { decide?: Record<string, unknown> }; synthesis: Record<string, unknown> };
  expect(details.triage.decide).toMatchObject({ mode: 'on', provider: 'typesafe:jev-1.13.0', threshold: 0.77, pass: 1 });
  expect('grounding' in details.synthesis).toBe(false);
  expect(new Set(r.decideQuestions.map((q) => q.type))).toEqual(new Set(['triage']));
  expect(new Set(r.receipts.map((x) => x.slot))).toEqual(new Set(['triage']));
}, 120_000);

test('with a TypeSafe key, decide.slots.triage.mode off keeps today\'s triage', async () => {
  const r = await managedRun({ 'decide.slots.triage.mode': 'off' });
  expect(r.result.status).toBe('ok');
  expect(r.decideQuestions).toHaveLength(0);
  expect(r.chatSystems.some((s) => s.startsWith('You triage'))).toBe(true);
  expect('decide' in (r.result.details as { triage: Record<string, unknown> }).triage).toBe(false);
}, 120_000);
