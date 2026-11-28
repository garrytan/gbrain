/**
 * BrainEngine parity: the lane 6 refusal-swallow sites on the extract path (lane 8's triage, rule
 * capability_refusal_swallowed). Every site reads or writes through a typed member: the extract_atoms ledgers are Rust
 * store records from store format 17. Page discovery (listExtractablePages) is sync 21's statement, which reads state
 * the store does not keep, so on a Rust brain it refuses by name and the cases that discover pages stop there.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: `extract --explain <kind>` prints the same 7-day rollup on every arm; siblingCanonical names the same
 *    group page; the extract-atoms stale-run read names the same stale sources. Each extract-atoms ledger write and
 *    read gives the same answer on every engine, and the phase with work runs, records what it settled and skips it on
 *    the next run, on every engine.
 *  - Regression: on a Rust brain each catch answered a default: explain said "no runs recorded" with no rollup, no
 *    sibling group formed (facts went under a slug no page has), the stale-run warning never fired, page discovery
 *    found nothing and the phase reported no work, and the idempotency and tombstone reads said "none", which
 *    re-spends every page and transcript.
 *  - Why existing coverage misses it: every one of these ran through `executeRaw` inside a catch, and their tests run
 *    on PGLite only.
 *  - Seam: `_chat` / `_transcripts` / `_pages` (the phase's own test seams) instead of a model call; real engines.
 */
