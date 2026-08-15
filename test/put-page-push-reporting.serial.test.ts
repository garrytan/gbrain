/**
 * put_page's write-through response on a durability-hardened repo reports
 * `committed: true` for both a successful and a FAILED background push — the
 * commit lands locally either way, but the push runs detached in the
 * post-commit hook, so the caller had no field to distinguish "pushed fine"
 * from "still local-only". This pins the honest contract: `committed` is
 * commit-only, `pushed: 'pending'` says the push outcome isn't known yet, and
 * `lastPushStatus` surfaces the hook's own log so a caller (or health
 * tooling) can see whether pushes for this branch are currently landing.
 */

import { describe, test, expect, beforeAll, beforeEach, afterEach, afterAll } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, chmodSync, appendFileSync } from 'fs';
import { execSync, execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { join } from 'path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { operations } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';

const putPageOp = operations.find((o) => o.name === 'put_page')!;

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

  afterEach(() => {
    if (oldGbrainHome === undefined) delete process.env.GBRAIN_HOME; else process.env.GBRAIN_HOME = oldGbrainHome;
    if (repo) rmSync(repo, { recursive: true, force: true });
    if (gbrainHome) rmSync(gbrainHome, { recursive: true, force: true });
  });

  test('reports committed + pending push, not an implied success, with no push history yet', async () => {
    const res: any = await putPageOp.handler(makeCtx(), {
      slug: 'notes/ppr-fresh',
      content: '---\ntype: concept\ntitle: PPR Fresh\n---\n\nbody',
    });

    expect(res.write_through.committed).toBe(true);
    expect(res.write_through.pushed).toBe('pending');
    expect(res.write_through.lastPushStatus.status).toBe('unknown');
  });

  test('surfaces a prior LOCAL-ONLY push failure instead of hiding it behind committed:true', async () => {
    // Simulate the hook having already logged an unresolved push failure for
    // this branch (e.g. from an earlier write in the same session).
    // CX2-8: GBRAIN_HOME is a PARENT dir — the resolved home is
    // $GBRAIN_HOME/.gbrain, so the push log lives under it.
    mkdirSync(join(gbrainHome, '.gbrain'), { recursive: true });
    appendFileSync(
      join(gbrainHome, '.gbrain', 'brain-push.log'),
      '2025-01-01T00:00:00Z [push] LOCAL-ONLY, NEEDS ATTENTION: main @ deadbee could not reach origin. Run: gbrain sources pull <id> && git push\n',
    );

    const res: any = await putPageOp.handler(makeCtx(), {
      slug: 'notes/ppr-broken-push',
      content: '---\ntype: concept\ntitle: PPR Broken Push\n---\n\nbody',
    });

    // The commit itself still succeeds (git commit doesn't touch the network) —
    // that's the honest part of `committed: true`. What must NOT happen is the
    // caller reading `committed: true` as "this is durably on the remote".
    expect(res.write_through.committed).toBe(true);
    expect(res.write_through.pushed).toBe('pending');
    expect(res.write_through.lastPushStatus.status).toBe('needs_attention');
    expect(res.write_through.lastPushStatus.detail).toContain('NEEDS ATTENTION');
  });
});
