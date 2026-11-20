/**
 * BrainEngine parity — the order of the keys in a page read, byte for byte.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: putPage (its returned keys), getPage, readPageSnapshot and listPages hand back a page whose JSON has its keys in the same order on
 *    every engine arm, and `gbrain get <slug> --json` (the CLI's own rendering of get_page) and the MCP get_page
 *    answer (remote caller, JSON-serialized) are the same text on every arm: plain page, page with frontmatter and
 *    tags, and an `as_of` read.
 *  - Regression: the Rust engine put the defaulted columns (`contextual_retrieval_mode`, `emotional_weight`,
 *    `salience_touched_at`, `withheld_source_path`) ahead of the store's own fields, so line 2 of `gbrain get --json`
 *    read `contextual_retrieval_mode` where PGLite and Postgres read `id`. Parsed-JSON comparison (toEqual) cannot
 *    see key order, so every other parity case passed.
 *  - Why existing coverage misses it: no case compares serialized text; rust-cli-parity compares parsed JSON.
 *  - Normalising: only the values that differ per run (ids, timestamps, the revision, version ids) are replaced
 *    by a marker, in place; no key is moved, so the compared text still carries the order.
 *  - Seam: none. Real engines, typed methods and the real operation handler plus the CLI's own `formatResult`.
 */
import { describe, expect } from 'bun:test';
import { formatResult, normalizeLocalResult } from '../../src/cli/main.ts';
import { operationsByName, type OperationContext } from '../../src/core/operations.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const PER_RUN = new Set(['id', 'page_id', 'created_at', 'updated_at', 'deleted_at', 'effective_date', 'ingested_at', 'salience_touched_at',
  'updated_at_iso', 'revision', 'knowledge_revision', 'sourceIncarnation', 'chosen_version_id', 'recorded_since']);

/** Replace each non-null per-run value in place by a marker; keys keep their positions, so the text keeps the order. */
function mark(value: unknown, key = ''): unknown {
  if (Array.isArray(value)) return value.map((v) => mark(v, key));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, mark(v, k)]));
  }
  return PER_RUN.has(key) && value !== null ? '<per-run>' : value;
}

const text = (value: unknown) => JSON.stringify(mark(JSON.parse(JSON.stringify(value))), null, 2);

function ctxOf(engine: BrainEngine, remote: boolean): OperationContext {
  return { engine, config: { engine: engine.kind }, remote, dryRun: false, sourceId: 'default', logger: { info() {}, warn() {}, error() {} } } as unknown as OperationContext;
}

/** `gbrain get <slug> --json`: the handler's result, round-tripped as the CLI does, then rendered by formatResult. */
async function cliText(engine: BrainEngine, params: Record<string, unknown>): Promise<string> {
  const result = normalizeLocalResult(await operationsByName.get_page.handler(ctxOf(engine, false), params));
  const out = formatResult('get_page', result, { ...params, json: true });
  expect(out.endsWith('\n')).toBe(true);
  return text(JSON.parse(out));
}

/** The MCP get_page answer: a remote caller, the result serialized as the transport does. */
async function mcpText(engine: BrainEngine, params: Record<string, unknown>): Promise<string> {
  return text(await operationsByName.get_page.handler(ctxOf(engine, true), params));
}

async function seed(engine: BrainEngine) {
  await engine.putPage('notes/plain', { type: 'note', title: 'Plain', compiled_truth: 'A plain body.', timeline: '' });
  await engine.putPage('notes/rich', {
    type: 'person', title: 'Rich', compiled_truth: 'Has frontmatter and tags.', timeline: '- **2026-01-02** | filed\n',
    frontmatter: { alias: ['r'], nested: { b: 1, a: 2 }, z_last: true },
  });
  await engine.addTag('notes/rich', 'beta');
  await engine.addTag('notes/rich', 'alpha');
}

describe('engine parity: the key order of a page read', () => {
  parityTest('getPage, readPageSnapshot and listPages serialize with the same key order, and putPage returns its keys in that order', { methods: ['putPage', 'getPage', 'readPageSnapshot', 'listPages'] }, async (engine) => {
    const put = await engine.putPage('notes/put', { type: 'note', title: 'Put', compiled_truth: 'A body.', timeline: '' });
    await seed(engine);
    const plain = await engine.getPage('notes/plain', { sourceId: 'default' });
    const rich = await engine.getPage('notes/rich', { sourceId: 'default' });
    const snapshot = await engine.readPageSnapshot('notes/rich', { sourceId: 'default' });
    const listed = await engine.listPages({ sourceId: 'default' } as never);
    const keys = (v: unknown) => Object.keys(v as object);
    expect(keys(plain)).toEqual(keys(rich));
    return { putKeys: keys(put), getPlain: text(plain), getRich: text(rich), snapshot: text(snapshot), list: text(listed.filter((p) => ['notes/plain', 'notes/rich'].includes(p.slug)).sort((a, b) => a.slug.localeCompare(b.slug))) };
  });

  parityTest('gbrain get --json prints the same text for a plain page and for a page with frontmatter and tags', { methods: ['putPage', 'readPageSnapshot'] }, async (engine) => {
    await seed(engine);
    return { plain: await cliText(engine, { slug: 'notes/plain' }), rich: await cliText(engine, { slug: 'notes/rich' }), content: await cliText(engine, { slug: 'notes/rich', include_content: true }) };
  });

  parityTest('the MCP get_page answer is the same text for a plain page and for a page with frontmatter and tags', { methods: ['putPage', 'readPageSnapshot'] }, async (engine) => {
    await seed(engine);
    return { plain: await mcpText(engine, { slug: 'notes/plain' }), rich: await mcpText(engine, { slug: 'notes/rich' }), content: await mcpText(engine, { slug: 'notes/rich', include_content: true }) };
  });

  parityTest('an as_of get_page read prints the same text through the CLI and through MCP', { methods: ['putPage', 'createVersion', 'readPageSnapshot'] }, async (engine) => {
    await engine.putPage('vt/keys', { type: 'note', title: 'Keys', compiled_truth: 'old body', timeline: '', frontmatter: { valid_from: '2026-01-01' } });
    await engine.createVersion('vt/keys', { sourceId: 'default' });
    await engine.putPage('vt/keys', { type: 'note', title: 'Keys', compiled_truth: 'new body', timeline: '', frontmatter: { valid_from: '2026-06-01' } });
    const params = { slug: 'vt/keys', as_of: '2026-07-01' };
    return { cli: await cliText(engine, params), mcp: await mcpText(engine, params) };
  });
});
