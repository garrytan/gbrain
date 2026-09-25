/**
 * #5234 — `get_versions` accepted no response bounds: every call returned the
 * page's ENTIRE history with every snapshot body inlined, so an agent that
 * only wanted "the last three snapshot timestamps" paid for the full
 * compiled_truth + timeline of every revision ever taken.
 *
 * The fix is operation-layer RESPONSE SHAPING only — two optional params on
 * the public op. The engine read, its source scope and its privacy predicates
 * are untouched, so these tests also pin that the policy handed to
 * `engine.getVersions` is byte-identical with the new params present, and that
 * remote fence stripping still runs.
 *
 * Handler-level with a stub engine on purpose: the behavior under test is
 * pure projection over whatever the engine returned, so a real PGLite fixture
 * would buy nothing and cost a schema init.
 */
import { describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import type { PageVersion } from '../src/core/types.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { renderFactsTable } from '../src/core/facts-fence.ts';

const SLUG = 'notes/bounded-history';
const SOURCE_ID = 'get-versions-response-bounds';

/**
 * A protected facts fence carrying one world row and one private row. Remote
 * callers must keep the world row and the surrounding prose and lose the
 * private row; local callers keep the literal bytes.
 */
function fencedBody(prefix: string): string {
  return `${prefix} public prose\n${renderFactsTable([
    { rowNum: 1, claim: `${prefix} world claim`, kind: 'fact', confidence: 1, visibility: 'world', notability: 'high', active: true },
    { rowNum: 2, claim: `${prefix} private claim`, kind: 'fact', confidence: 1, visibility: 'private', notability: 'high', active: true },
  ])}`;
}

/** Newest first — the order `BrainEngine.getVersions` guarantees. */
function history(): PageVersion[] {
  return [3, 2, 1].map(n => ({
    id: 300 + n,
    page_id: 42,
    title: `Revision ${n}`,
    type: 'note',
    tags: [`tag-${n}`],
    frontmatter: { visibility: 'world', revision: n },
    knowledge_revision: `kr-${n}`,
    is_deleted: false,
    snapshot_at: new Date(Date.UTC(2026, 0, n)),
    compiled_truth: fencedBody(`Body ${n}`),
    timeline: fencedBody(`Timeline ${n}`),
  }));
}

/** Stub engine: records the policy it was handed, replays a fixed history. */
function stubEngine(): BrainEngine & { calls: Array<{ slug: string; opts: unknown }> } {
  const calls: Array<{ slug: string; opts: unknown }> = [];
  return {
    kind: 'pglite',
    calls,
    getConfig: async () => undefined,
    getVersions: async (slug: string, opts?: unknown) => {
      calls.push({ slug, opts });
      return history();
    },
  } as unknown as BrainEngine & { calls: Array<{ slug: string; opts: unknown }> };
}

function context(engine: BrainEngine, remote: boolean): OperationContext {
  return {
    engine,
    config: { engine: engine.kind },
    sourceId: SOURCE_ID,
    remote,
    dryRun: false,
    logger: { info() {}, warn() {}, error() {} },
  };
}

const getVersions = (
  engine: BrainEngine,
  remote: boolean,
  params: Record<string, unknown> = {},
) => operationsByName.get_versions.handler(context(engine, remote), { slug: SLUG, ...params }) as Promise<
  Array<Record<string, unknown>>
>;

const BODY_KEYS = ['compiled_truth', 'timeline'] as const;
const META_KEYS = ['id', 'page_id', 'title', 'type', 'tags', 'frontmatter', 'knowledge_revision', 'is_deleted', 'snapshot_at'] as const;

describe('get_versions response bounds (#5234)', () => {
  test('no parameters returns the full history unchanged, local and remote', async () => {
    const local = await getVersions(stubEngine(), false);
    // Local is the raw engine rows: every field, every byte, including the
    // private fact row the remote projection strips.
    expect(local).toEqual(history() as unknown as Array<Record<string, unknown>>);

    const remote = await getVersions(stubEngine(), true);
    expect(remote).toHaveLength(3);
    expect(remote.map(v => v.id)).toEqual([303, 302, 301]);
    for (const version of remote) {
      for (const key of [...BODY_KEYS, ...META_KEYS]) expect(Object.hasOwn(version, key)).toBe(true);
      for (const field of BODY_KEYS) {
        expect(version[field]).toContain('public prose');
        expect(version[field]).toContain('world claim');
        expect(version[field]).not.toContain('private claim');
      }
    }
  });

  test('limit alone keeps the newest rows in engine order, bodies intact', async () => {
    for (const remote of [false, true]) {
      const engine = stubEngine();
      const bounded = await getVersions(engine, remote, { limit: 2 });
      expect(bounded.map(v => v.id)).toEqual([303, 302]);
      expect(bounded.map(v => (v.snapshot_at as Date).toISOString())).toEqual([
        '2026-01-03T00:00:00.000Z',
        '2026-01-02T00:00:00.000Z',
      ]);
      for (const version of bounded) {
        expect(typeof version.compiled_truth).toBe('string');
        expect(version.compiled_truth as string).toContain('public prose');
      }
      // Bounding is a response projection: the engine still got the one
      // unbounded read, under the byte-identical policy the no-param call
      // produces — source scope and privacy predicates are untouched.
      const baseline = stubEngine();
      await getVersions(baseline, remote);
      expect(engine.calls).toHaveLength(1);
      expect(engine.calls[0].slug).toBe(SLUG);
      expect(engine.calls[0].opts).toEqual(baseline.calls[0].opts);
      expect(engine.calls[0].opts).toMatchObject({ sourceId: SOURCE_ID });
    }
  });

  test('limit larger than the history, and limit exactly the history length, return everything', async () => {
    for (const limit of [3, 4, 1000]) {
      const all = await getVersions(stubEngine(), true, { limit });
      expect(all.map(v => v.id)).toEqual([303, 302, 301]);
    }
  });

  test('a fractional limit takes floor(N) rows', async () => {
    const bounded = await getVersions(stubEngine(), true, { limit: 2.9 });
    expect(bounded.map(v => v.id)).toEqual([303, 302]);
  });

  test('include_body=false drops both body keys and keeps every metadata field', async () => {
    for (const remote of [false, true]) {
      const meta = await getVersions(stubEngine(), remote, { include_body: false });
      expect(meta).toHaveLength(3);
      for (const version of meta) {
        for (const key of BODY_KEYS) {
          // Not "undefined" — the key itself must be gone, so a caller
          // cannot mistake an absent body for an empty one.
          expect(Object.hasOwn(version, key)).toBe(false);
        }
        for (const key of META_KEYS) expect(Object.hasOwn(version, key)).toBe(true);
        expect(JSON.stringify(version)).not.toContain('public prose');
        expect(JSON.stringify(version)).not.toContain('world claim');
      }
      expect(meta.map(v => v.title)).toEqual(['Revision 3', 'Revision 2', 'Revision 1']);
      expect(meta.map(v => v.tags)).toEqual([['tag-3'], ['tag-2'], ['tag-1']]);
    }
  });

  test('remote bodyless output never resurrects the removed keys', async () => {
    // The remote projection re-spreads compiled_truth (and timeline when it is
    // a string). If stripping ran before it, that spread would put a sanitized
    // '' body back on every row.
    const meta = await getVersions(stubEngine(), true, { include_body: false });
    for (const version of meta) {
      expect(Object.hasOwn(version, 'compiled_truth')).toBe(false);
      expect(Object.hasOwn(version, 'timeline')).toBe(false);
      expect(Object.values(version)).not.toContain('');
    }
  });

  test('limit and include_body=false combine: newest N rows, metadata only', async () => {
    const meta = await getVersions(stubEngine(), true, { limit: 1, include_body: false });
    expect(meta).toHaveLength(1);
    expect(meta[0].id).toBe(303);
    expect(meta[0].title).toBe('Revision 3');
    expect(Object.hasOwn(meta[0], 'compiled_truth')).toBe(false);
    expect(Object.hasOwn(meta[0], 'timeline')).toBe(false);
  });

  test('include_body must be EXACTLY false to strip; every other value keeps bodies', async () => {
    for (const include_body of [true, undefined, 'false', 0, null]) {
      const versions = await getVersions(stubEngine(), true, { include_body });
      expect(versions).toHaveLength(3);
      for (const version of versions) expect(Object.hasOwn(version, 'compiled_truth')).toBe(true);
    }
  });

  test('unusable limits fall back to the FULL history, never to an empty page', async () => {
    const unusable: Array<[string, unknown]> = [
      ['zero', 0],
      ['negative', -1],
      ['negative fractional', -0.5],
      ['below one', 0.5],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['-Infinity', Number.NEGATIVE_INFINITY],
      ['numeric string', '2'],
      ['non-numeric string', 'two'],
      ['null', null],
      ['boolean', true],
      ['object', { limit: 2 }],
      ['array', [2]],
    ];
    for (const [label, limit] of unusable) {
      const versions = await getVersions(stubEngine(), true, { limit });
      expect({ label, ids: versions.map(v => v.id) }).toEqual({ label, ids: [303, 302, 301] });
    }
  });

  test('Infinity is not silently floored into a bound, and stays paired with include_body', async () => {
    const meta = await getVersions(stubEngine(), true, { limit: Number.POSITIVE_INFINITY, include_body: false });
    expect(meta.map(v => v.id)).toEqual([303, 302, 301]);
    for (const version of meta) expect(Object.hasOwn(version, 'compiled_truth')).toBe(false);
  });
});
