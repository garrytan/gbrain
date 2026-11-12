/**
 * A classic (not `canonical: git`) worktree-backed page write: what its receipt says about Git. Its publication stores
 * `persistence.git_state: queued` (effect-journal.ts queuePublicationEffects) and nothing rewrites the request row, so
 * a receipt read later (#9227) takes `git_state` and `git_commit` from the Git effect row: queued while the effect is,
 * `committed` with the oid the effect recorded once it lands, `committed` without one for an effect row from an older
 * build, and `superseded`, `failed` or `retrying` with the effect's reason. The stored outcome stays as written.
 * PGLite and, with DATABASE_URL, Postgres.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, type OperationContext } from '../src/core/operations.ts';
import { runPersistenceEffects } from '../src/core/persistence/effects.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const op = (name: string) => operations.find(entry => entry.name === name)!;
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

for (const backend of testBackends()) describe(`[${backend}] a classic source's receipt after its Git commit lands`, () => {
  let engine: BrainEngine;
  let closePostgres: (() => Promise<void>) | undefined;
  const home = realpathSync(mkdtempSync(join(tmpdir(), `gbrain-receipt-git-${backend}-`)));
  const repo = join(home, 'repo');
  const env = { GBRAIN_HOME: home };
  const ctx = (): OperationContext => ({ engine, config: { engine: backend, embedding_disabled: true } as never,
    logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: false, sourceId: 'repo-source' });

  beforeAll(async () => withEnv(env, async () => {
    if (backend === 'pglite') { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }
    else { const pg = await isolatedPersistencePostgres(process.env.DATABASE_URL!); engine = pg.engine; closePostgres = pg.close; }
    mkdirSync(repo);
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.name', 'Example');
    git(repo, 'config', 'user.email', 'example@example.invalid');
    writeFileSync(join(repo, 'seed.md'), 'seed\n');
    git(repo, 'add', 'seed.md');
    git(repo, 'commit', '-qm', 'seed');
    // The durability hook banner is what marks the checkout hardened, so the Git effect commits (no push: no remote).
    mkdirSync(join(repo, '.git', 'hooks'), { recursive: true });
    writeFileSync(join(repo, '.git', 'hooks', 'post-commit'), '#!/usr/bin/env bash\n# gbrain brain-durability post-commit hook (v0.42.44+)\nexit 0\n');
    chmodSync(join(repo, '.git', 'hooks', 'post-commit'), 0o755);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', ['repo-source', repo]);
    await claimWorktree(engine, 'repo-source', repo);
    await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  }), 120_000);
  afterAll(async () => {
    await disposePersistenceConsumer(engine);
    if (closePostgres) await closePostgres(); else await engine.disconnect();
    rmSync(home, { recursive: true, force: true });
  }, 60_000);

  test('git_state reads queued until the Git effect commits, then committed with its oid; the stored row is not rewritten', async () => withEnv(env, async () => {
    const requestId = randomUUID();
    const written = await op('put_page').handler(ctx(), { slug: 'notes/landed', request_id: requestId, wait_ms: 20_000,
      content: '---\ntitle: Landed\ntype: note\n---\n# Landed\n\nA page whose commit lands later.\n' }) as Record<string, any>;
    expect(written).toMatchObject({ state: 'committed', persistence: { git_state: 'queued' } });
    const read = () => op('get_write_request').handler(ctx(), { request_id: requestId }) as Promise<Record<string, any>>;
    await disposePersistenceConsumer(engine);
    expect((await read()).persistence).toEqual({ mode: 'filesystem', file_written: true, git_state: 'queued' });
    const before = git(repo, 'rev-parse', 'HEAD');
    await disposePersistenceConsumer(engine);
    await runPersistenceEffects(engine, { engine: backend, embedding_disabled: true }, { hostId: localHostId(), limit: 8 });
    const head = git(repo, 'rev-parse', 'HEAD');
    expect(head).not.toBe(before);
    expect(git(repo, 'log', '-1', '--format=%H', '--', 'notes/landed.md')).toBe(head);
    const [effect] = await engine.executeRaw<{ state: string; outcome: Record<string, unknown> }>(
      `SELECT e.state,e.outcome FROM persistence_effects e JOIN persistence_requests r ON r.id=e.request_id WHERE r.request_id=$1::uuid AND e.kind='git'`, [requestId]);
    expect(effect!.state).toBe('committed');
    expect(effect!.outcome).toMatchObject({ git: 'committed', commit: head });
    const receipt = await read();
    expect(receipt.persistence).toEqual({ mode: 'filesystem', file_written: true, git_state: 'committed', git_commit: head });
    expect(receipt.effects).toContainEqual(expect.objectContaining({ kind: 'git', state: 'committed' }));
    const [stored] = await engine.executeRaw<{ outcome: Record<string, any> }>('SELECT outcome FROM persistence_requests WHERE request_id=$1::uuid', [requestId]);
    expect(stored!.outcome.persistence).toEqual({ mode: 'filesystem', file_written: true, git_state: 'queued' });
    expect(JSON.stringify(stored!.outcome)).not.toContain(head);
    // The same receipt over other Git effect rows, each set the way the effect worker leaves it.
    const setEffect = (sql: string) => engine.executeRaw(`UPDATE persistence_effects e SET ${sql} FROM persistence_requests r WHERE r.id=e.request_id AND r.request_id=$1::uuid AND e.kind='git'`, [requestId]);
    await setEffect(`outcome=e.outcome-'commit'`);
    expect((await read()).persistence).toEqual({ mode: 'filesystem', file_written: true, git_state: 'committed' });
    await setEffect(`outcome='{"git":"superseded","reason":"committed_by_another_writer"}'::jsonb`);
    expect((await read()).persistence).toMatchObject({ git_state: 'superseded', git_reason: 'committed_by_another_writer' });
    await setEffect(`state='queued',error_code='git_index_locked',outcome=NULL`);
    expect((await read()).persistence).toMatchObject({ git_state: 'retrying', git_reason: 'git_index_locked' });
    await setEffect(`state='failed',error_code='targets_parked'`);
    expect((await read()).persistence).toMatchObject({ git_state: 'failed', git_reason: 'targets_parked' });
  }), 120_000);
});
