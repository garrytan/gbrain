/**
 * T3 — alias hop + ingest projection (the named-thing fix).
 * Hermetic PGLite. applyAliasHop is tested directly (no embedding provider
 * needed); ingest projection is tested via importFromContent(noEmbed).
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { resetPgliteState } from '../helpers/reset-pglite.ts';
import { applyAliasHop } from '../../src/core/search/hybrid.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import type { SearchResult } from '../../src/core/types.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await resetPgliteState(engine); });

function res(slug: string, score: number, title = slug): SearchResult {
  return { slug, title, score, chunk_text: '', type: 'note', source_id: 'default', chunk_index: 0, chunk_id: 1 } as unknown as SearchResult;
}

describe('applyAliasHop', () => {
  test('a page made private after retrieval cannot add alias metadata or boost', async () => {
    const page = await engine.putPage('notes/revoked-example', { type: 'note', title: 'Revoked', compiled_truth: 'PUBLIC_BEFORE' });
    await engine.setPageAliases(page.slug, 'default', ['revoked alias']);
    const organic = { ...res(page.slug, 0.5), page_id: page.id };
    await engine.putPage(page.slug, { type: 'note', title: 'Revoked', compiled_truth: 'SECRET_NOW', frontmatter: { visibility: 'private' } });
    const hits = await applyAliasHop(engine, [organic], 'revoked alias', { sourceId: 'default', excludePrivate: true });
    expect(hits).toEqual([organic]);
    expect(hits[0].alias_hit).toBeUndefined();
    expect((await engine.resolveAliases(['revoked alias'], { sourceId: 'default', excludePrivate: true })).size).toBe(0);
    expect((await engine.resolveAliases(['revoked alias'], { sourceId: 'default' })).get('revoked alias')?.[0].slug).toBe(page.slug);
  });

  test('alias-injected excerpts strip every protected take fence', async () => {
    await engine.putPage('notes/body-example', { type: 'note', title: 'Public', compiled_truth: '<!--- gbrain:takes:begin -->\nSECRET_ALIAS_TAKE\n<!--- gbrain:takes:end -->\nPUBLIC_ALIAS_EXCERPT' });
    await engine.setPageAliases('notes/body-example', 'default', ['public alias']);
    const hits = await applyAliasHop(engine, [], 'public alias', { sourceId: 'default', excludePrivate: true });
    expect(hits[0].chunk_text).toContain('PUBLIC_ALIAS_EXCERPT');
    expect(hits[0].chunk_text).not.toContain('SECRET_ALIAS_TAKE');
  });

  test('injects an absent canonical when the query matches its alias', async () => {
    await engine.putPage('projects/mingtang', { type: 'note', title: 'The Mingtang', compiled_truth: 'Indoor Greek amphitheater.' });
    await engine.setPageAliases('projects/mingtang', 'default', ['hall of light', '明堂']);

    const organic = [res('notes/unrelated', 0.5)];
    const out = await applyAliasHop(engine, organic, 'Hall of Light', { sourceId: 'default' });

    const hit = out.find(r => r.slug === 'projects/mingtang');
    expect(hit).toBeDefined();
    expect(hit!.alias_hit).toBe(true);
    expect(out[0].slug).toBe('projects/mingtang'); // injected at top-of-organic + ε
    expect(hit!.score).toBeGreaterThan(0.5);
  });

  test('romanization/CJK alias also resolves', async () => {
    await engine.putPage('projects/mingtang', { type: 'note', title: 'The Mingtang', compiled_truth: 'x' });
    await engine.setPageAliases('projects/mingtang', 'default', ['明堂']);
    const out = await applyAliasHop(engine, [], '明堂', { sourceId: 'default' });
    expect(out.map(r => r.slug)).toContain('projects/mingtang');
  });

  test('boosts (does not duplicate) a canonical already in results', async () => {
    await engine.putPage('projects/mingtang', { type: 'note', title: 'The Mingtang', compiled_truth: 'x' });
    await engine.setPageAliases('projects/mingtang', 'default', ['hall of light']);
    const organic = [res('projects/mingtang', 0.4), res('notes/other', 0.5)];
    const out = await applyAliasHop(engine, organic, 'hall of light', { sourceId: 'default' });
    expect(out.filter(r => r.slug === 'projects/mingtang').length).toBe(1); // no dup
    const m = out.find(r => r.slug === 'projects/mingtang')!;
    expect(m.alias_hit).toBe(true);
    expect(m.score).toBeCloseTo(0.4 * 1.10, 6); // bounded present-boost
  });

  test('P0 source-isolation: alias hop boosts only the aliased source, not the same slug in another source', async () => {
    // The alias belongs to the src-b page only. Two same-slug results, different
    // sources, both in the organic set. The hop must boost ONLY src-b's row.
    const pages = [];
    for (const sourceId of ['src-a', 'src-b']) {
      await engine.executeRaw('INSERT INTO sources (id, name) VALUES ($1, $1) ON CONFLICT (id) DO NOTHING', [sourceId]);
      pages.push(await engine.putPage('shared/page', { type: 'note', title: 'Shared', compiled_truth: 'Synthetic source-scoped alias fixture' }, { sourceId }));
    }
    await engine.setPageAliases('shared/page', 'src-b', ['only in b']);
    const organic = [
      { ...res('shared/page', 0.5), page_id: pages[0].id, source_id: 'src-a' },
      { ...res('shared/page', 0.5), page_id: pages[1].id, source_id: 'src-b' },
    ];
    const out = await applyAliasHop(engine, organic, 'only in b', { sourceIds: ['src-a', 'src-b'] });
    const a = out.find(r => r.source_id === 'src-a')!;
    const b = out.find(r => r.source_id === 'src-b')!;
    expect(b.alias_hit).toBe(true);
    expect(b.score).toBeCloseTo(0.5 * 1.10, 6);
    expect(a.alias_hit).toBeUndefined(); // NOT cross-boosted
    expect(a.score).toBe(0.5);
  });

  test('no alias match → input unchanged', async () => {
    const organic = [res('a', 0.9), res('b', 0.8)];
    const out = await applyAliasHop(engine, organic, 'some unrelated query', { sourceId: 'default' });
    expect(out.map(r => r.slug)).toEqual(['a', 'b']);
  });

  test('long query is skipped (clearly prose, not a chosen name)', async () => {
    await engine.putPage('p/x', { type: 'note', title: 'X', compiled_truth: 'x' });
    await engine.setPageAliases('p/x', 'default', ['one two three four five six seven']);
    const out = await applyAliasHop(engine, [], 'one two three four five six seven', { sourceId: 'default' });
    expect(out.length).toBe(0); // >6 tokens → skipped
  });

  test('collision: two pages claim one alias → both injected, capped + deterministic', async () => {
    await engine.putPage('a/hall', { type: 'note', title: 'A Hall', compiled_truth: 'x' });
    await engine.putPage('b/hall', { type: 'note', title: 'B Hall', compiled_truth: 'x' });
    await engine.setPageAliases('a/hall', 'default', ['the hall']);
    await engine.setPageAliases('b/hall', 'default', ['the hall']);
    const out = await applyAliasHop(engine, [], 'the hall', { sourceId: 'default' });
    expect(out.map(r => r.slug).sort()).toEqual(['a/hall', 'b/hall']);
  });
});

describe('applyAliasHop — qualified alias hop (search.qualified_aliases)', () => {
  const company = async (slug = 'projects/acme-widget-project', alias = 'acme widget project') => {
    await engine.putPage(slug, { type: 'project', title: slug, compiled_truth: 'Widget project notes.' });
    await engine.setPageAliases(slug, 'default', [alias]);
  };
  const on = { sourceId: 'default', qualified: true };

  test('off by default: a 3-token alias inside a longer query does nothing', async () => {
    await company();
    const organic = [res('chats/log', 0.9)];
    const out = await applyAliasHop(engine, organic, 'status of the acme widget project today', { sourceId: 'default' });
    expect(out.map(r => r.slug)).toEqual(['chats/log']);
  });

  test('on: a sole absent claimant is injected, leads, and carries its own stamp', async () => {
    await company();
    const out = await applyAliasHop(engine, [res('chats/log', 0.9), res('notes/x', 0.4)], 'status of the acme widget project today', on);
    expect(out.map(r => r.slug)).toEqual(['projects/acme-widget-project', 'chats/log', 'notes/x']);
    expect(out[0].qualified_alias_hit).toBe(true);
    expect(out[0].alias_hit).toBeUndefined();
    expect(out[0].score).toBeGreaterThan(0.9);
  });

  test('on: a present claimant leads too; the rest keep their order', async () => {
    await company();
    const organic = [res('chats/log', 0.9), res('notes/x', 0.7), res('projects/acme-widget-project', 0.2)];
    const out = await applyAliasHop(engine, organic, 'status of the acme widget project today', on);
    expect(out.map(r => r.slug)).toEqual(['projects/acme-widget-project', 'chats/log', 'notes/x']);
    expect(out[0].qualified_alias_hit).toBe(true);
    expect(out[0].alias_hit).toBeUndefined();
    expect(out[0].score).toBeGreaterThan(0.9);
  });

  test('on: two claimants of the phrase suppress the hop', async () => {
    await company('projects/acme-widget-project');
    await company('projects/acme-widget-project-two');
    const out = await applyAliasHop(engine, [res('chats/log', 0.9)], 'status of the acme widget project today', on);
    expect(out.map(r => r.slug)).toEqual(['chats/log']);
  });

  test('on: an alias with two content tokens ("hall of light") never hops', async () => {
    await company('projects/mingtang', 'hall of light');
    const out = await applyAliasHop(engine, [res('chats/log', 0.9)], 'notes on the hall of light renovation', on);
    expect(out.map(r => r.slug)).toEqual(['chats/log']);
  });

  test('on: a 7-14 token query probes; a 15-token one does not', async () => {
    await company();
    const ten = 'please summarize what we decided about the acme widget project';
    const fourteen = 'please summarize what we decided last week about the acme widget project in detail';
    const fifteen = 'please summarize what we decided last week about the acme widget project in more detail';
    expect(fourteen.split(' ').length).toBe(14);
    expect(fifteen.split(' ').length).toBe(15);
    expect((await applyAliasHop(engine, [], ten, on)).map(r => r.slug)).toEqual(['projects/acme-widget-project']);
    expect((await applyAliasHop(engine, [], fourteen, on)).map(r => r.slug)).toEqual(['projects/acme-widget-project']);
    expect(await applyAliasHop(engine, [], fifteen, on)).toEqual([]);
  });

  test('on: excludeSlugs and a prefix exclude leave the visible claimant to fire', async () => {
    await company('projects/acme-widget-project');
    await company('archive/acme-widget-project');
    const q = 'status of the acme widget project today';
    expect((await applyAliasHop(engine, [], q, { ...on, excludeSlugs: ['archive/acme-widget-project'] })).map(r => r.slug))
      .toEqual(['projects/acme-widget-project']);
    expect((await applyAliasHop(engine, [], q, { ...on, excludeSlugPrefixes: ['archive/'] })).map(r => r.slug))
      .toEqual(['projects/acme-widget-project']);
  });

  test('on: a full-query alias still wins over a qualified one', async () => {
    await company('projects/acme-widget-project', 'acme widget project');
    await company('projects/acme-widget-project-review', 'acme widget project review');
    const out = await applyAliasHop(engine, [], 'acme widget project review', on);
    expect(out.map(r => r.slug)).toEqual(['projects/acme-widget-project-review']);
    expect(out[0].alias_hit).toBe(true);
    expect(out[0].qualified_alias_hit).toBeUndefined();
  });

  test('on: a query over 6 tokens never fires the full-query alias hop or the token hop', async () => {
    const long = 'acme quarterly planning notes and minutes from monday morning';
    await engine.putPage('notes/long-alias', { type: 'note', title: 'Long', compiled_truth: 'x' });
    await engine.setPageAliases('notes/long-alias', 'default', [long]);
    await engine.putPage('companies/acme-example', { type: 'company', title: 'Acme Example', compiled_truth: 'y' });
    await engine.setPageAliases('companies/acme-example', 'default', ['acme']);
    const out = await applyAliasHop(engine, [res('chats/log', 0.9)], long, { ...on, tokenHop: true });
    expect(out.map(r => r.slug)).toEqual(['chats/log']);
  });

  test('one alias-table read per lookup, holding the qualified windows; off probes exactly what it did before', async () => {
    const calls: string[][] = [];
    const counting = new Proxy(engine, {
      get(target, prop, receiver) {
        if (prop === 'resolveAliases') return (aliases: string[], opts: unknown) => { calls.push(aliases); return target.resolveAliases(aliases, opts as never); };
        return Reflect.get(target, prop, receiver);
      },
    });
    await company();
    const q = 'status of acme widget project today';
    await applyAliasHop(counting, [], q, { sourceId: 'default' });
    expect(calls).toEqual([[q]]);
    calls.length = 0;
    const out = await applyAliasHop(counting, [], q, on);
    expect(calls.length).toBe(1);
    expect(calls[0][0]).toBe(q);
    expect(calls[0]).toContain('acme widget project');
    expect(calls[0].length).toBeLessThanOrEqual(1 + 42);
    expect(out.map(r => r.slug)).toEqual(['projects/acme-widget-project']);
  });
});

describe('ingest projection (importFromContent)', () => {
  test('frontmatter aliases: land in page_aliases on import', async () => {
    const md = `---\ntype: note\ntitle: The Mingtang\naliases:\n  - Hall of Light\n  - 明堂\n---\nIndoor Greek amphitheater.`;
    await importFromContent(engine, 'projects/mingtang', md, { sourceId: 'default', noEmbed: true });
    const m = await engine.resolveAliases(['hall of light', '明堂'], { sourceId: 'default' });
    expect((m.get('hall of light') ?? []).map(r => r.slug)).toEqual(['projects/mingtang']);
    expect((m.get('明堂') ?? []).map(r => r.slug)).toEqual(['projects/mingtang']);
  });

  test('removing an alias from frontmatter clears it on re-import', async () => {
    const v1 = `---\ntype: note\ntitle: X\naliases: [old name, keep name]\n---\nbody one`;
    await importFromContent(engine, 'p/x', v1, { sourceId: 'default', noEmbed: true });
    const v2 = `---\ntype: note\ntitle: X\naliases: [keep name]\n---\nbody two changed`;
    await importFromContent(engine, 'p/x', v2, { sourceId: 'default', noEmbed: true });
    const m = await engine.resolveAliases(['old name', 'keep name'], { sourceId: 'default' });
    expect(m.get('old name')).toBeUndefined();
    expect((m.get('keep name') ?? []).map(r => r.slug)).toEqual(['p/x']);
  });
});
