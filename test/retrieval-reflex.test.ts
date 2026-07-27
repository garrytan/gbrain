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

describe('v0.43 (#2095) — rolling window extraction through assemble()', () => {
  const REFLEX_ON = { GBRAIN_RETRIEVAL_REFLEX: 'true' };

  test('entity named ONLY in a previous assistant turn yields a pointer now', async () => {
    await withEnv(REFLEX_ON, async () => {
      await seed('people/alice-example', 'Alice Example', 'Alice is a founder.');
      const ce = createGBrainContextEngine({
        workspaceDir: '/tmp/rr-test-ws-w1',
        resolveEntities: (candidates, opts) =>
          resolveEntitiesToPointers(engine, 'default', candidates, opts),
      });
      // Current turn is a pronoun follow-up; the antecedent was NAMED two
      // turns back by the ASSISTANT. Pre-window this never fired.
      const res = await ce.assemble({
        sessionId: 'w1',
        messages: [
          { role: 'user', content: 'who should I talk to about the seed round?' },
          { role: 'assistant', content: 'Alice Example led a similar round last year.' },
          { role: 'user', content: 'what did she invest in?' },
        ],
      });
      expect(res.systemPromptAddition).toContain('people/alice-example');
    });
  });

  test('window=1 reproduces the legacy current-turn-only behavior', async () => {
    await withEnv({ ...REFLEX_ON, GBRAIN_RETRIEVAL_REFLEX_WINDOW_TURNS: '1' }, async () => {
      await seed('people/alice-example', 'Alice Example', 'Alice is a founder.');
      const ce = createGBrainContextEngine({
        workspaceDir: '/tmp/rr-test-ws-w2',
        resolveEntities: (candidates, opts) =>
          resolveEntitiesToPointers(engine, 'default', candidates, opts),
      });
      const res = await ce.assemble({
        sessionId: 'w2',
        messages: [
          { role: 'assistant', content: 'Alice Example led a similar round last year.' },
          { role: 'user', content: 'what did she invest in?' },
        ],
      });
      // Current turn has no extractable entity; window=1 must NOT widen.
      expect(res.systemPromptAddition).not.toContain('people/alice-example');
    });
  });

  test('windowed suppression is slug-only: a prior-turn MENTION does not suppress (codex D7)', async () => {
    await withEnv(REFLEX_ON, async () => {
      await seed('people/alice-example', 'Alice Example', 'A founder.');
      const ce = createGBrainContextEngine({
        workspaceDir: '/tmp/rr-test-ws-w3',
        resolveEntities: (candidates, opts) =>
          resolveEntitiesToPointers(engine, 'default', candidates, opts),
      });
      // "Alice Example" appears in a PRIOR turn (a bare mention — prior
      // context contains the TITLE). Under the legacy title rule the pointer
      // would be suppressed; slug-only windowing must still fire.
      const res = await ce.assemble({
        sessionId: 'w3',
        messages: [
          { role: 'user', content: 'I met Alice Example yesterday' },
          { role: 'assistant', content: 'How did the meeting with Alice Example go?' },
          { role: 'user', content: 'she wants to invest — thoughts?' },
        ],
      });
      expect(res.systemPromptAddition).toContain('people/alice-example');
    });
  });

  test('windowed suppression still drops an already-surfaced page (slug in prior context)', async () => {
    await withEnv(REFLEX_ON, async () => {
      await seed('people/alice-example', 'Alice Example', 'A founder.');
      const ce = createGBrainContextEngine({
        workspaceDir: '/tmp/rr-test-ws-w4',
        resolveEntities: (candidates, opts) =>
          resolveEntitiesToPointers(engine, 'default', candidates, opts),
      });
      const res = await ce.assemble({
        sessionId: 'w4',
        messages: [
          { role: 'assistant', content: 'Pointer: **Alice Example** → `people/alice-example` (use get_page)' },
          { role: 'user', content: 'tell me more about Alice Example' },
        ],
      });
      expect(res.systemPromptAddition).not.toContain('Brain pages mentioned this turn');
    });
  });

  test('fail-open: a throwing resolver under windowing never breaks the turn', async () => {
    await withEnv(REFLEX_ON, async () => {
      await seed('people/alice-example', 'Alice Example', 'A founder.');
      const ce = createGBrainContextEngine({
        workspaceDir: '/tmp/rr-test-ws-w5',
        resolveEntities: async () => { throw new Error('resolver exploded'); },
      });
      const res = await ce.assemble({
        sessionId: 'w5',
        messages: [
          { role: 'assistant', content: 'Alice Example is relevant here.' },
          { role: 'user', content: 'ok tell me about her' },
        ],
      });
      expect(res.systemPromptAddition).toContain('Live Context');
      expect(res.systemPromptAddition).not.toContain('Brain pages mentioned this turn');
    });
  });
});

