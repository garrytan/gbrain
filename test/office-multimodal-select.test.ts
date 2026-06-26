import { test, expect } from 'bun:test';
import { selectAssetsToEmbed } from '../src/core/office/multimodal.ts';
import {
  DOCIR_VERSION,
  emptyLocator,
  type DocAsset,
  type DocBlock,
  type DocBlockType,
  type DocIR,
} from '../src/core/office/types.ts';

function asset(id: string, page: number, isRendered: boolean): DocAsset {
  return {
    id,
    kind: 'image',
    mime: 'image/png',
    data_b64: 'x',
    is_rendered_page: isRendered,
    locator: { ...emptyLocator(), page },
  };
}

function block(type: DocBlockType, page: number, text: string, order: number): DocBlock {
  return {
    id: `b${order}`,
    type,
    level: null,
    markdown: text,
    text,
    order,
    locator: { ...emptyLocator(), page },
    table: null,
    asset_ref: null,
  };
}

function docir(assets: DocAsset[], blocks: DocBlock[] = []): DocIR {
  return {
    docir_version: DOCIR_VERSION,
    doc: { format: 'pdf', page_count: 1, content_hash: 'x', parser: 't' },
    blocks,
    assets,
    warnings: [],
  };
}

test('mode off → no assets', () => {
  expect(selectAssetsToEmbed(docir([asset('a', 1, false)]), 'off')).toHaveLength(0);
});

test('mode all → every asset', () => {
  expect(selectAssetsToEmbed(docir([asset('a', 1, false), asset('b', 2, true)]), 'all')).toHaveLength(2);
});

test('selective → an extracted figure is always embedded', () => {
  expect(selectAssetsToEmbed(docir([asset('fig', 1, false)]), 'selective').map((a) => a.id)).toEqual(['fig']);
});

test('selective → a text-heavy rendered page is skipped', () => {
  const d = docir([asset('page', 1, true)], [block('paragraph', 1, 'x'.repeat(500), 0)]);
  expect(selectAssetsToEmbed(d, 'selective')).toHaveLength(0);
});

test('selective → a sparse-text page with a figure is embedded', () => {
  const d = docir(
    [asset('page', 1, true)],
    [block('paragraph', 1, 'short', 0), block('figure', 1, '', 1)],
  );
  expect(selectAssetsToEmbed(d, 'selective')).toHaveLength(1);
});

test('selective → a near-empty-text page is embedded', () => {
  const d = docir([asset('page', 1, true)], [block('paragraph', 1, 'hi', 0)]);
  expect(selectAssetsToEmbed(d, 'selective')).toHaveLength(1);
});
