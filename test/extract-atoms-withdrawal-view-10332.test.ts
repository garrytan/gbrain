/**
 * #10332: atom extraction reads a page through the canonical withdrawal view.
 *
 * A facts row withdrawn after it was written stays in the stored body; the
 * canonical snapshot (readPageSnapshot, what every reader and the managed
 * origin check see) strikes it. Before the fix discovery handed the stored
 * body to the phase, so on a managed brain the origin check refused every
 * attempt with revision_conflict (stored body != canonical body) and the page
 * never left the backlog, and on an unmanaged brain the withdrawn claim
 * reached the model prompt. Discovery now reads a fenced candidate's canonical
 * body, and the prompt drops withdrawn rows the way a world reader's get_page does.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { ChatOpts, ChatResult } from '../src/core/ai/gateway.ts';
import { countExtractAtomsBacklog, runPhaseExtractAtoms } from '../src/core/cycle/extract-atoms.ts';
import { renderFactsTable, type ParsedFact } from '../src/core/facts-fence.ts';
import { disposePersistenceConsumer, stopPersistenceConsumer } from '../src/core/persistence/service.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const SLUG = 'notes/withdrawn-example';
const WITHDRAWN = 'Acme-example withdrawn launch claim canarywithdrawn5512';
const RETAINED = 'Acme-example retained launch claim canaryretained2290';
const facts: ParsedFact[] = [
  { rowNum: 1, claim: WITHDRAWN, visibility: 'world', kind: 'fact', confidence: 1, notability: 'medium', active: true },
  { rowNum: 2, claim: RETAINED, visibility: 'world', kind: 'fact', confidence: 1, notability: 'medium', active: true },
];
const BODY = `${'The launch review measures every launch against clear exit criteria. '.repeat(12)}\n\n${renderFactsTable(facts)}`;

function recordingChat() {
  const prompts: string[] = [];
  const chat = async (opts: ChatOpts): Promise<ChatResult> => {
    prompts.push(JSON.stringify(opts.messages));
    const text = '[{"title":"Measured launches","atom_type":"insight","body":"Measure every launch against clear exit criteria."}]';
    return { text, blocks: [{ type: 'text', text }], stopReason: 'end',
      usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic' };
  };
  return { prompts, chat };
}

async function seedWithdrawnPage(engine: BrainEngine, sourceId: string): Promise<void> {
  await engine.putPage(SLUG, { type: 'note', title: 'Withdrawn example', compiled_truth: BODY, timeline: '' }, { sourceId });
  await engine.executeRaw('INSERT INTO fact_withdrawals(source_id, visibility, subject, fact_hash) VALUES($1,$2,$3,gbrain_fact_fingerprint($4))',
    [sourceId, 'world', SLUG, WITHDRAWN]);
  expect((await engine.readPageSnapshot(SLUG, { sourceId }))?.page.compiled_truth).not.toBe(BODY);
}

function expectCanonicalPrompt(prompts: string[], label: string) {
  expect(prompts.length, label).toBe(1);
  expect(prompts[0], label).toContain(RETAINED);
  expect(prompts[0], label).not.toContain(WITHDRAWN);
}

describe('#10332 atom extraction reads the canonical withdrawal view', () => {
  const engines: Array<{ backend: string; engine: BrainEngine }> = [];
  let closePostgres: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    for (const backend of testBackends()) {
      if (backend === 'pglite') {
        const engine = new PGLiteEngine();
        await engine.connect({});
        await engine.initSchema();
        engines.push({ backend, engine });
      } else {
        const isolated = await isolatedPersistencePostgres(requirePostgresTestDatabase());
        engines.push({ backend, engine: isolated.engine });
        closePostgres = isolated.close;
      }
    }
  }, 120_000);
  afterAll(async () => {
    for (const { engine } of engines) { await disposePersistenceConsumer(engine); await engine.disconnect(); }
    await closePostgres?.();
  });

  test('unmanaged: the withdrawn claim never reaches the prompt', async () => {
    for (const { backend, engine } of engines) {
      const sourceId = `withdrawn-${backend}`;
      await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
      await seedWithdrawnPage(engine, sourceId);
      const { prompts, chat } = recordingChat();
      expect((await runPhaseExtractAtoms(engine, { sourceId, _chat: chat, _transcripts: [] })).status, backend).toBe('ok');
      expectCanonicalPrompt(prompts, backend);
      expect(await countExtractAtomsBacklog(engine, sourceId), backend).toBe(0);
    }
  }, 120_000);

  test('managed: discovery hands the canonical body, so the origin check passes and the page leaves the backlog', async () => {
    const engine = engines.find(e => e.backend === 'pglite')!.engine;
    const home = mkdtempSync(join(tmpdir(), 'gbrain-withdrawn-atoms-'));
    try {
      await withEnv({ GBRAIN_HOME: home }, async () => {
        await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', ['withdrawn-managed']);
        await seedWithdrawnPage(engine, 'withdrawn-managed');
        await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
        const { prompts, chat } = recordingChat();
        const result = await runPhaseExtractAtoms(engine, { sourceId: 'withdrawn-managed', _chat: chat, _transcripts: [] });
        expect(result.details?.failures ?? [], JSON.stringify(result.details?.failures)).toEqual([]);
        expectCanonicalPrompt(prompts, 'managed');
        const [stored] = await engine.executeRaw<{ compiled_truth: string }>('SELECT compiled_truth FROM pages WHERE source_id=$1 AND slug=$2', ['withdrawn-managed', SLUG]);
        expect(stored.compiled_truth).toBe(BODY);
        expect(await countExtractAtomsBacklog(engine, 'withdrawn-managed')).toBe(0);
      });
    } finally {
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await stopPersistenceConsumer(engine);
      rmSync(home, { recursive: true, force: true });
    }
  }, 120_000);
});
