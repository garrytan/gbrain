/**
 * #7880: a company-brain source imports approved repository files through `importCompanyBrainFile` (src/core/company-brain/profile.ts),
 * which called `importFromContent` without holding a private request page privacy does not read. Inspection reads only
 * the exact lowercase `visibility` key, so a file whose frontmatter says `Visibility: private` passed it, and a legacy
 * (unmanaged) connect stored it as a world-readable page while a managed connect refused it.
 *
 * Protects: legacy and managed connects alike refuse that file (the content phase stays incomplete) and store no page
 * for it; the other approved file still imports on the legacy path. PGLite here; Postgres through
 * test/e2e/company-brain-private-hold-7880-postgres.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { inspectCompanyBrain } from '../src/core/company-brain/inspection.ts';
import { connectCompanyBrain } from '../src/core/company-brain/runtime.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { makeGitFixture } from './helpers/git-fixture.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-company-7880-'));
const backends = testBackends();
const engines: BrainEngine[] = [];
let closePostgres: (() => Promise<void>) | undefined;
const git = (root: string, ...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-C', root, ...args], { encoding: 'utf8' }).trim();
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

for (const backend of backends) for (const managed of [false, true]) describe(`[${backend}] company-brain connect, ${managed ? 'managed' : 'legacy'} (#7880)`, () => {
  test('a file asking for Visibility: private is refused and never stored world-readable', async () => withEnv({ GBRAIN_HOME: home }, async () => {
    const engine = engines[backends.indexOf(backend)]!;
    await engine.executeRaw('UPDATE persistence_brain SET enabled=$1 WHERE singleton=1', [managed]);
    const root = mkdtempSync(join(home, 'repo-'));
    await makeGitFixture(root);
    for (const [path, body] of Object.entries({
      'people/operator.md': '---\ntype: person\ntitle: Example Operator\n---\n# Example Operator\nOwns the account.\n',
      'customers/account.md': '---\ntype: customer\ntitle: Example Account\nowner: "[[people/operator]]"\nVisibility: private\n---\n# Example Account\nA synthetic account.\n',
    })) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), body); }
    git(root, 'add', '.'); git(root, 'commit', '-qm', 'Synthetic source fixture');
    const plan = await inspectCompanyBrain({ path: root, profile: 'company-brain' });
    expect(plan.ready).toBe(true);
    const sourceId = `company-${randomUUID().slice(0, 8)}`;
    const result = await connectCompanyBrain(engine, { brainId: 'company-example', sourceId, path: root, plan, remote: false, requestId: randomUUID() });
    expect(result).toMatchObject({ ok: false, receipt: { phase: 'CONTENT', outcome: 'incomplete', diagnostic: 'content_incomplete', counts: { failedFiles: 1 } } });
    expect(await engine.getPage('customers/account', { sourceId })).toBeNull();
    if (!managed) expect((await engine.getPage('people/operator', { sourceId }))?.title).toBe('Example Operator');
  }), 120_000);
});
