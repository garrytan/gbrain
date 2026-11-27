/**
 * GST-4043: what gbrain setup <harness> --serves several labels, and where.
 *
 * 1. Protects: the labelling and layout children setup spawns work on the host brain, so a setup run from a directory
 *    inside a mount labels the host brain and leaves the mount alone; --members=<ids> (the = form) labels the people
 *    as the two-argument form does; a harness pinned to one source (GBRAIN_SOURCE) gets its people labelled and its
 *    keys writing in that source, and a re-run there moves the keys an earlier run minted without replacing them; a
 *    --shape company run whose pinned source is company adds the source first and labels the people in it.
 * 2. Fails when: a mount around the working directory gets the members, the = form is refused or dropped, the rules or
 *    keys land in source default while the harness reads another source, a re-run mints new keys, or --shape company
 *    with the company pin refuses because the source does not exist yet.
 * 3. Existing coverage: setup-serves-several.test.ts (labelling on one source), setup-company-access.test.ts (the
 *    company regrant), setup-member-key-regrant-gbra585.test.ts (the key move in labelSeveral).
 * 4. Real seams: `bun src/cli.ts setup` spawned against a temp HOME / GBRAIN_HOME with PGLite brains.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { createEngine } from '../src/core/engine-factory.ts';
import type { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runCli } from './helpers/cli-spawn.ts';
import { box, CLEAN, gbrain, openBrainFile, removeTempDirs, ROSTER, setup, type Box } from './helpers/setup-serves-box.ts';

afterAll(removeTempDirs);

const members = async (engine: BrainEngine) => (await engine.executeRaw<{ id: string }>('SELECT id FROM access_members ORDER BY id')).map(r => r.id);
const keyRows = async (engine: PGLiteEngine) => engine.executeRaw<{ name: string; id: string; source_id: string }>('SELECT name, id, source_id FROM access_tokens WHERE name = ANY($1::text[]) AND revoked_at IS NULL ORDER BY name', [ROSTER.map(m => `member-${m}`)]);
async function inHost<T>(b: Box, read: (e: PGLiteEngine) => Promise<T>): Promise<T> {
  const e = await openBrainFile(b.home);
  try { return await read(e); } finally { await e.disconnect(); }
}

describe('gbrain setup --serves several: which brain and which source (GST-4043)', () => {
  test('run from a directory inside a mount, setup labels the host brain and leaves the mount alone', async () => {
    const b = box();
    expect((await gbrain(b, ['init', '--pglite', '--no-embedding', '--json'])).exitCode).toBe(0);
    const mountDb = join(b.root, 'mount.pglite');
    const mount = await createEngine({ engine: 'pglite', database_path: mountDb });
    await mount.connect({ engine: 'pglite', database_path: mountDb });
    await mount.initSchema();
    await mount.disconnect();
    const mountsPath = join(b.home, '.gbrain', 'mounts.json');
    writeFileSync(mountsPath, JSON.stringify({ version: 1, mounts: [{ id: 'example-mount', path: join(b.root, 'mount-clone'), engine: 'pglite', database_path: mountDb, enabled: true }] }), { mode: 0o600 });
    const project = join(b.root, 'project');
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, '.gbrain-mount'), 'example-mount\n');
    chmodSync(join(project, '.gbrain-mount'), 0o644);
    const env = { ...CLEAN, HOME: b.home, GBRAIN_HOME: b.home, GBRAIN_MOUNTS_PATH: mountsPath, OPENCLAW_STATE_DIR: join(b.root, 'openclaw-state'), OPENCLAW_PROFILE: undefined, HERMES_HOME: join(b.root, 'hermes-home') };
    const r = await runCli(['setup', 'claude-code', '--serves', 'several', '--members', ROSTER.join(','), '--open-history', '--json', '--gbrain-bin', b.bin], { env, cwd: project, timeoutMs: 240_000 });
    expect(r.exitCode, r.stdout + r.stderr).toBe(0);
    expect(await inHost(b, members)).toEqual(expect.arrayContaining(ROSTER));
    const m = await createEngine({ engine: 'pglite', database_path: mountDb });
    await m.connect({ engine: 'pglite', database_path: mountDb });
    try { expect(await members(m)).toEqual([]); } finally { await m.disconnect(); }
  }, 480_000);

  test('--members=<ids> labels the people; GBRAIN_SOURCE labels them in that source, and a re-run there moves the keys an earlier run minted', async () => {
    const b = box();
    expect((await gbrain(b, ['init', '--pglite', '--no-embedding', '--json'])).exitCode).toBe(0);
    expect((await gbrain(b, ['sources', 'add', 'source-a'])).exitCode).toBe(0);
    const first = await setup(b, ['claude-code', '--serves', 'several', `--members=${ROSTER.join(',')}`, '--open-history', '--json']);
    expect(first.exitCode, first.stdout + first.stderr).toBe(0);
    expect(await inHost(b, members)).toEqual(expect.arrayContaining(ROSTER));
    const minted = await inHost(b, keyRows);
    expect(minted.map(k => k.source_id)).toEqual(['default', 'default']);
    const files = ROSTER.map(m => readFileSync(join(b.home, '.gbrain', 'member-keys', `${m}.key`), 'utf8'));
    const pinned = await gbrain(b, ['setup', 'claude-code', '--serves', 'several', '--members', ROSTER.join(','), '--open-history', '--json', '--gbrain-bin', b.bin], { GBRAIN_SOURCE: 'source-a' });
    expect(pinned.exitCode, pinned.stdout + pinned.stderr).toBe(0);
    const doc = JSON.parse(pinned.stdout);
    expect(doc.serves.receipt.source_id).toBe('source-a');
    const roster = (xs: any[]) => xs.filter((k: any) => ROSTER.includes(k.member));
    expect(roster(doc.serves.receipt.keys).map((k: any) => [k.action, k.moves])).toEqual([['keep', 'default'], ['keep', 'default']]);
    expect(doc.serves.receipt.rules.map((x: any) => x.prefix)).toEqual(expect.arrayContaining(ROSTER.map(m => `people/${m}/`)));
    const moved = await inHost(b, keyRows);
    expect(moved).toEqual(minted.map(k => ({ ...k, source_id: 'source-a' })));
    expect(ROSTER.map(m => readFileSync(join(b.home, '.gbrain', 'member-keys', `${m}.key`), 'utf8'))).toEqual(files);
    const rules = await inHost(b, e => e.executeRaw<{ source_id: string }>("SELECT DISTINCT source_id FROM access_rules WHERE prefix LIKE 'people/%'"));
    expect(rules.map(x => x.source_id).sort()).toEqual(['default', 'source-a']);
  }, 480_000);

  test('access serves several without --source labels GBRAIN_SOURCE or sources.default, never the source of the directory it runs from', async () => {
    const b = box();
    expect((await gbrain(b, ['init', '--pglite', '--no-embedding', '--json'])).exitCode).toBe(0);
    expect((await gbrain(b, ['sources', 'add', 'source-a'])).exitCode).toBe(0);
    const dir = join(b.root, 'checkout');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.gbrain-source'), 'source-a\n');
    const env = { ...CLEAN, HOME: b.home, GBRAIN_HOME: b.home };
    const here = await runCli(['access', 'serves', 'several', '--members', ROSTER.join(','), '--json'], { env, cwd: dir, timeoutMs: 120_000 });
    expect(JSON.parse(here.stdout).source_id, here.stdout + here.stderr).toBe('default');
    const repo = join(b.root, 'repo-b');
    mkdirSync(repo, { recursive: true });
    expect((await gbrain(b, ['sources', 'add', 'source-b', '--path', repo, '--no-federated'])).exitCode).toBe(0);
    const registered = await runCli(['access', 'serves', 'several', '--members', ROSTER.join(','), '--json'], { env, cwd: repo, timeoutMs: 120_000 });
    expect(JSON.parse(registered.stdout).source_id, registered.stdout + registered.stderr).toBe('default');
    const pinned = await runCli(['access', 'serves', 'several', '--members', ROSTER.join(','), '--json'], { env: { ...env, GBRAIN_SOURCE: 'source-a' }, cwd: dir, timeoutMs: 120_000 });
    expect(JSON.parse(pinned.stdout).source_id, pinned.stdout + pinned.stderr).toBe('source-a');
  }, 240_000);

  test('--shape company with the harness pinned to the company source adds the source first and labels the people in it', async () => {
    const b = box();
    expect((await gbrain(b, ['init', '--pglite', '--no-embedding', '--json'])).exitCode).toBe(0);
    const r = await gbrain(b, ['setup', 'claude-code', '--shape', 'company', '--serves', 'several', '--members', ROSTER.join(','), '--labelled-only', '--json', '--gbrain-bin', b.bin], { GBRAIN_SOURCE: 'company' });
    expect(r.exitCode, r.stdout + r.stderr).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.serves.receipt.source_id).toBe('company');
    expect(doc.serves.company_first).toMatchObject({ source: 'company', action: 'created' });
    expect((await inHost(b, keyRows)).map(k => k.source_id)).toEqual(['company', 'company']);
    expect(existsSync(join(b.home, '.claude.json'))).toBe(true);
  }, 480_000);
});
