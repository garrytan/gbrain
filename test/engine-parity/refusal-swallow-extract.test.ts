/**
 * BrainEngine parity: the lane 6 refusal-swallow sites on the extract path (lane 8's triage, rule
 * capability_refusal_swallowed). Three now read typed members, so a Rust brain answers; the extract-atoms state reads
 * and writes, which a Rust brain has no store for, now let the refusal through.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: `extract --explain <kind>` prints the same 7-day rollup on every arm; siblingCanonical names the same
 *    group page; the extract-atoms stale-run read names the same stale sources. Each extract-atoms state statement
 *    answers on PGLite and Postgres and throws the typed `engine_capability_missing` refusal on Rust, and so does the
 *    phase, instead of reporting `no_work`.
 *  - Regression: on a Rust brain each catch answered a default: explain said "no runs recorded" with no rollup, no
 *    sibling group formed (facts went under a slug no page has), the stale-run warning never fired, page discovery
 *    found nothing and the phase reported no work, and the idempotency and tombstone reads said "none", which
 *    re-spends every page and transcript.
 *  - Why existing coverage misses it: every one of these ran through `executeRaw` inside a catch, and their tests run
 *    on PGLite only.
 *  - Seam: `_chat` / `_transcripts` / `_pages` (the phase's own test seams) instead of a model call; real engines.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { ChatResult } from '../../src/core/ai/gateway.ts';
import { runExtractExplain } from '../../src/commands/extract-explain.ts';
import { siblingCanonical } from '../../src/core/mentions/siblings.ts';
import { LAST_EXTRACT_ATOMS_AT_KEY, sourcesWithStaleExtractAtomsRun } from '../../src/core/cycle/extract-atoms-stamp.ts';
import { atomsExistingForHashes, discoverExtractablePages, runPhaseExtractAtoms, tombstonedTranscriptsForHashes } from '../../src/core/cycle/extract-atoms.ts';
import { releasePartialDispositions, stampTranscriptTombstone } from '../../src/core/cycle/extract-atoms-input.ts';
import { createSource, parityArms } from './harness.ts';
import { isCapabilityRefusal } from './arm-capabilities.ts';
import { testBackends } from '../helpers/test-backends.ts';

const { parityTest } = parityArms(testBackends());

const page = (type: string, title: string, body: string, frontmatter: Record<string, unknown> = {}) =>
  ({ type, title, compiled_truth: body, timeline: '', frontmatter }) as Parameters<BrainEngine['putPage']>[1];
const reply = (text: string): ChatResult => ({ text, blocks: [{ type: 'text', text }], stopReason: 'end',
  usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic' });
const HASH = 'abcdef0123456789abcdef0123456789';

/** The Rust store's named stop for the extract_atoms state store (RUST_ENGINE.md, lane 7, until the store format change). */
const STATE_STORE_STOP = {
  code: 'engine_capability_missing', reason: 'raw_sql',
  detail: 'member=assertAtomStateStore (the store keeps no extract_atoms page or transcript state) capability=raw_sql outcome=none written=nothing',
};
const stopOf = (e: unknown) => {
  const err = e as { code?: unknown; reason?: unknown; detail?: unknown } | null;
  return { code: err?.code, reason: err?.reason, detail: err?.detail };
};

/** What a command printed to stdout. */
async function stdoutOf(run: () => Promise<unknown>): Promise<string> {
  const out: string[] = [];
  const log = console.log;
  console.log = (...a: unknown[]) => { out.push(a.join(' ')); };
  try { await run(); } finally { console.log = log; }
  return out.join('\n');
}

