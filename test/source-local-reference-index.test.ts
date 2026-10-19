import { expect, test } from 'bun:test';
import { buildSourceLocalReferenceIndex } from '../src/core/source-local-reference-index.ts';
import { makeIndexedLinkResolver, type LinkPageMetadata } from '../src/core/link-reconciliation.ts';
import { readSourceLocalReferenceLimits } from '../src/core/source-local-reference-limits.ts';
import { KNOWN_CONFIG_KEYS } from '../src/core/config.ts';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withEnv } from './helpers/with-env.ts';

// Protect operator overrides through the real config dispatcher and both index
// bounds. Hardcoding either default or writing only DB config must fail here.
// Existing cases cover refusals only; this needs no test-only production seam.
// The baseline config dispatcher exits on unknown keys. A child keeps that
// refusal observable without terminating the test runner during discrimination.
async function config(args: string[]): Promise<void> {
  const module = new URL('../src/commands/config.ts', import.meta.url).href;
  const script = `import { runConfig } from ${JSON.stringify(module)};
    try { await runConfig({ unsetConfig: async () => 0 }, JSON.parse(process.argv[1])); }
    catch (error) { console.error(JSON.stringify({code: error.code, message: error.message})); process.exitCode = 1; }`;
  const child = Bun.spawn([process.execPath, '--no-env-file', '--eval', script, JSON.stringify(args)], {
    env: { ...process.env, HOME: process.env.GBRAIN_HOME!, DATABASE_URL: '', GBRAIN_DATABASE_URL: '' }, stdout: 'pipe', stderr: 'pipe',
  });
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text(), new Response(child.stdout).text()]);
  if (code !== 0) {
    let detail: { code?: string; message?: string } = {};
    try { detail = JSON.parse(stderr.trim()); } catch { /* baseline CLI refusal is plain text */ }
    throw Object.assign(new Error(detail.message ?? stderr), { code: detail.code });
  }
}

test('source-local names combine alias, title and basename candidates without guessing ambiguity', () => {
  const index = buildSourceLocalReferenceIndex([
    { slug: 'people/operator', title: 'Different Title', aliases: ['Ｄｕｔｙ owner', 'Common'] },
    { slug: 'people/peer', title: 'Common', aliases: [] },
    { slug: 'teams/common', title: 'Another Title', aliases: ['Duty owner'] },
  ]);
  expect(index.resolveMatches('Different Title')).toEqual(['people/operator']);
  expect(index.resolveMatches('operator')).toEqual(['people/operator']);
  expect(index.resolveMatches('Common')).toEqual(['people/operator', 'people/peer', 'teams/common']);
  expect(index.resolveMatches('Duty owner')).toEqual(['people/operator', 'teams/common']);
  expect(index.resolveMatches('Duty owner', 'people')).toEqual(['people/operator']);
  expect(index.resolveMatches('Common', ['people', 'teams'])).toEqual(['people/operator', 'people/peer', 'teams/common']);
  expect(index.resolveMatches('people/operator')).toEqual(['people/operator']);
  expect(index.resolveMatches('foreign:people/operator')).toEqual([]);
  expect(index.resolveMatches('../people/operator')).toEqual([]);
  expect(index.basenameMatches('Duty owner')).toEqual([]);
});

test('source-local reference indexes enforce page and metadata bounds', () => {
  expect(() => buildSourceLocalReferenceIndex(Array.from({ length: 100_001 }, () => ({ slug: 'notes/one', title: 'One' })))).toThrow('100,000');
  expect(() => buildSourceLocalReferenceIndex([{ slug: 'notes/large', title: 'x'.repeat(16 * 1024 ** 2) }])).toThrow('16 MiB');
});

test('an oversized source names its page count and operator setting', () => {
  expect(() => buildSourceLocalReferenceIndex(Array.from({ length: 100_001 }, () => ({ slug: 'notes/one', title: 'One' }))))
    .toThrow(expect.objectContaining({ code: 'request_too_large', suggestion: expect.stringContaining('The source has 100001 pages') }));
  expect(() => buildSourceLocalReferenceIndex(Array.from({ length: 100_001 }, () => ({ slug: 'notes/one', title: 'One' }))))
    .toThrow(expect.objectContaining({ suggestion: expect.stringContaining('links.reference_index_max_pages') }));
});

