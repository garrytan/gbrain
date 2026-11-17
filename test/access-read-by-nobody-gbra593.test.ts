/**
 * GBRA-582 item 9 (leaver handover, PR 1): the access commands say when a page is left readable by no member.
 *
 * 1. Protects: `gbrain access who-can-read` explains a page no enabled member reads remotely (its readers name only a
 *    disabled member, or its readable_by and a folder rule admit nobody in common) and names the label write that gives
 *    it back; `gbrain access member disable` counts and samples the pages it leaves readable by no member;
 *    `gbrain access rule add` previews the pages a new rule leaves readable by no member. Every one is a message: no
 *    page, rule or label changes, and the owner's reads are the same before and after.
 * 2. Fails when: who-can-read prints "none" with no reason, member disable says nothing about the pages it strands, or
 *    a rule preview over a pre-written page (audit case 9c) shows no warning.
 * 3. Existing coverage: access-who-can-read-folder-rules pins the member list; access-members pins disable itself.
 * 4. Real seams: the access CLI module on PGLite and Postgres, repo-less (database store) and on a managed git source.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runAccess, whoCanRead } from '../src/commands/access.ts';
import { addMember } from '../src/core/access/members.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { operationsByName } from '../src/core/operations.ts';
import { durableGitRepo } from './helpers/git-publication.ts';
import { managedBrain } from './helpers/managed-brain.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';

async function access(engine: BrainEngine, args: string[]): Promise<string> {
  const lines: string[] = [];
  const spy = spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')); });
  try { await runAccess(engine, args); } finally { spy.mockRestore(); }
  return lines.join('\n');
}

/** Every page's slug, readers and folder rules: what the owner's reads depend on. */
const pageState = (engine: BrainEngine, src: string) => engine.executeRaw<{ slug: string; readers: unknown; rules: unknown }>(
  `SELECT slug, frontmatter->'readable_by' AS readers, folder_rule_ids AS rules FROM pages WHERE source_id = $1 ORDER BY slug`, [src]);

/** Pages whose who-can-read list names the owner (or every source reader). */
async function ownerReads(engine: BrainEngine, src: string): Promise<string[]> {
  const out: string[] = [];
  for (const { slug } of await pageState(engine, src)) {
    const [entry] = await whoCanRead(engine, slug, src);
    if (entry!.members === 'every_source_reader' || entry!.members.includes('owner-example')) out.push(slug);
  }
  return out;
}

type Write = (slug: string, content: string) => Promise<unknown>;

async function fixture(engine: BrainEngine, src: string, write: Write = (slug, content) => importFromContent(engine, slug, content, { sourceId: src })): Promise<void> {
  if (src !== 'default') await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT DO NOTHING', [src]);
  for (const id of ['owner-example', 'alice-example', 'bob-example', 'carol-example', 'dave-example']) await addMember(engine, id);
  await engine.setConfig('access.owner_member', 'owner-example');
  const page = (slug: string, readable_by?: string[]) => write(slug,
    `---\ntype: note\ntitle: ${slug}\n${readable_by ? `readable_by: [${readable_by.join(', ')}]\n` : ''}---\nSynthetic notes.\n`);
  await page('companies/acme-example', ['bob-example']);
  await page('notes/bob-billing-example', ['bob-example']);
  await page('notes/alice-pricing-example', ['bob-example', 'alice-example']);
  await page('notes/owner-plan-example', ['bob-example', 'owner-example']);
  await page('people/dave-example/onboarding', ['carol-example']);
  await page('open/handbook-example');
}

