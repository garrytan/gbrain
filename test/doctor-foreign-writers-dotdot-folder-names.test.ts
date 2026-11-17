/**
 * Doctor `foreign_writers` scans the dirty page files under each source root. It recorded a source root as the whole
 * checkout whenever `relative(checkoutTop, sourceRoot)` started with `..`, which also matches a source folder named
 * `..x`, so for such a source every old dirty file anywhere in the checkout was reported as a page file waiting.
 * Protects: a source folder named `..x` scopes the scan to that folder (a file in `..xy`, a sibling folder that shares
 * the name prefix, or at the checkout root is not reported), the same as a folder named `notes`.
 * Authoring gate: (1) which dirty files doctor reports for a source; (2) a startsWith('..') check that is not
 * component-aware; (3) doctor-foreign-writers.test.ts only registers a source folder named `notes`; (4) no seam, the
 * real doctor entry on in-memory PGLite and real git repositories. A source root outside its checkout cannot be
 * registered here (the checkout is found from the root itself), so that escape case has no test.
 */
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { foreignWritersEntry } from '../src/commands/doctor/checks/foreign-writers.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import type { Check } from '../src/commands/doctor.ts';

let engine: PGLiteEngine;
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'gbrain-foreign-dotdot-')));
const ID = { GIT_AUTHOR_NAME: 'Example Writer', GIT_AUTHOR_EMAIL: 'writer@example.invalid', GIT_COMMITTER_NAME: 'Example Writer', GIT_COMMITTER_EMAIL: 'writer@example.invalid' };
const git = (cwd: string, args: string[]) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...ID } }).toString().trim();
const write = (root: string, rel: string, body: string) => { mkdirSync(dirname(join(root, rel)), { recursive: true }); writeFileSync(join(root, rel), body); };
const OLD = (Date.now() - 2 * 3_600_000) / 1000;
const age = (root: string, rel: string) => utimesSync(join(root, rel), OLD, OLD);
let n = 0;

/** A checkout with an upstream and committed seed files in `<folder>`, `<folder>y` (shares the name prefix) and at the root. */
function checkout(folder: string): string {
  const bare = join(dir, `origin-${n}.git`), work = join(dir, `work-${n++}`);
  git(dir, ['init', '-q', '--bare', '-b', 'main', bare]);
  git(dir, ['clone', '-q', bare, work]);
  git(work, ['config', 'commit.gpgsign', 'false']);
  for (const path of [`${folder}/seed.md`, `${folder}y/seed.md`, 'seed.md']) write(work, path, 'seed\n');
  git(work, ['add', '-A']); git(work, ['commit', '-q', '-m', 'seed']); git(work, ['push', '-q', '-u', 'origin', 'main']);
  return work;
}
const run = async (): Promise<Check> => ((await foreignWritersEntry.run({ engine, progress: { heartbeat() {} } } as unknown as DoctorContext)) as Check[])[0]!;
const dirtyPaths = (check: Check) => (check.details!.dirty as Array<{ path: string }>).map(d => d.path).sort();

beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); });
afterAll(async () => { await engine.disconnect(); rmSync(dir, { recursive: true, force: true }); });
beforeEach(async () => { await engine.executeRaw("DELETE FROM sources WHERE id <> 'default'"); });

for (const folder of ['..x', 'notes']) {
  test(`a source folder named ${folder} limits the dirty-file scan to that folder`, async () => {
    const work = checkout(folder);
    await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', ['source', join(work, folder)]);
    for (const path of [`${folder}/stray.md`, `${folder}y/stray.md`, 'stray.md']) { write(work, path, 'stray\n'); age(work, path); }
    const check = await run();
    expect(check.status).toBe('warn');
    expect(dirtyPaths(check)).toEqual([`${folder}/stray.md`]);
    expect(check.details!.dirty_count).toBe(1);
  }, 60_000);
}
