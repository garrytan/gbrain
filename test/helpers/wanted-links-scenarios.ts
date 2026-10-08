/**
 * Engine-parametrized wanted-pages scenarios. PGLite runs them from
 * test/wanted-links.test.ts; test/e2e/wanted-links-postgres.test.ts runs the
 * same bodies on Postgres.
 */
import { expect } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { BrainEngine } from '../../src/core/engine.ts';
import type { OperationContext } from '../../src/core/ops/contract.ts';
import { submitPageMutation } from '../../src/core/persistence/page-mutations.ts';
import { extractStaleFromDB } from '../../src/commands/extract.ts';
import { LINK_EXTRACTOR_VERSION_TS } from '../../src/core/link-extraction.ts';
import { operationsByName } from '../../src/core/operations.ts';
import { managedBrain } from './managed-brain.ts';

const put = (ctx: OperationContext, slug: string, body: string, type = 'note', frontmatter = '', expectedRevision?: string) =>
  submitPageMutation(ctx, { operation: 'put_page', params: { slug, request_id: randomUUID(),
    ...(expectedRevision ? { expected_revision: expectedRevision } : {}),
    content: `---\ntype: ${type}\ntitle: ${slug}\n${frontmatter}---\n\n${body}\n` } }) as Promise<Record<string, any>>;
const stale = (engine: BrainEngine) => engine.countStalePagesForExtraction({ versionTs: LINK_EXTRACTOR_VERSION_TS });
const extractStale = (engine: BrainEngine) => extractStaleFromDB(engine, { dryRun: false, jsonMode: true, quiet: true, catchUp: true });
const wantedRows = (engine: BrainEngine) => engine.executeRaw<{ target_ref: string; ref_kind: string; producer: string }>(
  'SELECT target_ref, ref_kind, producer FROM wanted_links ORDER BY target_ref');
const backlinks = (engine: BrainEngine, slug: string) => engine.executeRaw<{ slug: string }>(`SELECT f.slug FROM links l
  JOIN pages f ON f.id=l.from_page_id JOIN pages t ON t.id=l.to_page_id WHERE t.slug=$1 ORDER BY f.slug`, [slug]);
const wantedOp = (ctx: OperationContext, params: Record<string, unknown> = {}) =>
  operationsByName.wanted_pages!.handler(ctx, params) as Promise<{ total: number; targets: Array<Record<string, any>> }>;

/** A link written before its target page exists becomes an edge once the target is created, after the next sweep. */
export async function forwardReferenceHeals(databaseUrl?: string) {
  await managedBrain(async ({ engine, ctx }) => {
    const written = await put(ctx, 'notes/lunch', 'Lunch with [[people/carol-example]] about [[companies/acme-example]].');
    const autoLinks = (written.outcome ?? written).auto_links;
    expect(autoLinks.wanted_count).toBe(2);
    expect(autoLinks.wanted).toHaveLength(2);
    expect(autoLinks.wanted).toEqual(expect.arrayContaining([{ slug: 'people/carol-example', source_id: 'default' },
      { slug: 'companies/acme-example', source_id: 'default' }]));
    expect(autoLinks.fix).toMatchObject({ argv: ['gbrain', 'wanted', '--source-id', 'default'], mcp: { tool: 'wanted_pages' } });
    await extractStale(engine);
    expect(await stale(engine)).toBe(0);
    expect((await wantedRows(engine)).map(row => row.target_ref)).toEqual(['companies/acme-example', 'people/carol-example']);

    await put(ctx, 'people/carol-example', 'Carol.', 'person');
    // The origin was stamped before Carol existed; the wanted row makes it stale again.
    expect(await stale(engine)).toBeGreaterThanOrEqual(1);
    await extractStale(engine);
    expect(await backlinks(engine, 'people/carol-example')).toEqual([{ slug: 'notes/lunch' }]);
    expect((await wantedRows(engine)).map(row => row.target_ref)).toEqual(['companies/acme-example']);
    expect(await stale(engine)).toBe(0);
    const listed = await wantedOp(ctx);
    expect(listed.total).toBe(1);
    expect(listed.targets[0]).toMatchObject({ target: 'companies/acme-example', referenced_by: 1,
      sample_origins: [{ slug: 'notes/lunch', source_id: 'default' }] });
  }, { databaseUrl });
}

