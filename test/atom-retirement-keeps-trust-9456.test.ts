/**
 * #9456: retiring an atom authors no content, so the atom keeps the trust tier and write origin its extraction gave it,
 * and an atom a later extraction produces again comes back at that tier. The retirement used to stamp `retired_by`
 * with no trust declaration in force, which the tier trigger stores as `unknown` with no origin; a derived write can
 * only keep or lower a tier, so the revived atom stayed `unknown`.
 *
 * Managed brain, PGLite and, with DATABASE_URL, Postgres: three extractions of one transcript, where the second no longer
 * yields one atom (retired) and the third yields it again (revived). Unmanaged brain, PGLite: the shared retirement every
 * derived writer uses (`retireDerivedPages`) on a page written at a derived tier. Synthetic data only.
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

const KEPT = ['Write the decision down', 'Name one owner'];
const CYCLED = 'Close the loop on Friday';
const EXTRACT_TIMEOUT_MS = 240_000;

interface AtomTrust { slug: string; live: boolean; trust_tier: string; channel: string | null; retired_by: string | null }

const cycledAtom = async (engine: BrainEngine): Promise<AtomTrust> => {
  const rows = await engine.executeRaw<AtomTrust>(`SELECT slug, deleted_at IS NULL AS live, trust_tier, write_origin->>'channel' AS channel,
      frontmatter->>'retired_by' AS retired_by FROM pages WHERE source_id='default' AND type='atom' AND slug LIKE '%close-the-loop-on-friday%'`);
  expect(rows).toHaveLength(1);
  return rows[0]!;
};

const transcript = (round: number) => `Round ${round} of the planning notes. The group agreed on how decisions get recorded and owned. `.repeat(10);

async function extractRound(engine: BrainEngine, file: string, round: number, titles: string[]): Promise<void> {
  const content = transcript(round);
  writeFileSync(file, content);
  const chat = async (): Promise<ChatResult> => {
    const text = JSON.stringify(titles.map(title => ({ title, body: `${title}.`, atom_type: 'insight' })));
    return { text, blocks: [{ type: 'text', text }], stopReason: 'end', model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic',
      usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 } };
  };
  await runPhaseExtractAtoms(engine, { sourceId: 'default', _pages: [], _chat: chat, _transcripts: [{ filePath: file, content, contentHash: sha256(content) }] });
  const pending = await engine.executeRaw<WriteRequest>("SELECT * FROM persistence_requests WHERE source_id='default' AND state IN ('queued','running','recovering')");
  if (pending.length) await waitForWrites(engine, pending, { engine: engine.kind } as GBrainConfig, 60_000);
  await disposePersistenceConsumer(engine);
}

async function retireAndRevive(engine: BrainEngine, file: string, settle: () => Promise<void>, retiredBy: string): Promise<void> {
  await extractRound(engine, file, 1, [...KEPT, CYCLED]);
  await settle();
  const extracted = await cycledAtom(engine);
  expect(extracted).toMatchObject({ live: true, trust_tier: 'agent_written', channel: 'derive:atoms' });

  await extractRound(engine, file, 2, KEPT);
  await settle();
  expect(await cycledAtom(engine)).toMatchObject({ live: false, retired_by: retiredBy, trust_tier: 'agent_written', channel: 'derive:atoms' });

  await extractRound(engine, file, 3, [...KEPT, CYCLED]);
  await settle();
  expect(await cycledAtom(engine)).toMatchObject({ live: true, trust_tier: 'agent_written', channel: 'derive:atoms' });
}

describe('#9456 unmanaged derived retirement keeps the tier and origin (pglite)', () => {
  let engine: PGLiteEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  });
  afterAll(async () => {
    await engine.disconnect();
  });

  test('a retired page and its saved version keep agent_written and the derive:atoms origin', async () => {
    const slug = 'atoms/undated/close-the-loop-on-friday-0f0f0f';
    await engine.transaction(tx => withWriteTrust(tx, { tier: 'agent_written', origin: { channel: 'derive:atoms' } }, () => tx.putPage(slug,
      { type: 'atom', title: CYCLED, compiled_truth: `${CYCLED}.`, frontmatter: { type: 'atom', source_slug: 'notes/planning' } })));
    expect(await cycledAtom(engine)).toMatchObject({ live: true, trust_tier: 'agent_written', channel: 'derive:atoms' });

    await retireDerivedPages(engine, 'default', [slug], 'extract-atoms');
    expect(await cycledAtom(engine)).toMatchObject({ live: false, retired_by: 'extract-atoms', trust_tier: 'agent_written', channel: 'derive:atoms' });
    const versions = await engine.executeRaw<{ trust_tier: string; channel: string | null }>(
      `SELECT v.trust_tier, v.write_origin->>'channel' AS channel FROM page_versions v JOIN pages p ON p.id=v.page_id WHERE p.slug=$1`, [slug]);
    expect(versions).toEqual([{ trust_tier: 'agent_written', channel: 'derive:atoms' }]);
  });
});

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  describe(`#9456 managed atom retirement keeps the tier and origin (${backend})`, () => {
    test('an atom a managed re-extraction retires stays agent_written with its origin, and comes back at agent_written', async () => {
      await managedBrain(async ({ engine, root }) => {
        const corpus = join(dirname(root), 'corpus-9456');
        mkdirSync(corpus);
        await retireAndRevive(engine, join(corpus, 'notes.md'), () => settleManagedGitEffects(engine), 'managed-reextract');
      }, { databaseUrl });
    }, EXTRACT_TIMEOUT_MS);
  });
}
