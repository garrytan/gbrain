/**
 * pages-03: frontmatter values are kept exactly as the user wrote them.
 *
 * 1. Protects: a date (`born: 1990-05-01`), an offset timestamp (`2024-03-01T10:00:00+02:00`), a zip code with a
 *    leading zero (`02134`) and a version (`1.10`) are stored, read back by get/export and written back to the user's
 *    file as written, also after an agent edits one word of the body. A page stored before this fix (the old typing in
 *    the database, the user's text in the file) is not reported as a local edit, and its first write puts the user's
 *    values back: a value the caller changed in that write keeps the caller's value. Readers of those values (effective date, valid time, core priority, pack subtypes, chronicle dates)
 *    read the kept text as they read the old typed value.
 * 2. Fails when: the YAML parser types timestamps or numbers whose text does not print back the same, the dump changes
 *    a kept value, or a reader treats the kept text differently from the old value.
 * 3. Runs on PGLite (the managed-brain fixture). No embedding, no model calls.
 */
import { describe, expect, test } from 'bun:test';
import { DEFAULT_SCHEMA, dump } from 'js-yaml';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { dumpFrontmatterYaml, parseDataFrontmatter } from '../src/core/data-frontmatter.ts';
import { parseMarkdown, serializePageToMarkdown } from '../src/core/markdown.ts';
import { computeEffectiveDate, parseDateLoose } from '../src/core/effective-date.ts';
import { validDate } from '../src/core/valid-time.ts';
import { corePriority } from '../src/core/core-memory.ts';
import { legacyTypedFrontmatter } from '../src/core/frontmatter-legacy.ts';
import { endedInviteProposal } from '../src/core/chronicle/invite-projection.ts';
import { operationsByName } from '../src/core/operations.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { managedBrain, settleManagedGitEffects } from './helpers/managed-brain.ts';
import { durableGitRepo } from './helpers/git-publication.ts';
import { withManagedFixtureWrite } from './helpers/managed-e2e-fixture-write.ts';

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
const FILE = `---\ntitle: Hal Example\ntype: person\n${BLOCK.join('\n')}\n---\n# Hal Example\n\nHal likes tea.\n`;
const AS_WRITTEN = {
  company: 'acme-example', born: '1990-05-01', last_met: '2024-03-01T10:00:00+02:00', naive: '2024-03-01 10:00:00',
  zip: '02134', version: '1.10', one: '1.0', big: '12345678901234567890', count: 42, ratio: 0.5, flag: true,
  details: { role: 'cto', since: '2020-01-01' },
};

