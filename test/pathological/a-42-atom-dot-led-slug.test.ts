/**
 * GBRA-130 A-42 (#6804): `atomSlugStem` kept a leading dot, so an atom titled `.example domains grew 10% in Q3`
 * minted `atoms/<date>/.example-domains-…-<hash>`, a slug the op-boundary grammar (`validatePageSlug`) refuses:
 * put_page cannot touch the atom afterwards, and on a managed brain it is published database-only (its file path
 * is dot-led), so it never reaches the repository. The stem now drops leading dots.
 *
 * The inventory's second leg (the page's one atom batch fails `invalid_params` and the page's other atoms are lost)
 * does not reproduce on master: the managed batch commits both atoms. The item case pins that both land.
 * The legacy case pins the upgrade path: an atom minted dot-led by an older build is retired by the next
 * extraction of its page (a delete of a stored legacy slug is admitted, #6212), and the page does not wedge.
 * PGLite; Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { configureGateway, resetGateway, type ChatResult } from '../../src/core/ai/gateway.ts';
import { runPhaseExtractAtoms } from '../../src/core/cycle/extract-atoms.ts';
import { isOpPageSlug, validatePageSlug } from '../../src/core/ops/context.ts';
import type { BrainEngine } from '../../src/core/engine.ts';
import { managedBrain } from '../helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from '../helpers/test-backends.ts';
import { expectUnitNotAborted } from './harness.ts';

beforeAll(() => { configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} }); });
afterAll(() => { resetGateway(); });

const SOURCE_PAGE = 'notes/2026-10-16-tld-review';
const DOT_LED = { title: '.example domains grew 10% in Q3', body: 'Registrations of .example domains grew ten percent in the third quarter.' };
const PLAIN = { title: 'Measured progress', body: 'Measure progress against clear exit criteria.' };

const chatReturning = (atoms: Array<{ title: string; body: string }>) => async (): Promise<ChatResult> => ({
  text: JSON.stringify(atoms.map(atom => ({ ...atom, atom_type: 'insight' }))), blocks: [], stopReason: 'end',
  usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic' });

async function extract(engine: BrainEngine, atoms: Array<{ title: string; body: string }>) {
  const page = (await engine.getPage(SOURCE_PAGE, { sourceId: 'default' }))!;
  return runPhaseExtractAtoms(engine, { _transcripts: [], _pages: [{ slug: page.slug, content: page.compiled_truth, contentHash: page.content_hash! }], _chat: chatReturning(atoms) });
}
const liveAtoms = (engine: BrainEngine) => engine.executeRaw<{ slug: string; title: string }>(
  "SELECT slug, title FROM pages WHERE type='atom' AND deleted_at IS NULL ORDER BY title");
const seedSource = async ({ engine }: { engine: BrainEngine }) => {
  await engine.putPage(SOURCE_PAGE, { type: 'note', title: 'TLD review', compiled_truth: 'A synthetic review of domain registrations. '.repeat(40) }, { sourceId: 'default' });
};

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  describe(`A-42 (#6804): a dot-led atom title (${backend})`, () => {
    test('A-42 item: a managed page with a dot-led atom and a plain atom publishes both under grammar-valid slugs, written through', async () => {
      await managedBrain(async ({ engine }) => {
        const result = await expectUnitNotAborted(() => extract(engine, [DOT_LED, PLAIN]));
        const atoms = await liveAtoms(engine);
        expect({ status: result.status, atoms: atoms.map(atom => atom.title) }).toEqual({ status: 'ok', atoms: [DOT_LED.title, PLAIN.title] });
        expect(atoms[0]!.slug).toMatch(/^atoms\/2026-10-16\/example-domains-grew-10-in-q3-[0-9a-f]{8}$/);
        for (const { slug } of atoms) expect(() => validatePageSlug(slug)).not.toThrow();
        const receipts = (result.details as { write_requests: Array<{ slug: string; write_through?: { written?: boolean } }> }).write_requests
          .filter(receipt => receipt.slug?.startsWith('atoms/'));
        expect(receipts.map(receipt => [receipt.slug, receipt.write_through?.written])).toEqual(atoms.map(atom => [atom.slug, true]));
      }, { databaseUrl, setup: seedSource });
    }, 120_000);

    test('A-42 legacy: an atom an older build minted dot-led is retired by the next extraction, and the page does not wedge', async () => {
      await managedBrain(async ({ engine }) => {
        const legacy = 'atoms/2026-10-16/.example-domains-grew-10-in-q3-5fba9d3d';
        expect(isOpPageSlug(legacy)).toBe(false);
        const result = await expectUnitNotAborted(() => extract(engine, [DOT_LED, PLAIN]));
        expect(result.status).toBe('ok');
        const atoms = await liveAtoms(engine);
        expect(atoms.map(atom => atom.slug).includes(legacy)).toBe(false);
        expect(atoms.map(atom => atom.title)).toEqual([DOT_LED.title, PLAIN.title]);
        expect(atoms.every(atom => isOpPageSlug(atom.slug))).toBe(true);
      }, { databaseUrl, setup: async ({ engine }) => {
        await seedSource({ engine });
        await engine.putPage('atoms/2026-10-16/.example-domains-grew-10-in-q3-5fba9d3d', { type: 'atom', title: DOT_LED.title, compiled_truth: DOT_LED.body,
          frontmatter: { atom_type: 'insight', source_slug: SOURCE_PAGE, source_hash: 'stale-hash-0000', dream_generated: true } }, { sourceId: 'default' });
      } });
    }, 120_000);
  });
}
