import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('software repair UI contract', () => {
  const html = readFileSync(resolve(import.meta.dir, '../src/renderer/settings-content.html'), 'utf8');
  const css = readFileSync(resolve(import.meta.dir, '../src/renderer/style.css'), 'utf8');

  test('software repair exposes toast diagnose and confirm replace', () => {
    expect(html).toContain('id="repair-toast-diagnose"');
    expect(html).toContain('id="repair-toast-replace"');
    expect(html).toContain('大字段损坏修复');
    expect(html).toContain('pre-toast-repair');
  });

  test('diagnostic export keeps the visible primary-button label', () => {
    expect(html).toContain('<button class="primary" id="export-diagnostic"><span>导出诊断包</span>');
    expect(css).toContain('.diagnostic-export-card > div > span');
    expect(css).not.toMatch(/\.diagnostic-export-card span\s*\{/);
    expect(css).toContain('.diagnostic-export-card button { flex: 0 0 auto; min-width: 128px; }');
  });
});
