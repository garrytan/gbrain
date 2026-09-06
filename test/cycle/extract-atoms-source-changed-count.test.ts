/**
 * Per-page `atoms_source_changed` — read-only visibility for the drift
 * population doctor's `atom_provenance_drift` check (#4566) already measures
 * brain-wide and only when someone runs `gbrain doctor`.
 *
 * extract_atoms writes each page-derived atom with `source_slug` (the source
 * page) and `source_hash` (first 16 chars of that page's content_hash at
 * extraction time). Editing the page leaves older atoms pointing at the old
 * hash — doctor's `source_changed` bucket, and by far its largest one. The
 * phase now counts that slice for each page it touches and reports it in
 * details + the summary string, so the number rides ordinary cycle output.
 *
 * Diagnostic only, exactly like the doctor check: nothing is written, deleted,
 * or retired on the strength of this count.
 *
 * PGLite round-trip with a stubbed chat gateway (no model calls); the drain
 * case is pure-over-injected-deps like test/extract-atoms-drain.test.ts.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { runPhaseExtractAtoms } from '../../src/core/cycle/extract-atoms.ts';
import {
  runExtractAtomsDrain,
  type ExtractAtomsDrainDeps,
} from '../../src/core/cycle/extract-atoms-drain.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import type { ChatResult, ChatOpts } from '../../src/core/ai/gateway.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
}, 60_000);

beforeEach(async () => {
  await resetPgliteState(engine);
});

const PAGE_SLUG = 'writings/drift-essay';
const CURRENT_HASH = '1111111111111111aaaa'; // >16 chars: the phase slices to 16
const CURRENT_HASH16 = CURRENT_HASH.slice(0, 16);
const OLD_HASH16 = '9999999999999999';

/** Chat stub emitting one atom, or none when `title` is null (zero yield). */
const stubChat =
  (title: string | null) =>
  async (_o: ChatOpts): Promise<ChatResult> => ({
    text: title
      ? `[{"title":"${title}","atom_type":"insight","body":"A claim worth keeping."}]`
      : '[]',
    blocks: [{ type: 'text', text: '' }],
    stopReason: 'end',
    usage: { input_tokens: 100, output_tokens: 50, cache_read_tokens: 0, cache_creation_tokens: 0 },
    model: 'anthropic:claude-haiku-4-5',
    providerId: 'anthropic',
  });

/**
 * Seed an atom row directly. Slugs are deliberately unlike the deterministic
 * slugs the phase derives, so seeding can never collide with an import.
 */
async function seedAtom(
  slug: string,
  frontmatter: Record<string, unknown>,
  sourceId = 'default',
): Promise<void> {
  await engine.putPage(
    slug,
    {
      title: slug.split('/').pop() ?? slug,
      type: 'atom',
      compiled_truth: 'seeded atom body',
      frontmatter: { type: 'atom', ...frontmatter },
      timeline: '',
    },
    { sourceId },
  );
}

async function seedSourcePage(slug = PAGE_SLUG): Promise<void> {
  await engine.putPage(slug, {
    type: 'note',
    title: 'Drift Essay',
    compiled_truth: 'A long essay with extractable claims.',
    timeline: '',
  });
}

function runPage(chatTitle: string | null, opts: { dryRun?: boolean } = {}) {
  return runPhaseExtractAtoms(engine, {
    _transcripts: [],
    _pages: [
      { slug: PAGE_SLUG, content: 'A long essay with extractable claims.', contentHash: CURRENT_HASH },
    ],
    _chat: stubChat(chatTitle),
    ...opts,
  });
}

