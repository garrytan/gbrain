/**
 * #7897: `gbrain sources reconcile` publishes the merge of a canonical file and its stored page through
 * `importFromContent` (reconcile-prepare.ts), whose screen did not hold a private request page privacy does not read.
 * Only the lowercase `visibility` key is protected from the file side, so a file that adds `Visibility: private` merged
 * in as an ordinary field (an additive one under `--auto-additive`) and the page was published world-readable while its
 * frontmatter asked for private.
 *
 * Protects, on a source rooted at a plain directory (no Git) and at a Git checkout: such a merge refuses
 * `visibility_not_applied` and nothing is written; a page stored `visibility: private` still reconciles and stays
 * private; a merge that asks for nothing private still reconciles.
 *
 * PGLite here; Postgres through test/e2e/reconcile-private-hold-7897-postgres.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { serializePageToMarkdown } from '../src/core/markdown.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { registerLocalWriter, withVerifiedLocalRegistration } from '../src/core/persistence/identity.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { runReconcileApply, runReconcilePreview } from '../src/core/persistence/reconcile.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { isPrivatePage } from '../src/core/search/private-visibility.ts';
import { durableGitRepo } from './helpers/git-publication.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-reconcile-7897-'));
const backends = testBackends();
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
beforeAll(async () => {
  if (backends.includes('pglite')) { const pglite = new PGLiteEngine(); await pglite.connect({}); await pglite.initSchema(); engines.push(pglite); }
  if (backends.includes('postgres')) { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engines.push(pg.engine); closePostgres = pg.close; }
}, 120_000);
afterAll(async () => {
  await withEnv({ GBRAIN_HOME: home }, async () => {
    for (const engine of engines) { await disposePersistenceConsumer(engine); if (engine.kind === 'pglite') await engine.disconnect(); }
    await closePostgres?.();
  });
  rmSync(home, { recursive: true, force: true });
});

const SLUG = 'people/alice-example';
const stored = (extra = '') => `---\ntype: person\ntitle: Alice Example\n${extra}---\nA synthetic biography of alice-example at acme-example.\n`;

/** A managed source whose file is the stored page plus `frontmatter` and one appended body line. */
async function drifted(engine: BrainEngine, repo: boolean, storedExtra: string, frontmatter: Record<string, unknown>) {
  await disposePersistenceConsumer(engine);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  const id = `source-${randomUUID().slice(0, 8)}`;
  const root = join(home, id);
  mkdirSync(join(root, 'people'), { recursive: true });
  await engine.executeRaw('INSERT INTO sources(id,name,local_path,config) VALUES($1,$1,$2,\'{}\')', [id, root]);
  await importFromContent(engine, SLUG, stored(storedExtra), { sourceId: id, sourcePath: `${SLUG}.md`, noEmbed: true });
  const snapshot = (await engine.readPageSnapshot(SLUG, { sourceId: id }))!;
  writeFileSync(join(root, `${SLUG}.md`), serializePageToMarkdown({ ...snapshot.page, frontmatter: { ...snapshot.page.frontmatter, ...frontmatter },
    compiled_truth: `${snapshot.page.compiled_truth}\nAlso advises beta-example.` }, snapshot.tags));
  if (repo) durableGitRepo(root, [`${SLUG}.md`]);
  await claimWorktree(engine, id, root);
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  return { id, registration: await registerLocalWriter(engine, 'cli'), before: snapshot };
}

/** The --auto-additive preview, with every remaining conflict taken from the file. */
async function preview(engine: BrainEngine, id: string) {
  const first = await runReconcilePreview(engine, { source_id: id, slug: SLUG, auto_additive: true, accept_suggested: true });
  const decisions = ((first.conflict_paths as string[] | undefined) ?? []).map(path => ({ path, action: 'take_file' }));
  return decisions.length ? runReconcilePreview(engine, { source_id: id, slug: SLUG, from: first.preview, decisions }) : first;
}
const apply = async (engine: BrainEngine, id: string) =>
  runReconcileApply(engine, { source_id: id, slug: SLUG, preview: (await preview(engine, id)).preview, request_id: randomUUID() });

for (const backend of backends) for (const repo of [false, true]) describe(`[${backend}] sources reconcile, ${repo ? 'Git checkout' : 'plain directory'} (#7897)`, () => {
  const engine = () => engines[backends.indexOf(backend)]!;

  test('a file adding Visibility: private refuses visibility_not_applied and publishes nothing', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    const f = await drifted(engine(), repo, '', { Visibility: 'private' });
    const refused = await withVerifiedLocalRegistration(engine(), f.registration, () => apply(engine(), f.id))
      .then(() => null, (error: { code?: string; message?: string }) => ({ code: error.code, message: error.message }));
    expect(refused).toEqual({ code: 'visibility_not_applied', message: expect.stringContaining(`page ${SLUG} would stay world-readable`) });
    const after = (await engine().readPageSnapshot(SLUG, { sourceId: f.id }))!;
    expect({ revision: after.revision, body: after.page.compiled_truth, frontmatter: after.page.frontmatter })
      .toEqual({ revision: f.before.revision, body: f.before.page.compiled_truth, frontmatter: f.before.page.frontmatter });
  }), 120_000);

  test('a page stored visibility: private reconciles and stays private', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    const f = await drifted(engine(), repo, 'visibility: private\n', {});
    expect((await withVerifiedLocalRegistration(engine(), f.registration, () => apply(engine(), f.id))).state).toBe('committed');
    const after = (await engine().readPageSnapshot(SLUG, { sourceId: f.id }))!;
    expect({ body: after.page.compiled_truth.includes('Also advises beta-example.'), private: isPrivatePage(after.page) }).toEqual({ body: true, private: true });
  }), 120_000);

  test('a merge that asks for nothing private still reconciles', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    const f = await drifted(engine(), repo, '', { phone: '555-0100' });
    expect((await withVerifiedLocalRegistration(engine(), f.registration, () => apply(engine(), f.id))).state).toBe('committed');
    const after = (await engine().readPageSnapshot(SLUG, { sourceId: f.id }))!;
    expect({ body: after.page.compiled_truth.includes('Also advises beta-example.'), phone: after.page.frontmatter.phone, private: isPrivatePage(after.page) })
      .toEqual({ body: true, phone: '555-0100', private: false });
  }), 120_000);
});
