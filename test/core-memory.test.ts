/**
 * Always-loaded core memory: normalization, rendering, budget truncation,
 * ordering, revision and the brain-wide listing. PGLite in-memory ($0).
 */
import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import {
  CORE_DEFAULT_MAX_CHARS, coreChars, corePriority, coreRevision, coreUsage, isCoreFrontmatter, listCorePages,
  loadCoreBlock, orderCorePages, parseCoreMaxChars, renderCoreBlock, renderCorePage, toCorePage, validateCoreConfigValue,
} from '../src/core/core-memory.ts';
import { renderFactsTable } from '../src/core/facts-fence.ts';
import { TAKES_FENCE_BEGIN, TAKES_FENCE_END } from '../src/core/takes-fence.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  await engine.executeRaw(`INSERT INTO sources (id, name) VALUES ('wiki', 'wiki') ON CONFLICT DO NOTHING`);
  // Core is opt-in (off by default, per the held-out core gate); these tests exercise it turned on.
  await engine.setConfig('memory.core.enabled', 'true');
}, 60_000);
afterAll(async () => { if (engine) await engine.disconnect(); }, 60_000);

describe('core marking normalization', () => {
  test('only always_load: true is core', () => {
    expect(isCoreFrontmatter({ always_load: true })).toBe(true);
    for (const v of [false, 'true', 1, 0, null, undefined, 'yes']) expect(isCoreFrontmatter({ always_load: v })).toBe(false);
    expect(isCoreFrontmatter(null)).toBe(false);
  });
  test('core_priority is a positive integer, else 100', () => {
    expect(corePriority({ core_priority: 3 })).toBe(3);
    expect(corePriority({ core_priority: '7' })).toBe(7);
    for (const v of [0, -1, 1.5, 'x', null, undefined]) expect(corePriority({ core_priority: v })).toBe(100);
  });
  test('config validation names the range', () => {
    expect(parseCoreMaxChars('4000')).toBe(4000);
    expect(parseCoreMaxChars('499')).toBeNull();
    expect(parseCoreMaxChars('6001')).toBeNull();
    expect(validateCoreConfigValue('memory.core.max_chars', '7000')).toContain('500 to 6000');
    expect(validateCoreConfigValue('memory.core.remote_edit', 'maybe')).toContain('allow, notify or refuse');
    expect(validateCoreConfigValue('memory.core.max_chars', '4000')).toBeNull();
  });
});

describe('rendering', () => {
  test('renders title and compiled truth in the remote-safe view (takes dropped, timeline never included)', () => {
    const body = `I prefer short answers.\n\n${TAKES_FENCE_BEGIN}\n| secret take |\n${TAKES_FENCE_END}\nEnd.`;
    const out = renderCorePage({ source_id: 'default', slug: 'people/alice-example', title: 'Alice Example', compiled_truth: body });
    expect(out.startsWith('### Alice Example (default:people/alice-example)\n')).toBe(true);
    expect(out).toContain('I prefer short answers.');
    expect(out).not.toContain('secret take');
    expect(out).not.toContain(TAKES_FENCE_BEGIN);
  });
  test('facts fences render world rows only', () => {
    const fence = renderFactsTable([
      { rowNum: 1, claim: 'likes tea', kind: 'preference', confidence: 1, visibility: 'world', notability: 'medium', active: true },
      { rowNum: 2, claim: 'private thing', kind: 'fact', confidence: 1, visibility: 'private', notability: 'medium', active: true },
    ]);
    const out = renderCorePage({ source_id: 'default', slug: 'me', title: 'Me', compiled_truth: fence });
    expect(out).toContain('likes tea');
    expect(out).not.toContain('private thing');
  });
  test('block cuts whole pages past the budget, lowest priority first, with a visible line', () => {
    const pages = [
      toCorePage({ source_id: 'default', slug: 'a', title: 'A', compiled_truth: 'x'.repeat(300), frontmatter: { always_load: true, core_priority: 1 } }),
      toCorePage({ source_id: 'default', slug: 'b', title: 'B', compiled_truth: 'y'.repeat(300), frontmatter: { always_load: true, core_priority: 2 } }),
    ];
    const full = renderCoreBlock(pages, { maxChars: 5000 });
    expect(full.pages.map(p => p.slug)).toEqual(['a', 'b']);
    expect(full.truncated).toBe(false);
    expect(full.chars_used).toBe(coreChars(pages));
    const cut = renderCoreBlock(pages, { maxChars: pages[0].chars + 10 });
    expect(cut.pages.map(p => p.slug)).toEqual(['a']);
    expect(cut.truncated).toBe(true);
    expect(cut.text).toContain('[core truncated: 1 page(s)');
    expect(cut.text).not.toContain('yyyy');
  });
  test('empty core renders nothing', () => {
    expect(renderCoreBlock([], { maxChars: 4000 }).text).toBe('');
  });
  test('notices are capped at five lines plus a count', () => {
    const page = toCorePage({ source_id: 'default', slug: 'a', title: 'A', compiled_truth: 'x' });
    const block = renderCoreBlock([page], { maxChars: 4000, notices: Array.from({ length: 8 }, (_, i) => `edit ${i}`) });
    expect(block.text).toContain('> edit 4');
    expect(block.text).not.toContain('> edit 5');
    expect(block.text).toContain('+3 more remote edits');
  });
  test('ordering: default source first, then priority, then slug', () => {
    const mk = (source_id: string, slug: string, p?: number) => toCorePage({ source_id, slug, title: slug, compiled_truth: '', frontmatter: { always_load: true, ...(p ? { core_priority: p } : {}) } });
    const ordered = orderCorePages([mk('wiki', 'z', 1), mk('default', 'b'), mk('default', 'a', 5)]).map(p => `${p.source_id}:${p.slug}`);
    expect(ordered).toEqual(['default:a', 'default:b', 'wiki:z']);
  });
  test('revision moves when rendered text, priority or the limit changes', () => {
    const a = toCorePage({ source_id: 'default', slug: 'a', title: 'A', compiled_truth: 'one' });
    const r1 = coreRevision([a], 4000);
    expect(coreRevision([a], 4000)).toBe(r1);
    expect(coreRevision([toCorePage({ ...a, compiled_truth: 'two' })], 4000)).not.toBe(r1);
    expect(coreRevision([a], 3000)).not.toBe(r1);
    expect(coreRevision([toCorePage({ ...a, frontmatter: { core_priority: 2 } })], 4000)).not.toBe(r1);
  });
});

