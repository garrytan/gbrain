/**
 * source_durability_hardening doctor check.
 *
 * Gap: write-through (`put_page`, capture, enrichment) writes a source's
 * `.md` artifact to disk and reports success regardless of whether the repo
 * is durability-hardened. On an un-hardened repo the file sits uncommitted
 * forever — never pushed, invisible to `git status` on a fresh clone — so the
 * DB row becomes the only durable copy. `isDurabilityHardened` (used today
 * only to gate write-through's best-effort commit) had no doctor-facing
 * check surfacing which sources with a pushable remote never opted in via
 * `gbrain sources harden`.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { checkSourceDurabilityHardening } from '../src/commands/doctor.ts';

let engine: PGLiteEngine;
const tempDirs: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8',
  }).trim();
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gbrain-doctor-durability-'));
  tempDirs.push(dir);
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 't@t.t');
  git(dir, 'config', 'user.name', 'tester');
  return dir;
}

function addOriginRemote(repoPath: string): void {
  // Any URL works — the check only reads config (`git remote get-url`), it
  // never fetches or pushes.
  git(repoPath, 'remote', 'add', 'origin', 'https://example.invalid/brain.git');
}

/** Install a hook file carrying the gbrain durability banner (the detection
 *  key `isDurabilityHardened` looks for) — same fake used by
 *  write-through-commit.serial.test.ts, so no real push machinery needed. */
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

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  if (engine) await engine.disconnect();
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
}, 60_000);

beforeEach(async () => {
  await resetPgliteState(engine);
});

async function addSource(id: string, localPath: string | null): Promise<void> {
  await engine.executeRaw(
    `INSERT INTO sources (id, name, local_path, config) VALUES ($1, $1, $2, '{}'::jsonb)
     ON CONFLICT (id) DO UPDATE SET local_path = EXCLUDED.local_path`,
    [id, localPath],
  );
}

describe('source_durability_hardening', () => {
  test('no sources with local_path → ok (not applicable)', async () => {
    const c = await checkSourceDurabilityHardening(engine);
    expect(c.status).toBe('ok');
    expect(c.message).toContain('Not applicable');
  });

  test('source with no git remote → ok (not applicable, hardening does not apply)', async () => {
    const repo = makeRepo();
    await addSource('src-a', repo);
    const c = await checkSourceDurabilityHardening(engine);
    expect(c.status).toBe('ok');
    expect(c.message).toContain('Not applicable');
  });

  test('hardened source with a remote → ok', async () => {
    const repo = makeRepo();
    addOriginRemote(repo);
    installFakeDurabilityHook(repo);
    await addSource('src-a', repo);
    const c = await checkSourceDurabilityHardening(engine);
    expect(c.status).toBe('ok');
  });

  test('un-hardened source with a remote → warn naming the source', async () => {
    const repo = makeRepo();
    addOriginRemote(repo);
    await addSource('src-a', repo);
    const c = await checkSourceDurabilityHardening(engine);
    expect(c.status).toBe('warn');
    expect(c.message).toContain('src-a');
    expect(c.message).toContain('gbrain sources harden');
    expect((c.details as any).unhardened).toEqual(['src-a']);
  });

  test('mixed hardened + un-hardened sources → warn counts only the un-hardened one', async () => {
    const hardened = makeRepo();
    addOriginRemote(hardened);
    installFakeDurabilityHook(hardened);
    await addSource('src-hard', hardened);

    const bare = makeRepo();
    addOriginRemote(bare);
    await addSource('src-soft', bare);

    const c = await checkSourceDurabilityHardening(engine);
    expect(c.status).toBe('warn');
    expect((c.details as any).unhardened).toEqual(['src-soft']);
    expect(c.message).not.toContain('src-hard');
  });
});
