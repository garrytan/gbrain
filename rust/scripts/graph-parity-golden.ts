#!/usr/bin/env bun
/**
 * Writes rust/crates/gbrain-store/tests/fixtures/graph-parity.json: link, graph and timeline
 * scenarios with the results PGLite gives for every step. `cargo test -p gbrain-store --test
 * graph_parity` replays the same steps against the Rust store and compares.
 *
 *   bun rust/scripts/graph-parity-golden.ts            # rewrite the fixture
 *   bun rust/scripts/graph-parity-golden.ts --check    # exit 1 when the fixture is stale
 *
 * The scenarios mirror test/engine-parity/links.test.ts and timeline.test.ts on the
 * rust-engine/typed-methods branch, plus edge cases those files do not cover (bad dates, CHECK
 * failures, null filters, depth 0, the origin collision on delete). Those parity files stay the
 * contract; this fixture lets the Rust arm run before the TypeScript shell can open a Rust brain.
 *
 * Step format: [op, args, view?]. `args` are the engine method's positional arguments; the
 * string "$undef" stands for `undefined` (JSON has none, and `null` means something else to
 * removeLink). Two ops are not engine methods: `createSource(id)` adds a source row, and
 * `sealChunks(slug, chunks)` installs the chunks and seals the page's text projection (what
 * the typed `sealChunks` on rust-engine/typed-methods does; Rust seals in upsertChunks with
 * `expectedRevision`), so search serves them. `view` names a projection both arms apply: "quiet" records only success, "stale"
 * keeps `{ slug, stale }` of search rows. Every result drops `created_at`, and a `date` keeps
 * its first ten characters (PGLite returns a Date at UTC midnight, Rust a YYYY-MM-DD string).
 * An error is recorded as its class: invalid_argument (SQLSTATE 22xxx), constraint_violation
 * (23xxx) or page_not_found (PageMissingError); `message` is the PGLite text, for readers only.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { sealPageTextProjection } from '../../src/core/page-state/projections.ts';

type Step = [string, unknown[], string?];
type Case = { name: string; steps: Step[] };

const U = '$undef';
const note = (title: string) => ({ type: 'note', title, compiled_truth: `${title} body`, timeline: '' });
const pages = (slugs: string[], opts?: unknown): Step[] => slugs.map((s) => ['putPage', [s, note(s), opts ?? U], 'quiet']);
const chain: Step[] = [
  ...pages(['tg/a', 'tg/b', 'tg/c', 'tg/d']),
  ['addLink', ['tg/a', 'tg/b', 'fwd-ctx', 'cycle-fwd', 'manual']],
  ['addLink', ['tg/b', 'tg/a', 'back-ctx', 'cycle-back', 'manual']],
  ['addLink', ['tg/b', 'tg/c', 'step-ctx', 'step', 'manual']],
  ['addLink', ['tg/c', 'tg/d', 'deep-ctx', 'deep', 'manual']],
];
const altX: Step[] = [
  ['createSource', ['tg-alt']],
  ...chain,
  ...pages(['tg/x'], { sourceId: 'tg-alt' }),
  ['addLink', ['tg/b', 'tg/x', 'x-ctx', 'xsrc', 'manual', U, U, { fromSourceId: 'default', toSourceId: 'tg-alt' }]],
];

const CASES: Case[] = [
  {
    name: 'addLink round-trip with provenance; duplicates are idempotent',
    steps: [
      ...pages(['people/alice', 'companies/acme', 'notes/memo']),
      ['addLink', ['people/alice', 'companies/acme', 'Alice works at Acme', 'works_at', 'manual']],
      ['addLink', ['people/alice', 'companies/acme', 'Alice works at Acme', 'works_at', 'manual']],
      ['addLink', ['people/alice', 'companies/acme', 'invested', 'invested_in', 'manual']],
      ['addLink', ['notes/memo', 'people/alice', 'memo mentions alice']],
      ['addLink', ['companies/acme', 'people/alice', 'fm', 'key_people', 'frontmatter', 'companies/acme', 'key_people']],
      ['addLink', ['people/alice', 'companies/acme', 'updated context', 'works_at', 'manual']],
      ['getLinks', ['people/alice']],
      ['getBacklinks', ['people/alice']],
      ['getBacklinks', ['notes/memo']],
      ['getLinks', ['companies/nobody']],
      ['getLinks', ['PEOPLE/ALICE']],
    ],
  },
  {
    name: 'addLink refuses missing pages and bad provenance; a missing origin is dropped',
    steps: [
      ...pages(['p/a', 'p/b']),
      ['addLink', ['p/none', 'p/b', '', 't', 'manual']],
      ['addLink', ['p/a', 'p/none', '', 't', 'manual']],
      ['addLink', ['p/none', 'p/b', '', 't', 'Bad_Source']],
      ['addLink', ['p/a', 'p/b', '', 't', 'Bad_Source']],
      ['addLink', ['p/a', 'p/b', '', 't', '']],
      ['addLink', ['p/a', 'p/b', 'o', 't', 'frontmatter', 'p/ghost', 'field']],
      ['addLink', ['p/a', 'p/b', '', 't', 'markdown', U, U, { fromSourceId: 'nope' }]],
      ['getLinks', ['p/a']],
    ],
  },
  {
    name: 'addLinksBatch inserts new edges, dedups conflicts and drops edges to missing pages',
    steps: [
      ...pages(['b/one', 'b/two', 'b/three']),
      ['addLinksBatch', [[
        { from_slug: 'b/one', to_slug: 'b/two', link_type: 'cites', context: 'c1', link_source: 'manual' },
        { from_slug: 'b/one', to_slug: 'b/three', link_type: 'cites', context: 'c2', link_source: 'manual' },
        { from_slug: 'b/one', to_slug: 'b/missing', link_type: 'cites', link_source: 'manual' },
        { from_slug: 'b/two', to_slug: 'b/three' },
      ]]],
      ['addLinksBatch', [[
        { from_slug: 'b/one', to_slug: 'b/two', link_type: 'cites', context: 'c1', link_source: 'manual' },
        { from_slug: 'b/one', to_slug: 'b/three', link_type: 'cites', context: 'c2', link_source: 'manual' },
        { from_slug: 'b/one', to_slug: 'b/missing', link_type: 'cites', link_source: 'manual' },
        { from_slug: 'b/two', to_slug: 'b/three' },
      ]]],
      ['addLinksBatch', [[]]],
      ['addLinksBatch', [[{ from_slug: 'b/none', to_slug: 'b/two', link_source: 'Bad_Source' }]]],
      ['addLinksBatch', [[{ from_slug: 'b/one', to_slug: 'b/two', link_source: 'Bad_Source' }]]],
      ['getLinks', ['b/one']],
      ['getLinks', ['b/two']],
    ],
  },
  {
    name: 'removeLink honors link type and provenance and returns the deleted row count',
    steps: [
      ...pages(['r/from', 'r/to']),
      ['addLink', ['r/from', 'r/to', 'x', 'cites', 'manual']],
      ['addLink', ['r/from', 'r/to', 'y', 'cites', 'markdown']],
      ['addLink', ['r/from', 'r/to', 'z', 'mentions', 'manual']],
      ['removeLink', ['r/from', 'r/typo']],
      ['removeLink', ['r/from', 'r/to', 'nope']],
      ['removeLink', ['r/from', 'r/to', 'cites', 'frontmatter']],
      ['removeLink', ['r/from', 'r/to', null]],
      ['removeLink', ['r/from', 'r/to', U, null]],
      ['removeLink', ['r/from', 'r/to', 'cites', 'manual']],
      ['getLinks', ['r/from']],
      ['removeLink', ['r/from', 'r/to']],
      ['getLinks', ['r/from']],
      ['removeLink', ['r/from', 'r/to']],
      ['addLink', ['r/from', 'r/to', 'x', 'cites', 'manual']],
      ['addLink', ['r/from', 'r/to', 'y', 'cites', 'markdown']],
      ['addLink', ['r/from', 'r/to', 'z', 'mentions', 'manual']],
      ['removeLink', ['r/from', 'r/to', U, 'manual']],
      ['getLinks', ['r/from']],
    ],
  },
  {
    name: 'getLinks/getBacklinks hide soft-deleted endpoints and respect source scope',
    steps: [
      ['createSource', ['alt']],
      ...pages(['s/from', 's/to']),
      ...pages(['s/alt-doc'], { sourceId: 'alt' }),
      ['addLink', ['s/from', 's/to', 'ctx', 'wikilink']],
      ['addLink', ['s/from', 's/alt-doc', 'cross', 'cites', 'manual', U, U, { fromSourceId: 'default', toSourceId: 'alt' }]],
      ['getLinks', ['s/from']],
      ['getLinks', ['s/from', { sourceId: 'default' }]],
      ['getLinks', ['s/from', { sourceIds: ['default'] }]],
      ['getBacklinks', ['s/alt-doc', { sourceId: 'alt' }]],
      ['getBacklinks', ['s/alt-doc', { sourceIds: ['alt'] }]],
      ['getBacklinks', ['s/alt-doc', { sourceIds: ['alt', 'default'] }]],
      ['softDeletePage', ['s/from'], 'quiet'],
      ['getLinks', ['s/from']],
      ['getBacklinks', ['s/to']],
      ['restorePage', ['s/from']],
      ['getBacklinks', ['s/to']],
    ],
  },
  {
    name: 'deletePage removes its links and nulls the origin of links it derived',
    steps: [
      ...pages(['o/a', 'o/b', 'o/c', 'o/origin']),
      ['addLink', ['o/a', 'o/b', 'kept', 'rel', 'frontmatter', 'o/origin', 'field']],
      ['addLink', ['o/c', 'o/a', 'gone', 'rel', 'manual']],
      ['deletePage', ['o/origin'], 'quiet'],
      ['getLinks', ['o/a']],
      ['deletePage', ['o/c'], 'quiet'],
      ['getBacklinks', ['o/a']],
    ],
  },
  {
    name: 'deletePage refuses when nulling an origin collides with an existing link',
    steps: [
      ...pages(['p/a', 'p/b', 'p/o']),
      ['addLink', ['p/a', 'p/b', 'c1', 'rel', 'manual']],
      ['addLink', ['p/a', 'p/b', 'c2', 'rel', 'manual', 'p/o', 'field']],
      ['deletePage', ['p/o'], 'quiet'],
      ['getLinks', ['p/a']],
      ['traverseGraph', ['p/o', 0]],
    ],
  },
  {
    name: 'traverseGraph returns identical nodes for depth 0..3 and survives a cycle',
    steps: [
      ...chain,
      ['traverseGraph', ['tg/a', 0]],
      ['traverseGraph', ['tg/a', 1]],
      ['traverseGraph', ['tg/a', 2]],
      ['traverseGraph', ['tg/a', 3]],
      ['traverseGraph', ['tg/a', 10]],
      ['traverseGraph', ['tg/a']],
      ['traverseGraph', ['tg/nope', 3]],
      ['traverseGraph', ['tg/a', 3, { frontierCap: 1 }]],
    ],
  },
  {
    name: 'traverseGraph source scope keeps cross-source nodes out of a scoped walk',
    steps: [
      ...altX,
      ['traverseGraph', ['tg/a', 3]],
      ['traverseGraph', ['tg/a', 3, { sourceId: 'default' }]],
      ['traverseGraph', ['tg/a', 3, { sourceIds: ['default'] }]],
      ['traverseGraph', ['tg/a', 3, { sourceIds: ['default', 'tg-alt'] }]],
      ['traverseGraph', ['tg/x', 2, { sourceId: 'tg-alt' }]],
    ],
  },
  {
    name: 'traversePaths returns ordered edges across depth and direction, with link type filter',
    steps: [
      ...chain,
      ...[1, 2, 3].flatMap((depth) => (['in', 'out', 'both'] as const).map((direction): Step => ['traversePaths', ['tg/b', { depth, direction }]])),
      ['traversePaths', ['tg/a', { depth: 5, direction: 'out', linkType: 'cycle-fwd' }]],
      ['traversePaths', ['tg/a', { depth: 5, direction: 'out', linkType: 'no-such-type' }]],
      ['traversePaths', ['tg/c', { depth: 1, direction: 'out' }]],
      ['traversePaths', ['tg/a']],
      ['traversePaths', ['tg/a', { depth: 0 }]],
    ],
  },
  {
    name: 'traversePaths source scope: scalar and federated grants stop at the source boundary',
    steps: [
      ...altX,
      ['traversePaths', ['tg/a', { depth: 3, direction: 'out' }]],
      ['traversePaths', ['tg/a', { depth: 3, direction: 'out', sourceId: 'default' }]],
      ['traversePaths', ['tg/a', { depth: 3, direction: 'out', sourceIds: ['default'] }]],
      ['traversePaths', ['tg/a', { depth: 3, direction: 'both', sourceIds: ['default', 'tg-alt'] }]],
      ['traversePaths', ['tg/x', { depth: 2, direction: 'in' }]],
    ],
  },
  {
    name: 'traversePathsDetailed reports the paths and an untruncated walk',
    steps: [
      ...chain,
      ['traversePathsDetailed', ['tg/a', { depth: 1, direction: 'both' }]],
      ['traversePathsDetailed', ['tg/a', { depth: 4, direction: 'out' }]],
      ['traversePathsDetailed', ['tg/a', { depth: 4, direction: 'out', sourceIds: ['default'], linkType: 'step' }]],
      ['traversePathsDetailed', ['tg/a', { depth: 0 }]],
    ],
  },
  {
    name: 'traversal hides soft-deleted pages and recovers them after restore',
    steps: [
      ...chain,
      ['softDeletePage', ['tg/b'], 'quiet'],
      ['traverseGraph', ['tg/a', 3]],
      ['traversePaths', ['tg/a', { depth: 3, direction: 'both' }]],
      ['traversePaths', ['tg/b', { depth: 3, direction: 'out' }]],
      ['getLinks', ['tg/a']],
      ['restorePage', ['tg/b']],
      ['traversePaths', ['tg/a', { depth: 3, direction: 'out' }]],
    ],
  },
  {
    name: 'addTimelineEntry inserts, dedups on (date, summary) and reports whether a row was written',
    steps: [
      ...pages(['people/alice']),
      ['addTimelineEntry', ['people/alice', { date: '2026-01-02', source: 'cal', summary: 'Joined Acme', detail: 'day one' }]],
      ['addTimelineEntry', ['people/alice', { date: '2026-01-02', source: 'cal', summary: 'Joined Acme', detail: 'day one' }]],
      ['addTimelineEntry', ['people/alice', { date: '2026-01-02', source: 'other', summary: 'Joined Acme', detail: 'other source' }]],
      ['addTimelineEntry', ['people/alice', { date: '2026-03-04', summary: 'Promoted' }]],
      ['addTimelineEntry', ['people/alice', { date: '2025-12-31', source: 'note', summary: 'Interviewed', detail: 'phone screen' }]],
      ['addTimelineEntry', ['people/nobody', { date: '2026-01-01', summary: 'ghost' }]],
      ['addTimelineEntry', ['people/nobody', { date: '2026-01-01', summary: 'ghost' }, { skipExistenceCheck: true }]],
      ['getTimeline', ['people/alice']],
    ],
  },
  {
    name: 'addTimelineEntry date formats and refusals',
    steps: [
      ...pages(['p/a']),
      ['addTimelineEntry', ['p/none', { date: 'not-a-date', summary: 'x' }]],
      ['addTimelineEntry', ['p/none', { date: 'not-a-date', summary: 'x' }, { skipExistenceCheck: true }]],
      ['addTimelineEntry', ['p/a', { date: 'not-a-date', summary: 'x' }]],
      ['addTimelineEntry', ['p/a', { date: '2026-02-30', summary: 'x' }]],
      ['addTimelineEntry', ['p/a', { date: '2026-01-05T23:30:00-05:00', summary: 'iso' }]],
      ['addTimelineEntry', ['p/a', { date: '2026/01/07', summary: 'slash' }]],
      ['addTimelineEntry', ['p/a', { date: '2024-02-29', summary: 'leap' }]],
      ['getTimeline', ['p/a']],
      ['getTimeline', ['p/a', { limit: -1 }]],
      ['getTimeline', ['p/a', { after: 'nope' }]],
    ],
  },
  {
    name: 'getTimeline orders newest first and applies limit and the after/before window',
    steps: [
      ...pages(['people/bob']),
      ...[['2026-01-10', 'jan'], ['2026-02-10', 'feb'], ['2026-03-10', 'mar'], ['2026-04-10', 'apr'], ['2026-02-10', 'feb-2']]
        .map(([date, summary]): Step => ['addTimelineEntry', ['people/bob', { date, summary }]]),
      ['getTimeline', ['people/bob']],
      ['getTimeline', ['people/bob', { limit: 2 }]],
      ['getTimeline', ['people/bob', { limit: 0 }]],
      ['getTimeline', ['people/bob', { after: '2026-02-10' }]],
      ['getTimeline', ['people/bob', { before: '2026-03-10' }]],
      ['getTimeline', ['people/bob', { after: '2026-01-15', before: '2026-04-01' }]],
      ['getTimeline', ['people/bob', { after: '2026-04-01', before: '2026-01-15' }]],
      ['getTimeline', ['people/bob', { sourceId: 'no-such-source' }]],
      ['getTimeline', ['people/nobody']],
    ],
  },
  {
    name: 'addTimelineEntriesBatch counts inserted rows, drops missing pages and replays as no-ops',
    steps: [
      ['createSource', ['alt']],
      ...pages(['batch/one', 'batch/two']),
      ...pages(['batch/one'], { sourceId: 'alt' }),
      ...[0, 1].map((): Step => ['addTimelineEntriesBatch', [[
        { slug: 'batch/one', date: '2026-05-01', summary: 'one-a', detail: 'x', source: 'import' },
        { slug: 'batch/one', date: '2026-05-02', summary: 'one-b' },
        { slug: 'batch/two', date: '2026-05-01', summary: 'two-a' },
        { slug: 'batch/missing', date: '2026-05-01', summary: 'ghost' },
        { slug: 'batch/one', date: '2026-05-03', summary: 'alt-only', source_id: 'alt' },
      ]]]),
      ['addTimelineEntriesBatch', [[]]],
      ['addTimelineEntriesBatch', [[{ slug: 'batch/missing', date: 'not-a-date', summary: 'ghost' }]]],
      ['addTimelineEntriesBatch', [[{ slug: 'batch/two', date: 'not-a-date', summary: 'bad' }]]],
      ['getTimeline', ['batch/one', { sourceId: 'default' }]],
      ['getTimeline', ['batch/one', { sourceId: 'alt' }]],
      ['getTimeline', ['batch/one']],
      ['getTimeline', ['batch/one', { sourceIds: ['alt', 'default'] }]],
      ['getTimeline', ['batch/two']],
    ],
  },
  {
    name: 'searchKeyword marks a page stale when a timeline entry is newer than the page',
    steps: [
      ...pages(['st/one']),
      ['sealChunks', ['st/one', [{ chunk_index: 0, chunk_text: 'zebra crossing notes', chunk_source: 'compiled_truth' }]], 'quiet'],
      ['searchKeyword', ['zebra'], 'stale'],
      ['addTimelineEntry', ['st/one', { date: '2020-01-01', summary: 'old event' }]],
      ['searchKeyword', ['zebra'], 'stale'],
      ['putPage', ['st/one', { ...note('st/one'), compiled_truth: 'zebra rewritten' }], 'quiet'],
      ['sealChunks', ['st/one', [{ chunk_index: 0, chunk_text: 'zebra rewritten', chunk_source: 'compiled_truth' }]], 'quiet'],
      ['searchKeyword', ['zebra'], 'stale'],
      ['addTimelineEntry', ['st/one', { date: '2030-01-01', summary: 'future-dated event' }]],
      ['searchKeyword', ['zebra'], 'stale'],
    ],
  },
];

function errorClass(err: any): { error: string; message: string } {
  const code = String(err?.code ?? '');
  const message = String(err?.message ?? err);
  if (code.startsWith('22')) return { error: 'invalid_argument', message };
  if (code.startsWith('23')) return { error: 'constraint_violation', message };
  if (err?.name === 'PageMissingError') return { error: 'page_not_found', message };
  throw new Error(`unclassified PGLite error: ${err?.name} ${code} ${message}`);
}

function normalize(value: unknown, key?: string): unknown {
  if (value instanceof Date) value = value.toISOString();
  if (key === 'date' && typeof value === 'string') return value.slice(0, 10);
  if (Array.isArray(value)) return value.map((v) => normalize(v));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) if (k !== 'created_at') out[k] = normalize(v, k);
    return out;
  }
  return value === undefined ? null : value;
}

function view(result: unknown, name?: string): unknown {
  if (name === 'quiet') return null;
  if (name === 'stale') return (result as Array<{ slug: string; stale: boolean }>).map((r) => ({ slug: r.slug, stale: r.stale }));
  return normalize(result);
}

async function runCase(c: Case) {
  const engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' } as never);
  await engine.initSchema();
  const results: unknown[] = [];
  try {
    for (const [op, rawArgs, v] of c.steps) {
      const args = rawArgs.map((a) => (a === U ? undefined : a));
      try {
        let result: unknown;
        if (op === 'createSource') {
          await engine.executeRaw(`INSERT INTO sources (id, name, config) VALUES ($1, $1, '{}'::jsonb)`, [args[0]]);
        } else if (op === 'sealChunks') {
          const snap = await engine.readPageSnapshot(args[0] as string, {});
          if (!snap) throw new Error(`sealChunks: no page ${args[0]}`);
          await engine.upsertChunks(args[0] as string, args[1] as never, { expectedRevision: snap.revision });
          await sealPageTextProjection(engine, args[0] as string, 'default', snap);
        } else {
          const fn = (engine as any)[op];
          if (typeof fn !== 'function') throw new Error(`no engine method ${op}`);
          result = await fn.apply(engine, args);
        }
        results.push({ ok: view(result, v) });
      } catch (err) {
        results.push(errorClass(err));
      }
    }
  } finally {
    await engine.disconnect();
  }
  return { name: c.name, steps: c.steps, results };
}

const out = resolve(import.meta.dir, '../crates/gbrain-store/tests/fixtures/graph-parity.json');
const fixture = { generated_by: 'rust/scripts/graph-parity-golden.ts', engine: 'pglite', cases: [] as unknown[] };
for (const c of CASES) fixture.cases.push(await runCase(c));
const text = `${JSON.stringify(fixture, null, 1)}\n`;
if (process.argv.includes('--check')) {
  let current = '';
  try { current = readFileSync(out, 'utf8'); } catch { /* missing */ }
  if (current !== text) {
    console.error(`${out} is stale: run bun rust/scripts/graph-parity-golden.ts`);
    process.exit(1);
  }
  console.log('graph-parity fixture is current');
} else {
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, text);
  console.log(`wrote ${fixture.cases.length} cases to ${out}`);
}