describe('ambient-channel event logging (codex D11 — accept-side logDeliveredReflexPointers)', () => {
  test('logDeliveredReflexPointers logs channel=reflex events through the drained sink', async () => {
    const { logDeliveredReflexPointers } = await import('../src/core/context/retrieval-reflex.ts');
    const { awaitPendingVolunteerEventWrites, _resetPendingVolunteerEventWritesForTests } =
      await import('../src/core/context/volunteer-events.ts');
    _resetPendingVolunteerEventWritesForTests();
    await engine.executeRaw('DELETE FROM context_volunteer_events').catch(() => {});
    await seed('people/alice-example', 'Alice Example', 'A founder.');

    const block = await resolveEntitiesToPointers(
      engine,
      'default',
      extractCandidates('what do you think about Alice Example?'),
      {},
    );
    expect(block).not.toBeNull();
    logDeliveredReflexPointers(engine, block!.pointers);
    const { unfinished } = await awaitPendingVolunteerEventWrites(5_000);
    expect(unfinished).toBe(0);
    const rows = await engine.executeRaw<{ channel: string; slug: string; match_arm: string }>(
      'SELECT channel, slug, match_arm FROM context_volunteer_events',
      [],
    );
    expect(rows.length).toBe(1);
    expect(rows[0].channel).toBe('reflex');
    expect(rows[0].slug).toBe('people/alice-example');
    expect(rows[0].match_arm).toBe('title');
  });

  test('the bare resolver logs nothing — delivery is the only logging seam', async () => {
    await engine.executeRaw('DELETE FROM context_volunteer_events').catch(() => {});
    await seed('people/alice-example', 'Alice Example', 'A founder.');
    const block = await resolveEntitiesToPointers(
      engine,
      'default',
      extractCandidates('about Alice Example'),
      {},
    );
    expect(block).not.toBeNull();
    const { awaitPendingVolunteerEventWrites } = await import('../src/core/context/volunteer-events.ts');
    await awaitPendingVolunteerEventWrites(5_000);
    const rows = await engine.executeRaw<{ channel: string }>('SELECT channel FROM context_volunteer_events', []);
    expect(rows.length).toBe(0);
  });

  test('logDeliveredReflexPointers with an empty pointer list is a no-op', async () => {
    const { logDeliveredReflexPointers } = await import('../src/core/context/retrieval-reflex.ts');
    const { awaitPendingVolunteerEventWrites } = await import('../src/core/context/volunteer-events.ts');
    await engine.executeRaw('DELETE FROM context_volunteer_events').catch(() => {});
    logDeliveredReflexPointers(engine, []);
    await awaitPendingVolunteerEventWrites(5_000);
    const rows = await engine.executeRaw<{ channel: string }>('SELECT channel FROM context_volunteer_events', []);
    expect(rows.length).toBe(0);
  });
});