describe('listing (PGLite)', () => {
  test('lists live always_load pages across sources, honoring source scope and deletion', async () => {
    await engine.putPage('people/alice-example', { type: 'person', title: 'Alice Example', compiled_truth: 'Prefers tea.', frontmatter: { always_load: true } });
    await engine.putPage('notes/not-core', { type: 'note', title: 'Not core', compiled_truth: 'x', frontmatter: { always_load: false } });
    await engine.putPage('notes/string-true', { type: 'note', title: 'String', compiled_truth: 'x', frontmatter: { always_load: 'true' } });
    await engine.putPage('projects/wiki-core', { type: 'project', title: 'Wiki core', compiled_truth: 'Wiki standing rule.', frontmatter: { always_load: true } }, { sourceId: 'wiki' });
    const all = await listCorePages(engine);
    expect(all.map(p => `${p.source_id}:${p.slug}`).sort()).toEqual(['default:people/alice-example', 'wiki:projects/wiki-core']);
    const scoped = await listCorePages(engine, { sourceIds: ['default'] });
    expect(scoped.map(p => p.slug)).toEqual(['people/alice-example']);
    const excluded = await coreUsage(engine, { exclude: { sourceId: 'wiki', slug: 'projects/wiki-core' } });
    expect(excluded.pages.map(p => p.slug)).toEqual(['people/alice-example']);
    await engine.softDeletePage('projects/wiki-core', { sourceId: 'wiki' });
    expect((await listCorePages(engine)).map(p => p.slug)).toEqual(['people/alice-example']);
  });
  test('session block shows default plus the session source; disabled renders nothing', async () => {
    await engine.putPage('projects/wiki-two', { type: 'project', title: 'Wiki two', compiled_truth: 'Second.', frontmatter: { always_load: true } }, { sourceId: 'wiki' });
    const block = await loadCoreBlock(engine, { sessionSourceId: 'wiki' });
    expect(block.pages.map(p => `${p.source_id}:${p.slug}`)).toEqual(['default:people/alice-example', 'wiki:projects/wiki-two']);
    expect(block.text).toContain(`/${CORE_DEFAULT_MAX_CHARS.toLocaleString('en-US')} chars`);
    const defaultOnly = await loadCoreBlock(engine, { sessionSourceId: 'default' });
    expect(defaultOnly.pages.map(p => p.source_id)).toEqual(['default']);
    const granted = await loadCoreBlock(engine, { sessionSourceId: 'wiki', allowedSources: ['wiki'] });
    expect(granted.pages.map(p => p.source_id)).toEqual(['wiki']);
    await engine.unsetConfig('memory.core.enabled');
    const unset = await loadCoreBlock(engine, { sessionSourceId: 'wiki' });
    expect(unset.enabled).toBe(false);
    expect(unset.text).toBe('');
    await engine.setConfig('memory.core.enabled', 'false');
    const off = await loadCoreBlock(engine, { sessionSourceId: 'wiki' });
    expect(off.enabled).toBe(false);
    expect(off.text).toBe('');
    await engine.setConfig('memory.core.enabled', 'true');
  });
});
