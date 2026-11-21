/**
 * pages-03: frontmatter values are kept exactly as the user wrote them.
 *
 * 1. Protects: a date (`born: 1990-05-01`), an offset timestamp (`2024-03-01T10:00:00+02:00`), a zip code with a
 *    leading zero (`02134`) and a version (`1.10`) are stored and read back by get/export as written, and written back to
 *    the user's file as the same values (quoted where another YAML reader would type the plain text), also after an agent
 *    edits one word of the body. A page stored before this fix (the old typing in
 *    the database, the user's text in the file) is not reported as a local edit, and its first write puts the user's
 *    values back: a value the caller changed in that write keeps the caller's value. Readers of those values (effective date, valid time, core priority, pack subtypes, chronicle dates)
 *    read the kept text as they read the old typed value.
 * 2. Fails when: the YAML parser types timestamps or numbers whose text does not print back the same, the dump changes
 *    a kept value, or a reader treats the kept text differently from the old value.
 * 3. Runs on PGLite (the managed-brain fixture). No embedding, no model calls.
 */
import { describe, expect, test } from 'bun:test';
import { DEFAULT_SCHEMA, dump, load } from 'js-yaml';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dumpFrontmatterYaml, parseDataFrontmatter } from '../src/core/data-frontmatter.ts';
import { parseMarkdown, serializePageToMarkdown } from '../src/core/markdown.ts';
import { computeEffectiveDate, parseDateLoose } from '../src/core/effective-date.ts';
import { validDate } from '../src/core/valid-time.ts';
import { corePriority } from '../src/core/core-memory.ts';
import { legacyTypedFrontmatter } from '../src/core/frontmatter-legacy.ts';
import { endedInviteProposal } from '../src/core/chronicle/invite-projection.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { performManagedSync } from '../src/core/persistence/sync-run.ts';
import { operationsByName } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { managedBrain, settleManagedGitEffects } from './helpers/managed-brain.ts';
import { durableGitRepo } from './helpers/git-publication.ts';
import { withManagedFixtureWrite } from './helpers/managed-e2e-fixture-write.ts';
import { frontmatterIdentity } from '../src/core/sync-rename-identity.ts';

const BLOCK = [
  'company: acme-example',
  'born: 1990-05-01',
  'last_met: 2024-03-01T10:00:00+02:00',
  'naive: 2024-03-01 10:00:00',
  'zip: 02134',
  'version: 1.10',
  'one: 1.0',
  'big: 12345678901234567890',
  'count: 42',
  'ratio: 0.5',
  'flag: true',
  'details:',
  '  role: cto',
  '  since: 2020-01-01',
];
/** BLOCK as gbrain writes it back: a string any YAML reader would type is quoted, so every reader gets the same value. */
const WRITTEN_BACK = [
  'company: acme-example',
  "born: '1990-05-01'",
  "last_met: '2024-03-01T10:00:00+02:00'",
  "naive: '2024-03-01 10:00:00'",
  "zip: '02134'",
  "version: '1.10'",
  "one: '1.0'",
  "big: '12345678901234567890'",
  'count: 42',
  'ratio: 0.5',
  'flag: true',
  'details:',
  '  role: cto',
  "  since: '2020-01-01'",
];
const FILE = `---\ntitle: Hal Example\ntype: person\n${BLOCK.join('\n')}\n---\n# Hal Example\n\nHal likes tea.\n`;
const AS_WRITTEN = {
  company: 'acme-example', born: '1990-05-01', last_met: '2024-03-01T10:00:00+02:00', naive: '2024-03-01 10:00:00',
  zip: '02134', version: '1.10', one: '1.0', big: '12345678901234567890', count: 42, ratio: 0.5, flag: true,
  details: { role: 'cto', since: '2020-01-01' },
};