import { describe, expect } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { ChatResult } from '../../src/core/ai/gateway.ts';
import { runExtractExplain } from '../../src/commands/extract-explain.ts';
import { siblingCanonical } from '../../src/core/mentions/siblings.ts';
import { LAST_EXTRACT_ATOMS_AT_KEY, sourcesWithStaleExtractAtomsRun } from '../../src/core/cycle/extract-atoms-stamp.ts';
import { atomsExistingForHashes, countExtractAtomsBacklog, discoverExtractablePages, runPhaseExtractAtoms, tombstonedTranscriptsForHashes } from '../../src/core/cycle/extract-atoms.ts';
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

  parityTest('extract-atoms-input.ts:138 a transcript tombstone is stamped, and the tombstone read finds it', {
    methods: ['stampAtomTranscriptTombstone', 'strikeAtomTranscript', 'recordAtomTranscriptPartial', 'listTombstonedTranscripts', 'releasePartialAtomDispositions'],
  }, async (engine) => {
    const h = (n: number) => `${n}`.repeat(16).slice(0, 16);
    await stampTranscriptTombstone(engine, 'default', '/fake/session.txt', HASH);
    // A strike alone is not a tombstone; a partial row is skipped until a raised cap releases it.
    expect(await engine.strikeAtomTranscript('default', '/fake/struck.txt', h(1))).toBe(1);
    expect(await engine.strikeAtomTranscript('default', '/fake/struck.txt', h(1))).toBe(2);
    await engine.recordAtomTranscriptPartial('default', '/fake/cut.txt', h(2), 500);
    await engine.recordAtomTranscriptPartial('default', '/fake/cut-high.txt', h(3), 5000);
    const read = async () => [...await tombstonedTranscriptsForHashes(engine, 'default', [HASH.slice(0, 16), h(1), h(2), h(3)])].sort();
    const before = await read();
    await releasePartialDispositions(engine, 'default', 1000);
    const after = await read();
    const otherSource = [...await tombstonedTranscriptsForHashes(engine, 'other', [HASH.slice(0, 16)])];
    return { before, after, otherSource };
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
    expect(identity?.contentHash).toBe(older.content_hash as string);
    return { all, named, first, pinned: identity?.identity?.pageId === older.id && typeof identity?.identity?.revision === 'string' };
  });

  parityTest('extract-atoms.ts:470 discovery leaves out a page held for its current input, not one held for older content or a partial hold (#10270)', {
    methods: ['putPage', 'getPage', 'recordHeldGenerationRow', 'listExtractablePages'],
  }, async (engine) => {
    const body = 'We met and decided many durable things. '.repeat(40);
    for (const slug of ['meetings/held', 'meetings/held-pinned', 'meetings/stale-hold', 'meetings/partial', 'meetings/open']) {
      await engine.putPage(slug, page('meeting', slug, `${body} ${slug}`));
    }
    const pageOf = async (slug: string) => (await engine.getPage(slug))!;
    const hold = (holdId: string, inputPin: string, context: string) =>
      ({ holdId, runId: null, inputPin, inputSize: null, setHash: 'set', reason: 'shrunk', context, proposal: null, proposalBytes: 0 });
    const held = await pageOf('meetings/held');
    const pinned = await pageOf('meetings/held-pinned');
    const partial = await pageOf('meetings/partial');
    const record = (slug: string, row: ReturnType<typeof hold>) =>
      engine.transaction(tx => tx.recordHeldGenerationRow({ sourceId: 'default', kind: 'atom', ownerKey: `source_slug:${slug}` }, row as never));
    await record('meetings/held', hold('hold-a', held.content_hash!, '{}'));
    await record('meetings/held-pinned', hold('hold-b', `${pinned.content_hash}:${pinned.id}:${(pinned as unknown as { knowledge_revision: string }).knowledge_revision}`, '{}'));
    await record('meetings/stale-hold', hold('hold-c', 'f'.repeat(64), '{}'));
    await record('meetings/partial', hold('hold-d', partial.content_hash!, '{"partial":true}'));
    const list = async (holdIds: string[]) => (await engine.listExtractablePages({
      sourceId: 'default', types: ['meeting'], minChars: 500, limit: 50, affectedSlugs: null, connectorExclusion: null, holdIds,
    })).map(p => p.slug).sort();
    const out = { all: await list([]), held: await list(['hold-a', 'hold-b', 'hold-c', 'hold-d']), other: await list(['hold-other']) };
    expect(out.held).toEqual(['meetings/open', 'meetings/partial', 'meetings/stale-hold']);
    return out;
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

  parityTest('extract-atoms.ts:1020 a failed transcript records its strike on every engine, and three strikes tombstone it', {
    methods: ['strikeAtomTranscript', 'listLiveTranscriptGenerations', 'listTombstonedTranscripts'],
  }, async (engine) => {
    let calls = 0;
    const run = () => runPhaseExtractAtoms(engine, { sourceId: 'default', _pages: [], _chat: async () => { calls++; return reply('not valid output'); },
      _transcripts: [{ filePath: '/fake/session.txt', content: 'A synthetic session about durable decisions. '.repeat(20), contentHash: HASH }] });
    const statuses: string[] = [];
    const tombstoned: number[] = [];
    for (let i = 0; i < 4; i++) {
      statuses.push((await run()).status);
      tombstoned.push((await tombstonedTranscriptsForHashes(engine, 'default', [HASH.slice(0, 16)])).size);
    }
    // Three failures of the same content tombstone the transcript; the fourth run does not call the model.
    return { statuses, tombstoned, calls };
  });

  parityTest('extract-atoms phase with nothing to extract reports no work on every engine', {
    methods: ['releasePartialAtomDispositions', 'listExtractablePages'],
  }, async (engine) => {
    await engine.putPage('meetings/short', page('meeting', 'Short', 'Too short to extract.'));
    const result = await runPhaseExtractAtoms(engine, { _transcripts: [], _chat: async () => { throw new Error('no model call expected'); } });
    return { status: result.status, reason: (result.details as { reason?: string } | undefined)?.reason ?? null };
  });

  parityTest('extract-atoms page discovery refuses by name on a Rust brain before any model call (batch-17 re-merge, ruling A)', {
    methods: ['putPage', 'listExtractablePages'],
  }, async (engine, backend) => {
    // Sync 21 (GST-4020 #10542, #9888 #10483) reads source opt-outs, still-current scans and canonical snapshots the
    // Rust store does not keep, so its listExtractablePages refuses: the phase stops at discovery, before the model.
    await engine.putPage('meetings/example', page('meeting', 'Example', 'We met and decided many durable things. '.repeat(40)));
    let calls = 0;
    const chat = async () => {
      calls++;
      if (backend === 'rust') throw new Error('a Rust brain must not reach the model');
      return reply('[]');
    };
    try {
      const result = await runPhaseExtractAtoms(engine, { _transcripts: [], _chat: chat });
      const details = result.details as { pages_processed?: number } | undefined;
      return { status: result.status, pages: details?.pages_processed ?? null, calls };
    } catch (error) {
      const e = error as { code?: unknown; detail?: unknown };
      expect({ code: e.code, member: String(e.detail ?? '').split(' ')[0], calls })
        .toEqual({ code: 'engine_capability_missing', member: 'member=listExtractablePages', calls: 0 });
      throw error;
    }
  });

  parityTest('extract-atoms phase with work runs on every engine, records the page as settled and skips it on the next run', {
    methods: ['putPage', 'assertAtomStateStore', 'writeAtomPageState', 'listExtractablePages', 'countAtomExtractionBacklog', 'softDeletePage', 'restorePage'],
  }, async (engine) => {
    await engine.putPage('meetings/example', page('meeting', 'Example', 'We met and decided many durable things. '.repeat(40)));
    let calls = 0;
    const run = async () => {
      const result = await runPhaseExtractAtoms(engine, { _transcripts: [], _chat: async () => { calls++; return reply('[]'); } });
      const details = result.details as { reason?: string; pages_processed?: number; atoms_extracted?: number } | undefined;
      return { status: result.status, reason: details?.reason ?? null, pages: details?.pages_processed ?? null, atoms: details?.atoms_extracted ?? null };
    };
    const first = await run();
    const backlogAfterFirst = await countExtractAtomsBacklog(engine, 'default');
    const second = await run();
    const discovered = (await discoverExtractablePages(engine, 'default')).map(p => p.slug);
    // A soft delete and a restore drop the page's ledger rows (gbrain_clear_atom_page_state): the page is offered again.
    await engine.softDeletePage('meetings/example');
    await engine.restorePage('meetings/example');
    const afterRestore = (await discoverExtractablePages(engine, 'default')).map(p => p.slug);
    const backlogAfterRestore = await countExtractAtomsBacklog(engine, 'default');
    return { first, backlogAfterFirst, second, discovered, afterRestore, backlogAfterRestore, calls };
  });

  parityTest('extract-atoms phase writes the same atoms from a page and a transcript on every engine, and settles both', {
    methods: ['putPage', 'listPages', 'writeAtomPageState', 'listLiveTranscriptGenerations', 'listConversationPageFrontmatter'],
  }, async (engine) => {
    const atoms = (titles: string[]): ChatResult => ({ text: JSON.stringify(titles.map(title => ({ title, atom_type: 'insight', body: `${title} body.` }))),
      blocks: [{ type: 'text', text: '' }], stopReason: 'end', usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0, cache_creation_tokens: 0 },
      model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic' });
    await engine.putPage('meetings/example', page('meeting', 'Example', 'We met and decided many durable things. '.repeat(40)));
    const transcript = { filePath: '/fake/session.txt', content: 'A synthetic session about durable decisions. '.repeat(20), contentHash: HASH };
    let calls = 0;
    const run = async () => {
      const result = await runPhaseExtractAtoms(engine, { _transcripts: [transcript], _chat: async () => { calls++; return atoms(['First claim', 'Second claim']); } });
      const d = result.details as { atoms_extracted?: number; pages_processed?: number; transcripts_processed?: number; duplicates_skipped?: number };
      return { status: result.status, atoms: d.atoms_extracted, pages: d.pages_processed, transcripts: d.transcripts_processed, duplicates: d.duplicates_skipped };
    };
    const first = await run();
    const second = await run();
    // Atom slugs carry today's date; compare them without it.
    const slugs = (await engine.listPages({ type: 'atom' } as never)).map(p => p.slug.replace(/\d{4}-\d{2}-\d{2}/, 'DATE')).sort();
    return { first, second, slugs, calls };
  });

  parityTest('extract-atoms.ts:651 a configured session corpus is read, or the phase refuses by name: never a quiet skip', {
    methods: ['putPage'], requires: 'raw_sql',
  }, async (engine) => {
    // The session corpus resolves each file's source through archive.ts, which reads with raw SQL. A Rust brain cannot
    // answer that yet, and a bare catch used to turn the refusal into "no transcripts": the phase reported its pages
    // and skipped every corpus file with no sign. Until archive.ts is typed the phase refuses by name instead.
    await engine.putPage('meetings/short', page('meeting', 'Short', 'Too short to extract.'));
    const brainDir = mkdtempSync(join(tmpdir(), 'extract-corpus-'));
    try {
      const corpusDir = join(brainDir, 'corpus');
      mkdirSync(corpusDir);
      writeFileSync(join(corpusDir, '2026-01-05-planning.md'), 'A synthetic session about durable decisions. '.repeat(60));
      let calls = 0;
      try {
        const result = await runPhaseExtractAtoms(engine, {
          brainDir, _loadConfig: async () => ({ dream: { synthesize: { session_corpus_dir: corpusDir } } }) as never,
          _chat: async () => { calls++; return reply('[]'); },
        });
        const d = result.details as { transcripts_processed?: number } | undefined;
        return { status: result.status, transcripts: d?.transcripts_processed ?? null, calls };
      } catch (error) {
        // No model spend before the refusal.
        expect({ refused: isCapabilityRefusal(error, 'raw_sql'), calls }).toEqual({ refused: true, calls: 0 });
        throw error;
      }
    } finally {
      rmSync(brainDir, { recursive: true, force: true });
    }
  });
});
