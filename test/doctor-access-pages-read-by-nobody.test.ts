/**
 * GBRA-582 item 9 (leaver handover, PR 2): the access_pages_read_by_nobody doctor check.
 *
 * 1. Protects: doctor finds pages no enabled member reads remotely: a disabled member's own page (9a), a page naming
 *    only a group whose members are all off (9b), and a page written before its folder's rule named other readers
 *    (9c). It names the handover command when the pages name a disabled member and changes nothing.
 * 2. Fails when: such a page reads as ok, a shared page or a member page is flagged, or the check writes.
 * 3. Existing coverage: access-read-by-nobody-gbra593 pins the messages of who-can-read, disable and rule add.
 * 4. Real seams: the doctor entry on PGLite and Postgres.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { DoctorContext } from '../src/commands/doctor/context.ts';
import { accessPagesReadByNobodyEntry } from '../src/commands/doctor/checks/access-pages-read-by-nobody.ts';
import { categorizeCheck } from '../src/core/doctor-categories.ts';
import { runAccess } from '../src/commands/access.ts';
import { addMember, disableMember } from '../src/core/access/members.ts';
import { addFolderRules } from '../src/commands/access-rules.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { isolatedPersistencePostgres } from './helpers/persistence-postgres.ts';
import { testBackends } from './helpers/test-backends.ts';
import { spyOn } from 'bun:test';

type Result = { name: string; status: string; message: string; details?: { count: number; sample: string[] }; fix?: { argv?: string[] } };
const run = async (engine: BrainEngine) => (await accessPagesReadByNobodyEntry.run({ engine } as unknown as DoctorContext) as Result[])[0]!;
const page = (engine: BrainEngine, slug: string, readers?: string[]) => importFromContent(engine, slug,
  '---\ntype: note\ntitle: ' + slug + '\n' + (readers ? 'readable_by: [' + readers.join(', ') + ']\n' : '') + '---\nSynthetic notes.\n', { sourceId: 'default' });

async function quiet(engine: BrainEngine, args: string[]) {
  const spy = spyOn(console, 'log').mockImplementation(() => undefined);
  try { await runAccess(engine, args); } finally { spy.mockRestore(); }
}

async function cases(engine: BrainEngine): Promise<void> {
  expect(categorizeCheck('access_pages_read_by_nobody')).not.toBe('unknown');
  expect((await run(engine)).message).toContain('Not applicable');
  for (const id of ['owner-example', 'alice-example', 'bob-example', 'dave-example']) await addMember(engine, id);
  await engine.setConfig('access.owner_member', 'owner-example');
  await quiet(engine, ['group', 'add', 'team-a', '--members', 'bob-example']);
  await page(engine, 'notes/bob-private-example', ['bob-example']);
  await page(engine, 'notes/team-a-example', ['group:team-a']);
  await page(engine, 'calls/sync-example', ['bob-example', 'alice-example']);
  await page(engine, 'memory/members/bob-example', ['bob-example']);
  await page(engine, 'people/dave-example/onboarding', ['alice-example']);
  await page(engine, 'open/handbook-example');
  expect((await run(engine)).status).toBe('ok');

  await disableMember(engine, 'bob-example');
  await addFolderRules(engine, 'default', [{ id: 'dave', prefix: 'people/dave-example/', readable_by: ['member:dave-example', 'member:owner-example'] } as never], { apply: true, json: true });
  const before = await engine.executeRaw('SELECT slug, frontmatter FROM pages ORDER BY slug');
  const check = await run(engine);
  expect(check.status).toBe('warn');
  expect(check.details!.sample).toEqual(['default:notes/bob-private-example', 'default:notes/team-a-example', 'default:people/dave-example/onboarding']);
  expect(check.message).toContain('gbrain access member handover bob-example');
  expect(check.fix!.argv).toEqual(['gbrain', 'access', 'member', 'handover', 'bob-example']);
  expect(await engine.executeRaw('SELECT slug, frontmatter FROM pages ORDER BY slug')).toEqual(before);
}

for (const backend of testBackends()) {
  describe('access_pages_read_by_nobody (' + backend + ')', () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    beforeAll(async () => {
      if (backend === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { const pglite = new PGLiteEngine(); await pglite.connect({ engine: 'pglite' } as never); await pglite.initSchema(); engine = pglite; close = () => pglite.disconnect(); }
    }, 120_000);
    afterAll(async () => { await close?.(); });
    test('finds the pages no enabled member reads and names the handover', () => cases(engine), 120_000);
  });
}
