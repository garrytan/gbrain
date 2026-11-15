/**
 * GST-2128 item 1: since GST-2698 (#9371), `gbrain access rule add` refuses a reader list that leaves out the brain owner
 * unless --allow-without-owner. Every hint that prints a rule-add command for a named member must print one that command
 * accepts.
 *
 * 1. Protects: with an owner set, the doctor check unlabeled_people_folders, the labelled-only create refusal's host fix
 *    (access_labelled_only_unnamed), the serves receipt's clash line and the federation exposure's restrict command each
 *    print readers that include the owner, and pasting the printed command previews without readers_omit_owner; with no
 *    owner set each prints the member alone, as before.
 * 2. Fails when: a hint prints a list without the owner on a brain that has one, or adds an owner where none is set.
 * 3. Real seams: the doctor entry, assertLabelledOnlyCreate, labelSeveral and remotePagesFederationExposes on a
 *    repo-less source, then the gbrain access rule CLI module on the printed argv, PGLite and Postgres.
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runAccessRules } from '../src/commands/access-rules.ts';
import { labelSeveral } from '../src/commands/access-serves.ts';
import { unlabeledPeopleFoldersEntry } from '../src/commands/doctor/checks/unlabeled-people-folders.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import { assertLabelledOnlyCreate } from '../src/core/persistence/page-visibility.ts';
import type { WriteAuthority } from '../src/core/persistence/model.ts';
import { setMemberLabelledOnly } from '../src/core/access/labelled-only.ts';
import { remotePagesFederationExposes } from '../src/core/access/federation-exposure.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { __resetPrivateVisibilityCacheForTests } from '../src/core/search/private-visibility.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const OWNER = 'owner-example';

async function preview(engine: BrainEngine, argv: string[]): Promise<{ reason?: string } | null> {
  expect(argv.slice(0, 4)).toEqual(['gbrain', 'access', 'rule', 'add']);
  const spy = spyOn(console, 'log').mockImplementation(() => {});
  try { await runAccessRules(engine, 'rule', [...argv.slice(3), '--json'], true); return null; }
  catch (e: any) { return { reason: e.reason ?? e.code }; }
  finally { spy.mockRestore(); }
}

const readers = (argv: string[]) => argv[argv.indexOf('--readers') + 1];

for (const backend of testBackends()) {
  describe(`printed rule-add hints keep the owner (${backend}, repo-less)`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    let home: string;
    let tokenId: string;
    beforeAll(async () => {
      if (backend === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { const pglite = new PGLiteEngine(); await pglite.connect({ engine: 'pglite' } as never); await pglite.initSchema(); engine = pglite; close = () => pglite.disconnect(); }
      await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
      home = mkdtempSync(join(tmpdir(), 'gbrain-hints-'));
      for (const id of [OWNER, 'alice-example', 'bob-example', 'bot-example']) await engine.executeRaw('INSERT INTO access_members (id) VALUES ($1) ON CONFLICT DO NOTHING', [id]);
      await setMemberLabelledOnly(engine, 'bot-example', true, { remote: false });
      await engine.setConfig('access.serves', 'several');
      for (const slug of ['people/alice-example/note-one', 'notes/federated-one']) await importFromContent(engine, slug, `---\ntitle: ${slug}\n---\nA synthetic note.\n`, { sourceId: 'default', noEmbed: true });
      [{ id: tokenId }] = await engine.executeRaw<{ id: string }>("INSERT INTO access_tokens (name, token_hash, scopes, member_id) VALUES ('alice-key', 'hash-alice-example', ARRAY['read','write']::text[], 'alice-example') RETURNING id::text AS id");
      await engine.executeRaw('INSERT INTO access_tokens (name, token_hash, scopes, member_id) VALUES ($1, $2, ARRAY[\'read\',\'write\']::text[], $3)', ['bot-key', 'hash-bot-example', 'bot-example']);
      await engine.transaction(async tx => {
        await tx.executeRaw("SELECT set_config('gbrain.write_principal_kind', 'legacy_token', true), set_config('gbrain.write_principal_id', $1, true)", [tokenId]);
        await tx.executeRaw("UPDATE pages SET title = 'Federated one' WHERE slug = 'notes/federated-one'");
      });
      __resetPrivateVisibilityCacheForTests();
    }, 180_000);
    afterAll(async () => { await close?.(); rmSync(home, { recursive: true, force: true }); });

    const hints = async (): Promise<Record<string, string[]>> => {
      const doctor = (await unlabeledPeopleFoldersEntry.run({ engine } as unknown as DoctorContext) as Array<Record<string, any>>)[0]!;
      const [{ id: botToken }] = await engine.executeRaw<{ id: string }>("SELECT id::text AS id FROM access_tokens WHERE name = 'bot-key'");
      const authority = { version: 1, principal: { kind: 'legacy_token', id: botToken }, remote: true, excludePrivate: true, sourceId: 'default',
        sourceIncarnation: 'unused', scopes: ['read', 'write'], operations: null, slugPrefixes: null } as unknown as WriteAuthority;
      const unnamed = await assertLabelledOnlyCreate(engine, authority, 'notes/new-example', null, {}).then(() => null, (e: any) => e);
      expect(unnamed?.code).toBe('access_labelled_only_unnamed');
      const exposed = await remotePagesFederationExposes(engine, 'default');
      return { doctor: doctor.fix.argv, labelled_only: unnamed.fix.argv, federation: exposed!.restrict.split(' ') };
    };

    test('with an owner set each hint names the owner and its command previews; with none each names the member alone', async () => {
      await engine.executeRaw("DELETE FROM config WHERE key = 'access.owner_member'");
      const before = await hints();
      expect(Object.fromEntries(Object.entries(before).map(([k, v]) => [k, readers(v)])))
        .toEqual({ doctor: 'alice-example', labelled_only: 'bot-example', federation: 'alice-example' });

      await engine.setConfig('access.owner_member', OWNER);
      const after = await hints();
      expect(Object.fromEntries(Object.entries(after).map(([k, v]) => [k, readers(v)])))
        .toEqual({ doctor: `alice-example,${OWNER}`, labelled_only: `bot-example,${OWNER}`, federation: `alice-example,${OWNER}` });
      for (const argv of Object.values(after)) expect(await preview(engine, argv)).toBeNull();
      for (const argv of Object.values(before)) expect(await preview(engine, argv)).toEqual({ reason: 'readers_omit_owner' });
    }, 120_000);

    test('the serves receipt line for a clashing people/ rule prints a command that previews with an owner set', async () => {
      await engine.setConfig('access.owner_member', OWNER);
      const spy = spyOn(console, 'log').mockImplementation(() => {});
      try { await runAccessRules(engine, 'rule', ['add', '--prefix', 'people/alice-example/', '--readers', `bob-example,${OWNER}`, '--yes', '--json'], true); } finally { spy.mockRestore(); }
      const receipt = await withEnv({ GBRAIN_HOME: home }, () => labelSeveral(engine, ['alice-example'], 'default', false, true));
      const detail = receipt.rules.find(r => r.prefix === 'people/alice-example/')!.detail!;
      const argv = detail.slice(detail.indexOf('gbrain access rule add')).split(' ');
      expect(readers(argv)).toBe(`alice-example,${OWNER}`);
      expect(await preview(engine, argv)).toBeNull();
      const quiet = spyOn(console, 'log').mockImplementation(() => {});
      try { await runAccessRules(engine, 'rule', [...argv.slice(3), '--yes', '--json'], true); } finally { quiet.mockRestore(); }
      const again = await withEnv({ GBRAIN_HOME: home }, () => labelSeveral(engine, ['alice-example'], 'default', false, true));
      expect(again.rules.find(r => r.prefix === 'people/alice-example/')!.action).toBe('keep');
    }, 120_000);
  });
}