describe('serve IPC wiring — suppression passthrough + reflex-channel logging (review hardening)', () => {
  test('the IPC round-trip honors slug-only suppression and logs channel=reflex', async () => {
    const { startResolveIpcServer, resolveViaIpc, resolveSocketPath, IPC_UNAVAILABLE } =
      await import('../src/core/context/resolve-ipc.ts');
    const { awaitPendingVolunteerEventWrites, _resetPendingVolunteerEventWritesForTests } =
      await import('../src/core/context/volunteer-events.ts');
    const { mkdtempSync, rmSync } = await import('fs');
    const { join } = await import('path');
    const { tmpdir } = await import('os');

    _resetPendingVolunteerEventWritesForTests();
    await engine.executeRaw('DELETE FROM context_volunteer_events').catch(() => {});
    await seed('people/alice-example', 'Alice Example', 'A founder.');

    const dir = mkdtempSync(join(tmpdir(), 'rr-ipc-'));
    const sock = resolveSocketPath(dir);
    // The SAME wiring shape src/mcp/server.ts uses for serve: forwards
    // suppression from the request; logging happens at DELIVERY via the
    // onDelivered hook (post-write), never inside the resolver.
    const { logDeliveredReflexPointers } = await import('../src/core/context/retrieval-reflex.ts');
    const server = await startResolveIpcServer(
      sock,
      (req) =>
        resolveEntitiesToPointers(engine, req.sourceId || 'default', req.candidates ?? [], {
          priorContextText: req.priorContextText,
          maxPointers: req.maxPointers,
          suppression: req.suppression,
        }),
      (block) => logDeliveredReflexPointers(engine, block.pointers),
    );
    expect(server).not.toBeNull();
    try {
      // slug-only suppression: a TITLE mention in prior context must NOT
      // suppress (the windowing contract), and the resolve must log.
      const block = await resolveViaIpc(sock, {
        candidates: extractCandidates('tell me about Alice Example'),
        priorContextText: 'earlier turn merely mentioned Alice Example',
        suppression: 'slug-only',
      });
      expect(block).not.toBe(IPC_UNAVAILABLE);
      expect(block).not.toBeNull();
      expect((block as { pointers: Array<{ slug: string }> }).pointers[0].slug).toBe('people/alice-example');

      const { unfinished } = await awaitPendingVolunteerEventWrites(5_000);
      expect(unfinished).toBe(0);
      const rows = await engine.executeRaw<{ channel: string }>(
        'SELECT channel FROM context_volunteer_events', [],
      );
      expect(rows.length).toBe(1);
      expect(rows[0].channel).toBe('reflex');
    } finally {
      server!.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('windowTurnCount — knob edge semantics', () => {
  test('0, negative, NaN, and absent all fall back to the default of 4 (1 = legacy off)', async () => {
    const { windowTurnCount, DEFAULT_WINDOW_TURNS } = await import('../src/core/context/reflex.ts');
    expect(DEFAULT_WINDOW_TURNS).toBe(4);
    expect(windowTurnCount(null)).toBe(4);
    expect(windowTurnCount({ retrieval_reflex_window_turns: 0 } as never)).toBe(4);
    expect(windowTurnCount({ retrieval_reflex_window_turns: -3 } as never)).toBe(4);
    expect(windowTurnCount({ retrieval_reflex_window_turns: Number.NaN } as never)).toBe(4);
    // The documented "off" switch is 1 (legacy single-turn), not 0.
    expect(windowTurnCount({ retrieval_reflex_window_turns: 1 } as never)).toBe(1);
    expect(windowTurnCount({ retrieval_reflex_window_turns: 6.9 } as never)).toBe(6);
  });

  test('the env escape hatch is honored even when config is null (no config file / DB)', async () => {
    const { windowTurnCount } = await import('../src/core/context/reflex.ts');
    // loadConfig() returns null in a config-less environment (clean CI shard,
    // no brain) and drops its env→config mapping — windowTurnCount must still
    // read the env var directly, or the documented escape hatch is dead and
    // the window silently defaults to 4. withEnv() (not raw process.env
    // mutation) keeps the linter + isolation guard happy.
    await withEnv({ GBRAIN_RETRIEVAL_REFLEX_WINDOW_TURNS: '1' }, async () => {
      expect(windowTurnCount(null)).toBe(1);
    });
    await withEnv({ GBRAIN_RETRIEVAL_REFLEX_WINDOW_TURNS: '7' }, async () => {
      expect(windowTurnCount(null)).toBe(7);
      // Env wins over a config value too (env is the higher-precedence plane).
      expect(windowTurnCount({ retrieval_reflex_window_turns: 3 } as never)).toBe(7);
    });
    await withEnv({ GBRAIN_RETRIEVAL_REFLEX_WINDOW_TURNS: 'not-a-number' }, async () => {
      // Garbage env falls through to config / default, not a crash.
      expect(windowTurnCount(null)).toBe(4);
    });
  });
});
