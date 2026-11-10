/**
 * #8740: gbrain access who-can-read accounts for folder rules.
 *
 * 1. Protects: who-can-read names the members the remote read path admits for a page a folder rule covers, instead
 *    of reporting it readable by every caller entitled to the source.
 * 2. Fails when: who-can-read derives its answer from readable_by alone, so a page restricted only by a folder rule
 *    prints "not restricted" while remote reads enforce the rule.
 * 3. Existing coverage: access-members pins readable_by pages; access-folder-rules pins the read path.
 * 4. Real seams: PGLite, real members, groups and an applied folder rule; repo-less brain.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { whoCanRead } from '../src/commands/access.ts';
import { addGroup, addMember } from '../src/core/access/members.ts';
import { proposeRevision } from '../src/core/access/policy.ts';

const SRC = 'source-a';
let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite' } as never);
  await engine.initSchema();
  await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1)', [SRC]);
  for (const id of ['alice-example', 'bob-example', 'carol-example']) await addMember(engine, id);
  await addGroup(engine, 'team-b', ['bob-example']);
  const result = await proposeRevision(engine, SRC, [{ id: 'team-b-only', prefix: 'team-b/', readable_by: ['group:team-b', 'member:carol-example'] }], { origin: 'cli' });
  expect(result.state).toBe('applied');
  await engine.putPage('team-b/profile', { type: 'note', title: 'Team B profile', compiled_truth: 'Team notes.' }, { sourceId: SRC });
  await engine.putPage('team-b/alice-note', { type: 'note', title: 'Alice note', compiled_truth: 'Notes.', frontmatter: { readable_by: ['alice-example', 'bob-example'] } }, { sourceId: SRC });
  await engine.putPage('open/profile', { type: 'note', title: 'Open profile', compiled_truth: 'Open notes.' }, { sourceId: SRC });
}, 60_000);

afterAll(async () => { await engine.disconnect(); });

describe('#8740 who-can-read and folder rules', () => {
  test('a page covered only by a folder rule lists the members the rule admits', async () => {
    const [entry] = await whoCanRead(engine, 'team-b/profile', SRC);
    expect(entry.members).toEqual(['bob-example', 'carol-example']);
  });

  test('readable_by and a folder rule must both pass', async () => {
    const [entry] = await whoCanRead(engine, 'team-b/alice-note', SRC);
    expect(entry.members).toEqual(['bob-example']);
  });

  test('a page under no rule and no readers stays open to every source reader', async () => {
    const [entry] = await whoCanRead(engine, 'open/profile', SRC);
    expect(entry.members).toBe('every_source_reader');
  });
});
