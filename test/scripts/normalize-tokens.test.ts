/**
 * Shared token normalizer (refactor wave 1, CQ7): used by the migrations
 * golden handler hash and by scripts/verify-move-only.ts.
 * Protects: re-indenting or re-commenting moved code keeps its normal form,
 * while any real token change (including inside a template literal / SQL)
 * changes it.
 */

import { describe, expect, test } from 'bun:test';
import { normalizeSource, normalizeTokens } from '../../scripts/lib/normalize-tokens.ts';

const ORIGINAL = `{
    version: 2,
    /** doc comment */
    handler: async (engine) => {
      // progress to stderr
      const rows = await engine.executeRaw(\`SELECT  id
        FROM pages WHERE slug = $1\`, [slug]);
      if (rows.length > 0) process.stderr.write(\`  Renamed \${rows.length}\\n\`);
    },
  }`;

const REINDENTED = `{ version: 2, handler: async (engine) => { const rows = await engine.executeRaw(\`SELECT  id
        FROM pages WHERE slug = $1\`, [slug]);
  /* moved */ if (rows.length > 0) process.stderr.write(\`  Renamed \${rows.length}\\n\`); }, }`;

describe('normalizeTokens', () => {
  test('whitespace, newlines and comments outside literals do not change the normal form', () => {
    expect(normalizeSource(REINDENTED)).toBe(normalizeSource(ORIGINAL));
  });

  test('template literal / SQL text is preserved byte for byte', () => {
    const changedSql = REINDENTED.replace('SELECT  id', 'SELECT id');
    expect(normalizeSource(changedSql)).not.toBe(normalizeSource(ORIGINAL));
  });

  test('a single changed token changes the normal form', () => {
    expect(normalizeSource(ORIGINAL.replace('rows.length > 0', 'rows.length >= 0'))).not.toBe(normalizeSource(ORIGINAL));
    expect(normalizeSource(ORIGINAL.replace('version: 2', 'version: 3'))).not.toBe(normalizeSource(ORIGINAL));
  });

  test('rename map rewrites identifiers only', () => {
    const before = 'if (pullFailed) { log("pullFailed"); }';
    const after = 'if (run.pullFailed) { log("pullFailed"); }';
    expect(normalizeSource(before, { renameMap: { pullFailed: 'run.pullFailed' } })).toBe(normalizeSource(after));
    expect(normalizeSource(before)).not.toBe(normalizeSource(after));
  });

  test('tokens are the scanner stream without trivia', () => {
    expect(normalizeTokens('const  x = 1; // c')).toEqual(['const', 'x', '=', '1', ';']);
  });
});
