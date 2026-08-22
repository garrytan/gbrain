/**
 * #3768 — .svelte/.astro script extraction.
 *
 * detectCodeLanguage maps .svelte/.astro to 'html' (the markup half really is
 * html), which used to send the WHOLE file through the recursive fallback
 * chunker: no symbol names, no code edges, code-def/code-callers blind to
 * every component. The fix slices the script regions (<script> blocks and the
 * Astro `---` frontmatter fence) with line- and offset-preserving masking so
 * the TS/JS grammar parses them at their absolute positions, while the markup
 * keeps its html chunks with the script interiors blanked (no double-index).
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { chunkCodeTextFull } from '../../src/core/chunkers/code.ts';
import {
  isComponentMarkupPath,
  extractComponentScriptRegions,
  maskOutsideRegion,
  maskRegions,
} from '../../src/core/chunkers/component-markup.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { importCodeFile } from '../../src/core/import-file.ts';
import { findCodeDef } from '../../src/commands/code-def.ts';

// Each symbol is deliberately large enough to stay independent under the
// small-sibling merge threshold (~45 tokens at the default 300-token target);
// merged chunks lose their symbolName, which is not what these tests probe.
const SVELTE_SRC = `<script context="module" lang="ts">
export function readModuleCounterSeed(): number {
  const base = moduleCounterSeed + 1;
  const doubled = base * 2;
  const halved = Math.floor(doubled / 2);
  console.log('module counter seed read', base, doubled, halved);
  if (halved < 0) throw new Error('counter seed must never be negative');
  return halved;
}

export const moduleCounterSeed: number = 41;
</script>

<script lang="ts">
function handleComponentClick(): void {
  const seed = readModuleCounterSeed();
  clickTally = seed + clickTally;
  if (clickTally > 100) console.warn('tally is getting big', clickTally);
  if (clickTally < 0) throw new Error('tally must never go negative');
  reportComponentTally(clickTally);
}

function reportComponentTally(total: number): void {
  const formatted = 'tally is now ' + String(total).padStart(4, '0');
  console.log(formatted);
  if (total % 10 === 0) console.log('nice round number of clicks:', total);
  if (total > 1000) console.error('implausible click volume', total);
}

let clickTally: number = 0;
</script>

<button on:click={handleComponentClick}>
  clicked {clickTally} times
</button>

<style>
  button { color: rebeccapurple; }
</style>
`;

const ASTRO_SRC = `---
import { fetchWidgets } from '../lib/widgets';

function summarizeWidgetInventory(): string {
  const count = widgetInventoryList.length;
  const noun = count === 1 ? 'widget' : 'widgets';
  const banner = 'we have ' + count + ' ' + noun + ' in stock today';
  if (count === 0) return 'the warehouse is completely empty, restock soon';
  return banner + ' (updated hourly by the inventory cron)';
}

const widgetInventoryList = await fetchWidgets();
---
<html>
  <body>
    <h1>{summarizeWidgetInventory()}</h1>
  </body>
</html>
`;

describe('isComponentMarkupPath', () => {
  test('matches .svelte and .astro, not others', () => {
    expect(isComponentMarkupPath('src/App.svelte')).toBe(true);
    expect(isComponentMarkupPath('pages/index.ASTRO')).toBe(true);
    expect(isComponentMarkupPath('src/app.html')).toBe(false);
    expect(isComponentMarkupPath('src/app.vue')).toBe(false);
    expect(isComponentMarkupPath('src/app.ts')).toBe(false);
  });
});

describe('extractComponentScriptRegions', () => {
  test('finds both svelte scripts with lang=ts and correct start lines', () => {
    const regions = extractComponentScriptRegions(SVELTE_SRC, 'src/App.svelte');
    expect(regions.length).toBe(2);
    expect(regions[0]!.language).toBe('typescript');
    expect(regions[1]!.language).toBe('typescript');
    // Module script code starts on line 2 (after the opening tag on line 1).
    expect(SVELTE_SRC.slice(regions[0]!.start, regions[0]!.end)).toContain('readModuleCounterSeed');
    expect(SVELTE_SRC.slice(regions[1]!.start, regions[1]!.end)).toContain('handleComponentClick');
  });

  test('svelte script without lang attr is javascript', () => {
    const src = '<script>\nlet x = 1;\n</script>\n<p>hi</p>\n';
    const regions = extractComponentScriptRegions(src, 'a.svelte');
    expect(regions.length).toBe(1);
    expect(regions[0]!.language).toBe('javascript');
  });

  test('astro frontmatter fence is a typescript region', () => {
    const regions = extractComponentScriptRegions(ASTRO_SRC, 'pages/index.astro');
    expect(regions.length).toBe(1);
    expect(regions[0]!.language).toBe('typescript');
    expect(regions[0]!.startLine).toBe(2);
    const code = ASTRO_SRC.slice(regions[0]!.start, regions[0]!.end);
    expect(code).toContain('summarizeWidgetInventory');
    expect(code).not.toContain('<html>');
  });

  test('unterminated script block yields no region', () => {
    const regions = extractComponentScriptRegions('<script>\nlet x = 1;\n', 'a.svelte');
    expect(regions).toEqual([]);
  });
});

describe('masking preserves geometry', () => {
  test('maskOutsideRegion keeps length, lines, and region text', () => {
    const regions = extractComponentScriptRegions(SVELTE_SRC, 'src/App.svelte');
    const masked = maskOutsideRegion(SVELTE_SRC, regions[1]!);
    expect(masked.length).toBe(SVELTE_SRC.length);
    expect(masked.split('\n').length).toBe(SVELTE_SRC.split('\n').length);
    expect(masked).toContain('handleComponentClick');
    expect(masked).not.toContain('export function readModuleCounterSeed');
    expect(masked).not.toContain('<button');
    // Region text sits at the SAME index as in the original.
    expect(masked.indexOf('handleComponentClick')).toBe(SVELTE_SRC.indexOf('handleComponentClick'));
  });

  test('maskRegions blanks the script interiors, keeps markup', () => {
    const regions = extractComponentScriptRegions(SVELTE_SRC, 'src/App.svelte');
    const markup = maskRegions(SVELTE_SRC, regions);
    expect(markup.length).toBe(SVELTE_SRC.length);
    expect(markup).toContain('<button');
    expect(markup).toContain('<script context="module" lang="ts">');
    expect(markup).not.toContain('handleComponentClick(): void');
    expect(markup).not.toContain('moduleCounterSeed: number');
  });
});

describe('chunkCodeTextFull — svelte/astro component files (#3768)', () => {
  test('svelte scripts produce semantic TS chunks with absolute lines', async () => {
    const { chunks } = await chunkCodeTextFull(SVELTE_SRC, 'src/App.svelte', {});
    const byName = new Map(chunks.map((c) => [c.metadata.symbolName, c]));
    const handler = byName.get('handleComponentClick');
    expect(handler).toBeDefined();
    expect(handler!.metadata.language).toBe('typescript');
    expect(handler!.metadata.symbolType).toBe('function');
    // handleComponentClick is defined on line 12 of the .svelte file.
    const expectedLine = SVELTE_SRC.slice(0, SVELTE_SRC.indexOf('function handleComponentClick')).split('\n').length;
    expect(handler!.metadata.startLine).toBe(expectedLine);
    // Module script symbols come through too.
    expect(byName.get('readModuleCounterSeed')).toBeDefined();
  });

  test('svelte markup stays html and does not duplicate script code', async () => {
    const { chunks } = await chunkCodeTextFull(SVELTE_SRC, 'src/App.svelte', {});
    const htmlChunks = chunks.filter((c) => c.metadata.language === 'html');
    expect(htmlChunks.length).toBeGreaterThanOrEqual(1);
    for (const c of htmlChunks) {
      expect(c.text).not.toContain('reportComponentTally(clickTally)');
      expect(c.text).not.toContain('export function readModuleCounterSeed');
    }
    expect(htmlChunks.some((c) => c.text.includes('<button'))).toBe(true);
    // chunk indexes are unique + sequential across script and markup chunks.
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
  });

  test('svelte call edges carry absolute offsets into the original file', async () => {
    const { edges } = await chunkCodeTextFull(SVELTE_SRC, 'src/App.svelte', {});
    const call = edges.find((e) => e.edgeType === 'calls' && e.toSymbol.includes('reportComponentTally'));
    expect(call).toBeDefined();
    // The offset must point at the call site in the ORIGINAL source text.
    expect(SVELTE_SRC.slice(call!.callSiteByteOffset, call!.callSiteByteOffset + 'reportComponentTally'.length))
      .toBe('reportComponentTally');
  });

  test('astro fence produces semantic TS chunks with absolute lines', async () => {
    const { chunks } = await chunkCodeTextFull(ASTRO_SRC, 'pages/index.astro', {});
    const fn = chunks.find((c) => c.metadata.symbolName === 'summarizeWidgetInventory');
    expect(fn).toBeDefined();
    expect(fn!.metadata.language).toBe('typescript');
    const expectedLine = ASTRO_SRC.slice(0, ASTRO_SRC.indexOf('function summarizeWidgetInventory')).split('\n').length;
    expect(fn!.metadata.startLine).toBe(expectedLine);
  });

  test('component file without any script keeps the html fallback path', async () => {
    const src = '<div class="hero">\n  <p>static content only, nothing scripted here at all</p>\n</div>\n';
    const { chunks, edges } = await chunkCodeTextFull(src, 'src/Static.svelte', {});
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    for (const c of chunks) expect(c.metadata.language).toBe('html');
    expect(edges).toEqual([]);
  });
});

describe('importCodeFile + code-def/code-edges over a svelte component (#3768)', () => {
  let engine: PGLiteEngine;

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    await importCodeFile(engine, 'src/App.svelte', SVELTE_SRC, { noEmbed: true });
  }, 60000);

  afterAll(async () => {
    await engine.disconnect();
  }, 30000);

  test('code-def finds the svelte script function', async () => {
    const results = await findCodeDef(engine, 'handleComponentClick');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.language).toBe('typescript');
    expect(results[0]!.snippet).toContain('handleComponentClick');
  });

  test('call edges thread through to code_edges_symbol (code-callers substrate)', async () => {
    const callers = await engine.getCallersOf('reportComponentTally', { allSources: true });
    expect(callers.length).toBeGreaterThanOrEqual(1);
    expect(callers[0]!.edge_type).toBe('calls');
  });
});
