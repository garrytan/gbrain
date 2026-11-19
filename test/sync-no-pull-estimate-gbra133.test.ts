/**
 * GBRA-133 PR 2b (lane D's run.ts hunk): `foresights sync --no-pull` syncs local HEAD, so its inline cost estimate prices
 * local HEAD and runs no git fetch. The control (the same command without --no-pull) fetches, so the check is not
 * vacuous. The sync is stopped right after the cost gate, before it would pull.
 */
import { afterAll, beforeAll, expect, spyOn, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runSync } from '../src/commands/sync.ts';
import * as gitRemote from '../src/core/git-remote.ts';
import * as embedBackfill from '../src/core/sync-embed-backfill.ts';
import { configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { withEnv } from './helpers/with-env.ts';
import { chunkerStamp } from '../src/core/chunkers/code.ts';

const home = mkdtempSync(join(tmpdir(), 'gbrain-no-pull-estimate-'));
let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 60_000);
afterAll(async () => { resetGateway(); await engine?.disconnect(); rmSync(home, { recursive: true, force: true }); });
const sh = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', ...args], { cwd, encoding: 'utf8' }).trim();
const page = (name: string) => '---\ntitle: ' + name + '\n---\nA note about acme-example named ' + name + '.\n';

test('foresights sync --no-pull runs no git fetch during the cost estimate; without it the estimate fetches', async () => {
  const remote = join(home, 'remote.git'), writer = join(home, 'writer'), local = join(home, 'local');
  sh(home, 'init', '-q', '--bare', '-b', 'main', remote);
  sh(home, 'clone', '-q', remote, writer);
  writeFileSync(join(writer, 'a.md'), page('a')); sh(writer, 'add', '-A'); sh(writer, 'commit', '-qm', 'a'); sh(writer, 'push', '-q', 'origin', 'HEAD:main');
  sh(home, 'clone', '-q', remote, local);
  const base = sh(local, 'rev-parse', 'HEAD');
  writeFileSync(join(writer, 'b.md'), page('b')); sh(writer, 'add', '-A'); sh(writer, 'commit', '-qm', 'b'); sh(writer, 'push', '-q', 'origin', 'HEAD:main');

  await engine.executeRaw("INSERT INTO sources(id,name,local_path,config,last_commit,chunker_version) VALUES('estimate','estimate',$1,'{}',$2,$3)", [local, base, chunkerStamp()]);
  const fetches = spyOn(gitRemote, 'fetchRemote');
  const real = embedBackfill.resolveSingleSyncEmbedPlan;
  const gates: Array<Record<string, unknown>> = [];
  const gate = spyOn(embedBackfill, 'resolveSingleSyncEmbedPlan').mockImplementation(async (e, source, opts) => {
    gates.push(opts as unknown as Record<string, unknown>);
    return { ...await real(e, source, opts), stop: true };
  });
  try {
    await withEnv({ GBRAIN_HOME: home, GBRAIN_GIT_ALLOW_FILE_TRANSPORT: '1', OPENAI_API_KEY: 'sk-test-not-a-key', DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'sk-test-not-a-key' } } as never);
      await runSync(engine, ['--source', 'estimate', '--no-pull']);
      expect(gates.length).toBe(1);
      expect(fetches).not.toHaveBeenCalled();
      expect(sh(local, 'rev-parse', 'refs/remotes/origin/main')).toBe(base);
      expect(gates[0]!.noPull).toBe(true);
      await runSync(engine, ['--source', 'estimate']);
      expect(gates.length).toBe(2);
      expect(fetches).toHaveBeenCalled();
      expect(sh(local, 'rev-parse', 'refs/remotes/origin/main')).not.toBe(base);
    });
  } finally {
    fetches.mockRestore(); gate.mockRestore();
  }
}, 60_000);
