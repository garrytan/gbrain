/**
 * Retrieval Reflex — resolver + assemble() regression tests (#1981, T5).
 *
 * Encodes the motivating failure: a turn naming an entity with an existing brain
 * page must surface a pointer BEFORE the agent answers. Runs against a hermetic
 * in-memory PGLite engine (no file lock). The PGLite-in-production path is
 * covered by exercising the resolver through an injected resolver (the same
 * shape the serve IPC / host ctx.brainQuery supply).
 */
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { withEnv } from './helpers/with-env.ts';
import { normalizeAlias } from '../src/core/search/alias-normalize.ts';
import { resolveEntitiesToPointers } from '../src/core/context/retrieval-reflex.ts';
import { extractCandidates } from '../src/core/context/entity-salience.ts';
import { createGBrainContextEngine } from '../src/core/context-engine.ts';
import { disposeReflex } from '../src/core/context/reflex.ts';
import { TAKES_FENCE_BEGIN, TAKES_FENCE_END } from '../src/core/takes-fence.ts';

let engine: PGLiteEngine;

async function seed(slug: string, title: string, body: string, source = 'default') {
  await engine.executeRaw(
    `INSERT INTO pages (slug, source_id, type, title, compiled_truth, timeline)
     VALUES ($1, $2, 'person', $3, $4, '')`,
    [slug, source, title, body],
  );
}

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
  await disposeReflex();
});

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM page_aliases').catch(() => {});
  await engine.executeRaw('DELETE FROM pages');
});

describe('resolveEntitiesToPointers', () => {
  test('namespaced slug resolves from a bare title (the recall fix, D6)', async () => {
    await seed('people/alice-example', 'Alice Example', 'Alice is an early founder.');
    const candidates = extractCandidates('what do you think about Alice Example?');
    const block = await resolveEntitiesToPointers(engine, 'default', candidates, {});
    expect(block).not.toBeNull();
    expect(block!.pointers[0].slug).toBe('people/alice-example');
    expect(block!.text).toContain('people/alice-example');
    expect(block!.text).toContain('use get_page');
  });

  test('alias arm resolves an unambiguous single-slug hit', async () => {
    await seed('people/swami-x', 'Swami X', 'A close friend.');
    await engine.setPageAliases('people/swami-x', 'default', [normalizeAlias('Swami')]);
    const block = await resolveEntitiesToPointers(engine, 'default', extractCandidates('Spoke with Swami today'), {});
    expect(block).not.toBeNull();
    expect(block!.pointers.some((p) => p.slug === 'people/swami-x')).toBe(true);
  });

  test('privacy (D5): takes-fence content never leaks into the synopsis', async () => {
    const body = `${TAKES_FENCE_BEGIN}\nSECRET_HUNCH_DO_NOT_LEAK\n${TAKES_FENCE_END}\nAlice is a founder.`;
    await seed('people/alice-example', 'Alice Example', body);
    const block = await resolveEntitiesToPointers(engine, 'default', extractCandidates('about Alice Example'), {});
    expect(block).not.toBeNull();
    expect(block!.text).not.toContain('SECRET_HUNCH_DO_NOT_LEAK');
  });

  test('suppression: a slug already in PRIOR context is dropped', async () => {
    await seed('people/alice-example', 'Alice Example', 'A founder.');
    const candidates = extractCandidates('tell me about Alice Example');
    const block = await resolveEntitiesToPointers(engine, 'default', candidates, {
      priorContextText: 'earlier we already opened people/alice-example and read it',
    });
    expect(block).toBeNull();
  });

  test('empty candidates → null', async () => {
    expect(await resolveEntitiesToPointers(engine, 'default', [], {})).toBeNull();
  });

  test('cap to maxPointers', async () => {
    await seed('people/aa', 'Aa Bb', 'x');
    await seed('people/cc', 'Cc Dd', 'y');
    await seed('people/ee', 'Ee Ff', 'z');
    const block = await resolveEntitiesToPointers(
      engine,
      'default',
      extractCandidates('met Aa Bb, Cc Dd, and Ee Ff'),
      { maxPointers: 2 },
    );
    expect(block!.pointers.length).toBe(2);
  });

  test('pre-v110 brains: alias-table absence does not break the slug arm', async () => {
    await seed('people/alice-example', 'Alice Example', 'A founder.');
    // Simulate no page_aliases table.
    await engine.executeRaw('DROP TABLE IF EXISTS page_aliases');
    const block = await resolveEntitiesToPointers(engine, 'default', extractCandidates('about Alice Example'), {});
    expect(block).not.toBeNull();
    expect(block!.pointers[0].slug).toBe('people/alice-example');
    // restore for other tests
    await engine.initSchema();
  });
});

