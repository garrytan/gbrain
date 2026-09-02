/**
 * Tests for src/core/skillpack/preconditions.ts — the `requires:` precondition
 * vocabulary + checker. Pure: uses a fake PreconditionContext (no engine, no
 * fs), exercising parsePrecondition for every kind (incl. unknown) and
 * checkPreconditions for met + unmet across source/dir/config/pages.
 */
import { describe, test, expect } from 'bun:test';

import {
  parsePrecondition,
  checkPreconditions,
  type PreconditionContext,
  type PreconditionResult,
} from '../src/core/skillpack/preconditions.ts';

// ---------------------------------------------------------------------------
// Fake context helper
// ---------------------------------------------------------------------------

function fakeCtx(overrides: Partial<PreconditionContext> = {}): PreconditionContext {
  return {
    countPages: async () => 0,
    countPagesInDir: async () => 0,
    listSourceIds: async () => [],
    listPopulatedSourceIds: async () => [],
    getConfig: async () => undefined,
    ...overrides,
  };
}

function byRaw(results: PreconditionResult[], raw: string): PreconditionResult {
  const r = results.find(x => x.req.raw === raw);
  if (!r) throw new Error(`no result for ${raw}`);
  return r;
}

// ---------------------------------------------------------------------------
// parsePrecondition
// ---------------------------------------------------------------------------

describe('parsePrecondition', () => {
  test('bare source', () => {
    const p = parsePrecondition('source');
    expect(p.kind).toBe('source');
    expect(p.arg).toBeUndefined();
    expect(p.raw).toBe('source');
  });

  test('source:<id>', () => {
    const p = parsePrecondition('source:wiki');
    expect(p.kind).toBe('source');
    expect(p.arg).toBe('wiki');
  });

  test('dir:<path>', () => {
    const p = parsePrecondition('dir:conversations/');
    expect(p.kind).toBe('dir');
    expect(p.arg).toBe('conversations/');
  });

  test('config:<key> keeps colons in the key', () => {
    const p = parsePrecondition('config:embedding.model');
    expect(p.kind).toBe('config');
    expect(p.arg).toBe('embedding.model');
  });

  test('config with colon in the arg splits on first colon only', () => {
    const p = parsePrecondition('config:a:b:c');
    expect(p.kind).toBe('config');
    expect(p.arg).toBe('a:b:c');
  });

  test('pages:<n>', () => {
    const p = parsePrecondition('pages:50');
    expect(p.kind).toBe('pages');
    expect(p.arg).toBe('50');
  });

  test('unknown kind', () => {
    const p = parsePrecondition('banana:split');
    expect(p.kind).toBe('unknown');
    expect(p.arg).toBe('split');
  });

  test('trims surrounding whitespace', () => {
    const p = parsePrecondition('  pages:10  ');
    expect(p.kind).toBe('pages');
    expect(p.arg).toBe('10');
  });
});

// ---------------------------------------------------------------------------
// checkPreconditions — source
// ---------------------------------------------------------------------------