describe('extract_atoms per-page atoms_source_changed', () => {
  test('counts this page\'s live atoms whose stored source_hash is stale', async () => {
    await seedSourcePage();
    await seedAtom('atoms/seeded/stale-one', { source_slug: PAGE_SLUG, source_hash: OLD_HASH16 });
    await seedAtom('atoms/seeded/stale-two', { source_slug: PAGE_SLUG, source_hash: OLD_HASH16 });

    const result = await runPage('Prototypes beat renders');
    expect(result.details?.atoms_extracted).toBe(1);
    // The atom this run just wrote carries CURRENT_HASH16 after the completion
    // flip, so only the two pre-existing stale rows are counted.
    expect(result.details?.atoms_source_changed).toBe(2);
    expect(String(result.summary)).toContain('2 source-changed atoms');
  });

  test('an atom bound to a DIFFERENT page in the same source is not counted', async () => {
    await seedSourcePage();
    await seedAtom('atoms/seeded/other-page', {
      source_slug: 'writings/some-other-essay',
      source_hash: OLD_HASH16,
    });

    const result = await runPage('Prototypes beat renders');
    expect(result.details?.atoms_source_changed).toBe(0);
  });

  test('an atom on a different source_id with the same slug is not counted', async () => {
    await engine.executeRaw(
      `INSERT INTO sources (id, name) VALUES ('other-source', 'other-source') ON CONFLICT DO NOTHING`,
    );
    await seedSourcePage();
    await seedAtom(
      'atoms/seeded/cross-source',
      { source_slug: PAGE_SLUG, source_hash: OLD_HASH16 },
      'other-source',
    );

    const result = await runPage('Prototypes beat renders');
    expect(result.details?.atoms_source_changed).toBe(0);
  });

  test('a pending: marker is excluded (in-flight, not drift)', async () => {
    await seedSourcePage();
    // Same exclusion doctor's atom_provenance_drift applies: `pending:<hash>`
    // is the provisional receipt written before an extraction commits. Both
    // a stale-hash and a current-hash pending row must be invisible here.
    await seedAtom('atoms/seeded/pending-stale', {
      source_slug: PAGE_SLUG,
      source_hash: `pending:${OLD_HASH16}`,
    });
    await seedAtom('atoms/seeded/pending-current', {
      source_slug: PAGE_SLUG,
      source_hash: `pending:${CURRENT_HASH16}`,
    });

    const result = await runPage('Prototypes beat renders');
    expect(result.details?.atoms_source_changed).toBe(0);
  });

  test('zero when nothing is stale, and the summary stays quiet', async () => {
    await seedSourcePage();
    await seedAtom('atoms/seeded/fresh', { source_slug: PAGE_SLUG, source_hash: CURRENT_HASH16 });
    // A soft-deleted stale row must not resurrect the count.
    await seedAtom('atoms/seeded/deleted', { source_slug: PAGE_SLUG, source_hash: OLD_HASH16 });
    await engine.executeRaw(
      `UPDATE pages SET deleted_at = NOW() WHERE slug = $1 AND source_id = 'default'`,
      ['atoms/seeded/deleted'],
    );

    const result = await runPage('Prototypes beat renders');
    expect(result.details?.atoms_source_changed).toBe(0);
    expect(String(result.summary)).not.toContain('source-changed');
  });

  test('a zero-yield pass still reports pre-existing stale siblings', async () => {
    await seedSourcePage();
    await seedAtom('atoms/seeded/stale-one', { source_slug: PAGE_SLUG, source_hash: OLD_HASH16 });

    // The model returns no atoms: the page is tombstoned and the item
    // `continue`s early, but the count must not silently drop out on exactly
    // the pages that stopped producing.
    const result = await runPage(null);
    expect(result.details?.atoms_extracted).toBe(0);
    expect(result.details?.atoms_source_changed).toBe(1);
  });

  test('transcript-only runs never query (no page slug to bind)', async () => {
    await seedAtom('atoms/seeded/stale-one', { source_slug: PAGE_SLUG, source_hash: OLD_HASH16 });

    const result = await runPhaseExtractAtoms(engine, {
      _transcripts: [
        { filePath: '/fake/meeting.txt', content: 'transcript content here', contentHash: 'abc123def4567890' },
      ],
      _pages: [],
      _chat: stubChat('Transcript atom'),
    });
    expect(result.details?.atoms_source_changed).toBe(0);
  });

  test('dry-run takes the same code path and reports the same read', async () => {
    await seedSourcePage();
    await seedAtom('atoms/seeded/stale-one', { source_slug: PAGE_SLUG, source_hash: OLD_HASH16 });

    const result = await runPage('Prototypes beat renders', { dryRun: true });
    expect(result.details?.dry_run).toBe(true);
    expect(result.details?.atoms_source_changed).toBe(1);
    // Read-only: dry-run wrote nothing, so the seeded row is untouched.
    const rows = await engine.executeRaw<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM pages
        WHERE type = 'atom' AND deleted_at IS NULL AND source_id = 'default'`,
    );
    expect(rows[0]!.n).toBe(1);
  });
});

describe('drain lane carries atoms_source_changed', () => {
  const passThroughLock: ExtractAtomsDrainDeps['withLock'] = (work) => work();

  test('sums the per-batch count across batches', async () => {
    const counts = [2, 3];
    let i = 0;
    const remaining = [2, 1, 0, 0];
    let ri = 0;
    const result = await runExtractAtomsDrain(
      {
        withLock: passThroughLock,
        countRemaining: async () => remaining[Math.min(ri++, remaining.length - 1)]!,
        runBatch: async () => ({ extracted: 1, skipped: 0, sourceChanged: counts[i++] ?? 0 }),
        now: () => 0,
      },
      { windowMs: 1_000_000 },
    );
    expect(result.batches).toBe(2);
    expect(result.atoms_source_changed).toBe(5);
  });

  test('an adapter that omits the field reports 0, not NaN', async () => {
    const remaining = [1, 0, 0];
    let ri = 0;
    const result = await runExtractAtomsDrain(
      {
        withLock: passThroughLock,
        countRemaining: async () => remaining[Math.min(ri++, remaining.length - 1)]!,
        runBatch: async () => ({ extracted: 1, skipped: 0 }),
        now: () => 0,
      },
      { windowMs: 1_000_000 },
    );
    expect(result.atoms_source_changed).toBe(0);
  });
});
