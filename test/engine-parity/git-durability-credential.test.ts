/**
 * Engine parity for `gbrain sources writer git-durability --pat-file` (persistence/git-durability-administration.ts):
 * the token is wired as a repo-scoped credential, then each parked push of the worktree gets one more attempt.
 *
 * The parked-push retry reads raw SQL. On an engine without it (the Rust engine) the command must refuse before the
 * credential store or the checkout's git config change, so the refusal's "nothing ran" holds. The Rust arm stops on
 * that refusal (`requires: 'raw_sql'`), and the case rethrows it only after it checks that nothing was written.
 *
 * The claim is the internal `claimWorktree`, so the case sets up ownership without the reviewed `writer claim` verb.
 * Each case runs under its own GBRAIN_HOME.
 */
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect } from 'bun:test';
import { createSource, parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import { writerAdminState } from '../../src/core/persistence/admin-intent.ts';
import { runPersistenceAdministration } from '../../src/core/persistence/administration.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';

const { parityTest } = parityArms(testBackends());

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 'example', GIT_AUTHOR_EMAIL: 'example@example.com', GIT_COMMITTER_NAME: 'example', GIT_COMMITTER_EMAIL: 'example@example.com' };
function git(cwd: string, args: string[]): string {
  const run = spawnSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV });
  return (run.stdout ?? '').trim();
}

describe('writer git-durability --pat-file', () => {
  parityTest('wires the credential where parked pushes can be retried, and refuses before any write where they cannot', {
    methods: ['readWriterAdminState'],
    requires: 'raw_sql',
  }, async (engine, backend) => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-git-durability-parity-')));
    try {
      return await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
        const root = join(home, 'checkout');
        await Bun.write(join(root, 'example.md'), 'generic example');
        git(root, ['init', '-q', '-b', 'main']);
        git(root, ['add', '-A']);
        git(root, ['commit', '-q', '-m', 'init']);
        await createSource(engine, backend, 'work', {}, root);
        try {
          await claimWorktree(engine, 'work', root);
          const pat = join(home, 'pat.txt');
          writeFileSync(pat, 'example-token-0000\n');
          chmodSync(pat, 0o600);
          const written = () => ({
            credential_store: existsSync(join(home, 'git-credentials')) || existsSync(join(home, '.gbrain', 'git-credentials')),
            credential_helper: git(root, ['config', '--local', '--get', 'credential.helper']) !== '',
            managed_credential: git(root, ['config', '--local', '--get', 'gbrain.durability.managedcredential']),
          });
          const before = written();
          let result: Record<string, unknown>;
          try {
            result = await runPersistenceAdministration(engine, 'writer_git_durability', {
              source_id: 'work', pat_file: pat, admin_intent: 'writer_git_durability', expected_state: await writerAdminState(engine) });
          } catch (error) {
            const after = written();
            // The refusal says nothing ran: it must leave the credential store and the git config as they were.
            if (JSON.stringify(after) !== JSON.stringify(before)) throw new Error(`refused after writing: ${JSON.stringify({ before, after })}`);
            throw error;
          }
          const answers = { before, after: written(), status: result.status ?? null };
          expect(answers.before).toEqual({ credential_store: false, credential_helper: false, managed_credential: '' });
          expect(answers.after).toEqual({ credential_store: true, credential_helper: true, managed_credential: 'true' });
          return answers;
        } finally {
          await disposePersistenceConsumer(engine);
        }
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
