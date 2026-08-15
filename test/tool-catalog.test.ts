/**
 * E6 — the generated docs/TOOL_CATALOG.md: renderer determinism, coverage
 * (every non-localOnly op exactly once; localOnly never), starter/gate
 * annotations, the committed doc's freshness, and the CI wiring of the
 * freshness guard (package.json check + verify-chain membership).
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

import { renderToolCatalogMarkdown, firstSentence } from '../src/mcp/tool-catalog.ts';
import { operations } from '../src/core/operations.ts';
import { STARTER_OPS } from '../src/mcp/surface.ts';

const REPO_ROOT = join(import.meta.dir, '..');

describe('firstSentence', () => {
  test('cuts at the first sentence boundary', () => {
    expect(firstSentence('Read a page by slug. Soft-deleted pages are hidden.')).toBe('Read a page by slug.');
    expect(firstSentence('No trailing period here')).toBe('No trailing period here');
    expect(firstSentence('Multi\nline   text. Rest.')).toBe('Multi line text.');
  });
});

describe('renderToolCatalogMarkdown', () => {
  const md = renderToolCatalogMarkdown();

  test('deterministic: two renders are byte-identical', () => {
    expect(renderToolCatalogMarkdown()).toBe(md);
  });

  test('config-independent: contains no timestamps', () => {
    expect(md).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  test('every non-localOnly op appears exactly once; localOnly never', () => {
    for (const op of operations) {
      const cell = `| \`${op.name}\` |`;
      const count = md.split(cell).length - 1;
      if (op.localOnly) {
        expect(count).toBe(0);
      } else {
        expect(count).toBe(1);
      }
    }
  });

  test('starter members are marked; non-members are not', () => {
    for (const op of operations.filter((o) => !o.localOnly)) {
      const row = md.split('\n').find((l) => l.startsWith(`| \`${op.name}\` |`))!;
      const cells = row.split('|').map((c) => c.trim());
      // cells: ['', tool, description, scope, starter, gate, '']
      expect(cells[4]).toBe(STARTER_OPS.has(op.name) ? 'yes' : '');
    }
  });

  test('publish-gated ops carry their gate key', () => {
    const gated = operations.filter((o) => !o.localOnly && o.publishGateKey);
    expect(gated.length).toBeGreaterThan(0);
    for (const op of gated) {
      const row = md.split('\n').find((l) => l.startsWith(`| \`${op.name}\` |`))!;
      expect(row).toContain(`\`${op.publishGateKey}\``);
    }
  });

  test('one section per area, areas sorted', () => {
    const areas = [...new Set(operations.filter((o) => !o.localOnly).map((o) => o.area ?? 'other'))].sort();
    const headings = md.split('\n').filter((l) => l.startsWith('## ')).map((l) => l.slice(3));
    expect(headings).toEqual(areas);
  });
});

describe('freshness guard', () => {
  test('committed docs/TOOL_CATALOG.md matches a fresh render', () => {
    const committed = readFileSync(join(REPO_ROOT, 'docs', 'TOOL_CATALOG.md'), 'utf-8');
    expect(committed).toBe(renderToolCatalogMarkdown() + '\n');
  });

  test('check script exists and is wired into package.json + the verify chain', () => {
    expect(existsSync(join(REPO_ROOT, 'scripts', 'check-tool-catalog-fresh.sh'))).toBe(true);
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8'));
    expect(pkg.scripts['check:tool-catalog']).toBe('bash scripts/check-tool-catalog-fresh.sh');
    const verify = readFileSync(join(REPO_ROOT, 'scripts', 'run-verify-parallel.sh'), 'utf-8');
    expect(verify).toContain('"check:tool-catalog"');
  });
});
