/**
 * v0.31 Phase 6 — visibility ACL parity with takes (D21).
 *
 * Pins: visibility column is private/world; remote (untrusted) callers see
 * world-only when the recall op enforces the filter. Local CLI sees all.
 */

import { describe, test, expect, beforeAll, afterAll, afterEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dispatchToolCall } from '../src/mcp/dispatch.ts';
import {
  resolveDefaultVisibility,
  resolveVisibilityParam,
  FACTS_DEFAULT_VISIBILITY_KEY,
} from '../src/core/facts/visibility.ts';
import { runFactsBackstop } from '../src/core/facts/backstop.ts';
import { __setChatTransportForTests } from '../src/core/ai/gateway.ts';
import {
  markShortLivedCliProcess,
  __resetShortLivedCliForTests,
} from '../src/core/facts/cli-process-mode.ts';
import type { BrainEngine } from '../src/core/engine.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.insertFact(
    { fact: 'world-visible', kind: 'fact', entity_slug: 'vis-test', source: 'test', visibility: 'world' },
    { source_id: 'default' },
  );
  await engine.insertFact(
    { fact: 'private-only', kind: 'fact', entity_slug: 'vis-test', source: 'test', visibility: 'private' },
    { source_id: 'default' },
  );
});

afterAll(async () => {
  await engine.disconnect();
});

describe('visibility column', () => {
  test('insertFact stores visibility in DB', async () => {
    const rows = await engine.executeRaw<{ visibility: string }>(
      `SELECT visibility FROM facts WHERE entity_slug = 'vis-test'`,
    );
    const tiers = rows.map(r => r.visibility).sort();
    expect(tiers).toEqual(['private', 'world']);
  });

  test('listFactsByEntity with visibility=[world] returns only world rows', async () => {
    const rows = await engine.listFactsByEntity('default', 'vis-test', { visibility: ['world'] });
    expect(rows.length).toBe(1);
    expect(rows[0].fact).toBe('world-visible');
    expect(rows[0].visibility).toBe('world');
  });

  test('listFactsByEntity with visibility=[private,world] returns both', async () => {
    const rows = await engine.listFactsByEntity('default', 'vis-test', { visibility: ['private', 'world'] });
    expect(rows.length).toBe(2);
  });

  test('listFactsByEntity with no visibility filter returns all', async () => {
    const rows = await engine.listFactsByEntity('default', 'vis-test');
    expect(rows.length).toBe(2);
  });
});

describe('recall op visibility enforcement', () => {
  test('remote=true → only world facts in payload', async () => {
    const result = await dispatchToolCall(engine, 'recall', { entity: 'vis-test' }, {
      remote: true,
      sourceId: 'default',
    });
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.facts.length).toBe(1);
    expect(payload.facts[0].fact).toBe('world-visible');
  });

  test('remote=false → all visibility tiers in payload', async () => {
    const result = await dispatchToolCall(engine, 'recall', { entity: 'vis-test' }, {
      remote: false,
      sourceId: 'default',
    });
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.facts.length).toBe(2);
  });
});

// ── [ENG-8] facts.default_visibility — the ONE resolver helper ──────────────

describe('resolveDefaultVisibility [ENG-8]', () => {
  afterEach(async () => {
    await engine.unsetConfig(FACTS_DEFAULT_VISIBILITY_KEY);
  });

  test('unset config → private (fail-closed floor)', async () => {
    expect(await resolveDefaultVisibility(engine)).toBe('private');
  });

  test('world opt-in resolves world (whitespace/case tolerant)', async () => {
    await engine.setConfig(FACTS_DEFAULT_VISIBILITY_KEY, 'world');
    expect(await resolveDefaultVisibility(engine)).toBe('world');
    await engine.setConfig(FACTS_DEFAULT_VISIBILITY_KEY, '  WORLD ');
    expect(await resolveDefaultVisibility(engine)).toBe('world');
  });

  test('invalid config value → private', async () => {
    await engine.setConfig(FACTS_DEFAULT_VISIBILITY_KEY, 'everyone');
    expect(await resolveDefaultVisibility(engine)).toBe('private');
  });

  test('config read failure → private (never widen on error)', async () => {
    const broken = { getConfig: async () => { throw new Error('db down'); } } as unknown as BrainEngine;
    expect(await resolveDefaultVisibility(broken)).toBe('private');
  });
});

describe('resolveVisibilityParam — explicit caller value ALWAYS wins [ENG-8]', () => {
  afterEach(async () => {
    await engine.unsetConfig(FACTS_DEFAULT_VISIBILITY_KEY);
  });

  test("explicit 'private' beats a world default", async () => {
    await engine.setConfig(FACTS_DEFAULT_VISIBILITY_KEY, 'world');
    expect(await resolveVisibilityParam(engine, 'private')).toBe('private');
  });

  test("explicit 'world' beats the private floor", async () => {
    expect(await resolveVisibilityParam(engine, 'world')).toBe('world');
  });

  test('unset resolves the config default (the old ternary coerced this to private)', async () => {
    await engine.setConfig(FACTS_DEFAULT_VISIBILITY_KEY, 'world');
    expect(await resolveVisibilityParam(engine, undefined)).toBe('world');
    expect(await resolveVisibilityParam(engine, null)).toBe('world');
  });

  test('unset with no config → private', async () => {
    expect(await resolveVisibilityParam(engine, undefined)).toBe('private');
  });

  test('garbage values stay private even with a world default (fail-closed)', async () => {
    await engine.setConfig(FACTS_DEFAULT_VISIBILITY_KEY, 'world');
    expect(await resolveVisibilityParam(engine, 'banana')).toBe('private');
    expect(await resolveVisibilityParam(engine, 42)).toBe('private');
  });
});

