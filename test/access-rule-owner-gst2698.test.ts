/**
 * GST-2698 (GST-2670 decision d2): `gbrain access rule add` refuses a reader list that leaves out the brain owner, as
 * `gbrain repair visibility --readers` already does (readers_omit_owner), because such a rule closes the folder to the
 * owner's own keys.
 *
 * 1. Protects: with an owner set, a rule whose readers do not name the owner refuses on the preview and on --yes, with
 *    nothing written; --allow-without-owner accepts it; a list that names the owner applies; a brain with no owner set
 *    is unchanged.
 * 2. Fails when: a rule without the owner is written without the flag, the flag is ignored, or a brain with no owner
 *    starts refusing.
 * 3. Real seams: the gbrain access rule CLI module on a repo-less source (database store) and on a managed git source
 *    (.gbrain/access.yml through the door), PGLite and Postgres.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runAccessRules } from '../src/commands/access-rules.ts';
import { durableGitRepo } from './helpers/git-publication.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

async function cli(engine: BrainEngine, args: string[]): Promise<any> {
  const lines: string[] = [];
  const spy = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
  try { await runAccessRules(engine, args[0]!, [...args.slice(1), '--json'], true); } finally { spy.mockRestore(); }
  const text = lines.join('\n');
  try { return JSON.parse(text); } catch { throw new Error(`gbrain access ${args.join(' ')} printed no JSON: ${text}`); }
}

async function members(engine: BrainEngine, owner: string | null): Promise<void> {
  for (const id of ['owner-example', 'alice-example', 'bob-example']) await engine.executeRaw('INSERT INTO access_members (id) VALUES ($1) ON CONFLICT DO NOTHING', [id]);
  if (owner) await engine.setConfig('access.owner_member', owner);
  else await engine.executeRaw("DELETE FROM config WHERE key = 'access.owner_member'");
}

const refusal = (engine: BrainEngine, args: string[]) => cli(engine, args).then(() => null, (e: any) => ({ code: e.code, reason: e.reason, message: e.message, suggestion: e.suggestion }));
const ruleIds = async (engine: BrainEngine) => (await cli(engine, ['rule', 'list'])).rules.map((r: { id: string }) => r.id).sort();

/** The three cases on one source: refusal (preview and --yes), the override, the owner named, and no owner set. */
async function ownerCases(engine: BrainEngine, after: (expected: string[]) => void | Promise<void>): Promise<void> {
  await members(engine, 'owner-example');
  for (const yes of [[], ['--yes']]) {
    expect(await refusal(engine, ['rule', 'add', '--prefix', 'team/', '--readers', 'alice-example,bob-example', ...yes])).toEqual({
      code: 'invalid_params', reason: 'readers_omit_owner',
      message: 'These readers leave out the brain owner "owner-example", so the owner\'s own keys could no longer read the pages under team/; nothing was written. Name the owner, or pass --allow-without-owner.',
      suggestion: 'Add the owner to the list (--readers alice-example,bob-example,owner-example), or pass --allow-without-owner if the owner should not read it. A group that holds the owner does not count.',
    });
  }
  expect(await refusal(engine, ['rule', 'add', '--slug', 'notes/one-example', '--readers', 'alice-example', '--yes'])).toMatchObject({ reason: 'readers_omit_owner', message: expect.stringContaining('read the page notes/one-example;') });
  expect(await ruleIds(engine)).toEqual([]);
  await after([]);

  expect((await cli(engine, ['rule', 'add', '--prefix', 'team/', '--readers', 'alice-example,owner-example', '--yes'])).state).toBe('applied');
  expect((await cli(engine, ['rule', 'add', '--prefix', 'alice/', '--readers', 'alice-example', '--allow-without-owner', '--yes'])).state).toBe('applied');
  expect(await ruleIds(engine)).toEqual(['alice', 'team']);

  await members(engine, null);
  expect((await cli(engine, ['rule', 'add', '--prefix', 'bob/', '--readers', 'bob-example', '--yes'])).state).toBe('applied');
  expect(await ruleIds(engine)).toEqual(['alice', 'bob', 'team']);
  await after(['alice', 'bob', 'team']);
}

for (const backend of testBackends()) {
  describe(`access rule add keeps the owner in the readers on a repo-less brain (${backend})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    beforeAll(async () => {
      if (backend === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { const pglite = new PGLiteEngine(); await pglite.connect({ engine: 'pglite' } as never); await pglite.initSchema(); engine = pglite; close = () => pglite.disconnect(); }
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
    }, 180_000);
    afterAll(async () => { await close?.(); });

    test('refuses a list without the owner, accepts it with --allow-without-owner, and a brain with no owner is unchanged (database store)', async () => {
      await ownerCases(engine, async () => {
        expect((await cli(engine, ['rule', 'status'])).store).toBe((await ruleIds(engine)).length ? 'database' : null);
      });
    }, 120_000);
  });

  describe(`access rule add keeps the owner in the readers on a git source (${backend})`, () => {
    const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
    const setup = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), 'archive/\n'); durableGitRepo(root, ['.gitignore']); };

    test('refuses a list without the owner before access.yml is written, and the override and no-owner rules land in it', () => managedBrain(async ({ engine, root }) => {
      const file = join(root, '.gbrain', 'access.yml');
      await ownerCases(engine, ids => {
        if (!ids.length) return void expect(existsSync(file)).toBe(false);
        const text = readFileSync(file, 'utf8');
        for (const id of ids) expect(text).toContain(`id: ${id}`);
      });
    }, { databaseUrl, setup }), 240_000);
  });
}
