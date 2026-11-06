/**
 * 1. Protects: `gbrain access who-can-read` accounts for the folder rules covering a page,
 *    as remote reads do, instead of reporting a rule-covered page as unrestricted.
 * 2. Fails when: a page with no readable_by under a folder rule lists every source reader
 *    or members outside the rule's readers.
 * 3. Existing coverage: test/access-members.test.ts (readable_by only).
 */
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { addGroup, addMember } from '../src/core/access/members.ts';
import { runAccessRules } from '../src/commands/access-rules.ts';
import { whoCanRead } from '../src/commands/access.ts';

const SRC = 'wcr-team';

describe('who-can-read with folder rules', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite' } as never);
    await engine.initSchema();
    await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [SRC]);
    await addMember(engine, 'owner');
    await addMember(engine, 'alice-example');
    await addMember(engine, 'bob-example');
    await addGroup(engine, 'b', ['bob-example']);
    await importFromContent(engine, 'team-b/profile', '---\ntype: note\ntitle: Profile\n---\nBody.', { sourceId: SRC });
    await importFromContent(engine, 'open/page', '---\ntype: note\ntitle: Open\n---\nBody.', { sourceId: SRC });
    const spy = spyOn(console, 'log').mockImplementation(() => {});
    try { await runAccessRules(engine, 'rule', ['add', '--source', SRC, '--prefix', 'team-b/', '--readers', 'group:b,owner', '--yes', '--json'], true); } finally { spy.mockRestore(); }
  }, 120_000);

  afterAll(async () => { await engine.disconnect(); }, 60_000);

  test('a page under a folder rule admits only the rule readers', async () => {
    const [page] = await whoCanRead(engine, 'team-b/profile', SRC);
    expect(page!.members).toEqual(['bob-example', 'owner']);
    expect(page!.note).toContain(`${SRC}:`);
    expect((await whoCanRead(engine, 'open/page', SRC))[0]!.members).toBe('every_source_reader');
  });
});