describe('ontology_propose visibility site (operations.ts ~:5812) [ENG-8]', () => {
  afterEach(async () => {
    await engine.unsetConfig(FACTS_DEFAULT_VISIBILITY_KEY);
  });

  async function propose(entity: string, value: string, visibility?: string) {
    const result = await dispatchToolCall(engine, 'ontology_propose', {
      entity,
      dimension: 'role',
      value,
      ...(visibility ? { visibility } : {}),
    }, { remote: false, sourceId: 'default' });
    expect(result.isError).toBeFalsy();
    const rows = await engine.executeRaw<{ visibility: string }>(
      `SELECT visibility FROM facts WHERE entity_slug = $1 AND dimension = 'role' AND value = $2`,
      [entity, value],
    );
    expect(rows.length).toBe(1);
    return rows[0].visibility;
  }

  test('unset + no config → private (historic behavior preserved)', async () => {
    expect(await propose('people/ont-a', 'advisor')).toBe('private');
  });

  test('unset + world config → world (the config default finally reaches the op)', async () => {
    await engine.setConfig(FACTS_DEFAULT_VISIBILITY_KEY, 'world');
    expect(await propose('people/ont-b', 'advisor')).toBe('world');
  });

  test('explicit private wins over world config default', async () => {
    await engine.setConfig(FACTS_DEFAULT_VISIBILITY_KEY, 'world');
    expect(await propose('people/ont-c', 'advisor', 'private')).toBe('private');
  });

  test('explicit world wins over the private floor', async () => {
    expect(await propose('people/ont-d', 'advisor', 'world')).toBe('world');
  });
});

describe('backstop minion-payload visibility site (backstop.ts queue mode) [ENG-8]', () => {
  // The backstop gates on extraction availability before enqueueing; this
  // block asserts the minion PAYLOAD, not availability — stub the chat
  // transport so the gate passes regardless of shard env keys.
  beforeAll(() => {
    __setChatTransportForTests(async () => ({
      text: '[]',
      blocks: [{ type: 'text', text: '[]' }],
      stopReason: 'end' as const,
      usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'anthropic:claude-sonnet-4-6',
      providerId: 'anthropic',
    }));
  });
  afterAll(() => { __setChatTransportForTests(null); });
  afterEach(async () => {
    __resetShortLivedCliForTests();
    await engine.unsetConfig(FACTS_DEFAULT_VISIBILITY_KEY);
    await engine.executeRaw(`DELETE FROM minion_jobs WHERE name = 'facts-absorb'`).catch(() => {});
  });

  async function submitAndReadPayload(slug: string, visibility?: 'private' | 'world') {
    markShortLivedCliProcess(); // route queue mode through the durable minion job
    const r = await runFactsBackstop(
      {
        slug,
        type: 'note',
        compiled_truth: `An eligible note body for ${slug}. ${'Enough prose to clear the minimum body length gate. '.repeat(3)}`,
        frontmatter: {},
      },
      {
        engine,
        sourceId: 'default',
        sessionId: null,
        source: 'mcp:put_page',
        mode: 'queue',
        ...(visibility ? { visibility } : {}),
      },
    );
    expect(r.mode).toBe('queue');
    expect((r as { enqueued: boolean }).enqueued).toBe(true);
    const rows = await engine.executeRaw<{ data: unknown }>(
      `SELECT data FROM minion_jobs WHERE name = 'facts-absorb'`,
    );
    const payloads = rows.map((row) =>
      (typeof row.data === 'string' ? JSON.parse(row.data) : row.data) as { slug: string; visibility: string },
    );
    const mine = payloads.find((p) => p.slug === slug);
    expect(mine).toBeDefined();
    return mine!.visibility;
  }

  test('caller-unset visibility resolves the world config default at submit time', async () => {
    await engine.setConfig(FACTS_DEFAULT_VISIBILITY_KEY, 'world');
    expect(await submitAndReadPayload('wiki/notes/vis-default-world')).toBe('world');
  });

  test('explicit private wins over a world config default', async () => {
    await engine.setConfig(FACTS_DEFAULT_VISIBILITY_KEY, 'world');
    expect(await submitAndReadPayload('wiki/notes/vis-explicit-private', 'private')).toBe('private');
  });

  test('caller-unset + no config → private (historic behavior preserved)', async () => {
    expect(await submitAndReadPayload('wiki/notes/vis-floor')).toBe('private');
  });
});
