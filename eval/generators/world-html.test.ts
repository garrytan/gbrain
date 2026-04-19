import { describe, test, expect } from 'bun:test';
import { escapeHtml, renderWorldHtml } from './world-html.ts';

describe('escapeHtml — XSS safety', () => {
  test('escapes the 5 critical chars', () => {
    expect(escapeHtml('<script>alert(1)</script>'))
      .toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  test('escapes ampersand FIRST (or double-escape bug happens)', () => {
    expect(escapeHtml('&lt;'))
      .toBe('&amp;lt;');  // the input &lt; becomes &amp;lt;
  });

  test('escapes quotes (attribute context)', () => {
    expect(escapeHtml('onclick="alert(1)"'))
      .toBe('onclick=&quot;alert(1)&quot;');
    expect(escapeHtml("onclick='alert(1)'"))
      .toBe('onclick=&#39;alert(1)&#39;');
  });

  test('passthrough for safe ASCII', () => {
    expect(escapeHtml('Hello world.')).toBe('Hello world.');
  });

  test('handles null and undefined', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
  });

  test('handles numbers', () => {
    expect(escapeHtml(42)).toBe('42');
  });

  test('preserves Unicode (non-ASCII that\'s not special HTML)', () => {
    expect(escapeHtml('Héctor García 🎉')).toBe('Héctor García 🎉');
  });

  test('real Opus prose injection attempt neutralized', () => {
    // Representative: if Opus generates this in an entity backstory,
    // the explorer HTML must NOT execute it. The XSS protection works
    // because `<img` is escaped to `&lt;img` — the browser renders the
    // resulting string as text, not as an img element, so the embedded
    // `onerror=` attribute never gets parsed as an attribute.
    const attack = `<img src=x onerror=alert('xss')>`;
    const safe = escapeHtml(attack);
    // The opening `<` must be escaped (this is what neutralizes the tag).
    expect(safe).not.toContain('<img');
    // The single quote (which would break out of an attribute) is escaped.
    expect(safe).not.toContain("'xss'");
    expect(safe).toBe('&lt;img src=x onerror=alert(&#39;xss&#39;)&gt;');
  });

  test('javascript: URL neutralized when inserted as text', () => {
    // Even as text content, escape quotes so it can't break attribute context.
    const attack = `"javascript:alert(1)//`;
    expect(escapeHtml(attack)).toBe('&quot;javascript:alert(1)//');
  });
});

describe('renderWorldHtml', () => {
  const samplePage = {
    slug: 'people/alice-chen',
    type: 'person' as const,
    title: 'Alice Chen',
    compiled_truth: 'Alice Chen is a senior engineer.',
    timeline: '- **2023-01-15** | Promoted to staff engineer',
    _facts: { type: 'person', role: 'engineer' },
  };

  test('renders an HTML document', () => {
    const html = renderWorldHtml([samplePage]);
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('<html');
    expect(html).toContain('Alice Chen');
  });

  test('includes page in rail and in main cards', () => {
    const html = renderWorldHtml([samplePage]);
    // Rail link uses #slug anchor
    expect(html).toContain('href="#people/alice-chen"');
    // Entity card has matching id
    expect(html).toContain('id="people/alice-chen"');
  });

  test('escapes all user content (XSS neutralization)', () => {
    const maliciousPage = {
      ...samplePage,
      title: '<img src=x onerror=alert(1)>',
      compiled_truth: `<script>fetch('/steal')</script>`,
    };
    const html = renderWorldHtml([maliciousPage]);
    // Raw <script> / <img with onerror must NOT be present.
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>fetch');
    // Escaped forms must be present.
    expect(html).toContain('&lt;img src=x');
    expect(html).toContain('&lt;script&gt;fetch');
  });

  test('groups by type in the rail', () => {
    const pages = [
      { ...samplePage, slug: 'people/alice', title: 'Alice', type: 'person' as const },
      { ...samplePage, slug: 'companies/acme', title: 'Acme', type: 'company' as const },
      { ...samplePage, slug: 'meetings/standup', title: 'Standup', type: 'meeting' as const },
    ];
    const html = renderWorldHtml(pages);
    expect(html).toContain('companys');  // rendered as "${type}s" — imperfect plural but cheap
    expect(html).toContain('persons');
    expect(html).toContain('meetings');
  });

  test('empty corpus produces a valid (if sparse) document', () => {
    const html = renderWorldHtml([]);
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('<nav');
    expect(html).toContain('<main');
  });

  test('ledger metadata renders when provided', () => {
    const ledger = { generated_at: '2026-04-19T10:00:00Z', model: 'claude-opus-4-7', costUsd: 3.14 };
    const html = renderWorldHtml([samplePage], ledger);
    expect(html).toContain('claude-opus-4-7');
    expect(html).toContain('$3.14');
  });

  test('ledger HTML-escapes generated_at and model', () => {
    const ledger = { generated_at: '<malicious>', model: 'opus<script>' };
    const html = renderWorldHtml([samplePage], ledger);
    expect(html).not.toContain('<malicious>');
    expect(html).not.toContain('opus<script>');
    expect(html).toContain('&lt;malicious&gt;');
  });
});
