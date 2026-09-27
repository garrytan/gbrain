/**
 * Canonical publication and optional Git effects have separate durable
 * outcomes. Receipt polling must distinguish an unconfigured upstream from
 * a failed push without invalidating the already-committed canonical page.
 */

import { describe, test, expect, beforeAll, beforeEach, afterEach, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, chmodSync } from 'fs';
import { execSync, execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { operations } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { runPersistenceEffects } from '../src/core/persistence/effects.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';

const putPageOp = operations.find((o) => o.name === 'put_page')!;
const receiptOp = operations.find((o) => o.name === 'get_write_request')!;

let engine: PGLiteEngine;
let repo: string;
let gbrainHome: string;
let oldGbrainHome: string | undefined;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8',
  }).trim();
}

/** Same fixture as write-through-commit.serial.test.ts: a hook file carrying
 *  the gbrain banner (the only thing `isDurabilityHardened` checks) with a
 *  no-op body so tests never attempt a real network push. */
function installFakeDurabilityHook(repoPath: string): void {
  const hooksDir = join(repoPath, '.git', 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  const hookPath = join(hooksDir, 'post-commit');
  writeFileSync(hookPath, [
    '#!/usr/bin/env bash',
    '# gbrain brain-durability post-commit hook (v0.42.44+)',
    'exit 0',
    '',
  ].join('\n'));
  chmodSync(hookPath, 0o755);
}

function makeCtx(opts: Partial<OperationContext> = {}): OperationContext {
  return {
    engine,
    config: { engine: 'pglite' as const },
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    dryRun: false,
    remote: false,
    sourceId: 'default',
    ...opts,
  };
}

async function settledGit(requestId: string, expected: 'skipped' | 'retrying'): Promise<any> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const receipt: any = await receiptOp.handler(makeCtx(), { request_id: requestId });
    const effect = receipt.effects.find((item: { kind: string }) => item.kind === 'git');
    if (expected === 'skipped' ? effect?.push === 'skipped' : effect?.reason === 'git_push_unavailable' && effect.state === 'queued') return receipt;
    if (Date.now() >= deadline) throw new Error(`Git effect did not settle: ${JSON.stringify(effect)}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

describe('put_page write-through — commit/push reporting on a hardened repo', () => {
  beforeAll(async () => {
    configureGateway({
      embedding_model: 'openai:text-embedding-3-large',
      embedding_dimensions: 1536,
      env: { ...process.env, OPENAI_API_KEY: process.env.OPENAI_API_KEY || 'sk-test-stub' },
    });
    __setEmbedTransportForTests(async ({ values }: any) => ({
      embeddings: values.map(() => new Array(1536).fill(0)),
      usage: { tokens: 0 },
    }) as any);

    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
  }, 60_000);

  afterAll(async () => {
    await engine.disconnect();
    __setEmbedTransportForTests(null);
    resetGateway();
  }, 60_000);

  beforeEach(async () => {
    await resetPgliteState(engine);
    repo = mkdtempSync(join(tmpdir(), 'gbrain-ppr-'));
    execSync('git init -q -b main', { cwd: repo, stdio: 'pipe' });
    execSync('git config user.email "t@t.t"', { cwd: repo, stdio: 'pipe' });
    execSync('git config user.name "T"', { cwd: repo, stdio: 'pipe' });
    writeFileSync(join(repo, 'seed.md'), 'seed\n');
    execSync('git add -A && git commit -qm init', { cwd: repo, stdio: 'pipe' });
    installFakeDurabilityHook(repo);
    await engine.setConfig('sync.repo_path', repo);

    gbrainHome = mkdtempSync(join(tmpdir(), 'gbrain-home-'));
    oldGbrainHome = process.env.GBRAIN_HOME;
    process.env.GBRAIN_HOME = gbrainHome;
  });

  afterEach(async () => {
    await disposePersistenceConsumer(engine);
    if (oldGbrainHome === undefined) delete process.env.GBRAIN_HOME; else process.env.GBRAIN_HOME = oldGbrainHome;
    if (repo) rmSync(repo, { recursive: true, force: true });
    if (gbrainHome) rmSync(gbrainHome, { recursive: true, force: true });
  });

  test('reports durable Git work and an explicit skipped push without an upstream', async () => {
    const res: any = await putPageOp.handler(makeCtx(), {
      slug: 'notes/ppr-fresh',
      content: '---\ntype: concept\ntitle: PPR Fresh\n---\n\nbody',
    });

    expect(res.state).toBe('committed');
    expect(res.write_through.written).toBe(true);
    expect(res.persistence.git_state).toBe('queued');
    await runPersistenceEffects(engine, { engine: 'pglite', embedding_disabled: true }, { hostId: localHostId(), limit: 8 });
    const settled = await settledGit(res.request_id, 'skipped');
    expect(settled.state).toBe('committed');
    expect(settled.revision).toBe(res.revision);
    expect(settled.effects).toContainEqual({ kind: 'git', state: 'committed', push: 'skipped', reason: 'no_tracking_remote' });
    expect(git(repo, 'show', 'HEAD:notes/ppr-fresh.md')).toContain('PPR Fresh');
  });

  test('a failed push remains retryable while the canonical receipt and local Git commit stay durable', async () => {
    // A missing local Git remote exercises a real push failure without network
    // access or hook subprocesses. The outbox disables the legacy hook.
    git(repo, 'remote', 'add', 'origin', join(repo, 'missing-remote.git'));
    git(repo, 'config', 'branch.main.remote', 'origin');
    git(repo, 'config', 'branch.main.merge', 'refs/heads/main');

    const res: any = await putPageOp.handler(makeCtx(), {
      slug: 'notes/ppr-broken-push',
      content: '---\ntype: concept\ntitle: PPR Broken Push\n---\n\nbody',
    });

    expect(res.state).toBe('committed');
    await runPersistenceEffects(engine, { engine: 'pglite', embedding_disabled: true }, { hostId: localHostId(), limit: 8 });
    const receipt = await settledGit(res.request_id, 'retrying');
    expect(receipt.state).toBe('committed');
    expect(receipt.revision).toBe(res.revision);
    expect(receipt.effects).toContainEqual({ kind: 'git', state: 'queued', reason: 'git_push_unavailable' });
    expect(receipt.effects.some((effect: { push?: string }) => effect.push === 'committed')).toBe(false);
    expect(git(repo, 'show', 'HEAD:notes/ppr-broken-push.md')).toContain('PPR Broken Push');
  });
});
