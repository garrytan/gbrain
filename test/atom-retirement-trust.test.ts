/**
 * A derived retirement keeps the tier and origin of the page it retires.
 *
 * Protects: retiring an atom (soft delete plus the `retired_by` stamp) authors no content, so the tombstone stays at the tier
 * and write origin its extraction gave it. The stamp used to be written with no trust declaration, which the tier trigger
 * stores as `unknown` with no origin; the next extraction that produced the same atom again could then never lift it above
 * `unknown` (a tier can be kept or lowered by a derived write, never raised), so a live atom sat at `unknown` until the day
 * after. Covers the unmanaged retirement (`retireDerivedPages`), a managed re-extraction that retires an atom
 * (`managed_atom_delete`), and the revival of a retired atom. Runs on PGLite and, with DATABASE_URL, Postgres.
 *
 * Synthetic data only.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ChatResult } from '../src/core/ai/gateway.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runPhaseExtractAtoms } from '../src/core/cycle/extract-atoms.ts';
import { withWriteTrust } from '../src/core/persistence/context.ts';
import { retireDerivedPages } from '../src/core/persistence/derived-retirement-hold.ts';
import { disposePersistenceConsumer, waitForWrites } from '../src/core/persistence/service.ts';
import type { WriteRequest } from '../src/core/persistence/model.ts';
import { sha256 } from '../src/core/persistence/digest.ts';
import { managedBrain, settleManagedGitEffects } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

interface AtomRow { slug: string; live: boolean; trust_tier: string; channel: string | null; retired_by: string | null }
const atomRows = (engine: BrainEngine) => engine.executeRaw<AtomRow>(
  `SELECT slug, deleted_at IS NULL AS live, trust_tier, write_origin->>'channel' AS channel, frontmatter->>'retired_by' AS retired_by
     FROM pages WHERE source_id='default' AND type='atom' ORDER BY slug`);

const body = (label: string) => (label + ': the team ships small changes, measures each launch and reviews outcomes weekly. ').repeat(12);

function stub(titles: string[]) {
  return async (): Promise<ChatResult> => {
    const text = JSON.stringify(titles.map(title => ({ title, body: title + '.', atom_type: 'insight' })));
    return { text, blocks: [{ type: 'text', text }], stopReason: 'end',
      usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic' };
  };
}

async function extract(engine: BrainEngine, filePath: string, label: string, titles: string[]): Promise<void> {
  const content = body(label);
  writeFileSync(filePath, content);
  await runPhaseExtractAtoms(engine, { sourceId: 'default', _pages: [], _chat: stub(titles), _transcripts: [{ filePath, content, contentHash: sha256(content) }] });
  await disposePersistenceConsumer(engine);
}

async function drain(engine: BrainEngine): Promise<void> {
  const pending = await engine.executeRaw<WriteRequest>("SELECT * FROM persistence_requests WHERE source_id='default' AND state IN ('queued','running','recovering')");
  await waitForWrites(engine, pending, { engine: engine.kind } as GBrainConfig, 60_000);
  await disposePersistenceConsumer(engine);
}

describe('unmanaged derived retirement keeps the tier and origin (PGLite)', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });

  afterAll(async () => {
    await engine.disconnect();
  });

  test('a retired atom stays agent_written with its derive:atoms origin, and a rewrite of the tombstone does not drop it', async () => {
    const slug = 'atoms/2026-01-01/ship-small-changes-0a1b2c3d';
    const trust = { tier: 'agent_written' as const, origin: { channel: 'derive:atoms' } };
    const write = (claim: string) => engine.transaction(tx => withWriteTrust(tx, trust, () => tx.putPage(slug,
      { type: 'atom', title: 'Ship small changes', compiled_truth: claim, frontmatter: { type: 'atom', source_slug: 'notes/origin', source_hash: 'aaaaaaaaaaaaaaaa' } })));
    await write('Ship small changes.');

    await retireDerivedPages(engine, 'default', [slug], 'extract-atoms');
    const [retired] = await atomRows(engine);
    expect(retired).toMatchObject({ live: false, retired_by: 'extract-atoms', trust_tier: 'agent_written', channel: 'derive:atoms' });

    // The extraction that produces the atom again writes the same slug: the page is live again at the derived tier.
    await write('Ship small changes, again.');
    const [revived] = await atomRows(engine);
    expect(revived).toMatchObject({ live: true, trust_tier: 'agent_written', channel: 'derive:atoms' });
  }, 120_000);
});

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  describe(`managed re-extraction retirement keeps the tier and origin (${backend})`, () => {
    test('an atom a second extraction no longer produces is retired at agent_written with its origin, and comes back live at agent_written', async () => {
      await managedBrain(async ({ engine, root }) => {
        const corpus = join(dirname(root), 'corpus');
        mkdirSync(corpus);
        const file = join(corpus, 'session.md');
        await extract(engine, file, 'first', ['Ship small changes', 'Review outcomes weekly', 'Measure each launch', 'Pair on reviews']);
        await settleManagedGitEffects(engine);
        expect((await atomRows(engine)).filter(row => row.live)).toHaveLength(4);

        await extract(engine, file, 'second', ['Ship small changes', 'Review outcomes weekly', 'Track error budgets']);
        await drain(engine);
        await settleManagedGitEffects(engine);
        const retired = (await atomRows(engine)).filter(row => !row.live);
        expect(retired.map(row => row.slug.replace(/^atoms\/[^/]+\//, '').replace(/-[0-9a-f]+$/, '')).sort()).toEqual(['measure-each-launch', 'pair-on-reviews']);
        for (const row of retired) expect(row).toMatchObject({ retired_by: 'managed-reextract', trust_tier: 'agent_written', channel: 'derive:atoms' });

        // A third extraction produces one of them again: the tombstone is revived, and it is not stuck at unknown.
        await extract(engine, file, 'third', ['Ship small changes', 'Review outcomes weekly', 'Measure each launch']);
        await drain(engine);
        await settleManagedGitEffects(engine);
        const live = (await atomRows(engine)).filter(row => row.live);
        expect(live.find(row => /measure-each-launch/.test(row.slug))).toMatchObject({ trust_tier: 'agent_written', channel: 'derive:atoms' });
        expect(live.filter(row => row.trust_tier === 'unknown')).toEqual([]);
      }, { databaseUrl });
    }, 240_000);
  });
}