async function cases(engine: BrainEngine, src: string): Promise<void> {
  const ownerBefore = await ownerReads(engine, src);
  const stateBefore = await pageState(engine, src);
  expect(ownerBefore).toEqual(['notes/owner-plan-example', 'open/handbook-example']);

  const [before] = await whoCanRead(engine, 'companies/acme-example', src);
  expect(before!.members).toEqual(['bob-example']);
  expect(before!.note).not.toContain('No enabled member reads it');

  const disabled = await access(engine, ['member', 'disable', 'bob-example']);
  expect(disabled).toContain('Member disabled: bob-example');
  expect(disabled).toContain('Pages naming it that no enabled member reads remotely now (2): ' + src + ':companies/acme-example, ' + src + ':notes/bob-billing-example.');
  expect(disabled).not.toContain('alice-pricing-example');
  expect(disabled).not.toContain('owner-plan-example');
  expect(disabled).toContain('gbrain repair visibility --slug companies/acme-example --readers <member>,owner-example');
  const disabledJson = JSON.parse(await access(engine, ['member', 'disable', 'bob-example', '--json']));
  expect(Object.keys(disabledJson)).toEqual(['member']);

  const [after] = await whoCanRead(engine, 'companies/acme-example', src);
  expect(after!.members).toEqual([]);
  expect(after!.note).toContain('No enabled member reads it remotely: its readable_by names bob-example, which is disabled, removed or unknown.');
  expect(after!.note).toContain('gbrain repair visibility --slug companies/acme-example --readers <member>,owner-example');
  const text = await access(engine, ['who-can-read', 'companies/acme-example', '--source', src]);
  expect(text).toContain('Members who may read it: none');
  expect(text).toContain('No enabled member reads it remotely');
  const [shared] = await whoCanRead(engine, 'notes/alice-pricing-example', src);
  expect(shared!.members).toEqual(['alice-example']);
  expect(shared!.note).not.toContain('No enabled member reads it');

  const preview = await access(engine, ['rule', 'add', '--prefix', 'people/dave-example/', '--readers', 'dave-example,owner-example', '--source', src]);
  expect(preview).toContain('Pages this change leaves readable by no member remotely (1): people/dave-example/onboarding.');
  expect(preview).toContain('gbrain repair visibility --slug people/dave-example/onboarding --readers dave-example,owner-example');
  expect(preview.trimEnd().split('\n').at(-1)).toStartWith('Nothing written. To approve');
  const open = await access(engine, ['rule', 'add', '--prefix', 'open/', '--readers', 'alice-example,owner-example', '--source', src]);
  expect(open).not.toContain('readable by no member');

  expect(await pageState(engine, src)).toEqual(stateBefore);
  expect(await ownerReads(engine, src)).toEqual(ownerBefore);
}

for (const backend of testBackends()) {
  describe(`read-by-nobody messages on a repo-less brain (${backend})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    beforeAll(async () => {
      if (backend === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { const pglite = new PGLiteEngine(); await pglite.connect({ engine: 'pglite' } as never); await pglite.initSchema(); engine = pglite; close = () => pglite.disconnect(); }
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      await fixture(engine, 'source-a');
    }, 180_000);
    afterAll(async () => { await close?.(); });

    test('who-can-read, member disable and rule add name the pages no member reads, and change nothing', () => cases(engine, 'source-a'), 120_000);
  });

  describe(`read-by-nobody rule preview on a git source (${backend})`, () => {
    const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
    const setup = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), 'archive/\n'); durableGitRepo(root, ['.gitignore']); };

    test('the rule preview warns about the pre-written page and writes no access.yml', () => managedBrain(async ({ engine, ctx, root }) => {
      await fixture(engine, 'default', async (slug, content) => {
        expect(await operationsByName.put_page!.handler(ctx, { slug, content, request_id: randomUUID(), wait_ms: 30_000 })).toMatchObject({ state: 'committed' });
      });
      const preview = await access(engine, ['rule', 'add', '--prefix', 'people/dave-example/', '--readers', 'dave-example,owner-example']);
      expect(preview).toContain('Pages this change leaves readable by no member remotely (1): people/dave-example/onboarding.');
      expect(existsSync(join(root, '.gbrain', 'access.yml'))).toBe(false);
    }, { databaseUrl, setup }), 240_000);
  });
}
