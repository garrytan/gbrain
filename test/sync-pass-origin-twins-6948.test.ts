/**
 * #6712 PR 4b carry-over of #6948 (GBRA-129) into the level pass: a path several live pages record as their origin is
 * held `origin_conflict` on its own, with the shared verdict (persistence/origin-twins.ts), and the rest of the source
 * syncs. Before the carry-over the pass refused the whole source with `page_identity_changed`. The level pass sees every
 * claimed path, so an unchanged file is held too; the hold is re-screened on every pass (the tick after it is not idle)
 * and goes once one page records the file. The sync-time heal runs in `performSync`, so these runs (performManagedSync)
 * show the pass's own hold. PGLite here; Postgres through test/e2e/sync-pass-origin-twins-6948-postgres.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { readGitSourceHolds } from '../src/core/persistence/sync-holds.ts';
import { MANAGED_SYNC_PASS_OP } from '../src/core/persistence/sync-pass-row.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { dropOriginIndex } from './helpers/origin-index.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { testBackends } from './helpers/test-backends.ts';

const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root: string, message: string) => { git(root, 'add', '-A'); git(root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', 'commit', '-qm', message); };
const note = (title: string, body: string) => `---\ntype: concept\ntitle: ${title}\n---\n\n${body}\n`;
const OPTS = { sourceId: 'default', noPull: true, noEmbed: true, noExtract: true };
const setup = ({ root }: { root: string }) => {
  mkdirSync(join(root, 'notes'), { recursive: true }); git(root, 'init', '-q');
  for (const slug of ['a', 'b', 'c']) writeFileSync(join(root, `notes/${slug}.md`), note(`notes/${slug}`, `The committed body of notes/${slug}.`));
  commit(root, 'notes');
};

const passRow = async (engine: BrainEngine) => (await engine.executeRaw<{ value: { telemetry: { kind: string; counts?: Record<string, number> } } }>(
  "SELECT completed_keys->0 AS value FROM op_checkpoints WHERE op=$1 AND completed_keys->0->>'source_id'='default'", [MANAGED_SYNC_PASS_OP]))[0]!.value;
const originHolds = async (engine: BrainEngine) => ((await readGitSourceHolds(engine, { sourceIds: ['default'] }))[0]?.holds ?? []).filter(hold => hold.code === 'origin_conflict');
const body = async (engine: BrainEngine, slug: string) => (await engine.executeRaw<{ compiled_truth: string; deleted_at: string | null }>(
  'SELECT compiled_truth, deleted_at FROM pages WHERE source_id=$1 AND slug=$2', ['default', slug]))[0] ?? null;
/** A second live page recording notes/a.md, as legacy data left it (the origin index is dropped: such a brain has it pending). */
async function twin(engine: BrainEngine, slug: string, same: boolean): Promise<void> {
  await dropOriginIndex(engine);
  const [a] = await engine.executeRaw<{ compiled_truth: string; timeline: string | null; trust_tier: string }>(
    "SELECT compiled_truth, timeline, trust_tier::text AS trust_tier FROM pages WHERE source_id='default' AND slug='notes/a'");
  await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], async () => {
    await tx.executeRaw("SELECT set_config('gbrain.write_trust_tier', $1, true)", [a!.trust_tier]);
    await tx.putPage(slug, { type: 'concept', title: 'Example', compiled_truth: same ? a!.compiled_truth : 'A different body.', timeline: a!.timeline ?? '', frontmatter: {},
      content_hash: crypto.randomUUID() }, { sourceId: 'default' });
    await tx.executeRaw("UPDATE pages SET source_path='notes/a.md' WHERE source_id='default' AND slug=$1", [slug]);
  }, TEST_WRITE_ATTRIBUTION));
}

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? process.env.DATABASE_URL : undefined;
  const brain = (run: Parameters<typeof managedBrain>[0]) => managedBrain(run, { ...(databaseUrl ? { databaseUrl } : {}), setup });

  describe(`#6712 PR 4b level pass: #6948 duplicate-origin twins (${backend})`, () => {
    test('verified twins plus an unrelated edit: the pass holds only the twin-claimed file (no reason, so the heal resolves it) and syncs the rest', () => brain(async ({ engine, root }) => {
      expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
      await twin(engine, 'notes/a-copy', true);
      writeFileSync(join(root, 'notes/a.md'), note('notes/a', 'An edited body of notes/a.'));
      writeFileSync(join(root, 'notes/b.md'), note('notes/b', 'An edited body of notes/b.'));
      commit(root, 'edit a and b');
      const result = await performManagedSync(engine, OPTS);
      expect(result.status).toBe('synced');
      expect((await body(engine, 'notes/b'))!.compiled_truth).toContain('An edited body of notes/b.');
      expect((await body(engine, 'notes/a'))!.compiled_truth).toContain('The committed body of notes/a.');
      const held = await originHolds(engine);
      expect(held.map(hold => [hold.path, hold.meta.reason ?? null, hold.meta.canonical_slug, (hold.meta.origin_claimants ?? []).map(page => page.slug)]))
        .toEqual([['notes/a.md', null, 'notes/a', ['notes/a', 'notes/a-copy']]]);
      expect((await passRow(engine)).telemetry.counts?.holds_origin_conflict).toBe(1);
      expect((await body(engine, 'notes/a-copy'))!.deleted_at).toBeNull();
    }), 180_000);

    test('an unchanged file two differing pages claim is held with its reason on every pass (never idle meanwhile); once one page records it the hold goes', () => brain(async ({ engine, root }) => {
      expect((await performManagedSync(engine, OPTS)).status).toBe('first_sync');
      await twin(engine, 'notes/a-copy', false);
      writeFileSync(join(root, 'notes/c.md'), note('notes/c', 'An edited body of notes/c.'));
      commit(root, 'edit c');
      expect((await performManagedSync(engine, OPTS)).status).toBe('synced');
      expect((await body(engine, 'notes/c'))!.compiled_truth).toContain('An edited body of notes/c.');
      const reasons = async () => (await originHolds(engine)).map(hold => [hold.path, hold.meta.reason ?? null]);
      expect(await reasons()).toEqual([['notes/a.md', 'content_differs']]);
      await performManagedSync(engine, OPTS);
      expect((await passRow(engine)).telemetry.kind).not.toBe('idle');
      expect(await reasons()).toEqual([['notes/a.md', 'content_differs']]);
      await engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => tx.executeRaw("UPDATE pages SET source_path=NULL WHERE source_id='default' AND slug='notes/a-copy'"), TEST_WRITE_ATTRIBUTION));
      await performManagedSync(engine, OPTS);
      expect(await reasons()).toEqual([]);
      expect((await body(engine, 'notes/a'))!.compiled_truth).toContain('The committed body of notes/a.');
    }), 180_000);
  });
}