/** Resolved references, bare prose paths and code spans never become wanted rows. */
export async function onlyUnresolvedAuthoredReferences(databaseUrl?: string) {
  await managedBrain(async ({ engine, ctx }) => {
    await put(ctx, 'people/alice-example', 'Alice.', 'person');
    await put(ctx, 'notes/mixed', [
      'Met [[people/alice-example]].',
      'See src/core/engine.ts and and/or docs/guides/missing for context.',
      'Code: `[[people/in-code]]`.',
    ].join('\n'));
    await extractStale(engine);
    expect(await wantedRows(engine)).toEqual([]);
  }, { databaseUrl });
}

/** A bare-name reference that matches a page only by basename wakes its origin once, then settles (no re-listing loop). */
export async function bareNameReferenceSettles(databaseUrl?: string) {
  await managedBrain(async ({ engine, ctx }) => {
    await put(ctx, 'notes/call', 'Call with [[Dave Example]].');
    await extractStale(engine);
    expect(await wantedRows(engine)).toEqual([{ target_ref: 'dave-example', ref_kind: 'name', producer: 'body' }]);
    await put(ctx, 'people/dave-example', 'Dave.', 'person');
    expect(await stale(engine)).toBeGreaterThanOrEqual(1);
    await extractStale(engine);
    expect(await stale(engine)).toBe(0);
    const listed = await wantedOp(ctx);
    expect(listed.targets[0]).toMatchObject({ target: 'dave-example', ref_kind: 'name',
      existing_matches: [{ slug: 'people/dave-example', source_id: 'default' }] });
    expect(listed.targets[0].next).toContain('[[people/dave-example]]');
  }, { databaseUrl });
}

/** A remote caller never sees targets referenced only from private pages, nor counts that include them. */
export async function privateOriginsStayPrivate(databaseUrl?: string) {
  await managedBrain(async ({ engine, ctx }) => {
    await put(ctx, 'notes/open', 'Ask [[people/shared-target]].');
    await put(ctx, 'notes/secret', 'Ask [[people/shared-target]] and [[people/secret-target]].', 'note', 'visibility: private\n');
    await extractStale(engine);
    const local = await wantedOp(ctx);
    expect(local.targets.map(t => [t.target, t.referenced_by])).toEqual([['people/shared-target', 2], ['people/secret-target', 1]]);
    const remote = await wantedOp({ ...ctx, remote: true });
    expect(remote.total).toBe(1);
    expect(remote.targets.map(t => [t.target, t.referenced_by])).toEqual([['people/shared-target', 1]]);
    expect(JSON.stringify(remote)).not.toContain('secret');
  }, { databaseUrl });
}

/** Turning the feature off clears an origin's rows on its next extraction. */
export async function disabledClearsRows(databaseUrl?: string) {
  await managedBrain(async ({ engine, ctx }) => {
    const first = await put(ctx, 'notes/lunch', 'Lunch with [[people/carol-example]].');
    await extractStale(engine);
    expect(await wantedRows(engine)).toHaveLength(1);
    await engine.setConfig('wanted_pages.enabled', 'false');
    await put(ctx, 'notes/lunch', 'Lunch with [[people/carol-example]] again.', 'note', '', (first.outcome ?? first).revision);
    expect(await wantedRows(engine)).toEqual([]);
  }, { databaseUrl });
}

/** Restoring a soft-deleted target heals links written while it was deleted. */
export async function restoredTargetHeals(databaseUrl?: string) {
  await managedBrain(async ({ engine, ctx }) => {
    const carol = await put(ctx, 'people/carol-example', 'Carol.', 'person');
    await submitPageMutation(ctx, { operation: 'delete_page', params: { slug: 'people/carol-example', request_id: randomUUID(),
      expected_revision: (carol.outcome ?? carol).revision } });
    await put(ctx, 'notes/lunch', 'Lunch with [[people/carol-example]].');
    await extractStale(engine);
    expect((await wantedRows(engine)).map(row => row.target_ref)).toEqual(['people/carol-example']);
    const [deleted] = await engine.executeRaw<{ revision: string }>(
      "SELECT knowledge_revision::text AS revision FROM pages WHERE slug='people/carol-example'");
    await submitPageMutation(ctx, { operation: 'restore_page', params: { slug: 'people/carol-example', request_id: randomUUID(),
      expected_revision: deleted.revision } });
    expect(await stale(engine)).toBeGreaterThanOrEqual(1);
    await extractStale(engine);
    expect(await backlinks(engine, 'people/carol-example')).toEqual([{ slug: 'notes/lunch' }]);
  }, { databaseUrl });
}

