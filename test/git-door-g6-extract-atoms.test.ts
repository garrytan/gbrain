/**
 * G6 (git-canonical memory): dream extract-atoms on a strict source. Its managed branch (extract-atoms.ts
 * publishManagedAtomGeneration, persistence/atom-maintenance.ts) admits one managed generation per origin: create
 * members (managed_atom_page), the managed_generation_activate request, overwrite and retire members, and the batch
 * completion. That is also the generations page adapter's managed path (generations/managed.ts): adapters/page.ts
 * importPageItem only runs inside an unmanaged activation transaction. Target for a batch of three atoms: every atom
 * (and the origin page) at HEAD with the content its row holds, a clean tree, no git-gap census gap, and at most one
 * commit per publication group (test/helpers/strict-door-audit.ts). The LLM is a stub (_chat), as in
 * test/managed-extract-atoms.test.ts. Runs on PGLite, and on Postgres through
 * test/e2e/git-door-g6-extract-atoms-postgres.test.ts. Synthetic content only.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { configureGateway, resetGateway, type ChatResult } from '../src/core/ai/gateway.ts';
import { runPhaseExtractAtoms } from '../src/core/cycle/extract-atoms.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { durableGitRepo, gitAsync } from './helpers/git-publication.ts';
import { managedBrain, settleManagedGitEffects } from './helpers/managed-brain.ts';
import { auditDoor, expectDoorTarget, headCommit, strictSource, summarizeAudit } from './helpers/strict-door-audit.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';

const ORIGIN = 'notes/source-a';
const setup = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); };
const chatReturning = (titles: string[]) => async (): Promise<ChatResult> => ({
  text: JSON.stringify(titles.map(title => ({ title, atom_type: 'insight', body: `Body for ${title}, from the Acme Example review.` }))), blocks: [], stopReason: 'end',
  usage: { input_tokens: 10, output_tokens: 10, cache_read_tokens: 0, cache_creation_tokens: 0 }, model: 'anthropic:claude-haiku-4-5', providerId: 'anthropic' });
const seedOrigin = async (ctx: OperationContext, body: string) => {
  const current = await ctx.engine.readPageSnapshot(ORIGIN, { sourceId: 'default' });
  await submitPageMutation(ctx, { operation: 'put_page', params: { slug: ORIGIN, request_id: randomUUID(),
    content: `---\ntype: source\ntitle: Source A\n---\n\n${body}\n`, ...(current ? { expected_revision: current.revision } : {}) } });
  await settleManagedGitEffects(ctx.engine);
};
const extract = async (engine: BrainEngine, titles: string[]) => {
  const page = (await engine.getPage(ORIGIN, { sourceId: 'default' }))!;
  return runPhaseExtractAtoms(engine, { sourceId: 'default', _transcripts: [], _pages: [{ slug: page.slug, content: page.compiled_truth, contentHash: page.content_hash! }],
    _chat: chatReturning(titles) });
};
const liveAtoms = async (engine: BrainEngine) => (await engine.executeRaw<{ slug: string }>(
  "SELECT slug FROM pages WHERE source_id='default' AND type='atom' AND deleted_at IS NULL ORDER BY slug")).map(row => row.slug);

beforeAll(() => configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: {} }));
afterAll(() => resetGateway());

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  describe(`[${backend}] G6: extract-atoms on a strict source writes only through the door`, () => {
    test('a three-atom generation: at HEAD, clean, no census gap, one commit per group', () => managedBrain(async ({ engine, ctx, root }) => {
      await strictSource(engine);
      await seedOrigin(ctx, 'Alice Example reviewed the Acme Example launch plan with the team. '.repeat(40));
      const before = await auditDoor(engine, root, { since: await headCommit(root), slugs: [ORIGIN] });
      expect(before.census.states).toMatchObject({ equal: 1, database_ahead: 0, worktree_only: 0, undeclared_database_only: 0 });
      const since = await headCommit(root);
      const result = await extract(engine, ['Measure progress weekly', 'Ship small changes', 'Write the exit criteria first']);
      expect(result.status).toBe('ok');
      expect(result.details?.atoms_extracted).toBe(3);
      await settleManagedGitEffects(engine);
      const atoms = await liveAtoms(engine);
      expect(atoms).toHaveLength(3);
      const audit = await auditDoor(engine, root, { since, slugs: [...atoms, ORIGIN] });
      console.log(summarizeAudit(`extract-atoms create ${backend}`, audit));
      expectDoorTarget({ ...audit, pages: audit.pages.filter(page => page.slug !== ORIGIN) }, engine.kind);
      expect(audit.pages.find(page => page.slug === ORIGIN)).toMatchObject({ row: { state: 'equal' }, commits: 0 });
    }, { databaseUrl, setup }), 180_000);

    test('a re-extraction after an origin edit (three creates, three retirements): at HEAD, clean, no census gap, one commit per group', () => managedBrain(async ({ engine, ctx, root }) => {
      await strictSource(engine);
      await seedOrigin(ctx, 'Alice Example reviewed the Acme Example launch plan with the team. '.repeat(40));
      expect((await extract(engine, ['Measure progress weekly', 'Ship small changes', 'Write the exit criteria first'])).status).toBe('ok');
      await settleManagedGitEffects(engine);
      const first = await liveAtoms(engine);
      expect(first).toHaveLength(3);
      await seedOrigin(ctx, 'Alice Example revised the Acme Example launch plan after the pilot. '.repeat(40));
      const since = await headCommit(root);
      const result = await extract(engine, ['Pilot before launch', 'Keep the checklist short', 'Review outcomes monthly']);
      expect(result.status).toBe('ok');
      await settleManagedGitEffects(engine);
      const second = await liveAtoms(engine);
      expect(second).toHaveLength(3);
      expect(second.filter(slug => first.includes(slug))).toEqual([]);
      const audit = await auditDoor(engine, root, { since, slugs: second });
      console.log(summarizeAudit(`extract-atoms re-extract ${backend}`, audit));
      for (const slug of first) expect({ slug, head: await gitAsync(root, 'cat-file', '-e', `HEAD:${slug}.md`).then(() => 'present', () => 'absent') }).toEqual({ slug, head: 'absent' });
      expectDoorTarget(audit, engine.kind);
      // A retirement is a page publication of the same generation: its six members are one group.
      const generation = new Set([...first, ...second].map(slug => `${slug}.md`));
      expect(audit.commits.filter(commit => commit.paths.some(path => generation.has(path))).length).toBeLessThanOrEqual(engine.kind === 'postgres' ? 1 : generation.size);
    }, { databaseUrl, setup }), 240_000);
  });
}
