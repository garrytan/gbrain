/**
 * Shared scenario for test/shadow-empty-source-scope.test.ts (PGLite) and test/e2e/shadow-empty-source-scope.test.ts
 * (Postgres): the primary reads `sourceIds: []` as "no scope", and the shadow privacy guard relies on exactly that.
 *
 * The brain has rows in two sources. For each read the guard treats an empty list as unscoped, the primary's read with
 * `sourceIds: []` must return exactly the rows of the same read with no scope at all, and those rows must come from both
 * sources (so a primary that read [] as "nothing" fails here). Then the guard, handed that answer as the Rust result,
 * must not call it a privacy divergence, and the child must not pause.
 */
import { expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { BrainEngine } from '../../src/core/engine.ts';
import { runShadowChild } from '../../src/shadow/child.ts';
import { classifyResult, requestedSourceScope } from '../../src/shadow/classify.ts';
import { encodeValue } from '../../src/shadow/codec.ts';
import { readFaults, readShadowSummary } from '../../src/shadow/ledger.ts';
import { SHADOW_READ_MEMBERS, type ShadowReadMember } from '../../src/shadow/reads.ts';

const OTHER = 'second-source';
const page = (title: string, body: string) => ({ type: 'note' as const, title, compiled_truth: body, timeline: '', frontmatter: {} });

/** Pages, a link, a tag and a fact in the `default` source and in a second source (one slug exists in both). */
export async function fillTwoSources(engine: BrainEngine): Promise<void> {
  await engine.executeRaw('INSERT INTO sources(id, name) VALUES ($1, $1) ON CONFLICT DO NOTHING', [OTHER]);
  for (const sourceId of ['default', OTHER]) {
    await engine.putPage('people/alice-example', page(`Alice in ${sourceId}`, `Alice builds widgets in ${sourceId}.`), { sourceId });
    await engine.putPage(`companies/acme-${sourceId}`, page(`Acme ${sourceId}`, `Acme widgets live in ${sourceId}.`), { sourceId });
    for (const slug of ['people/alice-example', `companies/acme-${sourceId}`]) {
      await engine.sealChunks(slug, [{ chunk_index: 0, chunk_text: `${slug} widgets in ${sourceId}`, chunk_source: 'compiled_truth' }], { sourceId });
    }
    await engine.addLink('people/alice-example', `companies/acme-${sourceId}`, 'works at', 'works_at', undefined, undefined, undefined,
      { fromSourceId: sourceId, toSourceId: sourceId });
    await engine.addTag('people/alice-example', 'team', { sourceId });
    await engine.insertFact({ fact: `Alice prefers async standups (${sourceId})`, entity_slug: 'people/alice-example', source: 'mcp:remember' }, { source_id: sourceId });
  }
}

type Call = (opts: Record<string, unknown>) => Promise<unknown>;

/** Every read the guard reads an empty `sourceIds` list for, with its arguments and the sources its unscoped answer must span. */
function reads(engine: BrainEngine): Array<{ op: ShadowReadMember; call: Call; args: (opts: Record<string, unknown>) => unknown[]; sourcesOf: (rows: unknown) => string[] }> {
  const col = (name: string) => (rows: unknown): string[] => (Array.isArray(rows) ? rows : [rows]).flatMap(r => {
    const v = (r as Record<string, unknown> | null)?.[name];
    return typeof v === 'string' ? [v] : [];
  });
  return [
    { op: 'getPage', call: o => engine.getPage('people/alice-example', o), args: o => ['people/alice-example', o], sourcesOf: col('source_id') },
    { op: 'listPages', call: o => engine.listPages({ ...o, limit: 50 }), args: o => [{ ...o, limit: 50 }], sourcesOf: col('source_id') },
    { op: 'getLinks', call: o => engine.getLinks('people/alice-example', o), args: o => ['people/alice-example', o], sourcesOf: col('from_source_id') },
    { op: 'getBacklinks', call: o => engine.getBacklinks('companies/acme-default', o), args: o => ['companies/acme-default', o], sourcesOf: col('to_source_id') },
    { op: 'getTags', call: o => engine.getTags('people/alice-example', o), args: o => ['people/alice-example', o], sourcesOf: () => [] },
    { op: 'searchKeyword', call: o => engine.searchKeyword('widgets', o), args: o => ['widgets', o], sourcesOf: col('source_id') },
  ];
}

/** Whether the unscoped answer must come from both sources: getPage and getTags return one page's worth; getBacklinks one source's end. */
const SPANS_BOTH: ReadonlySet<ShadowReadMember> = new Set(['listPages', 'getLinks', 'searchKeyword']);

const canonical = (v: unknown): string => JSON.stringify(encodeValue(v));

export async function expectEmptySourceIdsReadsAsUnscoped(engine: BrainEngine): Promise<void> {
  await fillTwoSources(engine);
  for (const { op, call, args, sourcesOf } of reads(engine)) {
    const unscoped = await call({});
    const emptyList = await call({ sourceIds: [] });
    // Exactly the same rows, in the same order, as the read with no scope at all.
    expect(canonical(emptyList), `${op}: sourceIds [] must read as no scope`).toBe(canonical(unscoped));
    // A primary that read [] as "nothing" returns no rows; the unscoped read must hold rows, from both sources where it can.
    const rows = Array.isArray(unscoped) ? unscoped : unscoped === null ? [] : [unscoped];
    expect(rows.length, `${op}: the unscoped read has rows`).toBeGreaterThan(0);
    if (SPANS_BOTH.has(op)) expect(new Set(sourcesOf(unscoped)), `${op}: rows from both sources`).toEqual(new Set(['default', OTHER]));
    // The no-source sentinel is the opposite: the primary allows nothing, and the guard reads it as a single source.
    const none = await call({ sourceId: '__none__' });
    expect(Array.isArray(none) ? none.length : none === null ? 0 : 1, `${op}: sourceId '__none__' allows nothing`).toBe(0);
    expect(requestedSourceScope(args({ sourceId: '__none__' }), op)?.ids, op).toEqual(new Set(['__none__']));
    // The guard reads the call as unscoped, and does not call the (unscoped) Rust answer a divergence.
    expect(requestedSourceScope(args({ sourceIds: [] }), op), op).toBeNull();
    const classified = classifyResult(SHADOW_READ_MEMBERS[op], args({ sourceIds: [] }), encodeValue(emptyList), encodeValue(unscoped), op);
    expect(classified.outcome, op).toBe('match');
    // The child records the comparison without pausing.
    await expectChildDoesNotPause(op, args({ sourceIds: [] }), emptyList, unscoped);
  }
  // listFactsByEntity takes one source id by position (it has no sourceIds list): a read scoped to one source returns that
  // source's facts only, and a fact from the other source is a divergence the guard pauses on.
  const defaults = await engine.listFactsByEntity('default', 'people/alice-example');
  const others = await engine.listFactsByEntity(OTHER, 'people/alice-example');
  expect(defaults.length).toBeGreaterThan(0);
  expect(others.length).toBeGreaterThan(0);
  expect(new Set(defaults.map(f => f.source_id))).toEqual(new Set(['default']));
  expect(classifyResult('exact', ['default', 'people/alice-example'], encodeValue(defaults), encodeValue(defaults), 'listFactsByEntity').outcome).toBe('match');
  expect(classifyResult('exact', ['default', 'people/alice-example'], encodeValue(defaults), encodeValue([...defaults, ...others]), 'listFactsByEntity').outcome).toBe('privacy_diverged');
}

async function expectChildDoesNotPause(op: string, args: unknown[], primaryResult: unknown, rustResult: unknown): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-shadow-empty-scope-'));
  try {
    const input = new PassThrough();
    const control: string[] = [];
    const fake = { async connect() {}, async disconnect() {}, async [op]() { return rustResult; } };
    const done = runShadowChild(dir, {
      input, writeControl: l => control.push(l), heartbeatMs: 60_000, childId: 'c1',
      loadAddon: async () => ({ ok: true, addon: {} as never }), openEngine: () => fake as never,
    });
    input.write(JSON.stringify({ t: 'read', id: 1, at: Date.parse('2026-11-17T00:00:00Z'), op, primary_ms: 2, args: encodeValue(args), result: encodeValue(primaryResult) }) + '\n');
    input.end();
    await done;
    expect(readShadowSummary(dir).by_op[op], op).toEqual({ match: 1 });
    expect(control.filter(l => l.includes('"pause"')), op).toEqual([]);
    expect(readFaults(dir).map(f => f.kind), op).not.toContain('privacy_pause');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