describe('context-engine assemble() — Retrieval Reflex integration', () => {
  // Each test wraps its body in withEnv (NOT a beforeEach env mutation) so the
  // flag is restored even on throw — required by check-test-isolation rule R1.
  const REFLEX_ON = { GBRAIN_RETRIEVAL_REFLEX: 'true' };

  test('regression: a named entity with a page surfaces a pointer (host resolver path)', async () => {
    await withEnv(REFLEX_ON, async () => {
      await seed('people/alice-example', 'Alice Example', 'Alice is a founder.');
      // Inject a resolver the way the OpenClaw host (ctx.brainQuery) or serve IPC would.
      const ce = createGBrainContextEngine({
        workspaceDir: '/tmp/rr-test-ws',
        resolveEntities: (candidates, opts) =>
          resolveEntitiesToPointers(engine, 'default', candidates, opts),
      });
      const res = await ce.assemble({
        sessionId: 's1',
        messages: [{ role: 'user', content: 'what do you think about Alice Example?' }],
      });
      expect(res.systemPromptAddition).toContain('Brain pages mentioned this turn');
      expect(res.systemPromptAddition).toContain('people/alice-example');
      expect(res.systemPromptAddition).toContain('use get_page');
    });
  });

  test('no resolver available (PGLite, no serve/host) → no throw, live context still present', async () => {
    await withEnv(REFLEX_ON, async () => {
      const ce = createGBrainContextEngine({ workspaceDir: '/tmp/rr-test-ws-2' });
      const res = await ce.assemble({
        sessionId: 's2',
        messages: [{ role: 'user', content: 'what about Alice Example?' }],
      });
      // Live Context block always ships; no pointer block (nothing resolved).
      expect(res.systemPromptAddition).toContain('Live Context');
      expect(res.systemPromptAddition).not.toContain('Brain pages mentioned this turn');
    });
  });

  test('zero salient candidates → no brain touch, no pointer block', async () => {
    await withEnv(REFLEX_ON, async () => {
      let called = false;
      const ce = createGBrainContextEngine({
        workspaceDir: '/tmp/rr-test-ws-3',
        resolveEntities: async () => { called = true; return null; },
      });
      const res = await ce.assemble({
        sessionId: 's3',
        messages: [{ role: 'user', content: 'can you help me with this?' }],
      });
      expect(called).toBe(false);
      expect(res.systemPromptAddition).not.toContain('Brain pages mentioned this turn');
    });
  });

  test('suppression uses PRIOR turns only, not the current message', async () => {
    await withEnv(REFLEX_ON, async () => {
      await seed('people/alice-example', 'Alice Example', 'A founder.');
      const ce = createGBrainContextEngine({
        workspaceDir: '/tmp/rr-test-ws-4',
        resolveEntities: (candidates, opts) =>
          resolveEntitiesToPointers(engine, 'default', candidates, opts),
      });
      // The current message names Alice Example; prior context does NOT. Must fire.
      const res = await ce.assemble({
        sessionId: 's4',
        messages: [
          { role: 'user', content: 'hello' },
          { role: 'assistant', content: 'hi there' },
          { role: 'user', content: 'what do you think about Alice Example?' },
        ],
      });
      expect(res.systemPromptAddition).toContain('people/alice-example');
    });
  });
});