test('config set raises the page limit used by the link resolver and unset restores it', async () => {
  const home = mkdtempSync(join(tmpdir(), 'reference-config-'));
  try {
    await withEnv({ GBRAIN_HOME: home, GBRAIN_LINKS_REFERENCE_INDEX_MAX_PAGES: undefined, GBRAIN_LINKS_REFERENCE_INDEX_MAX_BYTES: undefined }, async () => {
      const pages: LinkPageMetadata[] = Array.from({ length: 100_001 }, (_, i) => ({
        slug: `notes/item-${i}`, title: `Item ${i}`, source_id: 'default', type: 'note', knowledge_revision: '1',
      }));
      expect(() => makeIndexedLinkResolver(pages, 'default')).toThrow(expect.objectContaining({ code: 'request_too_large' }));
      await config(['set', 'links.reference_index_max_pages', '100001']);
      const resolver = makeIndexedLinkResolver(pages, 'default');
      expect(await resolver.resolve('Item 100000')).toBe('notes/item-100000');
      expect(await resolver.resolve('foreign:notes/item-100000')).toBeNull();
      await config(['unset', 'links.reference_index_max_pages']);
      expect(() => makeIndexedLinkResolver(pages, 'default')).toThrow('100,000');
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('byte setting counts normalized UTF-8 metadata exactly and environment overrides file values', async () => {
  const home = mkdtempSync(join(tmpdir(), 'reference-bytes-'));
  try {
    await withEnv({ GBRAIN_HOME: home, GBRAIN_LINKS_REFERENCE_INDEX_MAX_BYTES: undefined, GBRAIN_LINKS_REFERENCE_INDEX_MAX_PAGES: undefined }, async () => {
      const pages = [{ slug: 'notes/one', title: 'Résumé', aliases: [' Ａlias ', 'alias'] }];
      const bytes = Buffer.byteLength(JSON.stringify(['notes/one', 'Résumé', ['alias']]));
      await config(['set', 'links.reference_index_max_bytes', String(bytes - 1)]);
      expect(() => buildSourceLocalReferenceIndex(pages, readSourceLocalReferenceLimits()))
        .toThrow(expect.objectContaining({ code: 'request_too_large', suggestion: expect.stringContaining('links.reference_index_max_bytes') }));
      await withEnv({ GBRAIN_LINKS_REFERENCE_INDEX_MAX_BYTES: String(bytes), GBRAIN_LINKS_REFERENCE_INDEX_MAX_PAGES: '1' }, () => {
        const limits = readSourceLocalReferenceLimits();
        expect(limits).toEqual({ maxPages: 1, maxBytes: bytes });
        expect(buildSourceLocalReferenceIndex(pages, limits).resolveMatches('alias')).toEqual(['notes/one']);
      });
      await config(['set', 'links.reference_index_max_bytes', String(bytes)]);
      const resolver = makeIndexedLinkResolver(pages.map(page => ({ ...page, source_id: 'default', type: 'note', knowledge_revision: '1' })), 'default');
      expect(await resolver.resolve('alias')).toBe('notes/one');
      await withEnv({ GBRAIN_LINKS_REFERENCE_INDEX_MAX_BYTES: '0' }, () => {
        expect(readSourceLocalReferenceLimits).toThrow(expect.objectContaining({ code: 'invalid_params' }));
      });
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('config set rejects invalid limits before changing either setting, even with force', async () => {
  const home = mkdtempSync(join(tmpdir(), 'reference-invalid-'));
  try {
    await withEnv({ GBRAIN_HOME: home }, async () => {
      for (const key of ['links.reference_index_max_pages', 'links.reference_index_max_bytes']) {
        expect(KNOWN_CONFIG_KEYS).toContain(key);
        await config(['set', key, '123456']);
        const path = join(home, '.gbrain', 'config.json');
        const before = readFileSync(path, 'utf8');
        for (const value of ['0', '1.5', 'NaN', 'Infinity', '9007199254740992', '12junk', 'true']) {
          await expect(config(['set', key, value, '--force']))
            .rejects.toMatchObject({ code: 'invalid_params' });
          expect(readFileSync(path, 'utf8')).toBe(before);
        }
      }
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
});
