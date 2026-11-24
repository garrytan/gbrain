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
import { describe } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { ChatResult } from '../../src/core/ai/gateway.ts';
import { runExtractExplain } from '../../src/commands/extract-explain.ts';
import { siblingCanonical } from '../../src/core/mentions/siblings.ts';
import { LAST_EXTRACT_ATOMS_AT_KEY, sourcesWithStaleExtractAtomsRun } from '../../src/core/cycle/extract-atoms-stamp.ts';
import { atomsExistingForHashes, discoverExtractablePages, runPhaseExtractAtoms, tombstonedTranscriptsForHashes } from '../../src/core/cycle/extract-atoms.ts';
import { releasePartialDispositions, stampTranscriptTombstone } from '../../src/core/cycle/extract-atoms-input.ts';
import { createSource, parityArms } from './harness.ts';
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

  parityTest('extract-atoms-input.ts:117 releasing partial dispositions refuses instead of leaving items skipped', { methods: ['executeRaw'], requires: 'raw_sql' }, async (engine) => {
    await releasePartialDispositions(engine, 'default', 1000);
    return 'released';
  });

  parityTest('extract-atoms-input.ts:138 a transcript tombstone is stamped or refused, never dropped', { methods: ['executeRaw'], requires: 'raw_sql' }, async (engine) => {
    await stampTranscriptTombstone(engine, 'default', '/fake/session.txt', HASH);
    return [...await tombstonedTranscriptsForHashes(engine, 'default', [HASH.slice(0, 16)])];
  });

  parityTest('extract-atoms.ts:470 page discovery refuses instead of finding no pages', { methods: ['executeRaw', 'putPage'], requires: 'raw_sql' }, async (engine) => {
    await engine.putPage('meetings/example', page('meeting', 'Example', 'We met and decided many durable things. '.repeat(40)));
    return (await discoverExtractablePages(engine, 'default')).map(p => p.slug);
  });

  parityTest('extract-atoms.ts:567 the idempotency read refuses instead of saying none were extracted', { methods: ['executeRaw'], requires: 'raw_sql' }, async (engine) => {
    return [...await atomsExistingForHashes(engine, 'default', [HASH.slice(0, 16)])];
  });

  parityTest('extract-atoms.ts:612 the tombstone read refuses instead of saying none are tombstoned', { methods: ['executeRaw'], requires: 'raw_sql' }, async (engine) => {
    return [...await tombstonedTranscriptsForHashes(engine, 'default', [HASH.slice(0, 16)])];
  });

  // The strike write is reached only after the phase's first state statement (extract-atoms-input.ts:117), which a Rust
  // brain refuses first; the SQL arms record the strike, and the phase on Rust refuses rather than skipping it.
  parityTest('extract-atoms.ts:1020 a failed transcript records its strike, and the phase refuses where it cannot', { methods: ['executeRaw'], requires: 'raw_sql' }, async (engine) => {
    const result = await runPhaseExtractAtoms(engine, { sourceId: 'default', _pages: [], _chat: async () => reply('not valid output'),
      _transcripts: [{ filePath: '/fake/session.txt', content: 'A synthetic session about durable decisions. '.repeat(20), contentHash: HASH }] });
    return { status: result.status };
  });

  parityTest('extract-atoms phase refuses on an engine without the state store instead of reporting no work', { methods: ['executeRaw', 'putPage'], requires: 'raw_sql' }, async (engine) => {
    await engine.putPage('meetings/example', page('meeting', 'Example', 'We met and decided many durable things. '.repeat(40)));
    const result = await runPhaseExtractAtoms(engine, { _transcripts: [], _chat: async () => reply('[]') });
    return { status: result.status, reason: (result.details as { reason?: string } | undefined)?.reason ?? null };
  });
});
