/**
 * A managed checkout on a host with no Git identity (a fresh CI runner, a new machine): the product path stays loud.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: a bound put_page commits the page; its Git effect fails `git_unavailable` and the effect's commit step names
 *    the cause ("a missing Git identity (user.name, user.email) in that checkout is one cause to check"); repeated failures
 *    park the effect (PARK_AFTER_FAILURES, effect-model.ts), so it never stays queued without an end.
 *  - Regression: an identity default added for the checkout (the failure would then go unseen on such a host), a lost
 *    cause in the commit step's error, or an effect that never parks.
 *  - Why existing coverage misses it: every other managed checkout in the suite sets a local identity, and most hosts
 *    have a global one, so the no-identity path never ran.
 *  - Seam: real PGLite brain, real Git checkout; identity hidden through the environment only (HOME, GIT_CONFIG_GLOBAL with
 *    user.useConfigOnly so git does not guess one, GIT_CONFIG_NOSYSTEM, no GIT_AUTHOR_* / GIT_COMMITTER_* / EMAIL).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { createSource } from './engine-parity/harness.ts';
import { withEnv } from './helpers/with-env.ts';
import { writerAdminState } from '../src/core/persistence/admin-intent.ts';
import { runPersistenceAdministration } from '../src/core/persistence/administration.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { hostIdFor, readLocalWriter } from '../src/core/persistence/identity.ts';
import { runPersistenceEffects } from '../src/core/persistence/effects.ts';
import { commitGitTargets } from '../src/core/persistence/effect-git.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 60_000);
afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); });

const GIT_ID = ['-c', 'user.name=Example', '-c', 'user.email=example@example.invalid'];
const ctxFor = (e: BrainEngine) => ({ engine: e, sourceId: 'work', remote: false as const,
  config: { engine: e.kind, embedding_disabled: true }, dryRun: false, logger: { info() {}, warn() {}, error() {} } });

describe('a managed checkout with no Git identity', () => {
  test('the page write commits, the Git effect fails git_unavailable naming the missing identity, and it parks after repeated failures', async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-no-git-identity-')));
    const bare = join(home, 'no-identity'); mkdirSync(bare, { recursive: true });
    writeFileSync(join(bare, 'gitconfig'), '[user]\n\tuseConfigOnly = true\n');
    try {
      await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined, GBRAIN_GIT_ALLOW_FILE_TRANSPORT: '1',
        HOME: bare, GIT_CONFIG_GLOBAL: join(bare, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1', EMAIL: undefined,
        GIT_AUTHOR_NAME: undefined, GIT_AUTHOR_EMAIL: undefined, GIT_COMMITTER_NAME: undefined, GIT_COMMITTER_EMAIL: undefined }, async () => {
        // The checkout's first commit names an identity on the command line only; the checkout's config keeps none.
        const root = join(home, 'checkout');
        mkdirSync(join(root, 'notes'), { recursive: true });
        execFileSync('git', ['-C', root, 'init', '-q', '-b', 'main']);
        writeFileSync(join(root, 'notes', 'alice-example.md'), '---\ntitle: Alice Example\n---\nWorks at acme-example.\n');
        execFileSync('git', ['-C', root, 'add', '.']);
        execFileSync('git', ['-C', root, ...GIT_ID, 'commit', '-qm', 'notes']);
        const remote = join(home, 'remote.git');
        execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
        execFileSync('git', ['-C', root, 'remote', 'add', 'origin', remote]);
        execFileSync('git', ['-C', root, 'push', '-q', '-u', 'origin', 'main']);
        await createSource(engine, 'pglite', 'work', {}, root);
        const reviewed = async (operation: string) => ({ admin_intent: operation, expected_state: await writerAdminState(engine) });
        await runPersistenceAdministration(engine, 'writer_claim', { source_id: 'work', path: root, ...await reviewed('writer_claim') });
        await runPersistenceAdministration(engine, 'writer_git_durability', { source_id: 'work', enable: true, ...await reviewed('writer_git_durability') });

        const request_id = randomUUID();
        await submitPageMutation(ctxFor(engine) as never, { operation: 'put_page',
          params: { slug: 'notes/ivy-example', content: '---\ntype: note\ntitle: Ivy Example\n---\nWorks at widget-co.\n', request_id } });
        const row = (await engine.readWriteRequest('local_cli', (await readLocalWriter(engine, 'cli')).id, request_id))!;
        const git = async () => (await engine.readRequestEffects(row.id, 'git'))[0];
        for (let i = 0; i < 40 && (await git())?.error_code !== 'git_unavailable'; i++) {
          await runPersistenceEffects(engine, { engine: engine.kind } as never, { hostId: hostIdFor(engine), limit: 20 });
          await Bun.sleep(250);
        }
        const first = await git();
        const direct = (await commitGitTargets(root, ['notes/ivy-example.md'])).get('notes/ivy-example.md') as { code?: string; suggestion?: string };
        const page = await engine.getPage('notes/ivy-example', { sourceId: 'work' });
        const tracked = execFileSync('git', ['-C', root, 'ls-files', 'notes/ivy-example.md'], { encoding: 'utf8' }).trim();
        expect({ request: row.state, page: page?.title ?? null, effect: first?.state, code: first?.error_code ?? null, tracked,
          direct: { code: direct?.code, namesIdentity: String(direct?.suggestion ?? '').includes('missing Git identity (user.name, user.email)') } })
          .toEqual({ request: 'committed', page: 'Ivy Example', effect: 'queued', code: 'git_unavailable', tracked: '',
            direct: { code: 'git_unavailable', namesIdentity: true } });
        // Each retry comes due at once (instead of 30 s later); the effect parks after PARK_AFTER_FAILURES failures.
        for (let i = 0; i < 12 && (await git())?.state !== 'failed'; i++) {
          await engine.executeRaw("UPDATE persistence_effects SET next_attempt_at=now() WHERE kind='git' AND state='queued'");
          await runPersistenceEffects(engine, { engine: engine.kind } as never, { hostId: hostIdFor(engine), limit: 20 });
        }
        expect((await git())?.state).toBe('failed');
        expect(execFileSync('git', ['-C', root, 'ls-files', 'notes/ivy-example.md'], { encoding: 'utf8' }).trim()).toBe('');
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }, 120_000);
});