// #6228: bracketed code on a code page parses as a wikilink whose target no slug can be.
// #6225: a citation prefix that names no registered source parses as a qualified wikilink.
export const BRACKETED_CODE = 'const routes = mockFetch([[/api\\.example/, () => reply(200)]]);\n// see [[people/alice-example]] and [[people/bob-example]]';
export const FOREIGN_PREFIXES = 'Noted in [[memory:4242]]. Ask [[people/alice-example]], [[people/bob-example]] and [[archive:people/erin-example]].';
const registerArchive = async ({ engine }: { engine: BrainEngine }) => {
  await engine.executeRaw("INSERT INTO sources (id, name) VALUES ('archive', 'archive')");
};
export const wantedKeys = (engine: BrainEngine) => engine.executeRaw<{ key: string }>(
  "SELECT DISTINCT target_source_id || ':' || target_ref AS key FROM wanted_links ORDER BY 1");
export const POSSIBLE_WANTED = [{ key: 'archive:people/erin-example' }, { key: 'default:people/bob-example' }];

/** A sweep meeting targets no page can have records only possible ones, lands every valid link and stamps every page. */
export async function impossibleTargetsNeverAbortTheSweep(databaseUrl?: string) {
  await managedBrain(async ({ engine, ctx }) => {
    await put(ctx, 'people/alice-example', 'Alice.', 'person');
    await engine.setConfig('wanted_pages.enabled', 'false');
    await put(ctx, 'src/routes.test.ts', BRACKETED_CODE, 'code');
    await put(ctx, 'notes/citations', FOREIGN_PREFIXES);
    await engine.setConfig('wanted_pages.enabled', 'true');
    await engine.setConfig('link_resolution.cross_source', 'true');
    await engine.executeRaw("UPDATE pages SET links_extracted_at = NULL WHERE slug IN ('src/routes.test.ts', 'notes/citations')");
    await extractStale(engine);
    expect(await stale(engine)).toBe(0);
    expect(await backlinks(engine, 'people/alice-example')).toEqual([{ slug: 'notes/citations' }, { slug: 'src/routes.test.ts' }]);
    expect(await wantedKeys(engine)).toEqual(POSSIBLE_WANTED);
  }, { databaseUrl, setup: registerArchive });
}

/** A put_page holding such targets succeeds, and its receipt lists exactly the wanted rows the store kept. */
export async function impossibleTargetsStayOutOfWrites(databaseUrl?: string) {
  await managedBrain(async ({ engine, ctx }) => {
    await engine.setConfig('link_resolution.cross_source', 'true');
    await put(ctx, 'people/alice-example', 'Alice.', 'person');
    const code = (await put(ctx, 'src/routes.test.ts', BRACKETED_CODE, 'code')).outcome;
    expect(code.auto_links.wanted).toEqual([{ slug: 'people/bob-example', source_id: 'default' }]);
    const cited = (await put(ctx, 'notes/citations', FOREIGN_PREFIXES)).outcome;
    expect(cited.auto_links.wanted_count).toBe(2);
    expect(cited.auto_links.wanted).toEqual(expect.arrayContaining([{ slug: 'people/bob-example', source_id: 'default' },
      { slug: 'people/erin-example', source_id: 'archive' }]));
    expect(await backlinks(engine, 'people/alice-example')).toEqual([{ slug: 'notes/citations' }, { slug: 'src/routes.test.ts' }]);
    expect(await wantedKeys(engine)).toEqual(POSSIBLE_WANTED);
  }, { databaseUrl, setup: registerArchive });
}