describe('checkPreconditions — source', () => {
  test('bare source met when a source has content', async () => {
    const [r] = await checkPreconditions(['source'], fakeCtx({ listPopulatedSourceIds: async () => ['wiki'] }));
    expect(r.met).toBe(true);
    expect(r.hint.length).toBeGreaterThan(0);
  });

  test('#4278 bare source accepts a populated default corpus', async () => {
    const [r] = await checkPreconditions(['source'], fakeCtx({ listPopulatedSourceIds: async () => ['default'] }));
    expect(r.met).toBe(true);
    expect(r.detail).toContain('default');
  });

  test('bare source unmet on empty brain, with remediation hint', async () => {
    const [r] = await checkPreconditions(['source'], fakeCtx({ listPopulatedSourceIds: async () => [] }));
    expect(r.met).toBe(false);
    expect(r.hint).toContain('gbrain');
    expect(r.hint.length).toBeGreaterThan(0);
  });

  test('source:<id> met when id present', async () => {
    const [r] = await checkPreconditions(
      ['source:wiki'],
      fakeCtx({ listSourceIds: async () => ['wiki', 'gstack'] }),
    );
    expect(r.met).toBe(true);
  });

  test('source:<id> unmet when id absent', async () => {
    const [r] = await checkPreconditions(
      ['source:wiki'],
      fakeCtx({ listSourceIds: async () => ['gstack'] }),
    );
    expect(r.met).toBe(false);
    expect(r.hint.length).toBeGreaterThan(0);
  });

  test('#4278 split predicates: registered-but-unpopulated source meets source:<id> but not bare source', async () => {
    // The naive fix (one shared populated-only accessor) silently regresses
    // source:<id>, whose documented contract is EXISTENCE: a source the user
    // registered but has not yet synced would flip from met to unmet.
    const ctx = fakeCtx({
      listSourceIds: async () => ['default', 'newsrc'],
      listPopulatedSourceIds: async () => [],
    });
    const results = await checkPreconditions(['source:newsrc', 'source'], ctx);
    expect(byRaw(results, 'source:newsrc').met).toBe(true);
    expect(byRaw(results, 'source').met).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// checkPreconditions — dir
// ---------------------------------------------------------------------------

describe('checkPreconditions — dir', () => {
  test('met when directory has pages', async () => {
    const [r] = await checkPreconditions(
      ['dir:conversations/'],
      fakeCtx({ countPagesInDir: async d => (d === 'conversations/' ? 12 : 0) }),
    );
    expect(r.met).toBe(true);
    expect(r.detail).toContain('conversations/');
  });

  test('unmet when directory empty', async () => {
    const [r] = await checkPreconditions(
      ['dir:conversations/'],
      fakeCtx({ countPagesInDir: async () => 0 }),
    );
    expect(r.met).toBe(false);
    expect(r.hint.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// checkPreconditions — config
// ---------------------------------------------------------------------------

describe('checkPreconditions — config', () => {
  test('met when config resolves to a non-empty value', async () => {
    const [r] = await checkPreconditions(
      ['config:embedding.model'],
      fakeCtx({ getConfig: async k => (k === 'embedding.model' ? 'voyage-3' : undefined) }),
    );
    expect(r.met).toBe(true);
  });

  test('unmet when config missing', async () => {
    const [r] = await checkPreconditions(
      ['config:embedding.model'],
      fakeCtx({ getConfig: async () => undefined }),
    );
    expect(r.met).toBe(false);
    expect(r.hint).toContain('gbrain config set embedding.model');
  });

  test('unmet when config is whitespace-only', async () => {
    const [r] = await checkPreconditions(
      ['config:embedding.model'],
      fakeCtx({ getConfig: async () => '   ' }),
    );
    expect(r.met).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// checkPreconditions — pages
// ---------------------------------------------------------------------------

describe('checkPreconditions — pages', () => {
  test('met when total >= n', async () => {
    const [r] = await checkPreconditions(['pages:10'], fakeCtx({ countPages: async () => 25 }));
    expect(r.met).toBe(true);
  });

  test('unmet when total < n', async () => {
    const [r] = await checkPreconditions(['pages:100'], fakeCtx({ countPages: async () => 3 }));
    expect(r.met).toBe(false);
    expect(r.hint).toContain('100');
  });

  test('met at exact boundary', async () => {
    const [r] = await checkPreconditions(['pages:5'], fakeCtx({ countPages: async () => 5 }));
    expect(r.met).toBe(true);
  });

  test('malformed count is unmet with a vocabulary-ish hint', async () => {
    const [r] = await checkPreconditions(['pages:lots'], fakeCtx({ countPages: async () => 999 }));
    expect(r.met).toBe(false);
    expect(r.hint.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// checkPreconditions — unknown + ordering
// ---------------------------------------------------------------------------

describe('checkPreconditions — unknown + ordering', () => {
  test('unknown kind is unmet with vocabulary hint', async () => {
    const [r] = await checkPreconditions(['banana:split'], fakeCtx());
    expect(r.met).toBe(false);
    expect(r.hint).toContain('skillpack/preconditions.ts');
    expect(r.hint).toContain('banana:split');
  });

  test('returns one result per input, in order, all with non-empty hints', async () => {
    const reqs = ['source', 'dir:conversations/', 'config:x', 'pages:10', 'nope'];
    const results = await checkPreconditions(
      reqs,
      fakeCtx({
        listPopulatedSourceIds: async () => ['wiki'],
        countPagesInDir: async () => 1,
        getConfig: async () => 'set',
        countPages: async () => 50,
      }),
    );
    expect(results.map(r => r.req.raw)).toEqual(reqs);
    for (const r of results) expect(r.hint.length).toBeGreaterThan(0);
    // The first four are satisfied; the unknown one is not.
    expect(byRaw(results, 'source').met).toBe(true);
    expect(byRaw(results, 'dir:conversations/').met).toBe(true);
    expect(byRaw(results, 'config:x').met).toBe(true);
    expect(byRaw(results, 'pages:10').met).toBe(true);
    expect(byRaw(results, 'nope').met).toBe(false);
  });
});