describe('refusal-swallow extract sites', () => {
  parityTest('extract-explain.ts:169 explain prints the kind rollup, not "no runs recorded"', { methods: ['readExtractKindRollup7d'] }, async (engine) => {
    const json = JSON.parse(await stdoutOf(() => runExtractExplain(engine, ['--explain', 'meeting', '--json']))) as { rollup_7d: unknown };
    const text = await stdoutOf(() => runExtractExplain(engine, ['--explain', 'meeting']));
    return { rollup: json.rollup_7d, lines: text.split('\n').filter(l => l.startsWith('Last 7 days') || l.startsWith('  ')).filter(l => !l.includes('/')) };
  });

  parityTest('siblings.ts:110 two pages one name resolved to form one group', { methods: ['readSiblingGroupRows', 'putPage'] }, async (engine) => {
    await engine.putPage('companies/acme-sheet', page('company', 'Account sheet: Acme Example', 'The account sheet.'));
    await engine.putPage('companies/acme-crm', page('company', 'CRM record: Acme Example', 'The CRM record.'));
    await engine.putPage('companies/acme-other', page('company', 'Acme Example', 'A different company.', { identity: 'separate' }));
    return {
      group: await siblingCanonical(engine, 'default', ['companies/acme-crm', 'companies/acme-sheet']),
      separate: await siblingCanonical(engine, 'default', ['companies/acme-crm', 'companies/acme-other']),
      missing: await siblingCanonical(engine, 'default', ['companies/acme-crm', 'companies/ghost']),
    };
  });

  parityTest('extract-atoms-stamp.ts:57 the stale-run read names sources with no recent extract_atoms run', { methods: ['listSourceRecords', 'updateSourceConfig'] }, async (engine, backend) => {
    await createSource(engine, backend, 'fresh');
    await createSource(engine, backend, 'stale');
    await engine.updateSourceConfig('fresh', { [LAST_EXTRACT_ATOMS_AT_KEY]: new Date().toISOString() });
    await engine.updateSourceConfig('stale', { [LAST_EXTRACT_ATOMS_AT_KEY]: '2020-01-01T00:00:00.000Z' });
    const rows = await sourcesWithStaleExtractAtomsRun(engine, [{ source_id: 'fresh', backlog: 2 }, { source_id: 'stale', backlog: 3 }, { source_id: 'default', backlog: 1 }]);
    return rows?.map(r => ({ source_id: r.source_id, backlog: r.backlog, stamp: r.last_extract_atoms_at }));
  });

  parityTest('extract-atoms-input.ts:117 releasing partial dispositions clears only the managed-atoms checkpoints recorded below the cap', {
    methods: ['writeOpCheckpointRecord', 'readOpCheckpointRecord', 'releasePartialAtomDispositions'],
  }, async (engine) => {
    const seed = (fp: string, key: Record<string, unknown>) => engine.writeOpCheckpointRecord('managed-atoms', fp, [key]);
    await seed('low', { sourceId: 'default', kind: 'page', partial: 500 });
    await seed('at-cap', { sourceId: 'default', kind: 'page', partial: 1000 });
    await seed('high', { sourceId: 'default', kind: 'page', partial: 2000 });
    await seed('whole', { sourceId: 'default', kind: 'page' });
    await seed('other-source', { sourceId: 'other', kind: 'page', partial: 500 });
    await releasePartialDispositions(engine, 'default', 1000);
    const kept: Record<string, boolean> = {};
    for (const fp of ['low', 'at-cap', 'high', 'whole', 'other-source']) kept[fp] = (await engine.readOpCheckpointRecord('managed-atoms', fp)) !== null;
    expect(kept).toEqual({ low: false, 'at-cap': true, high: true, whole: true, 'other-source': true });
    return kept;
  });

  parityTest('extract-atoms-input.ts:138 a transcript tombstone is stamped or refused, never dropped', { methods: ['executeRaw'], requires: 'raw_sql' }, async (engine) => {
    try {
      await stampTranscriptTombstone(engine, 'default', '/fake/session.txt', HASH);
    } catch (error) {
      // The Rust store keeps no transcript state until the store format change (RUST_ENGINE.md, lane 7): the write refuses.
      expect(isCapabilityRefusal(error, 'raw_sql')).toBe(true);
      throw error;
    }
    return [...await tombstonedTranscriptsForHashes(engine, 'default', [HASH.slice(0, 16)])];
  });

  parityTest('extract-atoms.ts:470 page discovery finds the live, long, unextracted pages of the source, newest first', {
    methods: ['putPage', 'getPage', 'listExtractablePages'],
  }, async (engine, backend) => {
    const body = 'We met and decided many durable things. '.repeat(40);
    await engine.putPage('meetings/older', page('meeting', 'Older', body));
    await engine.putPage('meetings/short', page('meeting', 'Short', 'Too short to extract.'));
    await engine.putPage('meetings/dreamed', page('meeting', 'Dreamed', body, { dream_generated: 'true' }));
    await engine.putPage('meetings/opted-out', page('meeting', 'Opted out', body, { extract_atoms: 'false' }));
    await engine.putPage('people/alice-example', page('person', 'Alice Example', body));
    await engine.putPage('meetings/covered', page('meeting', 'Covered', `${body} covered`));
    await engine.putPage('meetings/newer', page('meeting', 'Newer', `${body} newer`));
    const covered = (await engine.getPage('meetings/covered'))!.content_hash!;
    await engine.putPage('atoms/covered-atom', page('atom', 'A decision', 'An atom.', { source_hash: covered.slice(0, 16) }));
    await createSource(engine, backend, 'other');
    await engine.putPage('meetings/elsewhere', page('meeting', 'Elsewhere', body), { sourceId: 'other' } as never);
    const all = (await discoverExtractablePages(engine, 'default')).map(p => p.slug);
    const named = (await discoverExtractablePages(engine, 'default', ['meetings/older', 'meetings/short'])).map(p => p.slug);
    const first = (await discoverExtractablePages(engine, 'default', undefined, 1)).map(p => p.slug);
    const identity = (await discoverExtractablePages(engine, 'default', ['meetings/older']))[0];
    const older = (await engine.getPage('meetings/older'))!;
    expect({ all, named, first }).toEqual({ all: ['meetings/newer', 'meetings/older'], named: ['meetings/older'], first: ['meetings/newer'] });
    expect(identity?.contentHash).toBe(older.content_hash);
    return { all, named, first, pinned: identity?.identity?.pageId === older.id && typeof identity?.identity?.revision === 'string' };
  });

  parityTest('extract-atoms.ts:567 the idempotency read names the hashes a live, unmanaged atom of the source carries', {
    methods: ['putPage', 'listAtomSourceHashes'],
  }, async (engine, backend) => {
    const h = (n: number) => `${String(n).repeat(16)}`.slice(0, 16);
    await engine.putPage('atoms/one', page('atom', 'One', 'An atom.', { source_hash: h(1) }));
    await engine.putPage('atoms/managed', page('atom', 'Managed', 'An atom.', { source_hash: h(2), managed_extraction: 'true' }));
    await engine.putPage('notes/not-atom', page('note', 'Not an atom', 'A note.', { source_hash: h(3) }));
    await createSource(engine, backend, 'other');
    await engine.putPage('atoms/elsewhere', page('atom', 'Elsewhere', 'An atom.', { source_hash: h(4) }), { sourceId: 'other' } as never);
    const found = [...await atomsExistingForHashes(engine, 'default', [h(1), h(2), h(3), h(4), h(5)])].sort();
    expect(found).toEqual([h(1)]);
    return found;
  });

  parityTest('extract-atoms.ts:612 the tombstone read finds no tombstoned transcript on a brain that recorded none', {
    methods: ['listTombstonedTranscripts'],
  }, async (engine) => {
    return [...await tombstonedTranscriptsForHashes(engine, 'default', [HASH.slice(0, 16)])];
  });

  parityTest('extract-atoms.ts:1550 the atom-title read lists the live atoms bound to one source page', {
    methods: ['putPage', 'softDeletePage', 'listSourcePageAtomTitles'],
  }, async (engine) => {
    await engine.putPage('atoms/first', page('atom', 'First Decision', 'An atom.', { source_slug: 'meetings/m1' }));
    await engine.putPage('atoms/second', page('atom', 'Second Decision', 'An atom.', { source_slug: 'meetings/m1' }));
    await engine.putPage('atoms/gone', page('atom', 'Gone Decision', 'An atom.', { source_slug: 'meetings/m1' }));
    await engine.softDeletePage('atoms/gone');
    await engine.putPage('atoms/other-page', page('atom', 'Other', 'An atom.', { source_slug: 'meetings/m2' }));
    await engine.putPage('notes/bound-note', page('note', 'Not an atom', 'A note.', { source_slug: 'meetings/m1' }));
    const rows = (await engine.listSourcePageAtomTitles('default', 'meetings/m1')).sort((a, b) => a.slug.localeCompare(b.slug));
    expect(rows).toEqual([{ slug: 'atoms/first', title: 'First Decision' }, { slug: 'atoms/second', title: 'Second Decision' }]);
    return rows;
  });

  // The strike write (extract-atoms.ts:1020) is reached only after a model call. A Rust brain refuses earlier, at the
  // transcript key read, before any model call; the SQL arms record the strike.
  parityTest('extract-atoms.ts:1020 a failed transcript records its strike, and the phase refuses where it cannot, before any model call', { methods: ['executeRaw'], requires: 'raw_sql' }, async (engine) => {
    let calls = 0;
    try {
      const result = await runPhaseExtractAtoms(engine, { sourceId: 'default', _pages: [], _chat: async () => { calls++; return reply('not valid output'); },
        _transcripts: [{ filePath: '/fake/session.txt', content: 'A synthetic session about durable decisions. '.repeat(20), contentHash: HASH }] });
      return { status: result.status, calls };
    } catch (error) {
      expect(isCapabilityRefusal(error, 'raw_sql')).toBe(true);
      expect(calls).toBe(0);
      throw error;
    }
  });

  parityTest('extract-atoms phase with nothing to extract reports no work on every engine', {
    methods: ['releasePartialAtomDispositions', 'listExtractablePages'],
  }, async (engine) => {
    await engine.putPage('meetings/short', page('meeting', 'Short', 'Too short to extract.'));
    const result = await runPhaseExtractAtoms(engine, { _transcripts: [], _chat: async () => { throw new Error('no model call expected'); } });
    return { status: result.status, reason: (result.details as { reason?: string } | undefined)?.reason ?? null };
  });

  parityTest('extract-atoms phase with work refuses on an engine without the state store, before any model call', {
    methods: ['putPage', 'assertAtomStateStore'], requires: 'raw_sql',
  }, async (engine) => {
    await engine.putPage('meetings/example', page('meeting', 'Example', 'We met and decided many durable things. '.repeat(40)));
    let calls = 0;
    try {
      const result = await runPhaseExtractAtoms(engine, { _transcripts: [], _chat: async () => { calls++; return reply('[]'); } });
      return { status: result.status, reason: (result.details as { reason?: string } | undefined)?.reason ?? null, calls };
    } catch (error) {
      // No model spend before the refusal: the gate runs after discovery, before the first model call.
      expect({ refused: isCapabilityRefusal(error, 'raw_sql'), stop: stopOf(error), calls }).toEqual({ refused: true, stop: STATE_STORE_STOP, calls: 0 });
      throw error;
    }
  });
});
