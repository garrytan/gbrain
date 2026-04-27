/**
 * Contract tests for inferred vs stored link types:
 *
 * - **Inference**: closed union `InferredLinkType` / `RELATIONSHIP` in entity-taxonomy + link-extraction.
 * - **Storage / API / reads**: {@link StoredLinkType} (= `string`; `links.link_type` is TEXT without CHECK).
 * - **Bridge**: `asStoredLinkType()` only where deterministic candidates become DB rows (extract batch,
 *   put_page auto-link). User/API paths (`add_link`, `traverse_graph`, CLI graph-query) stay open strings.
 *
 * Rejects (by design): DB ENUM/CHECK on link_type, narrowing `Link.link_type` to the inference union.
 */
import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join, resolve } from 'path';

import type { Link, GraphPath } from '../src/core/types.ts';
import type { LinkBatchInput } from '../src/core/engine.ts';
import type { InferredLinkType, StoredLinkType } from '../src/core/entity-taxonomy.ts';

const root = resolve(import.meta.dir, '..');

function readRepoFile(rel: string): string {
  return readFileSync(join(root, rel), 'utf8');
}

/** Balanced scan: full `CREATE TABLE … links ( … );` including nested parens in CHECK / UNIQUE. */
function extractLinksCreateTable(sql: string): string {
  const needle = 'CREATE TABLE IF NOT EXISTS links';
  const start = sql.indexOf(needle);
  if (start < 0) throw new Error(`missing ${needle}`);
  const openParen = sql.indexOf('(', start + needle.length);
  if (openParen < 0) throw new Error('missing opening ( for links table');
  let depth = 0;
  for (let i = openParen; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) {
        const semi = sql.indexOf(';', i);
        if (semi < 0) throw new Error('missing semicolon after links CREATE');
        return sql.slice(start, semi + 1);
      }
    }
  }
  throw new Error('unbalanced parentheses in links CREATE TABLE');
}

describe('link_type schema — unconstrained TEXT (inventory)', () => {
  const sources = ['src/schema.sql', 'src/core/pglite-schema.ts', 'src/core/schema-embedded.ts'];

  test('links.link_type is TEXT with no CHECK on link_type (schema.sql, pglite-schema, schema-embedded)', () => {
    for (const rel of sources) {
      const sql = readRepoFile(rel);
      const ddl = extractLinksCreateTable(sql);
      expect(ddl, rel).toMatch(/\blink_type\s+TEXT\b/i);
      expect(ddl, rel).not.toMatch(/\blink_type\b[^\n)]*CHECK\b/i);
    }
  });
});

describe('typing strategy (chosen: inferred union + string at boundary)', () => {
  test('InferredLinkType widens to StoredLinkType; DB/API shapes stay string', () => {
    const inferred: InferredLinkType = 'mentions';
    const stored: StoredLinkType = inferred;
    expect(stored).toBe('mentions');

    const row = { link_type: 'legacy_or_manual' } as Pick<Link, 'link_type'>;
    const fromDb: string = row.link_type;
    expect(fromDb).toBe('legacy_or_manual');

    const path = { link_type: 'filter' } as Pick<GraphPath, 'link_type'>;
    expect(path.link_type).toBe('filter');

    const batch: LinkBatchInput = { from_slug: 'a', to_slug: 'b', link_type: 'anything' };
    const t: string | undefined = batch.link_type;
    expect(t).toBe('anything');
  });
});

describe('call sites — persistence bridge vs open string paths', () => {
  test('asStoredLinkType used only at extract + runAutoLink persistence; add_link / traverse stay raw string', () => {
    const extractTs = readRepoFile('src/commands/extract.ts');
    const operationsTs = readRepoFile('src/core/operations.ts');
    const graphQueryTs = readRepoFile('src/commands/graph-query.ts');
    const engineTs = readRepoFile('src/core/engine.ts');

    expect(extractTs).toContain('asStoredLinkType');
    expect(extractTs).toContain('link_type: asStoredLinkType');

    expect(operationsTs).toContain('asStoredLinkType(c.linkType)');
    expect(operationsTs).toContain('(p.link_type as string)');
    expect(operationsTs).toContain("link_type: { type: 'string'");

    expect(graphQueryTs).toContain('linkType?: string');
    expect(graphQueryTs).toContain('traversePaths');

    expect(engineTs).toMatch(/\blink_type\?\s*:\s*string\b/);
  });
});