describe('pages-03: frontmatter values as written', () => {
  test('the parser keeps timestamps and numbers whose text does not print back the same as the written text', () => {
    expect(parseDataFrontmatter(FILE).data).toEqual({ title: 'Hal Example', type: 'person', ...AS_WRITTEN });
    // Each value dumps back as the same value; a string another YAML reader would type is quoted.
    const dumped = dumpFrontmatterYaml(AS_WRITTEN).trimEnd().split('\n');
    expect(dumped).toEqual(WRITTEN_BACK);
    expect(parseDataFrontmatter(`---\n${dumped.join('\n')}\n---\n`).data).toEqual(AS_WRITTEN);
    // js-yaml's default schema (an older gbrain, most YAML tools) reads the written-back file as the same strings.
    expect(load(dumped.join('\n'), { schema: DEFAULT_SCHEMA })).toEqual(AS_WRITTEN);
    // A string that reads as another type is still quoted, so it reads back as the same string.
    const strings = { a: '2134', b: 'true', c: 'null', d: '1e+21' };
    expect(parseDataFrontmatter(`---\n${dumpFrontmatterYaml(strings)}---\n`).data).toEqual(strings);
    // A Date a write site puts in frontmatter renders as its ISO text.
    expect(dumpFrontmatterYaml({ at: new Date(Date.UTC(2024, 0, 2)) })).toBe('at: 2024-01-02T00:00:00.000Z\n');
  });

  test('the old typing is what pages stored before this fix hold', () => {
    expect(legacyTypedFrontmatter(FILE)).toMatchObject({
      born: '1990-05-01T00:00:00.000Z', last_met: '2024-03-01T08:00:00.000Z', zip: 2134, version: 1.1, one: 1,
      details: { since: '2020-01-01T00:00:00.000Z' },
    });
  });

  test('readers read the kept text as they read the old typed value', () => {
    expect(parseDateLoose('2024-03-01T10:00:00+02:00')?.toISOString()).toBe('2024-03-01T08:00:00.000Z');
    expect(parseDateLoose('2001-12-14 21:59:43.10 -5')?.toISOString()).toBe('2001-12-15T02:59:43.100Z');
    expect(parseDateLoose('2024-03-01 10:00:00')?.toISOString()).toBe('2024-03-01T10:00:00.000Z');
    // `published: 1.10` was the number 1.1 (not a date), never Date.parse's 2001-01-10.
    expect(computeEffectiveDate({ slug: 'notes/x', frontmatter: { published: '1.10' }, updatedAt: new Date(Date.UTC(2025, 0, 1)), createdAt: new Date(Date.UTC(2025, 0, 1)) } as never).source).not.toBe('published');
    expect(validDate('2024-03-01 00:00:00')).toBe('2024-03-01');
    expect(validDate('2024-03-01T00:00:00')).toBe('2024-03-01');
    expect(validDate('2024-03-01T10:00:00')).toBeNull();
    expect(corePriority({ core_priority: '1.0' })).toBe(1);
    expect(corePriority({ core_priority: '007' })).toBe(7);
    const invite = endedInviteProposal({ slug: 'calendar/x', type: 'calendar-event', title: 'Sync',
      frontmatter: { start: '2024-03-01 10:00:00', end: '2024-03-01 11:00:00' } }, [], new Date(Date.UTC(2024, 2, 1, 11, 30)));
    expect(invite).not.toBeNull();
  });

  test('an export written before this fix re-imports with the same values, and exports again with the same values', () => {
    // What an older gbrain exported for FILE: the old typing, dumped by js-yaml's default schema.
    const stored = legacyTypedFrontmatter(FILE)!;
    const oldExport = `---\ntype: person\ntitle: Hal Example\n${dump(stored, { schema: DEFAULT_SCHEMA })}---\n# Hal Example\n\nHal likes tea.\n`;
    expect(oldExport).toContain("born: '1990-05-01T00:00:00.000Z'");
    expect(oldExport).toContain('zip: 2134');
    const reimported = parseMarkdown(oldExport).frontmatter;
    expect(reimported).toEqual(stored);
    const page = { id: 1, slug: 'people/hal-example', source_id: 'default', type: 'person', title: 'Hal Example', compiled_truth: '# Hal Example\n\nHal likes tea.', timeline: '', frontmatter: reimported } as never;
    expect(parseMarkdown(serializePageToMarkdown(page, [])).frontmatter).toEqual(stored);
  });

  const call = (ctx: OperationContext, name: string, params: Record<string, unknown>) =>
    operationsByName[name]!.handler(ctx, { request_id: randomUUID(), wait_ms: 30_000, ...params }) as Promise<Record<string, any>>;
  const setup = ({ root }: { root: string }) => { writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore']); };
  /** The user's file committed, imported by sync, and the database then holding what an older gbrain stored for it. */
  const userFileSetup = ({ root }: { root: string }) => {
    mkdirSync(join(root, 'people'), { recursive: true }); writeFileSync(join(root, 'people/hal-example.md'), FILE);
    writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore', 'people/hal-example.md']);
  };
  const importedUnderOldTyping = async (engine: BrainEngine) => {
    expect((await performManagedSync(engine, { sourceId: 'default', noPull: true })).status).toBe('first_sync');
    const stored = (await engine.getPage('people/hal-example'))!.frontmatter;
    const legacy = legacyTypedFrontmatter(FILE)!;
    const old = { ...stored, ...Object.fromEntries(Object.entries(legacy).filter(([k]) => k in AS_WRITTEN)) };
    await withManagedFixtureWrite(engine, ['default'], tx => tx.executeRaw("UPDATE pages SET frontmatter=$1::text::jsonb WHERE slug='people/hal-example'", [JSON.stringify(old)]));
  };
  const parseMarkdownHeadText = (file: string) => file.split('\n---\n')[0]!.replace(/^---\n/, '');
  const valueLines = (text: string) => WRITTEN_BACK.filter(line => text.split('\n').includes(line));

  test('put, get, export and a one-word edit keep the written values in the database and the file', () => managedBrain(async ({ engine, ctx, root }) => {
    await call(ctx, 'put_page', { slug: 'people/hal-example', content: FILE });
    await settleManagedGitEffects(engine);
    const page = (await engine.getPage('people/hal-example'))!;
    expect(page.frontmatter).toMatchObject(AS_WRITTEN);
    expect(valueLines(serializePageToMarkdown(page, []))).toEqual(WRITTEN_BACK);
    expect(valueLines(readFileSync(join(root, 'people/hal-example.md'), 'utf8'))).toEqual(WRITTEN_BACK);
    const rev = (await engine.readPageSnapshot('people/hal-example', { sourceId: 'default' }))!.revision;
    await call(ctx, 'edit_page', { slug: 'people/hal-example', expected_revision: rev, edits: [{ old_text: 'likes tea', new_text: 'likes coffee' }] });
    await settleManagedGitEffects(engine);
    const file = readFileSync(join(root, 'people/hal-example.md'), 'utf8');
    expect(file).toContain('Hal likes coffee.');
    expect(valueLines(file)).toEqual(WRITTEN_BACK);
    expect((await engine.getPage('people/hal-example'))!.frontmatter).toMatchObject(AS_WRITTEN);
  }, { setup }), 120_000);

  test('values the author quoted keep their quotes through put and edit, so every YAML reader gets the same string', () => managedBrain(async ({ engine, ctx, root }) => {
    const quoted = ["id: '001'", 'zip: "02134"', "ver: '1.10'", "hex: '0x1F'", "day: '2024-03-01'", "plus: '+1'", "half: '.5'", "exp: '1e3'"];
    const strings = { id: '001', zip: '02134', ver: '1.10', hex: '0x1F', day: '2024-03-01', plus: '+1', half: '.5', exp: '1e3' };
    await call(ctx, 'put_page', { slug: 'notes/quoted', content: `---\ntype: note\ntitle: Quoted\n${quoted.join('\n')}\n---\n# Quoted\n\nPlain words.\n` });
    await settleManagedGitEffects(engine);
    const rev = (await engine.readPageSnapshot('notes/quoted', { sourceId: 'default' }))!.revision;
    await call(ctx, 'edit_page', { slug: 'notes/quoted', expected_revision: rev, edits: [{ old_text: 'Plain words', new_text: 'Other words' }] });
    await settleManagedGitEffects(engine);
    const file = readFileSync(join(root, 'notes/quoted.md'), 'utf8');
    expect(file).toContain('Other words.');
    expect((await engine.getPage('notes/quoted'))!.frontmatter).toMatchObject(strings);
    for (const [key, value] of Object.entries(strings)) expect(file.split('\n')).toContain(`${key}: '${value}'`);
    expect(load(parseMarkdownHeadText(file), { schema: DEFAULT_SCHEMA })).toMatchObject(strings);
  }, { setup }), 120_000);

  test('a page stored under the old typing is not a local edit, and its first write puts the written values back', () => managedBrain(async ({ engine, ctx, root }) => {
    await importedUnderOldTyping(engine);
    expect((await engine.getPage('people/hal-example'))!.frontmatter).toMatchObject({ zip: 2134, version: 1.1 });
    const rev = (await engine.readPageSnapshot('people/hal-example', { sourceId: 'default' }))!.revision;
    await call(ctx, 'edit_page', { slug: 'people/hal-example', expected_revision: rev, edits: [{ old_text: 'likes tea', new_text: 'likes coffee' }] });
    await settleManagedGitEffects(engine);
    const file = readFileSync(join(root, 'people/hal-example.md'), 'utf8');
    expect(file).toContain('Hal likes coffee.');
    expect(valueLines(file)).toEqual(WRITTEN_BACK);
    expect((await engine.getPage('people/hal-example'))!.frontmatter).toMatchObject(AS_WRITTEN);
    expect(parseMarkdown(file).frontmatter).toMatchObject(AS_WRITTEN);
  }, { setup: userFileSetup }), 120_000);

  test('an unchanged put of an older page\'s values does not overwrite the written values in its file', () => managedBrain(async ({ engine, ctx, root }) => {
    await importedUnderOldTyping(engine);
    // The caller reads the page as an older gbrain renders it (the old typing) and puts it back unchanged.
    const read = serializePageToMarkdown((await engine.getPage('people/hal-example'))!, []);
    const rev = (await engine.readPageSnapshot('people/hal-example', { sourceId: 'default' }))!.revision;
    await call(ctx, 'put_page', { slug: 'people/hal-example', expected_revision: rev, content: read });
    await settleManagedGitEffects(engine);
    const file = readFileSync(join(root, 'people/hal-example.md'), 'utf8');
    expect(parseMarkdown(file).frontmatter).toMatchObject(AS_WRITTEN);
    expect((await engine.getPage('people/hal-example'))!.frontmatter).toMatchObject(AS_WRITTEN);
  }, { setup: userFileSetup }), 120_000);

  test('an older database-only page never takes values from a file at its slug path', () => managedBrain(async ({ engine, ctx }) => {
    await importedUnderOldTyping(engine);
    // The page is database-only (written while its source was unbound); the file at its slug path is not its file.
    await withManagedFixtureWrite(engine, ['default'], tx => tx.executeRaw(
      "UPDATE pages SET source_path=NULL, source_uri=NULL, database_only_reason='unbound_source' WHERE slug='people/hal-example'"));
    const rev = (await engine.readPageSnapshot('people/hal-example', { sourceId: 'default' }))!.revision;
    await call(ctx, 'edit_page', { slug: 'people/hal-example', expected_revision: rev, edits: [{ old_text: 'likes tea', new_text: 'likes coffee' }] });
    const page = (await engine.getPage('people/hal-example'))!;
    expect(page.compiled_truth).toContain('likes coffee');
    expect(page.frontmatter).toMatchObject({ zip: 2134, version: 1.1 });
  }, { setup: userFileSetup }), 120_000);

  test('on an older page\'s first write, a nested value the caller changed keeps the new value and its untouched siblings get their written text back', () => managedBrain(async ({ engine, ctx, root }) => {
    await importedUnderOldTyping(engine);
    const read = serializePageToMarkdown((await engine.getPage('people/hal-example'))!, []);
    expect(read).toContain('role: cto');
    const rev = (await engine.readPageSnapshot('people/hal-example', { sourceId: 'default' }))!.revision;
    await call(ctx, 'put_page', { slug: 'people/hal-example', expected_revision: rev, content: read.replace('role: cto', 'role: ceo') });
    await settleManagedGitEffects(engine);
    const expected = { ...AS_WRITTEN, details: { role: 'ceo', since: '2020-01-01' } };
    expect((await engine.getPage('people/hal-example'))!.frontmatter).toMatchObject(expected);
    expect(parseMarkdown(readFileSync(join(root, 'people/hal-example.md'), 'utf8')).frontmatter).toMatchObject(expected);
  }, { setup: userFileSetup }), 120_000);

  test('on an older page\'s first write, a value the caller changed keeps the new value and the others get their written text back', () => managedBrain(async ({ engine, ctx, root }) => {
    await importedUnderOldTyping(engine);
    // The caller reads the page as an older gbrain renders it (the old typing) and changes two of those values.
    const read = serializePageToMarkdown((await engine.getPage('people/hal-example'))!, []);
    expect(read).toContain('zip: 2134');
    expect(read).toContain("born: '1990-05-01T00:00:00.000Z'");
    const sent = read.replace('zip: 2134', "zip: '02139'").replace("born: '1990-05-01T00:00:00.000Z'", 'born: 1991-06-02');
    const rev = (await engine.readPageSnapshot('people/hal-example', { sourceId: 'default' }))!.revision;
    await call(ctx, 'put_page', { slug: 'people/hal-example', expected_revision: rev, content: sent });
    await settleManagedGitEffects(engine);
    const expected = { ...AS_WRITTEN, zip: '02139', born: '1991-06-02' };
    expect((await engine.getPage('people/hal-example'))!.frontmatter).toMatchObject(expected);
    const file = readFileSync(join(root, 'people/hal-example.md'), 'utf8');
    expect(parseMarkdown(file).frontmatter).toMatchObject(expected);
    expect(file).toContain("zip: '02139'");
    expect(file).toContain("born: '1991-06-02'");
    for (const line of WRITTEN_BACK.filter(line => !/^(zip|born):/.test(line))) expect(file.split('\n')).toContain(line);
  }, { setup: userFileSetup }), 120_000);

  /** A note the user committed; each test then gives the database what an older gbrain stored for it. */
  const noteSetup = (text: string) => ({ root }: { root: string }) => {
    mkdirSync(join(root, 'notes'), { recursive: true }); writeFileSync(join(root, 'notes/p.md'), text);
    writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore', 'notes/p.md']);
  };
  const editBody = async (engine: BrainEngine, ctx: OperationContext) => {
    const rev = (await engine.readPageSnapshot('notes/p', { sourceId: 'default' }))!.revision;
    await call(ctx, 'edit_page', { slug: 'notes/p', expected_revision: rev, edits: [{ old_text: 'Body text', new_text: 'Body words' }] });
    await settleManagedGitEffects(engine);
  };

  test('an older page whose only old-typed value is .inf (stored as null) takes a body edit before the upgrade sync', () => managedBrain(async ({ engine, ctx, root }) => {
    expect((await performManagedSync(engine, { sourceId: 'default', noPull: true })).status).toBe('first_sync');
    // The old typing read `.inf` as Infinity, which JSON stores as null.
    await withManagedFixtureWrite(engine, ['default'], tx => tx.executeRaw("UPDATE pages SET frontmatter = frontmatter || '{\"limit\":null}'::jsonb WHERE slug='notes/p'"));
    await editBody(engine, ctx);
    const file = readFileSync(join(root, 'notes/p.md'), 'utf8');
    expect(file).toContain('Body words.');
    expect(file.split('\n')).toContain("limit: '.inf'");
  }, { setup: noteSetup('---\ntitle: Limits\ntype: note\nlimit: .inf\n---\n# Limits\n\nBody text.\n') }), 120_000);

  const ITEM = '---\ntitle: Item\ntype: note\nid: 007\n---\n# Item\n\nBody text.\n';
  test('the rename identity reader reads an id as the page stores it (id: 007 is "007")', () => {
    expect(frontmatterIdentity(ITEM).id).toBe('007');
    expect(parseMarkdown(ITEM).frontmatter.id).toBe('007');
  });

  test('a case-only rename of an id: 007 page syncs as a rename, not a page identity refusal', () => managedBrain(async ({ engine, root }) => {
    expect((await performManagedSync(engine, { sourceId: 'default', noPull: true })).status).toBe('first_sync');
    const before = (await engine.getPage('notes/item'))!;
    expect(before.frontmatter.id).toBe('007');
    const git = (...args: string[]) => execFileSync('git', ['-C', root, '-c', 'user.name=Example', '-c', 'user.email=example@example.invalid', ...args]);
    git('mv', 'notes/Item.md', 'notes/item.md'); git('commit', '-qm', 'case rename');
    const result = await performManagedSync(engine, { sourceId: 'default', noPull: true });
    expect(JSON.stringify(result)).not.toContain('page_identity_changed');
    expect(result.fileRefusals ?? []).toEqual([]);
    const after = (await engine.getPage('notes/item'))!;
    expect({ id: after.id, path: after.source_path }).toEqual({ id: before.id, path: 'notes/item.md' });
  }, { setup: ({ root }: { root: string }) => {
    mkdirSync(join(root, 'notes'), { recursive: true }); writeFileSync(join(root, 'notes/Item.md'), ITEM);
    writeFileSync(join(root, '.gitignore'), '\n'); durableGitRepo(root, ['.gitignore', 'notes/Item.md']);
  } }), 120_000);
});
