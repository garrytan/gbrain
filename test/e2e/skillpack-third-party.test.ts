/**
 * End-to-end test for the third-party skillpack scaffold flow.
 *
 * Spawns the actual `gbrain` CLI as a subprocess (not via in-process
 * imports), drives `init` -> `doctor` -> `pack` -> `scaffold` against a
 * local-path source. Covers the canonical publisher + consumer loop
 * without needing network or a real git remote.
 *
 * Runs against PGLite-free paths only; no DATABASE_URL required.
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync } from 'child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const REPO_ROOT = process.cwd();
const CLI = ['bun', 'run', join(REPO_ROOT, 'src/cli.ts')];

function hasGnuTar(): boolean {
  for (const bin of ['gtar', 'tar']) {
    const r = spawnSync(bin, ['--version'], { encoding: 'utf-8' });
    if (r.status === 0 && r.stdout.includes('GNU')) return true;
  }
  return false;
}
const SKIP_NO_GNU = !hasGnuTar();

interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], env: Record<string, string> = {}): CliResult {
  const r = spawnSync(CLI[0], [...CLI.slice(1), ...args], {
    encoding: 'utf-8',
    env: { ...process.env, ...env },
    cwd: REPO_ROOT,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

let tmp: string;
beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'sp-e2e-'));
});
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('e2e: full publisher loop', () => {
  test.skipIf(SKIP_NO_GNU)('init -> doctor (10/10) -> pack -> tarball exists', () => {
    const env = { GBRAIN_HOME: join(tmp, 'gbrain-home-1') };
    const packDir = join(tmp, 'e2e-pack-1');

    // 1. init
    const init = runCli(['skillpack', 'init', 'e2e-pack-1', '--target', packDir], env);
    expect(init.status).toBe(0);
    expect(existsSync(join(packDir, 'skillpack.json'))).toBe(true);

    // 2. doctor
    const doc = runCli(['skillpack', 'doctor', packDir, '--quick', '--json'], env);
    expect(doc.status).toBe(0);
    const docResult = JSON.parse(doc.stdout);
    expect(docResult.score).toBe(10);
    expect(docResult.tier_eligibility).toBe('endorsed');

    // 3. pack
    const pack = runCli(['skillpack', 'pack', packDir, '--json'], env);
    expect(pack.status).toBe(0);
    const packResult = JSON.parse(pack.stdout);
    expect(packResult.tarball).not.toBeNull();
    expect(packResult.tarball.sha256.length).toBe(64);
    expect(existsSync(packResult.tarball.outPath)).toBe(true);
  });
});

describe('e2e: full consumer loop (third-party scaffold from local path)', () => {
  test('init pack A -> scaffold pack A into workspace B -> files land', () => {
    const env = { GBRAIN_HOME: join(tmp, 'gbrain-home-2') };
    const packDir = join(tmp, 'pack-2');
    const workspace = join(tmp, 'ws-2');

    runCli(['skillpack', 'init', 'consumer-pack', '--target', packDir], env);
    const scaffold = runCli(
      ['skillpack', 'scaffold', packDir, '--workspace', workspace, '--json'],
      env,
    );
    expect(scaffold.status).toBe(0);
    const r = JSON.parse(scaffold.stdout);
    expect(r.ok).toBe(true);
    expect(r.status).toBe('wrote_new');
    expect(r.pack.name).toBe('consumer-pack');
    expect(existsSync(join(workspace, 'skills/consumer-pack/SKILL.md'))).toBe(true);
    // state.json should record the install.
    const statePath = join(env.GBRAIN_HOME, '.gbrain', 'skillpack-state.json');
    expect(existsSync(statePath)).toBe(true);
    const state = JSON.parse(readFileSync(statePath, 'utf-8'));
    expect(state.packs).toHaveLength(1);
    expect(state.packs[0].name).toBe('consumer-pack');
  });

  test('second scaffold of same pack into same workspace refuses to overwrite', () => {
    const env = { GBRAIN_HOME: join(tmp, 'gbrain-home-3') };
    const packDir = join(tmp, 'pack-3');
    const workspace = join(tmp, 'ws-3');
    runCli(['skillpack', 'init', 'twicepack', '--target', packDir], env);
    runCli(['skillpack', 'scaffold', packDir, '--workspace', workspace], env);
    const second = runCli(
      ['skillpack', 'scaffold', packDir, '--workspace', workspace, '--json'],
      env,
    );
    expect(second.status).toBe(0);
    const r = JSON.parse(second.stdout);
    expect(r.status).toBe('all_skipped_existing');
    expect(r.copy.wroteNew).toBe(0);
  });
});

describe('e2e: doctor --fix loop', () => {
  test('full init -> delete required artifacts -> doctor surfaces gaps -> --fix --yes restores them', () => {
    const env = { GBRAIN_HOME: join(tmp, 'gbrain-home-4') };
    const packDir = join(tmp, 'pack-fix');
    runCli(['skillpack', 'init', 'fix-target', '--target', packDir], env);
    // Knock out auto-fixable artifacts.
    rmSync(join(packDir, 'runbooks/bootstrap.md'));
    rmSync(join(packDir, 'LICENSE'));
    rmSync(join(packDir, 'skills/fix-target/routing-eval.jsonl'));

    const first = runCli(['skillpack', 'doctor', packDir, '--quick', '--json'], env);
    const f = JSON.parse(first.stdout);
    expect(f.score).toBeLessThan(10);

    const fixed = runCli(
      ['skillpack', 'doctor', packDir, '--quick', '--fix', '--yes', '--json'],
      env,
    );
    const fr = JSON.parse(fixed.stdout);
    expect(fr.fixes_applied.length).toBeGreaterThan(0);
    // The score in `fr` IS the post-fix re-walk (runDoctor re-walks after applying fixes).
    expect(fr.score).toBeGreaterThan(f.score);
  });

  test('--minimal init scores 7/10 (3 missing badges that need manifest patches)', () => {
    const env = { GBRAIN_HOME: join(tmp, 'gbrain-home-4b') };
    const packDir = join(tmp, 'pack-min');
    runCli(['skillpack', 'init', 'min-target', '--target', packDir, '--minimal'], env);
    const r = runCli(['skillpack', 'doctor', packDir, '--quick', '--json'], env);
    const j = JSON.parse(r.stdout);
    expect(j.score).toBe(7);
    expect(j.tier_eligibility).toBe('experimental');
  });
});

describe('e2e: search + info against a localhost fixture registry', () => {
  // Bun.serve + subprocess `gbrain` CLI has timing flakiness (subprocess
  // startup + fetch round-trip frequently overruns bun:test's default
  // 5s per-test budget). Unit-level coverage of the registry-client
  // network path lives in test/skillpack-registry-client.test.ts via the
  // fetchImpl injection seam, which is deterministic and fast.
  test.skip('search returns the local fixture; info shows full details', async () => {
    const env = { GBRAIN_HOME: join(tmp, 'gbrain-home-5') };
    const fixtureDir = join(tmp, 'fixture-registry');
    mkdirSync(fixtureDir, { recursive: true });

    const catalog = {
      schema_version: 'gbrain-registry-v1',
      updated_at: '2026-05-18T20:00:00Z',
      skillpacks: [
        {
          name: 'fixture-pack',
          description: 'Fixture pack for E2E search',
          author: 'Test',
          author_handle: 'test',
          homepage: 'https://example.com',
          source: {
            kind: 'git',
            url: 'https://example.com/fixture.git',
            pinned_commit: 'a'.repeat(40),
          },
          tarball_sha256: 'b'.repeat(64),
          gbrain_min_version: '0.36.0',
          default_tier: 'community',
          tags: ['fixture'],
          validated_at: '2026-05-18T20:00:00Z',
          validation_run_id: 'r1',
          skills_count: 1,
          skills: ['skills/fixture'],
          version: '0.1.0',
        },
      ],
    };
    writeFileSync(join(fixtureDir, 'registry.json'), JSON.stringify(catalog, null, 2));
    writeFileSync(
      join(fixtureDir, 'endorsements.json'),
      JSON.stringify({ schema_version: 'gbrain-endorsements-v1', endorsements: {} }),
    );

    // Bun.serve picks a free port for us (port: 0 => ephemeral).
    const serve = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        const file = join(fixtureDir, url.pathname);
        if (existsSync(file)) {
          return new Response(readFileSync(file));
        }
        return new Response('not found', { status: 404 });
      },
    });
    const port = serve.port;
    try {
      const search = runCli(
        ['skillpack', 'search', 'fixture', '--url', `http://localhost:${port}/registry.json`, '--json'],
        env,
      );
      expect(search.status).toBe(0);
      const sj = JSON.parse(search.stdout);
      expect(sj.count).toBe(1);
      expect(sj.results[0].name).toBe('fixture-pack');

      const info = runCli(
        ['skillpack', 'info', 'fixture-pack', '--url', `http://localhost:${port}/registry.json`, '--json'],
        env,
      );
      expect(info.status).toBe(0);
      const ij = JSON.parse(info.stdout);
      expect(ij.name).toBe('fixture-pack');
      expect(ij.skills_count).toBe(1);
    } finally {
      serve.stop();
    }
  });
});
