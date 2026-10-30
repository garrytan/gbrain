/**
 * GBRA-161 PR 2, for GBRA-60: `publishExtractedFacts`, the generation publish path of the conversation lane and the facts
 * backstop. An assistant-attributed or third-party fact is never attached to an entity page as an owner fact, even when
 * subject inference attached it; only a `whole_body` result retires, an `appended_range` one is additive, and an empty
 * whole-body result retires nothing without a proof. PGLite; Postgres when DATABASE_URL is set.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { inferConversationSubjects } from '../../src/core/facts/conversation-subject-infer.ts';
import { publishExtractedFacts } from '../../src/core/generations/adapters/extracted-facts.ts';
import { managedPersistenceEnabled } from '../../src/core/persistence/ownership.ts';
import { _resetWriteThroughCacheForTest } from '../../src/core/write-through.ts';
import { isolatedSharedSkillsEngine } from '../helpers/shared-skills-engine.ts';
import { withEnv } from '../helpers/with-env.ts';
import { pathologicalArms } from './harness.ts';

const CHAT = 'conversations/chat-example';
const ALICE = 'people/alice-example';

async function withBrain(databaseUrl: string | undefined, run: (engine: BrainEngine) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-g2x-'));
  try {
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      _resetWriteThroughCacheForTest();
      const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
      try {
        expect(await managedPersistenceEnabled(engine)).toBe(false);
        await engine.executeRaw(`INSERT INTO pages(slug,type,title) VALUES($1,'person','Alice Example'),($2,'conversation','Chat Example') ON CONFLICT DO NOTHING`, [ALICE, CHAT]);
        await run(engine);
      } finally { await close(); }
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

const live = (engine: BrainEngine) => engine.executeRaw<{ fact: string; entity_slug: string | null }>(
  'SELECT fact, entity_slug FROM facts WHERE source_markdown_slug=$1 AND expired_at IS NULL ORDER BY fact', [CHAT]);
const fact = (text: string, attributed_to: 'user' | 'assistant' | 'other' = 'user') => ({ fact: text, visibility: 'world' as const, entity_slug: null as string | null, attributed_to });

for (const { backend, databaseUrl } of pathologicalArms()) {
  describe(`GBRA-161 PR 2 extracted facts (${backend})`, () => {
    test('an assistant-attributed or third-party fact inference attached is stored with no entity, never as an owner fact', async () => {
      await withBrain(databaseUrl, async engine => {
        const inferred = await inferConversationSubjects(engine, 'default', 'world', [fact('Alice Example prefers green tea.', 'assistant'),
          fact('Alice Example plays chess every week.', 'other'), fact('Alice Example joined acme-example.')]);
        expect(inferred.map(row => row.entity_slug)).toEqual([ALICE, ALICE, ALICE]);
        const outcome = await publishExtractedFacts(engine, { sourceId: 'default', slug: CHAT, writer: 'conversation', coverage: 'whole_body',
          input: { pin: 'chat-v1', size: 100 }, facts: inferred });
        expect(outcome.state).toBe('published');
        expect(outcome.detached.map(row => [row.attributed_to, row.entity_slug])).toEqual([['assistant', ALICE], ['other', ALICE]]);
        expect(await live(engine)).toEqual([{ fact: 'Alice Example joined acme-example.', entity_slug: ALICE },
          { fact: 'Alice Example plays chess every week.', entity_slug: null }, { fact: 'Alice Example prefers green tea.', entity_slug: null }]);
        expect((await engine.executeRaw('SELECT 1 FROM facts WHERE entity_slug=$1 AND attributed_to IN (\'assistant\',\'other\')', [ALICE])).length).toBe(0);
      });
    }, 120_000);

    test('only a whole_body result retires (with before-state); appended_range is additive; an empty whole_body result is held no_proof', async () => {
      await withBrain(databaseUrl, async engine => {
        const publish = (coverage: 'whole_body' | 'appended_range', pin: string, facts: string[]) => publishExtractedFacts(engine, { sourceId: 'default', slug: CHAT,
          writer: 'conversation', coverage, input: { pin, size: 100 }, facts: facts.map(text => fact(text)) });
        expect((await publish('whole_body', 'v1', ['Claim A.', 'Claim B.'])).state).toBe('published');
        expect((await publish('appended_range', 'v2', ['Claim C.'])).state).toBe('published');
        expect((await live(engine)).map(row => row.fact)).toEqual(['Claim A.', 'Claim B.', 'Claim C.']);
        expect((await publish('appended_range', 'v3', [])).state).not.toBe('held');
        expect((await live(engine)).map(row => row.fact)).toEqual(['Claim A.', 'Claim B.', 'Claim C.']);
        const shrink = await publish('whole_body', 'v4', ['Claim A.', 'Claim B.']);
        expect(shrink).toMatchObject({ state: 'published', retired: [expect.stringMatching(/^fact:/)] });
        expect((await live(engine)).map(row => row.fact)).toEqual(['Claim A.', 'Claim B.']);
        const [retired] = await engine.executeRaw<{ fact: string }>(`SELECT i.preimage->>'fact' AS fact FROM derived_generation_items i
          JOIN derived_generations g ON g.id=i.generation_id WHERE g.kind='extracted_facts' AND g.state='live' AND i.action='retired'`);
        expect(retired?.fact).toBe('Claim C.');
        expect(await publish('whole_body', 'v5', [])).toMatchObject({ state: 'held', reason: 'no_proof' });
        expect((await live(engine)).map(row => row.fact)).toEqual(['Claim A.', 'Claim B.']);
      });
    }, 120_000);
  });
}