describe('pages-03: frontmatter values as written', () => {
  test('the parser keeps timestamps and numbers whose text does not print back the same as the written text', () => {
    expect(parseDataFrontmatter(FILE).data).toEqual({ title: 'Hal Example', type: 'person', ...AS_WRITTEN });
    // Each value line dumps back exactly as written.
    const dumped = dumpFrontmatterYaml(AS_WRITTEN).trimEnd().split('\n');
    expect(dumped).toEqual(BLOCK);
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
  const valueLines = (text: string) => BLOCK.filter(line => text.split('\n').includes(line));

  test('put, get, export and a one-word edit keep the written values in the database and the file', () => managedBrain(async ({ engine, ctx, root }) => {
    await call(ctx, 'put_page', { slug: 'people/hal-example', content: FILE });
    await settleManagedGitEffects(engine);
    const page = (await engine.getPage('people/hal-example'))!;
    expect(page.frontmatter).toMatchObject(AS_WRITTEN);
    expect(valueLines(serializePageToMarkdown(page, []))).toEqual(BLOCK);
    expect(valueLines(readFileSync(join(root, 'people/hal-example.md'), 'utf8'))).toEqual(BLOCK);
    const rev = (await engine.readPageSnapshot('people/hal-example', { sourceId: 'default' }))!.revision;
    await call(ctx, 'edit_page', { slug: 'people/hal-example', expected_revision: rev, edits: [{ old_text: 'likes tea', new_text: 'likes coffee' }] });
    await settleManagedGitEffects(engine);
    const file = readFileSync(join(root, 'people/hal-example.md'), 'utf8');
    expect(file).toContain('Hal likes coffee.');
    expect(valueLines(file)).toEqual(BLOCK);
    expect((await engine.getPage('people/hal-example'))!.frontmatter).toMatchObject(AS_WRITTEN);
  }, { setup }), 120_000);

  test('a page stored under the old typing is not a local edit, and its first write puts the written values back', () => managedBrain(async ({ engine, ctx, root }) => {
    await call(ctx, 'put_page', { slug: 'people/hal-example', content: FILE });
    await settleManagedGitEffects(engine);
    // What an older gbrain stored for the same file.
    const legacy = { ...legacyTypedFrontmatter(FILE)!, trust_tier: undefined };
    const stored = (await engine.getPage('people/hal-example'))!.frontmatter;
    const old = { ...stored, ...Object.fromEntries(Object.entries(legacy).filter(([k]) => k in AS_WRITTEN)) };
    await withManagedFixtureWrite(engine, ['default'], tx => tx.executeRaw("UPDATE pages SET frontmatter=$1::text::jsonb WHERE slug='people/hal-example'", [JSON.stringify(old)]));
    const rev = (await engine.readPageSnapshot('people/hal-example', { sourceId: 'default' }))!.revision;
    await call(ctx, 'edit_page', { slug: 'people/hal-example', expected_revision: rev, edits: [{ old_text: 'likes tea', new_text: 'likes coffee' }] });
    await settleManagedGitEffects(engine);
    const file = readFileSync(join(root, 'people/hal-example.md'), 'utf8');
    expect(file).toContain('Hal likes coffee.');
    expect(valueLines(file)).toEqual(BLOCK);
    expect((await engine.getPage('people/hal-example'))!.frontmatter).toMatchObject(AS_WRITTEN);
    expect(parseMarkdown(file).frontmatter).toMatchObject(AS_WRITTEN);
  }, { setup }), 120_000);

  test('on an older page\'s first write, a value the caller changed keeps the new value and the others get their written text back', () => managedBrain(async ({ engine, ctx, root }) => {
    await call(ctx, 'put_page', { slug: 'people/hal-example', content: FILE });
    await settleManagedGitEffects(engine);
    const legacy = legacyTypedFrontmatter(FILE)!;
    const stored = (await engine.getPage('people/hal-example'))!.frontmatter;
    const old = { ...stored, ...Object.fromEntries(Object.entries(legacy).filter(([k]) => k in AS_WRITTEN)) };
    await withManagedFixtureWrite(engine, ['default'], tx => tx.executeRaw("UPDATE pages SET frontmatter=$1::text::jsonb WHERE slug='people/hal-example'", [JSON.stringify(old)]));
    // The caller reads the page as an older gbrain renders it (the old typing) and changes two of those values.
    const read = serializePageToMarkdown((await engine.getPage('people/hal-example'))!, []);
    expect(read).toContain('zip: 2134');
    expect(read).toContain('born: 1990-05-01T00:00:00.000Z');
    const sent = read.replace('zip: 2134', "zip: '02139'").replace('born: 1990-05-01T00:00:00.000Z', 'born: 1991-06-02');
    const rev = (await engine.readPageSnapshot('people/hal-example', { sourceId: 'default' }))!.revision;
    await call(ctx, 'put_page', { slug: 'people/hal-example', expected_revision: rev, content: sent });
    await settleManagedGitEffects(engine);
    const expected = { ...AS_WRITTEN, zip: '02139', born: '1991-06-02' };
    expect((await engine.getPage('people/hal-example'))!.frontmatter).toMatchObject(expected);
    const file = readFileSync(join(root, 'people/hal-example.md'), 'utf8');
    expect(parseMarkdown(file).frontmatter).toMatchObject(expected);
    expect(file).toContain('zip: 02139');
    expect(file).toContain('born: 1991-06-02');
    for (const line of BLOCK.filter(line => !/^(zip|born):/.test(line))) expect(file.split('\n')).toContain(line);
  }, { setup }), 120_000);
});
