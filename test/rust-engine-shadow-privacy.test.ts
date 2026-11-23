/**
 * Shadow mode privacy guard: a Rust row the call's scope hides must be `privacy_diverged` (never a plain `diff`), and the
 * child must then ask the parent to pause. Each case builds the exact call the primary engine took and a Rust result that
 * leaks. The "not a leak" cases pin what the primary engine itself allows, so the guard cannot pause on a legal answer.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { runShadowChild } from '../src/shadow/child.ts';
import { classifyResult } from '../src/shadow/classify.ts';
import { encodeValue } from '../src/shadow/codec.ts';
import { PRIVACY_ALIASES, isPrivacyPrivatePage } from '../src/core/search/private-visibility.ts';
import { readFaults, readShadowSummary } from '../src/shadow/ledger.ts';
import { SHADOW_READ_MEMBERS, type ShadowReadMember } from '../src/shadow/reads.ts';

const classify = (op: ShadowReadMember, args: unknown[], primary: unknown, rust: unknown) =>
  classifyResult(SHADOW_READ_MEMBERS[op], args, primary, rust, op).outcome;

const link = (from: string, to: string, origin: string | null = null) => ({
  from_slug: 'a', from_source_id: from, to_slug: 'b', to_source_id: to, link_type: 'mentions', origin_source_id: origin,
});

describe('shadow privacy guard', () => {
  test('link endpoints: a federated grant covers the from, to and origin sources of every link row', () => {
    const args = ['a', { sourceIds: ['s1', 's2'] }];
    expect(classify('getLinks', args, [], [link('s1', 'hidden')])).toBe('privacy_diverged');
    expect(classify('getBacklinks', args, [], [link('hidden', 's1')])).toBe('privacy_diverged');
    expect(classify('getLinks', args, [], [link('s1', 's2', 'hidden')])).toBe('privacy_diverged');
    expect(classify('getLinks', args, [], [link('s1', 's2', 's1')])).toBe('diff');
  });

  test('link endpoints: a single source scopes the side the primary scopes (getLinks from, getBacklinks to)', () => {
    expect(classify('getLinks', ['a', { sourceId: 's1' }], [], [link('hidden', 's1')])).toBe('privacy_diverged');
    expect(classify('getBacklinks', ['a', { sourceId: 's1' }], [], [link('s1', 'hidden')])).toBe('privacy_diverged');
    // The primary returns the other end of a one-source read across sources, so that is a plain difference.
    expect(classify('getLinks', ['a', { sourceId: 's1' }], [], [link('s1', 'other')])).toBe('diff');
    expect(classify('getBacklinks', ['a', { sourceId: 's1' }], [], [link('other', 's1')])).toBe('diff');
  });

  test('positional fact scope: listFactsByEntity takes its source as the first argument', () => {
    const rust = [{ id: 1, source_id: 'hidden', entity_slug: 'alice', fact: 'x' }];
    expect(classify('listFactsByEntity', ['s1', 'alice'], [], rust)).toBe('privacy_diverged');
    expect(classify('listFactsByEntity', ['s1', 'alice', { limit: 5 }], [], rust)).toBe('privacy_diverged');
    expect(classify('listFactsByEntity', ['hidden', 'alice'], rust, rust)).toBe('match');
  });

  test('positional scope: findByTitleFuzzy and resolveSlugWithAlias name their sources by position', () => {
    // These return a slug with no source column, so only the options-object form of a leak can be seen; the positional
    // scope must still be read without throwing and must not flag a row that sits inside it.
    expect(classify('findByTitleFuzzy', ['alice', undefined, 0.5, 's1'], null, { slug: 'x', similarity: 1 })).toBe('diff');
    expect(classify('resolveSlugWithAlias', ['x', ['s1', 's2']], 'x', 'y')).toBe('diff');
  });

  test('empty sourceIds names no scope: the primary and Rust both read the call as unscoped', () => {
    const rows = [{ slug: 'a', source_id: 'default', frontmatter: {} }];
    expect(classify('listPages', [{ sourceIds: [] }], rows, rows)).toBe('match');
    expect(classify('getPage', ['a', { sourceIds: [] }], rows[0], rows[0])).toBe('match');
    expect(classify('getLinks', ['a', { sourceIds: [] }], [link('s1', 's2')], [link('s1', 's2')])).toBe('match');
    expect(classify('listFactsByEntity', [[], 'alice'], [], [])).toBe('match');
    // An empty list next to a single source is the single source, as the primary reads it.
    const leak = { slug: 'a', source_id: 'hidden', frontmatter: {} };
    expect(classify('getPage', ['a', { sourceIds: [], sourceId: 's1' }], null, leak)).toBe('privacy_diverged');
    expect(classify('getPage', ['a', { sourceIds: [], sourceId: 's1' }], null, { ...leak, source_id: 's1' })).toBe('diff');
    // The no-source sentinel a token with `--sources none` carries is a single source.
    expect(classify('getPage', ['a', { sourceId: '__none__' }], null, leak)).toBe('privacy_diverged');
  });

  test("sourceId '__none__' allows nothing: any Rust row, in any source column, is a privacy divergence", () => {
    const none = { sourceId: '__none__' };
    const row = (source: string) => ({ slug: 'a', source_id: source, frontmatter: {} });
    for (const source of ['default', 's1', 'hidden']) {
      expect(classify('getPage', ['a', none], null, row(source)), `getPage ${source}`).toBe('privacy_diverged');
      expect(classify('listPages', [none], [], [row(source)]), `listPages ${source}`).toBe('privacy_diverged');
      expect(classify('searchKeyword', ['q', none], [], [row(source)]), `searchKeyword ${source}`).toBe('privacy_diverged');
      expect(classify('getLinks', ['a', none], [], [link(source, source)]), `getLinks ${source}`).toBe('privacy_diverged');
      expect(classify('getBacklinks', ['a', none], [], [link(source, source)]), `getBacklinks ${source}`).toBe('privacy_diverged');
      expect(classify('getTags', ['a', none], [], [row(source)]), `getTags ${source}`).toBe('privacy_diverged');
    }
    // The sentinel next to an empty list is still that single source, and no rows at all is not a leak.
    expect(classify('getPage', ['a', { sourceIds: [], sourceId: '__none__' }], null, row('default'))).toBe('privacy_diverged');
    expect(classify('listPages', [none], [], [])).toBe('match');
    // A positional fact scope of the sentinel allows nothing too.
    expect(classify('listFactsByEntity', ['__none__', 'alice'], [], [{ id: 1, source_id: 'default', fact: 'x' }])).toBe('privacy_diverged');
  });

  test('excludePrivate: a Rust page the call asked to hide as private is a divergence', () => {
    const priv = { slug: 'p', source_id: 's1', type: 'note', frontmatter: { visibility: 'private' } };
    expect(classify('listPages', [{ excludePrivate: true }], [], [priv])).toBe('privacy_diverged');
    expect(classify('getPage', ['p', { excludePrivate: true }], null, priv)).toBe('privacy_diverged');
    expect(classify('listPages', [{ excludePrivate: true, sourceId: 's1' }], [], [priv])).toBe('privacy_diverged');
    // An unmarked derived page and a pinned question are private by the primary's own rule.
    expect(classify('listPages', [{ excludePrivate: true }], [], [{ slug: 'q', type: 'atom', frontmatter: {} }])).toBe('privacy_diverged');
    expect(classify('listPages', [{ excludePrivate: true }], [], [{ slug: 'q', type: 'note', frontmatter: { pinned_question: true } }])).toBe('privacy_diverged');
    // Not a leak: privacy was not asked for, or the page is world-visible.
    expect(classify('listPages', [{ excludePrivate: false }], [priv], [priv])).toBe('match');
    expect(classify('listPages', [{}], [priv], [priv])).toBe('match');
    expect(classify('listPages', [{ excludePrivate: true }], [], [{ slug: 'w', type: 'note', frontmatter: { visibility: 'world' } }])).toBe('diff');
    expect(classify('listPages', [{ excludePrivate: true }], [], [{ slug: 'w', type: 'note', frontmatter: {} }])).toBe('diff');
  });

  test('excludePrivate: an access or confidentiality alias is private when visibility is unset, unless the primary returned the page too', () => {
    const aliased = (frontmatter: Record<string, unknown>) => ({ slug: 'p', source_id: 's1', type: 'note', frontmatter });
    expect(classify('listPages', [{ excludePrivate: true }], [], [aliased({ access: 'private' })])).toBe('privacy_diverged');
    expect(classify('listPages', [{ excludePrivate: true }], [], [aliased({ confidentiality: ' Secret ' })])).toBe('privacy_diverged');
    // An explicit visibility wins over an alias, and an unlisted alias value is not private.
    expect(classify('listPages', [{ excludePrivate: true }], [], [aliased({ visibility: 'world', access: 'private' })])).toBe('diff');
    expect(classify('listPages', [{ excludePrivate: true }], [], [aliased({ access: 'public' })])).toBe('diff');
    // A brain that turned the aliases off returns the page from the primary too: no divergence.
    const page = aliased({ access: 'private' });
    expect(classify('listPages', [{ excludePrivate: true }], [page], [page])).toBe('match');
    expect(classify('getPage', ['p', { excludePrivate: true }], page, page)).toBe('match');
  });

  test('the alias table the classifier reads is the primary\'s own', () => {
    for (const [key, values] of Object.entries(PRIVACY_ALIASES)) {
      for (const value of [...values, 'nope']) {
        const frontmatter = { [key]: value };
        expect(classify('listPages', [{ excludePrivate: true }], [], [{ slug: 'p', source_id: 's1', type: 'note', frontmatter }]) === 'privacy_diverged', `${key}: ${value}`)
          .toBe(isPrivacyPrivatePage({ type: 'note', frontmatter }));
      }
    }
  });

  test('a row inside the requested scope and the old single-source check still behave as before', () => {
    expect(classify('searchKeyword', ['q', { sourceId: 's1' }], [], [{ slug: 'x', source_id: 's1' }])).toBe('diff');
    expect(classify('searchKeyword', ['q', { sourceId: 's1' }], [], [{ slug: 'x', source_id: 'b' }])).toBe('privacy_diverged');
    expect(classify('searchKeyword', ['q', { sourceIds: ['s1', 's2'] }], [], [{ slug: 'x', source_id: 's3' }])).toBe('privacy_diverged');
    expect(classify('searchKeyword', ['q'], [], [{ slug: 'x', source_id: 'b' }])).toBe('diff');
  });
});

describe('shadow privacy guard in the child', () => {
  const event = (op: string, args: unknown[], result: unknown) => JSON.stringify({
    t: 'read', id: 1, at: Date.parse('2026-11-17T00:00:00Z'), op, primary_ms: 2, args: encodeValue(args), result: encodeValue(result),
  }) + '\n';

  const cases: Array<[string, string, unknown[], unknown]> = [
    ['link endpoint', 'getLinks', ['a', { sourceIds: ['s1'] }], [link('s1', 'hidden')]],
    ['positional fact scope', 'listFactsByEntity', ['s1', 'alice'], [{ id: 1, source_id: 'hidden', fact: 'x' }]],
    ["sourceId '__none__'", 'listPages', [{ sourceId: '__none__' }], [{ slug: 'p', source_id: 'default', frontmatter: {} }]],
    ["sourceId '__none__' read by position", 'listFactsByEntity', ['__none__', 'alice'], [{ id: 1, source_id: 'default', fact: 'x' }]],
    ['excludePrivate', 'listPages', [{ excludePrivate: true }], [{ slug: 'p', source_id: 's1', type: 'note', frontmatter: { visibility: 'private' } }]],
  ];

  for (const [name, op, args, leak] of cases) {
    test(`${name}: the child records privacy_diverged, writes the pause fault and asks the parent to pause`, async () => {
      const dir = mkdtempSync(join(tmpdir(), 'gbrain-shadow-privacy-'));
      const input = new PassThrough();
      const control: string[] = [];
      const fake = { async connect() {}, async disconnect() {}, async [op]() { return leak; } };
      const done = runShadowChild(dir, {
        input, writeControl: (l) => control.push(l), heartbeatMs: 60_000, childId: 'c1',
        loadAddon: async () => ({ ok: true, addon: {} as never }), openEngine: () => fake as never,
      });
      input.write(event(op, args, []));
      input.write(event(op, args, [])); // queued behind the leak: never compared once paused
      input.end();
      await done;
      expect(readShadowSummary(dir).by_op[op]).toEqual({ privacy_diverged: 1 });
      expect(control).toContain('{"t":"pause","reason":"privacy_diverged"}\n');
      expect(readFaults(dir).map((f) => f.kind)).toContain('privacy_pause');
      rmSync(dir, { recursive: true, force: true });
    });
  }
});
