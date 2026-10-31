/**
 * GBRA-218 A1 identity: local `--as <member>` as real CLI subprocesses against
 * a repo-less PGLite brain on disk (no git checkout).
 *
 * 1. Protects: `--as` previews an operation's reads as that member (pages
 *    naming readers appear only for a listed member); the plain local CLI is
 *    unchanged; an unknown, disabled or ill-formed `--as` is refused with
 *    access_member_invalid before any work; a command that would ignore
 *    `--as` refuses it; writes under `--as` keep local write trust.
 * 2. Fails when: `--as` is silently ignored (shows everything), an unknown
 *    member reads as unbound, or `--as` turns local writes into remote ones.
 * 3. Existing coverage: none for the CLI seam (test/access-as.test.ts holds
 *    the in-process composition and upload confinement).
 * 4. Real seams: src/cli.ts global flag parsing, runSharedOperation, makeContext.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createEngine } from '../src/core/engine-factory.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';

const CLI = join(resolve(import.meta.dir, '..'), 'src', 'cli.ts');
let root: string, home: string, db: string;

function env(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) out[key] = value;
  for (const key of ['DATABASE_URL', 'GBRAIN_DATABASE_URL', 'GBRAIN_BRAIN_ID', 'GBRAIN_SOURCE', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'VOYAGE_API_KEY']) delete out[key];
  return { ...out, HOME: home, GBRAIN_HOME: home, GBRAIN_SELF_UPGRADE_MODE: 'off', GBRAIN_SKIP_STARTUP_HOOKS: '1', GBRAIN_SWEEP: '0' };
}

async function cli(args: string[], stdin?: string) {
  const proc = Bun.spawn(['bun', 'run', CLI, ...args], { cwd: root, env: env(), stdin: stdin === undefined ? 'ignore' : new Blob([stdin]), stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, exitCode };
}

async function withBrain<T>(run: (engine: BrainEngine) => Promise<T>): Promise<T> {
  const config = { engine: 'pglite' as const, database_path: db };
  const engine = await createEngine(config);
  await engine.connect(config);
  try { return await run(engine); } finally { await disposePersistenceConsumer(engine); await engine.disconnect(); }
}

/** A repo-less PGLite brain on disk (no git checkout), the default keyless install. */
async function makeBrain(prefix: string, seed: (engine: BrainEngine) => Promise<void>): Promise<void> {
  root = mkdtempSync(join(tmpdir(), prefix));
  home = join(root, 'home');
  db = join(root, 'db');
  mkdirSync(join(home, '.gbrain'), { recursive: true });
  writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: 'pglite', database_path: db }));
  await withBrain(async engine => { await engine.initSchema(); await seed(engine); });
}

const ALICE = { slug: 'notes/alice-plan', canary: 'canaryasalice' };

beforeAll(async () => {
  await makeBrain('gb-access-as-', async engine => {
    await engine.putPage(ALICE.slug, { type: 'note', title: 'Alice plan', compiled_truth: `Planning notes ${ALICE.canary}.`, timeline: '', frontmatter: { readable_by: ['alice-example'] } }, { sourceId: 'default' });
    await engine.putPage('notes/open-plan', { type: 'note', title: 'Open plan', compiled_truth: 'Open notes canaryasopen.', timeline: '', frontmatter: {} }, { sourceId: 'default' });
    for (const id of ['alice-example', 'bob-example', 'carol-example']) await engine.executeRaw('INSERT INTO access_members (id) VALUES ($1)', [id]);
    await engine.executeRaw("UPDATE access_members SET disabled_at = now() WHERE id = 'carol-example'");
  });
}, 120_000);

afterAll(() => { rmSync(root, { recursive: true, force: true }); });

describe('local --as <member> (repo-less PGLite)', () => {
  test('the plain local CLI reads the restricted page; --as narrows to the member view', async () => {
    const plain = await cli(['get', ALICE.slug]);
    expect(plain.exitCode).toBe(0);
    expect(plain.stdout).toContain(ALICE.canary);
    const asAlice = await cli(['get', ALICE.slug, '--as', 'alice-example']);
    expect(asAlice.exitCode).toBe(0);
    expect(asAlice.stdout).toContain(ALICE.canary);
    const asBob = await cli(['--as', 'bob-example', 'get', ALICE.slug]);
    expect(asBob.stdout + asBob.stderr).not.toContain(ALICE.canary);
    expect(asBob.exitCode).not.toBe(0);
    const listBob = await cli(['list', '--as', 'bob-example', '--json']);
    expect(listBob.exitCode).toBe(0);
    expect(listBob.stdout).toContain('notes/open-plan');
    expect(listBob.stdout).not.toContain(ALICE.slug);
  }, 180_000);

  test('an unknown, disabled or ill-formed --as is refused before any work', async () => {
    for (const [who, reason] of [['nobody-example', 'unknown'], ['carol-example', 'disabled'], ['Not_Valid!', 'ill_formed']] as const) {
      const r = await cli(['get', 'notes/open-plan', '--as', who, '--json']);
      expect({ who, exit: r.exitCode === 0 }).toEqual({ who, exit: false });
      expect(r.stdout).not.toContain('canaryasopen');
      expect(JSON.parse(r.stdout)).toMatchObject({ code: 'access_member_invalid', reason });
    }
    const missing = await cli(['get', 'notes/open-plan', '--as']);
    expect(missing.exitCode).not.toBe(0);
  }, 180_000);

  test('a command that would ignore --as refuses it', async () => {
    const r = await cli(['access', 'member', 'list', '--as', 'alice-example']);
    expect(r.exitCode).not.toBe(0);
    const doctor = await cli(['doctor', '--as', 'alice-example']);
    expect(doctor.exitCode).not.toBe(0);
    expect(doctor.stderr).toContain('--as previews member reads for operation commands only');
  }, 120_000);

  test('whoami --as reports the member; writes under --as keep local trust', async () => {
    const who = await cli(['whoami', '--as', 'bob-example', '--json']);
    expect(who.exitCode).toBe(0);
    expect(JSON.parse(who.stdout)).toMatchObject({ transport: 'local', access: { member: 'bob-example', bound_by: 'as' } });
    const put = await cli(['put', 'notes/bob-draft', '--as', 'bob-example'], '---\ntype: note\ntitle: Bob draft\n---\n# Bob draft\n\nDraft canaryasbob.\n');
    expect({ exit: put.exitCode, err: put.exitCode === 0 ? '' : put.stderr }).toEqual({ exit: 0, err: '' });
    const read = await cli(['get', 'notes/bob-draft']);
    expect(read.stdout).toContain('canaryasbob');
  }, 180_000);
});
