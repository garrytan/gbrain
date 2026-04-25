/**
 * Subagent brain-tool registry tests. Covers:
 *   - every allow-list name exists in OPERATIONS (catches renames upstream)
 *   - Anthropic tool-name constraint enforced
 *   - put_page schema is namespace-wrapped per subagent
 *   - execute() invokes the op handler with viaSubagent=true + subagentId
 *   - filterAllowedTools narrows registry + rejects unknown names
 *   - denied ops (file_upload etc.) do NOT appear in the registry
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, OperationError } from '../src/core/operations.ts';
import {
  BRAIN_TOOL_ALLOWLIST,
  buildBrainTools,
  filterAllowedTools,
  __testing,
} from '../src/core/minions/tools/brain-allowlist.ts';
import type { GBrainConfig } from '../src/core/config.ts';
import type { ToolCtx } from '../src/core/minions/types.ts';

let engine: PGLiteEngine;
const config: GBrainConfig = { engine: 'pglite' } as GBrainConfig;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({ database_url: '' });
  await engine.initSchema();
}, 60_000);

afterAll(async () => {
  await engine.disconnect();
}, 60_000);

beforeEach(async () => {
  await engine.executeRaw('DELETE FROM pages');
});

describe('BRAIN_TOOL_ALLOWLIST', () => {
  test('every name exists in src/core/operations.ts OPERATIONS', () => {
    const opNames = new Set(operations.map(o => o.name));
    const missing = [...BRAIN_TOOL_ALLOWLIST].filter(n => !opNames.has(n));
    expect(missing).toEqual([]);
  });

  test('contains the read-only 10 + put_page', () => {
    expect(BRAIN_TOOL_ALLOWLIST.size).toBe(11);
    expect(BRAIN_TOOL_ALLOWLIST.has('query')).toBe(true);
    expect(BRAIN_TOOL_ALLOWLIST.has('search')).toBe(true);
    expect(BRAIN_TOOL_ALLOWLIST.has('get_page')).toBe(true);
    expect(BRAIN_TOOL_ALLOWLIST.has('list_pages')).toBe(true);
    expect(BRAIN_TOOL_ALLOWLIST.has('put_page')).toBe(true);
  });

  test('does NOT contain destructive ops', () => {
    expect(BRAIN_TOOL_ALLOWLIST.has('file_upload')).toBe(false);
    expect(BRAIN_TOOL_ALLOWLIST.has('delete_page')).toBe(false);
    expect(BRAIN_TOOL_ALLOWLIST.has('delete_file')).toBe(false);
    expect(BRAIN_TOOL_ALLOWLIST.has('sync')).toBe(false);
  });
});

describe('buildBrainTools', () => {
  test('produces one ToolDef per allow-listed op that exists in operations.ts', () => {
    const tools = buildBrainTools({ subagentId: 42, engine, config });
    const opNames = new Set(operations.map(o => o.name));
    const expected = [...BRAIN_TOOL_ALLOWLIST].filter(n => opNames.has(n)).length;
    expect(tools.length).toBe(expected);
  });

  test('tool names are brain_<op> and match Anthropic constraint', () => {
    const tools = buildBrainTools({ subagentId: 7, engine, config });
    for (const t of tools) {
      expect(t.name).toMatch(__testing.ANTHROPIC_NAME_RE);
      expect(t.name.startsWith('brain_')).toBe(true);
    }
  });

  test('tools are flagged idempotent in v0.15', () => {
    const tools = buildBrainTools({ subagentId: 1, engine, config });
    expect(tools.every(t => t.idempotent === true)).toBe(true);
  });

  test('tools carry the op description verbatim', () => {
    const tools = buildBrainTools({ subagentId: 1, engine, config });
    const getPage = tools.find(t => t.name === 'brain_get_page');
    const op = operations.find(o => o.name === 'get_page');
    expect(getPage?.description).toBe(op!.description);
  });

  test('put_page schema is namespace-wrapped per subagent', () => {
    const tools42 = buildBrainTools({ subagentId: 42, engine, config });
    const putPage42 = tools42.find(t => t.name === 'brain_put_page');
    const slug42 = ((putPage42!.input_schema as any).properties as any).slug;
    expect(slug42.pattern).toBe('^wiki/agents/42/.+');
    expect(slug42.description).toContain('wiki/agents/42/');

    const tools7 = buildBrainTools({ subagentId: 7, engine, config });
    const putPage7 = tools7.find(t => t.name === 'brain_put_page');
    const slug7 = ((putPage7!.input_schema as any).properties as any).slug;
    expect(slug7.pattern).toBe('^wiki/agents/7/.+');
  });

  test('non-put_page tools do NOT get a pattern on slug', () => {
    const tools = buildBrainTools({ subagentId: 42, engine, config });
    const getPage = tools.find(t => t.name === 'brain_get_page');
    const slug = ((getPage!.input_schema as any).properties as any).slug;
    expect(slug).toBeDefined();
    expect(slug.pattern).toBeUndefined();
  });

  test('execute() on put_page with valid namespace slug succeeds', async () => {
    const tools = buildBrainTools({ subagentId: 42, engine, config });
    const putPage = tools.find(t => t.name === 'brain_put_page');
    const ctx: ToolCtx = { engine, jobId: 1, remote: true };
    const res = await putPage!.execute(
      { slug: 'wiki/agents/42/notes', content: '---\ntitle: Notes\n---\nbody' },
      ctx,
    );
    expect(res).toBeTruthy();
  });

  test('execute() on put_page with out-of-namespace slug throws permission_denied', async () => {
    const tools = buildBrainTools({ subagentId: 42, engine, config });
    const putPage = tools.find(t => t.name === 'brain_put_page');
    const ctx: ToolCtx = { engine, jobId: 1, remote: true };
    await expect(
      putPage!.execute(
        { slug: 'wiki/analysis/stomp', content: '---\ntitle: x\n---\nb' },
        ctx,
      ),
    ).rejects.toBeInstanceOf(OperationError);
  });
});

describe('filterAllowedTools', () => {
  test('passes prefixed names through', () => {
    const tools = buildBrainTools({ subagentId: 1, engine, config });
    const filtered = filterAllowedTools(tools, ['brain_get_page', 'brain_search']);
    expect(filtered.map(t => t.name)).toEqual(['brain_get_page', 'brain_search']);
  });

  test('accepts un-prefixed names as a convenience', () => {
    const tools = buildBrainTools({ subagentId: 1, engine, config });
    const filtered = filterAllowedTools(tools, ['get_page', 'search']);
    expect(filtered.map(t => t.name)).toEqual(['brain_get_page', 'brain_search']);
  });

  test('rejects unknown tool names (no silent ignore)', () => {
    const tools = buildBrainTools({ subagentId: 1, engine, config });
    expect(() => filterAllowedTools(tools, ['brain_typo_nope'])).toThrow(/unknown tool/);
  });

  test('deduplicates when both prefixed + unprefixed given', () => {
    const tools = buildBrainTools({ subagentId: 1, engine, config });
    const filtered = filterAllowedTools(tools, ['brain_get_page', 'get_page']);
    expect(filtered.length).toBe(1);
  });

  test('empty array yields empty registry', () => {
    const tools = buildBrainTools({ subagentId: 1, engine, config });
    expect(filterAllowedTools(tools, [])).toEqual([]);
  });
});

describe('sanitizeToolName', () => {
  test('returns within 64 chars', () => {
    // Synthetic: simulate an op name long enough to need slicing.
    const long = 'a'.repeat(100);
    expect(__testing.sanitizeToolName(long).length).toBeLessThanOrEqual(64);
  });

  test('replaces non-conforming chars with _', () => {
    expect(__testing.sanitizeToolName('foo.bar')).toBe('brain_foo_bar');
  });
});
